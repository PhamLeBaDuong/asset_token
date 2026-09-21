import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, Contract, ContractFactory, ZeroAddress, ZeroHash, id } from "ethers";
import { creationArgs, createdEvent, readToken, checkMintRejection, factoryABI, tokenABI } from "../src/contracts.js";

const require = createRequire(import.meta.url);
const sample = {
  tokenName: "Building Token", tokenSymbol: "BLDG", initialSupply: "1000",
  assetId: "BUILDING-001", assetName: "Test building", assetType: "Real estate",
  valuation: "250000", currency: "USD", metadataURI: "ipfs://example", documentHash: id("document")
};

test("input conversion preserves integers and rejects invalid inputs", () => {
  assert.equal(creationArgs(sample)[2], 1000n);
  assert.equal(creationArgs({ ...sample, initialSupply: "9007199254740993" })[2], 9007199254740993n);
  assert.equal(creationArgs({ ...sample, documentHash: "" })[9], ZeroHash);
  for (const initialSupply of ["1.5", "-1", "1e18", "9".repeat(80)]) {
    assert.throws(() => creationArgs({ ...sample, initialSupply }));
  }
  assert.throws(() => creationArgs({ ...sample, documentHash: "0x1234" }));
  assert.throws(() => creationArgs({ ...sample, assetId: " " }));
});

test("factory creation, chain reads, duplicate rejection, and fixed supply", async () => {
  const sources = Object.fromEntries(["asset_factory.sol", "asset_token.sol"].map((name) =>
    [name, { content: readFileSync(new URL(`../../smart_contracts/${name}`, import.meta.url), "utf8") }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
  }), { import: (path) => {
    try { return { contents: readFileSync(require.resolve(path), "utf8") }; }
    catch { return { error: `Import not found: ${path}` }; }
  } }));
  assert.deepEqual((output.errors || []).filter((error) => error.severity === "error"), []);
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0), outsider = await provider.getSigner(1);
    const artifact = output.contracts["asset_factory.sol"].AssetTokenFactory;
    const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, issuer).deploy();
    await deployed.waitForDeployment();
    const address = await deployed.getAddress();
    const factory = new Contract(address, factoryABI, issuer);
    const receipt = await (await factory.createAssetToken(...creationArgs(sample))).wait();
    const { event } = createdEvent(receipt, address);
    assert.equal(event.args.issuer, issuer.address);
    assert.notEqual(event.args.tokenAddress, ZeroAddress);
    assert.notEqual(await provider.getCode(event.args.tokenAddress), "0x");
    const data = await readToken(provider, address, sample.assetId);
    assert.equal(data.address, event.args.tokenAddress);
    assert.equal(data.issuer, issuer.address);
    assert.equal(data.supply, 1000n * 10n ** 18n);
    assert.equal(data.balance, data.supply);
    assert.equal(data.factoryBalance, 0n);
    assert.equal(data.name, sample.tokenName);
    assert.equal(data.symbol, sample.tokenSymbol);
    for (const key of ["assetId", "assetName", "assetType", "currency", "metadataURI", "documentHash"]) {
      assert.equal(data.asset[key], sample[key]);
    }
    assert.equal(data.asset.valuation, 250000n);
    assert.equal(data.asset.active, true);
    assert.equal(data.asset.tokenizedAt, BigInt((await provider.getBlock(receipt.blockNumber)).timestamp));
    assert.equal(data.transactionHash, receipt.hash);
    const record = await factory.assets(0);
    assert.equal(record.tokenAddress, data.address);
    assert.equal(record.issuer, issuer.address);
    const token = new Contract(data.address, tokenABI, provider);
    assert.equal(await token.hasRole(ZeroHash, issuer.address), true);
    assert.equal(await token.hasRole(id("ADMIN_ROLE"), issuer.address), true);
    assert.equal(await token.hasRole(id("ADMIN_ROLE"), outsider.address), false);
    for (const caller of [issuer, outsider]) {
      await assert.rejects(factory.connect(caller).createAssetToken.staticCall(...creationArgs(sample)), /Asset already tokenized/);
      assert.equal(await checkMintRejection(provider, data.address, caller.address), true);
    }
    assert.equal(await factory.tokenByAssetId(sample.assetId), data.address);
    assert.equal(await token.totalSupply(), data.supply);
    await assert.rejects(factory.assets(1));
    await assert.rejects(readToken(provider, address, "MISSING"), /No token/);
    await (await factory.connect(outsider).createAssetToken(...creationArgs({ ...sample, assetId: "BUILDING-002", initialSupply: "25" }))).wait();
    const second = await readToken(provider, address, "BUILDING-002");
    assert.notEqual(second.address, data.address);
    assert.equal(second.issuer, outsider.address);
    assert.equal(second.balance, 25n * 10n ** 18n);
    assert.equal(await token.totalSupply(), data.supply);
  } finally { provider.destroy(); await connection.close(); }
});

test("mint check does not mistake RPC failure for contract rejection", async () => {
  const provider = { getCode: async () => "0x1234", call: async () => { throw new Error("RPC disconnected"); } };
  await assert.rejects(checkMintRejection(provider, ZeroAddress, ZeroAddress), /RPC disconnected/);
});
