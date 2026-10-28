import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, Contract, ContractFactory, ZeroAddress, ZeroHash, parseEther, parseUnits } from "ethers";

const require = createRequire(import.meta.url);
let compiled;

function compile() {
  if (compiled) return compiled;
  const sources = Object.fromEntries(["funding_campaign.sol", "asset_token.sol"].map((name) =>
    [name, { content: readFileSync(new URL(`../../smart_contracts/${name}`, import.meta.url), "utf8") }]));
  sources["funding_issuer.sol"] = {
    content: readFileSync(new URL("./fixtures/funding_issuer.sol", import.meta.url), "utf8")
  };
  sources["refund_contributor.sol"] = {
    content: readFileSync(new URL("./fixtures/refund_contributor.sol", import.meta.url), "utf8")
  };
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  }), { import: (path) => {
    try { return { contents: readFileSync(require.resolve(path), "utf8") }; }
    catch { return { error: `Import not found: ${path}` }; }
  } }));
  assert.deepEqual((output.errors || []).filter((error) => error.severity === "error"), []);
  compiled = {
    campaign: output.contracts["funding_campaign.sol"].FundingCampaign,
    token: output.contracts["asset_token.sol"].AssetToken,
    issuer: output.contracts["funding_issuer.sol"].FundingIssuer,
    refundContributor: output.contracts["refund_contributor.sol"].RefundContributor
  };
  return compiled;
}

