import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, ContractFactory, ZeroAddress, ZeroHash, parseEther, parseUnits } from "ethers";

const require = createRequire(import.meta.url);
let compiled;

function compile() {
  if (compiled) return compiled;
  const sources = Object.fromEntries(["funding_campaign.sol", "asset_token.sol"].map((name) =>
    [name, { content: readFileSync(new URL(`../../smart_contracts/${name}`, import.meta.url), "utf8") }]));
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
    token: output.contracts["asset_token.sol"].AssetToken
  };
  return compiled;
}

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

test("Checkpoint 3: multiple contributors and funding cap", async (t) => {
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
