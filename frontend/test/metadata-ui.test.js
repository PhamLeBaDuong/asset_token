import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as ethers from "ethers";
import * as contracts from "../src/contracts.js";
import * as integrity from "../src/metadata-integrity.js";
import { assetRecord } from "../src/asset-record.js";
import { metadataState, rememberMetadata } from "../src/metadata-state.js";
import { assetRoute } from "../src/database-api.js";
import { mountFundingUI } from "../src/funding-ui.js";
import { mountNavigation } from "../src/navigation.js";
import { mountDemoUI } from "../src/demo-wallet.js";

const factory = "0x" + "1".repeat(40), token = "0x" + "2".repeat(40), issuer = "0x" + "3".repeat(40);
const fields = {
  tokenName: "Coffee Token", tokenSymbol: "COF", initialSupply: "100000",
  assetId: "smthh", assetName: "Coffee", assetType: "Business", valuation: "500000",
  currency: "USD", metadataURI: "urn:asset:smthh"
};
function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

// Execute the real UI handlers with a small DOM and wallet/RPC adapter. This
// covers state transitions that pure hashing and contract tests cannot cover.
function harness(storage = memoryStorage(), formFields = fields) {
  const elements = new Map();
  function element() {
    return { value: "", textContent: "", hidden: false, className: "", children: [], listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; }
    };
  }
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, element());
  const events = {};
  const base = {
    address: ethers.getAddress(token), factoryAddress: ethers.getAddress(factory), issuer: ethers.getAddress(issuer),
    name: formFields.tokenName, symbol: formFields.tokenSymbol, decimals: 18n, chainId: 31337n,
    supply: ethers.parseUnits("100000", 18), balance: ethers.parseUnits("100000", 18),
    connectedWallet: ethers.getAddress(issuer), connectedBalance: ethers.parseUnits("100000", 18), factoryBalance: 0n,
    readBlock: 2, creationBlock: 2, transactionHash: "0x" + "4".repeat(64), blockHash: "0x" + "5".repeat(64),
    asset: { assetId: formFields.assetId, assetName: formFields.assetName, assetType: formFields.assetType, valuation: BigInt(formFields.valuation),
      currency: formFields.currency, metadataURI: formFields.metadataURI, documentHash: ethers.ZeroHash, tokenizedAt: 1700000000n, active: true }
  };
  let sentArgs;
  class WalletContract {
    async createAssetToken(...args) {
      sentArgs = args;
      base.asset.documentHash = args[9];
      return { hash: base.transactionHash, wait: async () => ({ hash: base.transactionHash, blockNumber: 2 }) };
    }
  }
  const provider = { getCode: async () => "0x1234", getNetwork: async () => ({ chainId: 31337n }) };
  const signer = { getAddress: async () => ethers.getAddress(issuer) };
  const context = vm.createContext({
    ...ethers, ...contracts, ...integrity, Contract: WalletContract, assetRecord, metadataState, rememberMetadata, assetRoute, mountFundingUI, mountNavigation, mountDemoUI,
    createdEvent: () => ({ event: { args: { tokenAddress: token } } }),
    readToken: async () => ({ ...base }),
    readTransferHistory: async () => ({ entries: [], fromBlock: 2, toBlock: 2, nextToBlock: null }),
    fetchAssetRecord: async () => { throw new Error("No saved record"); },
    document: { getElementById: (id) => elements.get(id), createElement: element, querySelectorAll: () => [] },
    window: { localStorage: storage, location: { pathname: "/", search: "" },
      history: { replaceState() {}, pushState() {} }, addEventListener() {},
      ethereum: { request: async () => "0x7a69", on: (event, handler) => { events[event] = handler; } } },
    FormData: class { constructor() { return Object.entries(formFields); } },
    setTimeout, mockProvider: provider, mockSigner: signer
  });
  const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replaceAll("import.meta.env", JSON.stringify({ VITE_FACTORY_ADDRESS: factory, VITE_CHAIN_ID: "31337" }));
  vm.runInContext(source, context);
  function connect() { vm.runInContext("provider = mockProvider; signer = mockSigner;", context); }
  async function submit(id) {
    elements.get(id).onsubmit({ preventDefault() {}, target: elements.get(id) });
    for (let i = 0; i < 100 && vm.runInContext("busy", context); i++) await new Promise(setImmediate);
    assert.equal(vm.runInContext("busy", context), false);
  }
  return { elements, events, base, context, storage, connect, submit, sentArgs: () => sentArgs };
}

test("UI creation immediately verifies the exact document sent to the wallet", async () => {
  const ui = harness();
  ui.connect();
  ui.elements.get("creation-description").value = "Coffee shop";
  ui.elements.get("creation-metadata").value = '{"location":"Indianapolis","note":"café"}';
  await ui.submit("create-form");
  assert.equal(ui.sentArgs()[9], integrity.creationMetadata(fields, "Coffee shop", '{"location":"Indianapolis","note":"café"}').hash);
  assert.equal(ui.elements.get("asset-description").value, "Coffee shop");
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
});

test("UI refresh, wallet reset, and page reload preserve the created document", async () => {
  const ui = harness();
  ui.connect();
  ui.elements.get("creation-description").value = "Coffee shop";
  ui.elements.get("creation-metadata").value = '{"location":"Indianapolis"}';
  await ui.submit("create-form");
  await ui.submit("lookup-form");
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
  assert.equal(ui.elements.get("asset-description").value, "Coffee shop");
  ui.events.accountsChanged();
  ui.connect();
  await ui.submit("lookup-form");
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
  const reloaded = harness(ui.storage);
  reloaded.base.asset.documentHash = ui.base.asset.documentHash;
  reloaded.connect();
  await reloaded.submit("lookup-form");
  assert.equal(reloaded.elements.get("asset-description").value, "Coffee shop");
  assert.match(reloaded.elements.get("integrity-status").textContent, /^Verified/);
});