test("Checkpoint 3: failed campaigns, refunds, and refund payment safety", async (t) => {
  const artifacts = compile();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const alice = await provider.getSigner(1);
    const bob = await provider.getSigner(2);
    const outsider = await provider.getSigner(3);
    const token = await new ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, issuer)
      .deploy(issuer.address, "Coffee", "COF", 100000n,
        "refunds", "Coffee", "Business", 1n, "USD", "urn:refunds", ZeroHash);
    await token.waitForDeployment();
    const factory = new ContractFactory(artifacts.campaign.abi, artifacts.campaign.evm.bytecode.object, issuer);
    const offered = parseUnits("10000", 18);
    const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
    async function deployCampaign(end = deadline) {
      const result = await factory.deploy(await token.getAddress(), parseEther("1"), end, offered);
      await result.waitForDeployment();
      return result;
    }
    async function activate(result) {
      await (await token.approve(await result.getAddress(), offered)).wait();
      await (await result.activate()).wait();
    }
    function revertsWith(name) {
      return (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        assert.equal(factory.interface.parseError(error.data).name, name);
        return true;
      };
    }
    const campaign = await deployCampaign();
    const empty = await deployCampaign();
    const setup = await deployCampaign();
    const address = await campaign.getAddress();
    await activate(campaign);
    await activate(empty);
    await (await campaign.connect(alice).contribute({ value: parseEther("0.2") })).wait();
    await (await campaign.connect(bob).contribute({ value: parseEther("0.15") })).wait();

    await t.test("active campaigns reject early finalization, refunds, and escrow return", async () => {
      await assert.rejects(campaign.finalizeCampaign.staticCall(), revertsWith("DeadlineNotReached"));
      await assert.rejects(campaign.connect(alice).claimRefund.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.reclaimFailedTokens.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.settle.staticCall(), revertsWith("InvalidState"));
      assert.equal(await provider.getBalance(address), parseEther("0.35"));
    });

    await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(deadline) - 1] });
    await connection.provider.request({ method: "evm_mine", params: [] });
    await t.test("finalization is rejected one second before the deadline", async () => {
      await assert.rejects(campaign.finalizeCampaign.staticCall(), revertsWith("DeadlineNotReached"));
    });

    await t.test("any wallet can finalize failure exactly at the deadline without moving funds", async () => {
      const before = await provider.getBalance(issuer.address);
      await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(deadline)] });
      const receipt = await (await campaign.connect(outsider).finalizeCampaign()).wait();
      assert.equal(BigInt((await provider.getBlock(receipt.blockNumber)).timestamp), deadline);
      assert.equal(await campaign.state(), 3n); // Failed
      assert.equal(await provider.getBalance(issuer.address), before);
      assert.equal(await provider.getBalance(address), parseEther("0.35"));
      assert.equal(await token.balanceOf(address), offered);
      const event = campaign.interface.parseLog(receipt.logs[0]);
      assert.equal(event.name, "CampaignFailed");
      assert.equal(event.args.totalRaised, parseEther("0.35"));
    });

    await t.test("failed campaigns block settlement, contributions, token claims, and repeated finalization", async () => {
      await assert.rejects(campaign.settle.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.contribute.staticCall({ value: 1n }), revertsWith("InvalidState"));
      await assert.rejects(campaign.connect(alice).claimTokens.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.finalizeCampaign.staticCall(), revertsWith("InvalidState"));
    });

    await t.test("non-contributors cannot claim refunds and non-issuers cannot reclaim escrow", async () => {
      await assert.rejects(campaign.connect(outsider).claimRefund.staticCall(), revertsWith("NothingToClaim"));
      await assert.rejects(campaign.claimRefund.staticCall(), revertsWith("NothingToClaim"));
      await assert.rejects(campaign.connect(alice).reclaimFailedTokens.staticCall(), revertsWith("OnlyIssuer"));
    });

    await t.test("Alice receives her 0.2 ETH once, with original contribution history preserved", async () => {
      const before = await provider.getBalance(alice.address);
      const receipt = await (await campaign.connect(alice).claimRefund()).wait();
      assert.equal(await provider.getBalance(alice.address), before + parseEther("0.2") - receipt.fee);
      assert.equal(await campaign.refundClaimed(alice.address), true);
      assert.equal(await campaign.contributions(alice.address), parseEther("0.2"));
      assert.equal(await campaign.totalRefunded(), parseEther("0.2"));
      const event = campaign.interface.parseLog(receipt.logs[0]);
      assert.equal(event.name, "RefundClaimed");
      assert.equal(event.args.contributor, alice.address);
      assert.equal(event.args.amount, parseEther("0.2"));
      await assert.rejects(campaign.connect(alice).claimRefund.staticCall(), revertsWith("AlreadyClaimed"));
    });

    await t.test("issuer recovers offered tokens once without taking Bob's pending refund", async () => {
      const before = await token.balanceOf(issuer.address);
      const receipt = await (await campaign.reclaimFailedTokens()).wait();
      assert.equal(await token.balanceOf(issuer.address), before + offered);
      assert.equal(await token.balanceOf(address), 0n);
      assert.equal(await campaign.escrowReturned(), true);
      assert.equal(await provider.getBalance(address), parseEther("0.15"));
      const event = campaign.interface.parseLog(receipt.logs.find((log) => log.address.toLowerCase() === address.toLowerCase()));
      assert.equal(event.name, "EscrowReturned");
      assert.equal(event.args.amount, offered);
      await assert.rejects(campaign.reclaimFailedTokens.staticCall(), revertsWith("AlreadyClaimed"));
    });

    await t.test("Bob independently recovers 0.15 ETH after issuer reclaims tokens", async () => {
      const before = await provider.getBalance(bob.address);
      const receipt = await (await campaign.connect(bob).claimRefund()).wait();
      assert.equal(await provider.getBalance(bob.address), before + parseEther("0.15") - receipt.fee);
      assert.equal(await campaign.totalRefunded(), parseEther("0.35"));
      assert.equal(await campaign.totalRaised(), parseEther("0.35"));
      assert.equal(await provider.getBalance(address), 0n);
      assert.equal(await campaign.state(), 3n);
    });

    await t.test("zero-contributor campaigns can fail and return escrow; Setup cannot finalize", async () => {
      await (await empty.connect(outsider).finalizeCampaign()).wait();
      await (await empty.reclaimFailedTokens()).wait();
      assert.equal(await empty.state(), 3n);
      assert.equal(await token.balanceOf(await empty.getAddress()), 0n);
      await assert.rejects(setup.finalizeCampaign.staticCall(), revertsWith("InvalidState"));
    });

    const safetyDeadline = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
    const safety = await deployCampaign(safetyDeadline);
    await activate(safety);
    const receiver = await new ContractFactory(artifacts.refundContributor.abi,
      artifacts.refundContributor.evm.bytecode.object, issuer).deploy();
    await receiver.waitForDeployment();
    await (await receiver.contribute(await safety.getAddress(), { value: parseEther("0.2") })).wait();
    await (await safety.connect(bob).contribute({ value: parseEther("0.15") })).wait();
    await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(safetyDeadline) + 1] });
    await (await safety.finalizeCampaign()).wait();

    await t.test("rejecting refund receiver preserves its claim and cannot block another investor", async () => {
      await (await receiver.configure(true, false)).wait();
      await assert.rejects(async () => {
        await (await receiver.claimRefund({ gasLimit: 500000 })).wait();
      });
      await assert.rejects(receiver.claimRefund.staticCall(), revertsWith("EtherTransferFailed"));
      assert.equal(await safety.refundClaimed(await receiver.getAddress()), false);
      assert.equal(await safety.totalRefunded(), 0n);
      assert.equal(await provider.getBalance(await safety.getAddress()), parseEther("0.35"));
      await (await safety.connect(bob).claimRefund()).wait();
      assert.equal(await safety.totalRefunded(), parseEther("0.15"));
    });

    await t.test("refund retry succeeds while nested refund withdrawal is blocked", async () => {
      await (await receiver.configure(false, true)).wait();
      await (await receiver.claimRefund()).wait();
      assert.equal(await receiver.reentryBlocked(), true);
      assert.equal(await safety.refundClaimed(await receiver.getAddress()), true);
      assert.equal(await provider.getBalance(await receiver.getAddress()), parseEther("0.2"));
      assert.equal(await provider.getBalance(await safety.getAddress()), 0n);
      assert.equal(await safety.totalRefunded(), parseEther("0.35"));
      await assert.rejects(receiver.claimRefund.staticCall(), revertsWith("AlreadyClaimed"));
    });
  } finally {
    provider.destroy();
    await connection.close();
  }
});

