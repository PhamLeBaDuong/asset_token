import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, ContractFactory, parseEther, parseUnits } from "ethers";
import { creationArgs, readToken } from "../src/contracts.js";
import { mountFundingUI } from "../src/funding-ui.js";
import { fundingArtifact, campaignTerms, paymentUnits, matchesCampaignCode, readCampaign, savedCampaigns, rememberCampaign } from "../src/funding.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("funding inputs preserve precision and browser discovery is scoped to token and chain", () => {
  const asset = { address: "0x" + "1".repeat(40), decimals: 18, connectedBalance: parseUnits("10000", 18), chainId: 31337n };
  const address = "0x" + "2".repeat(40);
  assert.equal(paymentUnits("0.000000000000000001"), 1n);
  for (const amount of ["0", "-1", "1e3", "0.0000000000000000001", "9".repeat(80)]) assert.throws(() => paymentUnits(amount));
  const terms = campaignTerms(asset, { goal: "0.01", offered: "10000", deadline: "2030-01-01T00:00:00Z" }, 1n);
  assert.equal(terms[1], parseEther("0.01"));
  assert.equal(terms[3], parseUnits("10000", 18));
  assert.throws(() => campaignTerms(asset, { goal: "1", offered: "10001", deadline: "2030-01-01T00:00:00Z" }, 1n));
  assert.throws(() => campaignTerms(asset, { goal: "1", offered: "1", deadline: "invalid" }, 1n));
  assert.throws(() => campaignTerms(asset, { goal: "1", offered: "1", deadline: "2030-01-01T00:00:00Z" }, terms[2]));
  const storage = memoryStorage();
  rememberCampaign(storage, asset, address);
  rememberCampaign(storage, asset, address);
  assert.deepEqual(savedCampaigns(storage, asset), [address]);
  assert.deepEqual(savedCampaigns(storage, { ...asset, chainId: 1n }), []);
  assert.deepEqual(savedCampaigns(storage, { ...asset, address }), []);
  assert.deepEqual(savedCampaigns({ getItem: () => "malformed" }, asset), []);
  assert.doesNotThrow(() => rememberCampaign({ getItem() { throw Error(); }, setItem() { throw Error(); } }, asset, address));
  assert.equal(matchesCampaignCode("0x"), false);
  assert.equal(matchesCampaignCode("0x" + "ff".repeat((fundingArtifact.runtime.length - 2) / 2)), false);
  const ranges = Object.values(fundingArtifact.immutableReferences).find((entries) => entries.length > 1);
  const changedSlot = 2 + ranges[0].start * 2;
  const inconsistent = fundingArtifact.runtime.slice(0, changedSlot) + "ff" + fundingArtifact.runtime.slice(changedSlot + 2);
  assert.equal(matchesCampaignCode(inconsistent), false, "reject inconsistent copies of a constructor immutable");
});