test("UI missing document is unverified, while an actual edit fails integrity", async () => {
  const ui = harness();
  ui.base.asset.documentHash = integrity.creationMetadata(fields, "Coffee shop", "{}").hash;
  ui.connect();
  await ui.submit("lookup-form");
  assert.match(ui.elements.get("integrity-status").textContent, /^Metadata not loaded/);
  assert.equal(ui.elements.get("integrity-status").textContent.includes("Integrity check failed"), false);
  ui.elements.get("asset-description").value = "Coffee shop";
  ui.elements.get("asset-description").listeners.input();
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
  ui.elements.get("asset-description").value = "Changed shop";
  ui.elements.get("asset-description").listeners.input();
  assert.match(ui.elements.get("integrity-status").textContent, /^Integrity check failed/);
});

test("local metadata is scoped to token and chain and never hides changed DB content", () => {
  const ui = harness();
  const created = integrity.creationMetadata(fields, "Coffee shop", "{}").record;
  metadataState({ ...ui.base, creationDocument: created }, undefined, {}, ui.storage);
  assert.equal(metadataState({ ...ui.base, chainId: 1n }, undefined, {}, ui.storage).data.metadataAvailable, false);
  assert.equal(metadataState({ ...ui.base, address: factory }, undefined, {}, ui.storage).data.metadataAvailable, false);
  const changed = { ...created, description: "Tampered" };
  const result = metadataState({ ...ui.base, database: changed }, undefined, {}, ui.storage);
  assert.equal(result.description, "Tampered");
  assert.equal(result.data.database, changed);
});

test("UI recovers blank original metadata only when its hash matches", async () => {
  const ui = harness();
  ui.base.asset.documentHash = integrity.creationMetadata(fields, "", "{}").hash;
  ui.connect();
  await ui.submit("lookup-form");
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
  assert.equal(ui.elements.get("asset-description").value, "");
  const reloaded = harness(ui.storage);
  reloaded.base.asset.documentHash = ui.base.asset.documentHash;
  reloaded.connect();
  await reloaded.submit("lookup-form");
  assert.match(reloaded.elements.get("integrity-status").textContent, /^Verified/);
});

test("UI recovers an older token from the unchanged creation form", async () => {
  const ui = harness();
  ui.elements.get("creation-description").value = "Coffee shop";
  ui.elements.get("creation-metadata").value = '{"location":"Indianapolis"}';
  ui.base.asset.documentHash = integrity.creationMetadata(fields, "Coffee shop", '{"location":"Indianapolis"}').hash;
  ui.connect();
  await ui.submit("lookup-form");
  assert.match(ui.elements.get("integrity-status").textContent, /^Verified/);
  assert.equal(ui.elements.get("asset-description").value, "Coffee shop");
});

test("confirmed creation retains its metadata when the follow-up RPC read fails", async () => {
  const ui = harness();
  ui.connect();
  ui.elements.get("creation-description").value = "Coffee shop";
  vm.runInContext('readToken = async () => { throw new Error("RPC unavailable"); };', ui.context);
  await ui.submit("create-form");
  assert.match(ui.elements.get("status").textContent, /Creation succeeded/);
  const reloaded = harness(ui.storage);
  reloaded.base.asset.documentHash = ui.base.asset.documentHash;
  reloaded.connect();
  await reloaded.submit("lookup-form");
  assert.match(reloaded.elements.get("integrity-status").textContent, /^Verified/);
  assert.equal(reloaded.elements.get("asset-description").value, "Coffee shop");
});

test("reported smthh fields reproduce the mismatch, while new blank creation commits the correct hash", async () => {
  const reported = {
    tokenName: "SMTHH", tokenSymbol: "SMTHH", initialSupply: "100000",
    assetId: "smthh", assetName: "smthh", assetType: "Bla", valuation: "129000",
    currency: "USD", metadataURI: "https://"
  };
  const stored = "0x59d02cc439096a344022c0af2e154666a35a8cf27bdaaf5ad60bec1caf4c23ba";
  const expected = "0x1c66169df471f35914428d6994d708ebaaac4df77bd147b2ab4926b2a79b1965";
  const original = integrity.creationMetadata(reported, "", "{}");
  assert.equal(original.hash, expected);
  assert.equal(integrity.verifyMetadata(original.record, stored).status, "failed");
  const existing = harness(memoryStorage(), reported);
  existing.base.asset.documentHash = stored;
  existing.connect();
  await existing.submit("lookup-form");
  assert.match(existing.elements.get("integrity-status").textContent, /^Metadata not loaded/);
  assert.equal(existing.elements.get("integrity-canonical").hidden, true);
  existing.elements.get("asset-metadata").value = "{}";
  existing.elements.get("asset-metadata").listeners.input();
  assert.match(existing.elements.get("integrity-status").textContent, /^Integrity check failed/);
  const fresh = harness(memoryStorage(), reported);
  fresh.connect();
  await fresh.submit("create-form");
  assert.equal(fresh.sentArgs()[9], expected);
  assert.match(fresh.elements.get("integrity-status").textContent, /^Verified/);
  assert.equal(fresh.elements.get("integrity-canonical").hidden, false);
  await fresh.submit("lookup-form");
  assert.match(fresh.elements.get("integrity-status").textContent, /^Verified/);
});