test("Checkpoint 3: rounding and settlement payment safety", async (t) => {
  const artifacts = compile();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const alice = await provider.getSigner(1);
    const bob = await provider.getSigner(2);
    const tokenFactory = new ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, issuer);
    const token = await tokenFactory.deploy(issuer.address, "Coffee", "COF", 100000n,
      "rounding", "Coffee", "Business", 1n, "USD", "urn:rounding", ZeroHash);
    await token.waitForDeployment();
    const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
    const factory = new ContractFactory(artifacts.campaign.abi, artifacts.campaign.evm.bytecode.object, issuer);

    for (const offered of [10n, 1n]) {
      await t.test(`rounding with ${offered} token base units preserves claims and returns dust once`, async () => {
        const campaign = await factory.deploy(await token.getAddress(), 3n, deadline, offered);
        await campaign.waitForDeployment();
        const address = await campaign.getAddress();
        await (await token.approve(address, offered)).wait();
        await (await campaign.activate()).wait();
        await (await campaign.connect(alice).contribute({ value: 1n })).wait();
        await (await campaign.connect(bob).contribute({ value: 2n })).wait();
        await (await campaign.settle()).wait();
        assert.equal(await campaign.tokenAllocation(alice.address), offered / 3n);
        assert.equal(await campaign.tokenAllocation(bob.address), offered * 2n / 3n);
        const aliceBefore = await token.balanceOf(alice.address);
        const bobBefore = await token.balanceOf(bob.address);
        await (await campaign.connect(alice).claimTokens()).wait();
        await assert.rejects(campaign.reclaimRemainder.staticCall(), (error) => {
          assert.equal(error.revert.name, "ClaimsOutstanding"); return true;
        });
        await (await campaign.connect(bob).claimTokens()).wait();
        assert.equal(await token.balanceOf(alice.address), aliceBefore + offered / 3n);
        assert.equal(await token.balanceOf(bob.address), bobBefore + offered * 2n / 3n);
        assert.equal(await campaign.claimedContributions(), 3n, "zero-token allocations still complete their claims");
        assert.equal(await token.balanceOf(address), 1n);
        await assert.rejects(campaign.connect(alice).reclaimRemainder.staticCall(), (error) => {
          assert.equal(error.revert.name, "OnlyIssuer"); return true;
        });
        const before = await token.balanceOf(issuer.address);
        await (await campaign.reclaimRemainder()).wait();
        assert.equal(await token.balanceOf(issuer.address), before + 1n);
        assert.equal(await token.balanceOf(address), 0n);
        await assert.rejects(campaign.reclaimRemainder.staticCall(), (error) => {
          assert.equal(error.revert.name, "AlreadyClaimed"); return true;
        });
      });
    }

    const receiver = await new ContractFactory(artifacts.issuer.abi, artifacts.issuer.evm.bytecode.object, issuer).deploy();
    await receiver.waitForDeployment();
    await (await token.transfer(await receiver.getAddress(), 10n)).wait();
    await (await receiver.launch(await token.getAddress(), 3n, deadline, 10n)).wait();
    const campaign = new Contract(await receiver.campaign(), artifacts.campaign.abi, alice);
    await (await campaign.contribute({ value: 3n })).wait();

    await t.test("rejected issuer payment rolls back settlement and leaves ETH locked", async () => {
      await (await receiver.configure(true, false)).wait();
      await assert.rejects(async () => {
        await (await receiver.settle({ gasLimit: 500000 })).wait();
      });
      await assert.rejects(receiver.settle.staticCall(), (error) => {
        assert.equal(campaign.interface.parseError(error.data).name, "EtherTransferFailed"); return true;
      });
      assert.equal(await campaign.state(), 2n);
      assert.equal(await provider.getBalance(await campaign.getAddress()), 3n);
      assert.equal(await provider.getBalance(await receiver.getAddress()), 0n);
      assert.equal(await token.balanceOf(await campaign.getAddress()), 10n);
    });

    await t.test("issuer callback cannot reenter settlement; normal settlement succeeds once", async () => {
      await (await receiver.configure(false, true)).wait();
      await (await receiver.settle()).wait();
      assert.equal(await receiver.reentryBlocked(), true);
      assert.equal(await provider.getBalance(await receiver.getAddress()), 3n);
      assert.equal(await provider.getBalance(await campaign.getAddress()), 0n);
      assert.equal(await campaign.state(), 4n);
      await (await campaign.claimTokens()).wait();
      assert.equal(await token.balanceOf(await campaign.getAddress()), 0n);
    });
  } finally {
    provider.destroy();
    await connection.close();
  }
});