test("funding UI creates and runs successful and failed rounds on a registered asset", async (t) => {
  const require = createRequire(import.meta.url);
  const sources = Object.fromEntries(["asset_factory.sol", "asset_token.sol"].map((name) => [name, {
    content: readFileSync(new URL(`../../smart_contracts/${name}`, import.meta.url), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
  }), { import: (path) => ({ contents: readFileSync(require.resolve(path), "utf8") }) }));
  assert.deepEqual((output.errors || []).filter((error) => error.severity === "error"), []);
  const artifact = output.contracts["asset_factory.sol"].AssetTokenFactory;
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const investors = await Promise.all([1, 2, 3].map((index) => provider.getSigner(index)));
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, issuer).deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    const assetId = "coffee-funding-ui";
    await (await factory.createAssetToken(...creationArgs({
      tokenName: "Coffee", tokenSymbol: "COF", initialSupply: "100000", assetId,
      assetName: "Coffee business", assetType: "Business", valuation: "500000", currency: "USD", metadataURI: "urn:coffee:ui"
    }))).wait();
    const elements = new Map();
    function element() {
      return { value: "", textContent: "", hidden: false, children: [], listeners: {},
        addEventListener(type, handler) { this.listeners[type] = handler; },
        append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = items; }
      };
    }
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, element());
    const document = { getElementById: (id) => elements.get(id), createElement: element };
    const $ = (id) => elements.get(id);
    const storage = memoryStorage();
    let signer = issuer, asset, pending, error, status;
    const ui = mountFundingUI({
      document, storage,
      getContext: async () => ({ provider, signer, factory: factoryAddress }),
      setStatus: (value) => { status = value; },
      run: (action) => {
        error = undefined;
        pending = Promise.resolve().then(action).catch((reason) => { error = reason; });
        return pending;
      },
      refreshAsset: async (ctx, data, minimumBlock) => {
        asset = await readToken(provider, factoryAddress, data.asset.assetId, undefined, await ctx.signer.getAddress(), minimumBlock);
        ui.setAsset(asset);
      }
    });
    async function wallet(next) {
      signer = next;
      ui.reset();
      asset = await readToken(provider, factoryAddress, assetId, undefined, next.address);
      ui.setAsset(asset);
    }
    async function submit(id, expectedError) {
      $(id).onsubmit({ preventDefault() {} });
      await pending;
      if (expectedError) assert.match(error?.message || "", expectedError);
      else assert.ifError(error);
    }
    async function click(name) {
      await $(`campaign-${name}`).onclick();
      assert.ifError(error);
    }
    async function load(address) {
      $("campaign-address").value = address;
      await submit("campaign-load-form");
    }
    async function create() {
      $("campaign-goal").value = "0.01";
      $("campaign-offered").value = "10000";
      const deadline = BigInt((await provider.getBlock("latest")).timestamp) + 86400n;
      $("campaign-deadline").value = new Date(Number(deadline) * 1000).toISOString();
      await submit("campaign-create-form");
      return { address: $("campaign-address").value, deadline };
    }
    await wallet(issuer);
    let success;
    await t.test("issuer deploys through the UI, then approves and escrows tokens", async () => {
      success = await create();
      assert.match(status, /Campaign created/);
      assert.equal($("campaign-approve").hidden, false);
      assert.equal($("campaign-activate").hidden, true);
      assert.equal(matchesCampaignCode(await provider.getCode(success.address)), true);
      await click("approve");
      assert.equal($("campaign-activate").hidden, false);
      await click("activate");
      assert.equal(asset.connectedBalance, parseUnits("90000", 18));
      assert.equal($("campaign-contribute-form").hidden, false);
      assert.equal($("campaign-settle").hidden, true);
      assert.deepEqual(savedCampaigns(storage, asset), [success.address]);
    });

    await t.test("investors load a shared address and contribute through the UI", async () => {
      for (const [index, amount] of ["0.002", "0.003", "0.005"].entries()) {
        await wallet(investors[index]);
        assert.equal($("campaign-create-form").hidden, true);
        await load(success.address);
        if (index === 2) {
          $("campaign-amount").value = "0.006";
          await submit("campaign-contribute-form", /exceeds the remaining/);
        }
        $("campaign-amount").value = amount;
        await submit("campaign-contribute-form");
        assert.equal($("campaign-amount").value, "");
      }
      assert.equal($("campaign-progress").value, 100);
      assert.equal($("campaign-contribute-form").hidden, true);
      assert.equal($("campaign-settle").hidden, true, "investor cannot settle");
    });

    await t.test("issuer settles and investors claim the correct allocations through the UI", async () => {
      await wallet(issuer);
      await load(success.address);
      assert.equal($("campaign-settle").hidden, false);
      await click("settle");
      assert.equal($("campaign-settle").hidden, true);
      for (const [index, tokens] of ["2000", "3000", "5000"].entries()) {
        await wallet(investors[index]);
        await load(success.address);
        assert.equal($("campaign-claimTokens").hidden, false);
        assert.equal($("campaign-claimRefund").hidden, true);
        await click("claimTokens");
        assert.equal(asset.connectedBalance, parseUnits(tokens, 18));
        assert.equal($("campaign-claimTokens").hidden, true);
      }
    });

    let failed;
    await t.test("second round expires below goal and exposes permissionless finalization", async () => {
      await wallet(issuer);
      failed = await create();
      await click("approve");
      await click("activate");
      for (const [index, amount] of ["0.002", "0.0015"].entries()) {
        await wallet(investors[index]);
        await load(failed.address);
        $("campaign-amount").value = amount;
        await submit("campaign-contribute-form");
      }
      await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(failed.deadline)] });
      await connection.provider.request({ method: "evm_mine", params: [] });
      await load(failed.address);
      assert.equal($("campaign-finalize").hidden, false);
      assert.equal($("campaign-contribute-form").hidden, true);
      await click("finalize");
      assert.equal($("campaign-claimRefund").hidden, false);
      assert.equal($("campaign-claimTokens").hidden, true);
    });

    await t.test("issuer retrieves escrow and contributors independently claim refunds through the UI", async () => {
      await wallet(issuer);
      await load(failed.address);
      assert.equal($("campaign-settle").hidden, true);
      assert.equal($("campaign-reclaimFailedTokens").hidden, false);
      await click("reclaimFailedTokens");
      assert.equal($("campaign-reclaimFailedTokens").hidden, true);
      for (const investor of investors.slice(0, 2)) {
        await wallet(investor);
        await load(failed.address);
        assert.equal($("campaign-claimRefund").hidden, false);
        await click("claimRefund");
        assert.equal($("campaign-claimRefund").hidden, true);
      }
      assert.equal(await provider.getBalance(failed.address), 0n);
    });

    await t.test("lookup rejects other contracts, other asset tokens, and mismatched issuers", async () => {
      $("campaign-address").value = asset.address;
      await submit("campaign-load-form", /does not contain/);
      assert.equal($("campaign-claimRefund").hidden, true);
      await assert.rejects(readCampaign(provider, success.address, { ...asset, address: factoryAddress }, signer.address), /different asset/);
      const impostor = await new ContractFactory(fundingArtifact.abi, fundingArtifact.bytecode, investors[0])
        .deploy(asset.address, parseEther("1"), BigInt((await provider.getBlock("latest")).timestamp) + 86400n, 1n);
      await impostor.waitForDeployment();
      await assert.rejects(readCampaign(provider, await impostor.getAddress(), asset, signer.address), /issuer does not match/);
      await load(success.address);
    });

    await t.test("editing the campaign address and resetting the wallet clear prior actions", async () => {
      $("campaign-address").listeners.input();
      assert.equal($("campaign-details").children.length, 0);
      assert.equal($("campaign-contribute-form").hidden, true);
      ui.reset();
      assert.equal($("campaign-controls").hidden, true);
      assert.equal($("campaign-address").value, "");
      await submit("campaign-load-form", /Look up an asset/);
    });
  } finally {
    provider.destroy();
    await connection.close();
  }
});