test("Checkpoint 3: campaign configuration and escrow activation", async (t) => {
  const artifacts = compile();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const investor = await provider.getSigner(1);
    const token = await new ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, issuer)
      .deploy(issuer.address, "Duong Coffee Token", "DCOF", 100000n,
        "coffee-cp3-001", "Duong Coffee", "Business", 500000n, "USD", "urn:coffee:cp3", ZeroHash);
    await token.waitForDeployment();
    const factory = new ContractFactory(artifacts.campaign.abi, artifacts.campaign.evm.bytecode.object, issuer);
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const terms = [await token.getAddress(), parseEther("1"), now + 86400n, parseUnits("10000", 18)];

    await t.test("deployment records immutable terms, starts in Setup, and moves no tokens", async () => {
      const campaign = await factory.deploy(...terms);
      await campaign.waitForDeployment();
      assert.equal(await campaign.issuer(), issuer.address);
      assert.equal(await campaign.assetToken(), terms[0]);
      assert.equal(await campaign.fundingGoal(), terms[1]);
      assert.equal(await campaign.deadline(), terms[2]);
      assert.equal(await campaign.offeredTokens(), terms[3]);
      assert.equal(await campaign.state(), 0n); // Setup is the first enum member.
      assert.equal(await campaign.totalRaised(), 0n);
      assert.equal(await campaign.contributions(investor.address), 0n);
      assert.equal(await token.balanceOf(issuer.address), parseUnits("100000", 18));
      assert.equal(await token.balanceOf(await campaign.getAddress()), 0n);
    });

    const latest = BigInt((await provider.getBlock("latest")).timestamp);
    const invalidCases = [
      ["zero token address", 0, ZeroAddress, "InvalidAssetToken"],
      ["wallet as token address", 0, investor.address, "InvalidAssetToken"],
      ["zero goal", 1, 0n, "InvalidFundingGoal"],
      ["deadline equal to current block time", 2, latest, "InvalidDeadline"],
      ["past deadline", 2, latest - 1n, "InvalidDeadline"],
      ["zero offered tokens", 3, 0n, "InvalidOfferedTokens"]
    ];
    for (const [label, index, value, expectedError] of invalidCases) {
      await t.test(`rejects ${label}`, async () => {
        const args = [...terms];
        args[index] = value;
        const transaction = await factory.getDeployTransaction(...args);
        await assert.rejects(provider.call({ ...transaction, from: issuer.address }), (error) => {
          assert.equal(error.code, "CALL_EXCEPTION");
          assert.equal(factory.interface.parseError(error.data).name, expectedError);
          return true;
        });
      });
    }

    const campaign = await factory.deploy(...terms);
    await campaign.waitForDeployment();
    const address = await campaign.getAddress();
    const supply = parseUnits("100000", 18);
    function revertsWith(contract, name) {
      return (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        assert.equal(contract.interface.parseError(error.data).name, name);
        return true;
      };
    }
    async function assertSetupIntact() {
      assert.equal(await campaign.state(), 0n);
      assert.equal(await token.balanceOf(issuer.address), supply);
      assert.equal(await token.balanceOf(address), 0n);
    }

    await t.test("activation without approval reverts and preserves Setup and balances", async () => {
      // Submit an actual transaction to check rollback, rather than only simulate it.
      await assert.rejects(async () => {
        const tx = await campaign.activate({ gasLimit: 500000 });
        await tx.wait();
      });
      await assertSetupIntact();
      await assert.rejects(campaign.activate.staticCall(), revertsWith(token, "ERC20InsufficientAllowance"));
    });

    await t.test("insufficient approval cannot partially fund escrow", async () => {
      await (await token.approve(address, terms[3] - 1n)).wait();
      await assert.rejects(campaign.activate.staticCall(), revertsWith(token, "ERC20InsufficientAllowance"));
      await assertSetupIntact();
    });

    await t.test("only issuer can activate, even with sufficient approval", async () => {
      await (await token.approve(address, terms[3])).wait();
      await assert.rejects(campaign.connect(investor).activate.staticCall(), revertsWith(campaign, "OnlyIssuer"));
      await assertSetupIntact();
    });

    await t.test("insufficient issuer balance leaves the campaign in Setup", async () => {
      const oversized = await factory.deploy(terms[0], terms[1], terms[2], supply + 1n);
      await oversized.waitForDeployment();
      await (await token.approve(await oversized.getAddress(), supply + 1n)).wait();
      await assert.rejects(oversized.activate.staticCall(), revertsWith(token, "ERC20InsufficientBalance"));
      assert.equal(await oversized.state(), 0n);
      assert.equal(await token.balanceOf(await oversized.getAddress()), 0n);
      assert.equal(await token.balanceOf(issuer.address), supply);
    });

    await t.test("activation reserves exactly 10,000 tokens and emits an event", async () => {
      const receipt = await (await campaign.activate()).wait();
      assert.equal(await campaign.state(), 1n); // Active
      assert.equal(await token.balanceOf(address), terms[3]);
      assert.equal(await token.balanceOf(issuer.address), supply - terms[3]);
      assert.equal(await token.allowance(issuer.address, address), 0n);
      assert.equal(await token.totalSupply(), supply);
      const log = receipt.logs.find((entry) => entry.address.toLowerCase() === address.toLowerCase());
      const event = campaign.interface.parseLog(log);
      assert.equal(event.name, "CampaignActivated");
      assert.equal(event.args.issuer, issuer.address);
      assert.equal(event.args.offeredTokens, terms[3]);
    });

    await t.test("activation cannot run twice", async () => {
      await assert.rejects(campaign.activate.staticCall(), revertsWith(campaign, "InvalidState"));
      assert.equal(await campaign.state(), 1n);
      assert.equal(await token.balanceOf(address), terms[3]);
    });

    await t.test("issuer cannot spend the tokens reserved in escrow", async () => {
      await assert.rejects(token.transfer.staticCall(investor.address, supply),
        revertsWith(token, "ERC20InsufficientBalance"));
      assert.equal(await token.balanceOf(address), terms[3]);
    });

    await t.test("activation at or after deadline is rejected even with approval", async () => {
      const expired = await factory.deploy(...terms);
      await expired.waitForDeployment();
      await (await token.approve(await expired.getAddress(), terms[3])).wait();
      await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(terms[2])] });
      await connection.provider.request({ method: "evm_mine", params: [] });
      await assert.rejects(expired.activate.staticCall(), revertsWith(expired, "DeadlinePassed"));
      await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(terms[2]) + 1] });
      await connection.provider.request({ method: "evm_mine", params: [] });
      await assert.rejects(expired.activate.staticCall(), revertsWith(expired, "DeadlinePassed"));
      assert.equal(await expired.state(), 0n);
      assert.equal(await token.balanceOf(await expired.getAddress()), 0n);
    });
  } finally {
    provider.destroy();
    await connection.close();
  }
});

test("Checkpoint 3: multiple contributors, funding cap, settlement, and claims", async (t) => {
  const artifacts = compile();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const alice = await provider.getSigner(1);
    const bob = await provider.getSigner(2);
    const carol = await provider.getSigner(3);
    const token = await new ContractFactory(artifacts.token.abi, artifacts.token.evm.bytecode.object, issuer)
      .deploy(issuer.address, "Duong Coffee Token", "DCOF", 100000n,
        "coffee-contributions", "Duong Coffee", "Business", 500000n, "USD", "urn:coffee:funding", ZeroHash);
    await token.waitForDeployment();
    const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
    const campaign = await new ContractFactory(artifacts.campaign.abi, artifacts.campaign.evm.bytecode.object, issuer)
      .deploy(await token.getAddress(), parseEther("1"), deadline, parseUnits("10000", 18));
    await campaign.waitForDeployment();
    const address = await campaign.getAddress();
    function revertsWith(name) {
      return (error) => {
        assert.equal(error.code, "CALL_EXCEPTION");
        assert.equal(campaign.interface.parseError(error.data).name, name);
        return true;
      };
    }

    await t.test("cannot contribute before tokens are escrowed", async () => {
      await assert.rejects(campaign.connect(alice).contribute.staticCall({ value: parseEther("0.2") }),
        revertsWith("InvalidState"));
      assert.equal(await campaign.totalRaised(), 0n);
      assert.equal(await provider.getBalance(address), 0n);
    });
    await (await token.approve(address, parseUnits("10000", 18))).wait();
    await (await campaign.activate()).wait();

    await t.test("rejects zero contributions", async () => {
      await assert.rejects(campaign.connect(alice).contribute.staticCall(), revertsWith("ZeroContribution"));
    });

    await t.test("issuer cannot settle before reaching the goal", async () => {
      await assert.rejects(campaign.settle.staticCall(), revertsWith("InvalidState"));
    });

    await t.test("records repeated contributions and emits the payment event", async () => {
      await (await campaign.connect(alice).contribute({ value: parseEther("0.1") })).wait();
      const receipt = await (await campaign.connect(alice).contribute({ value: parseEther("0.1") })).wait();
      assert.equal(await campaign.contributions(alice.address), parseEther("0.2"));
      assert.equal(await campaign.totalRaised(), parseEther("0.2"));
      assert.equal(await campaign.state(), 1n);
      const event = campaign.interface.parseLog(receipt.logs[0]);
      assert.equal(event.name, "ContributionReceived");
      assert.equal(event.args.contributor, alice.address);
      assert.equal(event.args.amount, parseEther("0.1"));
      assert.equal(event.args.totalRaised, parseEther("0.2"));
    });

    await t.test("tracks a second wallet separately and holds ETH without distributing tokens", async () => {
      await (await campaign.connect(bob).contribute({ value: parseEther("0.3") })).wait();
      assert.equal(await campaign.contributions(alice.address), parseEther("0.2"));
      assert.equal(await campaign.contributions(bob.address), parseEther("0.3"));
      assert.equal(await campaign.totalRaised(), parseEther("0.5"));
      assert.equal(await provider.getBalance(address), parseEther("0.5"));
      for (const investor of [alice, bob, carol]) {
        assert.equal(await token.balanceOf(investor.address), 0n);
      }
      assert.equal(await token.balanceOf(address), parseUnits("10000", 18));
    });

    await t.test("over-cap payment reverts without changing contributions or escrow", async () => {
      await assert.rejects(campaign.connect(carol).contribute.staticCall({ value: parseEther("0.6") }),
        revertsWith("FundingCapExceeded"));
      await assert.rejects(async () => {
        await (await campaign.connect(carol).contribute({ value: parseEther("0.6"), gasLimit: 500000 })).wait();
      });
      assert.equal(await campaign.contributions(carol.address), 0n);
      assert.equal(await campaign.totalRaised(), parseEther("0.5"));
      assert.equal(await provider.getBalance(address), parseEther("0.5"));
      assert.equal(await campaign.state(), 1n);
    });

    await t.test("third wallet reaches the goal and immediately marks success", async () => {
      const receipt = await (await campaign.connect(carol).contribute({ value: parseEther("0.5") })).wait();
      assert.equal(await campaign.contributions(carol.address), parseEther("0.5"));
      assert.equal(await campaign.totalRaised(), parseEther("1"));
      assert.equal(await provider.getBalance(address), parseEther("1"));
      assert.equal(await campaign.state(), 2n); // Successful
      assert.ok(BigInt((await provider.getBlock(receipt.blockNumber)).timestamp) < deadline);
      const event = campaign.interface.parseLog(receipt.logs[1]);
      assert.equal(event.name, "CampaignSuccessful");
      assert.equal(event.args.totalRaised, parseEther("1"));
      assert.equal(await token.balanceOf(address), parseUnits("10000", 18));
    });

    await t.test("rejects further contributions after success", async () => {
      await assert.rejects(campaign.connect(alice).contribute.staticCall({ value: 1n }),
        revertsWith("InvalidState"));
      assert.equal(await campaign.totalRaised(), parseEther("1"));
    });

    await t.test("ordinary ETH transfers cannot bypass contribution accounting", async () => {
      await assert.rejects(provider.call({ from: alice.address, to: address, value: 1n }));
      assert.equal(await provider.getBalance(address), parseEther("1"));
    });

    await t.test("successful campaign blocks token claims until settlement", async () => {
      await assert.rejects(campaign.connect(alice).claimTokens.staticCall(), revertsWith("InvalidState"));
      assert.equal(await campaign.tokenAllocation(alice.address), parseUnits("2000", 18));
    });

    await t.test("successful campaign cannot fail, refund, or return offered tokens", async () => {
      await assert.rejects(campaign.finalizeCampaign.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.connect(alice).claimRefund.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.reclaimFailedTokens.staticCall(), revertsWith("InvalidState"));
    });

    await t.test("only issuer can settle", async () => {
      await assert.rejects(campaign.connect(alice).settle.staticCall(), revertsWith("OnlyIssuer"));
      assert.equal(await provider.getBalance(address), parseEther("1"));
    });

    await t.test("settlement pays exactly the funding goal and preserves escrow", async () => {
      const before = await provider.getBalance(issuer.address);
      const receipt = await (await campaign.settle()).wait();
      assert.equal(await provider.getBalance(issuer.address), before + parseEther("1") - receipt.fee);
      assert.equal(await provider.getBalance(address), 0n);
      assert.equal(await campaign.state(), 4n); // Settled
      assert.equal(await campaign.totalRaised(), parseEther("1"));
      assert.equal(await token.balanceOf(address), parseUnits("10000", 18));
      const event = campaign.interface.parseLog(receipt.logs[0]);
      assert.equal(event.name, "CampaignSettled");
      assert.equal(event.args.amount, parseEther("1"));
    });

    await t.test("settlement cannot run twice and further contributions remain blocked", async () => {
      await assert.rejects(campaign.settle.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.connect(alice).contribute.staticCall({ value: 1n }), revertsWith("InvalidState"));
      await assert.rejects(campaign.connect(alice).claimRefund.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.finalizeCampaign.staticCall(), revertsWith("InvalidState"));
      await assert.rejects(campaign.reclaimFailedTokens.staticCall(), revertsWith("InvalidState"));
    });

    await t.test("non-contributor cannot claim tokens", async () => {
      await assert.rejects(campaign.claimTokens.staticCall(), revertsWith("NothingToClaim"));
    });

    await t.test("issuer cannot reclaim tokens while investor claims are outstanding", async () => {
      await assert.rejects(campaign.reclaimRemainder.staticCall(), revertsWith("ClaimsOutstanding"));
    });

    await t.test("investors receive 2,000, 3,000, and 5,000 tokens in separate claims", async () => {
      for (const [investor, tokens] of [[alice, "2000"], [bob, "3000"], [carol, "5000"]]) {
        const contribution = await campaign.contributions(investor.address);
        const receipt = await (await campaign.connect(investor).claimTokens()).wait();
        assert.equal(await token.balanceOf(investor.address), parseUnits(tokens, 18));
        assert.equal(await campaign.tokensClaimed(investor.address), true);
        assert.equal(await campaign.contributions(investor.address), contribution, "retain original contribution history");
        const event = campaign.interface.parseLog(receipt.logs.find((log) => log.address.toLowerCase() === address.toLowerCase()));
        assert.equal(event.name, "TokensClaimed");
        assert.equal(event.args.contributor, investor.address);
        assert.equal(event.args.amount, parseUnits(tokens, 18));
        await assert.rejects(campaign.connect(investor).claimTokens.staticCall(), revertsWith("AlreadyClaimed"));
      }
      assert.equal(await token.balanceOf(address), 0n);
      assert.equal(await campaign.claimedContributions(), parseEther("1"));
      assert.equal(await campaign.totalTokensClaimed(), parseUnits("10000", 18));
    });

    await t.test("rejects contributions at and after the deadline while below goal", async () => {
      const expired = await new ContractFactory(artifacts.campaign.abi, artifacts.campaign.evm.bytecode.object, issuer)
        .deploy(await token.getAddress(), parseEther("1"), deadline, parseUnits("10000", 18));
      await expired.waitForDeployment();
      await (await token.approve(await expired.getAddress(), parseUnits("10000", 18))).wait();
      await (await expired.activate()).wait();
      await (await expired.connect(alice).contribute({ value: parseEther("0.2") })).wait();
      for (const timestamp of [Number(deadline), Number(deadline) + 1]) {
        await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [timestamp] });
        await connection.provider.request({ method: "evm_mine", params: [] });
        await assert.rejects(expired.connect(bob).contribute.staticCall({ value: 1n }), revertsWith("DeadlinePassed"));
      }
      assert.equal(await expired.totalRaised(), parseEther("0.2"));
      assert.equal(await expired.contributions(bob.address), 0n);
      assert.equal(await provider.getBalance(await expired.getAddress()), parseEther("0.2"));
    });
  } finally {
    provider.destroy();
    await connection.close();
  }
});
