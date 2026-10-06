import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, Contract, ContractFactory, ZeroAddress, ZeroHash, formatUnits, parseUnits, id } from "ethers";
import { creationArgs, createdEvent, readToken, checkMintRejection, findCreationBlock, factoryABI, tokenABI, transferArgs, readTransferHistory } from "../src/contracts.js";
import { assetRecord } from "../src/asset-record.js";
import { readLinkedToken } from "../src/contracts.js";
import { fetchAssetRecord, assetRoute } from "../src/database-api.js";
import { createApp } from "../../server/src/app.js";
import { once } from "node:events";

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

let factoryArtifact, tokenArtifact;
function compileFactory() {
  if (factoryArtifact) return factoryArtifact;
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
  factoryArtifact = output.contracts["asset_factory.sol"].AssetTokenFactory;
  tokenArtifact = output.contracts["asset_token.sol"].AssetToken;
  return factoryArtifact;
}

test("checkpoint step 1: Alice, Bob, and Carol read the same coffee token", async () => {
  const artifact = compileFactory();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const alice = await provider.getSigner(0);
    const bob = await provider.getSigner(1);
    const carol = await provider.getSigner(2);
    const wallets = [alice, bob, carol];
    assert.equal(new Set(wallets.map((wallet) => wallet.address)).size, 3);

    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, alice).deploy();
    await factory.waitForDeployment();
    const coffee = {
      ...sample, tokenName: "Duong Coffee Token", tokenSymbol: "DCOF",
      initialSupply: "100000", assetId: "coffee-001", assetName: "Duong Coffee",
      assetType: "Business", valuation: "500000"
    };
    const receipt = await (await factory.createAssetToken(...creationArgs(coffee))).wait();
    const tokenAddress = await factory.tokenByAssetId(coffee.assetId);
    const { event } = createdEvent(receipt, await factory.getAddress());
    assert.equal(event.args.issuer, alice.address);
    assert.equal(event.args.tokenAddress, tokenAddress);

    const token = new Contract(tokenAddress, tokenABI, provider);
    const decimals = await token.decimals();
    const supply = parseUnits("100000", decimals);
    assert.equal(await token.totalSupply(), supply);
    assert.equal(await token.symbol(), "DCOF");

    const expected = [supply, 0n, 0n];
    const names = ["Alice (issuer)", "Bob (user)", "Carol (user)"];
    console.log(`Step 1 token: ${tokenAddress}`);
    for (const [index, wallet] of wallets.entries()) {
      // Each account reads the same deployed contract through its own signer.
      const balance = await token.connect(wallet).balanceOf(wallet.address);
      assert.equal(balance, expected[index]);
      console.log(`${names[index]}: ${wallet.address} | ${formatUnits(balance, decimals)} DCOF`);
    }
  } finally { provider.destroy(); await connection.close(); }
});

test("checkpoint step 2: Alice transfers to Bob, then Bob transfers to Carol", async () => {
  const artifact = compileFactory();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const alice = await provider.getSigner(0);
    const bob = await provider.getSigner(1);
    const carol = await provider.getSigner(2);
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, alice).deploy();
    await factory.waitForDeployment();
    const coffee = {
      ...sample, tokenName: "Duong Coffee Token", tokenSymbol: "DCOF",
      initialSupply: "100000", assetId: "coffee-001", assetName: "Duong Coffee",
      assetType: "Business", valuation: "500000"
    };
    const creation = await (await factory.createAssetToken(...creationArgs(coffee))).wait();
    const factoryAddress = await factory.getAddress();
    const data = await readToken(provider, factoryAddress, coffee.assetId, creation, alice.address);
    assert.equal(data.connectedWallet, alice.address);
    assert.equal(data.connectedBalance, parseUnits("100000", data.decimals));
    const token = new Contract(data.address, tokenABI, alice);
    const wallets = [alice, bob, carol];
    async function checkBalances(expected, receipt) {
      const balances = await Promise.all(wallets.map((wallet) =>
        token.balanceOf(wallet.address, { blockTag: receipt.blockNumber })));
      assert.deepEqual(balances, expected.map((amount) => parseUnits(amount, data.decimals)));
      assert.equal(await token.totalSupply(), parseUnits("100000", data.decimals));
    }

    const first = await (await token.transfer(...transferArgs(bob.address, "10000", data.decimals))).wait();
    await checkBalances(["90000", "10000", "0"], first);
    const bobView = await readToken(provider, factoryAddress, coffee.assetId, undefined, bob.address, first.blockNumber);
    assert.equal(bobView.connectedBalance, parseUnits("10000", data.decimals));
    assert.equal(bobView.balance, parseUnits("90000", data.decimals));
    assert.ok(bobView.readBlock >= first.blockNumber);

    const second = await (await token.connect(bob).transfer(...transferArgs(carol.address, "2500", data.decimals))).wait();
    await checkBalances(["90000", "7500", "2500"], second);
    const refreshedBob = await readToken(provider, factoryAddress, coffee.assetId, undefined, bob.address, second.blockNumber);
    const carolView = await readToken(provider, factoryAddress, coffee.assetId, undefined, carol.address, second.blockNumber);
    assert.equal(refreshedBob.connectedBalance, parseUnits("7500", data.decimals));
    assert.equal(carolView.connectedBalance, parseUnits("2500", data.decimals));
    assert.equal(carolView.transactionHash, creation.hash, "creation transaction stays distinct from transfer");
    console.log("Step 2 verified: Alice 90,000 | Bob 7,500 | Carol 2,500 DCOF; supply 100,000.");
  } finally { provider.destroy(); await connection.close(); }
});

test("checkpoint step 3: invalid transfers and ERC-20 authorization", async (t) => {
  const artifact = compileFactory();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const alice = await provider.getSigner(0);
    const bob = await provider.getSigner(1);
    const carol = await provider.getSigner(2);
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, alice).deploy();
    await factory.waitForDeployment();
    const coffee = {
      ...sample, tokenName: "Duong Coffee Token", tokenSymbol: "DCOF",
      initialSupply: "100000", assetId: "coffee-001", assetName: "Duong Coffee",
      assetType: "Business", valuation: "500000"
    };
    await (await factory.createAssetToken(...creationArgs(coffee))).wait();
    // Use the compiler ABI here so ethers can decode OpenZeppelin custom errors.
    const token = new Contract(await factory.tokenByAssetId(coffee.assetId), tokenArtifact.abi, alice);
    const decimals = await token.decimals();
    const units = (amount) => parseUnits(amount, decimals);
    await (await token.transfer(bob.address, units("10000"))).wait();
    await (await token.connect(bob).transfer(carol.address, units("2500"))).wait();

    async function state() {
      const [aliceBalance, bobBalance, carolBalance, supply, allowance] = await Promise.all([
        token.balanceOf(alice.address), token.balanceOf(bob.address), token.balanceOf(carol.address),
        token.totalSupply(), token.allowance(bob.address, carol.address)
      ]);
      return { aliceBalance, bobBalance, carolBalance, supply, allowance };
    }
    const baseline = {
      aliceBalance: units("90000"), bobBalance: units("7500"), carolBalance: units("2500"),
      supply: units("100000"), allowance: 0n
    };
    assert.deepEqual(await state(), baseline);

    function expectedRevert(name, args) {
      return (error) => {
        assert.equal(error.code, "CALL_EXCEPTION", "must be a contract revert, not an RPC failure");
        assert.equal(error.revert?.name, name);
        assert.deepEqual(Array.from(error.revert.args), args);
        return true;
      };
    }

    await t.test("Bob cannot transfer 10,000 when he owns 7,500", async () => {
      await assert.rejects(
        token.connect(bob).transfer.staticCall(carol.address, units("10000")),
        expectedRevert("ERC20InsufficientBalance", [bob.address, units("7500"), units("10000")])
      );
      assert.deepEqual(await state(), baseline, "rejected transfer must leave balances, supply, and allowance unchanged");
      console.log("Step 3: Bob's 10,000 DCOF transfer reverted (balance 7,500); token state unchanged.");
    });

    await t.test("Carol cannot take 5,000 from Bob without allowance", async () => {
      await assert.rejects(
        token.connect(carol).transferFrom.staticCall(bob.address, carol.address, units("5000")),
        expectedRevert("ERC20InsufficientAllowance", [carol.address, 0n, units("5000")])
      );
      assert.deepEqual(await state(), baseline, "unauthorized transfer must leave balances, supply, and allowance unchanged");
      console.log("Step 3: Carol's unauthorized transferFrom reverted (allowance 0); token state unchanged.");
    });

    await t.test("Bob's approval lets Carol transfer only the approved 1,000", async () => {
      await (await token.connect(bob).approve(carol.address, units("1000"))).wait();
      assert.deepEqual(await state(), { ...baseline, allowance: units("1000") });
      // Approval does not authorize a larger transfer, even though Bob has enough tokens.
      await assert.rejects(
        token.connect(carol).transferFrom.staticCall(bob.address, carol.address, units("5000")),
        expectedRevert("ERC20InsufficientAllowance", [carol.address, units("1000"), units("5000")])
      );
      assert.deepEqual(await state(), { ...baseline, allowance: units("1000") });
      await (await token.connect(carol).transferFrom(bob.address, carol.address, units("1000"))).wait();
      const authorized = { ...baseline, bobBalance: units("6500"), carolBalance: units("3500") };
      assert.deepEqual(await state(), authorized, "transfer must consume the allowance and preserve total supply");
      await assert.rejects(
        token.connect(carol).transferFrom.staticCall(bob.address, carol.address, units("1")),
        expectedRevert("ERC20InsufficientAllowance", [carol.address, 0n, units("1")])
      );
      assert.deepEqual(await state(), authorized);
      console.log("Step 3: approved 1,000 DCOF transfer succeeded; Bob 6,500, Carol 3,500, allowance 0, supply 100,000.");
    });
  } finally { provider.destroy(); await connection.close(); }
});

test("checkpoint steps 4 and 5: Transfer logs and deployment-specific database export", async (t) => {
  const artifact = compileFactory();
  const connection = await network.connect();
  let limitRanges = false, disconnected = false, logRequests = 0;
  const rpc = { request: async (request) => {
    if (request.method === "eth_getLogs") {
      logRequests++;
      if (disconnected) throw Object.assign(new Error("RPC disconnected"), { code: -32000 });
      const filter = request.params[0];
      if (limitRanges && filter.fromBlock !== filter.toBlock) {
        throw Object.assign(new Error("block range limited to one block"), { code: -32005 });
      }
    }
    return connection.provider.request(request);
  } };
  const provider = new BrowserProvider(rpc, undefined, { cacheTimeout: -1 });
  try {
    const alice = await provider.getSigner(0), bob = await provider.getSigner(1), carol = await provider.getSigner(2);
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, alice).deploy();
    await factory.waitForDeployment();
    const coffee = {
      ...sample, tokenName: "Duong Coffee Token", tokenSymbol: "DCOF", initialSupply: "100000",
      assetId: "coffee-001", assetName: "Duong Coffee", assetType: "Business", valuation: "9007199254740993"
    };
    const creation = await (await factory.createAssetToken(...creationArgs(coffee))).wait();
    const tokenAddress = await factory.tokenByAssetId(coffee.assetId);
    const token = new Contract(tokenAddress, tokenABI, alice);
    const first = await (await token.transfer(bob.address, parseUnits("10000", 18))).wait();
    const second = await (await token.connect(bob).transfer(carol.address, parseUnits("2500", 18))).wait();
    const expectedHashes = [second.hash, first.hash, creation.hash];

    await t.test("history includes mint and both transfers with the correct addresses and amounts", async () => {
      const page = await readTransferHistory(provider, tokenAddress, creation.blockNumber, second.blockNumber);
      assert.deepEqual(page.entries.map((entry) => entry.transactionHash), expectedHashes);
      assert.deepEqual(page.entries.map(({ from, to, value }) => [from, to, value]), [
        [bob.address, carol.address, parseUnits("2500", 18)],
        [alice.address, bob.address, parseUnits("10000", 18)],
        [ZeroAddress, alice.address, parseUnits("100000", 18)]
      ]);
      assert.equal(page.nextToBlock, null);
    });
    await t.test("older block pages neither skip nor duplicate transfers", async () => {
      const entries = [];
      let cursor = second.blockNumber;
      do {
        const page = await readTransferHistory(provider, tokenAddress, creation.blockNumber, cursor, 1);
        assert.equal(page.fromBlock, page.toBlock);
        entries.push(...page.entries);
        cursor = page.nextToBlock;
      } while (cursor !== null);
      assert.deepEqual(entries.map((entry) => entry.transactionHash), expectedHashes);
    });
    await t.test("wallet RPC block limits trigger smaller queries without losing events", async () => {
      limitRanges = true;
      logRequests = 0;
      const page = await readTransferHistory(provider, tokenAddress, creation.blockNumber, second.blockNumber);
      assert.deepEqual(page.entries.map((entry) => entry.transactionHash), expectedHashes);
      assert.ok(logRequests > 1);
      limitRanges = false;
    });
    await t.test("an RPC outage is reported rather than shown as empty history", async () => {
      disconnected = true;
      logRequests = 0;
      await assert.rejects(readTransferHistory(provider, tokenAddress, creation.blockNumber, second.blockNumber), /RPC disconnected/);
      assert.equal(logRequests, 1, "outages must not trigger range splitting");
      disconnected = false;
    });
    await t.test("export uses this deployment and preserves whole-number precision", async () => {
      const data = await readToken(provider, await factory.getAddress(), coffee.assetId, creation, bob.address, second.blockNumber);
      const record = JSON.parse(JSON.stringify(assetRecord(data, "Owner's coffee shop", '{"business":"Coffee","image":"https://example.com/coffee.png"}')));
      assert.equal(record.token_address, tokenAddress.toLowerCase());
      assert.equal(record.issuer_address, alice.address.toLowerCase());
      assert.equal(record.factory_address, (await factory.getAddress()).toLowerCase());
      assert.equal(record.chain_id, (await provider.getNetwork()).chainId.toString());
      assert.equal(record.creation_transaction_hash, creation.hash);
      assert.equal(record.valuation, "9007199254740993");
      assert.equal(record.document_hash, coffee.documentHash);
      assert.equal(record.description, "Owner's coffee shop");
      assert.deepEqual(record.metadata, { business: "Coffee", image: "https://example.com/coffee.png" });
      assert.throws(() => assetRecord(data, "", "[]"), /JSON object/);
      assert.throws(() => assetRecord(data, "", "null"), /JSON object/);
      assert.throws(() => assetRecord(data, "", "{broken"), SyntaxError);
    });
  } finally { provider.destroy(); await connection.close(); }
});

test("checkpoint step 6: API asset record resolves its actual token on the blockchain", async () => {
  const artifact = compileFactory();
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  let api;
  try {
    const alice = await provider.getSigner(0), bob = await provider.getSigner(1);
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, alice).deploy();
    await factory.waitForDeployment();
    const creation = await (await factory.createAssetToken(...creationArgs(sample))).wait();
    const original = await readToken(provider, await factory.getAddress(), sample.assetId, creation, bob.address);
    const stored = assetRecord(original, "Description from PostgreSQL", '{"business":"Coffee"}');
    let queries = 0;
    api = createApp({ query: async (sql, values) => {
      queries++;
      assert.match(sql, /FROM public.assets/);
      assert.deepEqual(values, [sample.assetId, stored.chain_id]);
      return { rows: [stored] };
    } }, () => {});
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    const record = await fetchAssetRecord(sample.assetId, stored.chain_id, (path) => fetch(`http://127.0.0.1:${api.address().port}${path}`));
    const linked = await readLinkedToken(provider, record, bob.address);
    assert.equal(queries, 1);
    assert.equal(linked.address.toLowerCase(), stored.token_address);
    assert.equal(linked.database.description, "Description from PostgreSQL");
    assert.equal(linked.connectedBalance, 0n);
    const token = new Contract(linked.address, tokenABI, alice);
    const transfer = await (await token.transfer(...transferArgs(bob.address, "25", linked.decimals))).wait();
    const refreshed = await readLinkedToken(provider, record, bob.address, transfer.blockNumber);
    assert.equal(refreshed.connectedBalance, parseUnits("25", linked.decimals));
    assert.equal(refreshed.database.token_address, stored.token_address);
    await assert.rejects(readLinkedToken(provider, { ...record, chain_id: "999999" }, bob.address), /Wrong network/);
    await assert.rejects(readLinkedToken(provider, { ...record, token_address: bob.address }, bob.address), /Database token address/);
    await assert.rejects(readLinkedToken(provider, { ...record, issuer_address: bob.address }, bob.address), /deployment details/);
    await assert.rejects(readLinkedToken(provider, { ...record, creation_block: "0" }, bob.address), /deployment details/);
    await assert.rejects(readLinkedToken(provider, { ...record, creation_transaction_hash: ZeroHash }, bob.address), /deployment details/);
  } finally {
    if (api) await new Promise((resolve) => api.close(resolve));
    provider.destroy();
    await connection.close();
  }
});

test("database routes and API failures preserve asset identifiers and useful errors", async () => {
  assert.deepEqual(assetRoute({ pathname: "/assets/coffee-001", search: "?chainId=11155111" }), { assetId: "coffee-001", chainId: "11155111" });
  assert.equal(assetRoute({ pathname: "/assets/coffee%2F001", search: "" }).assetId, "coffee/001");
  assert.equal(assetRoute({ pathname: "/", search: "" }), null);
  assert.equal(assetRoute({ pathname: "/assets/%ZZ", search: "" }), null);
  await assert.rejects(fetchAssetRecord("coffee-001", "1", async () => ({ ok: false, json: async () => ({ error: "Import this asset first" }) })), /Import/);
  await assert.rejects(fetchAssetRecord("coffee-001", "1", async () => ({ json: async () => { throw new Error("HTML response"); } })), /Start the API/);
});

test("transfer input preserves fractional precision and validates recipient and amount", () => {
  const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  assert.deepEqual(transferArgs(recipient, "10000", 18), [recipient, 10000n * 10n ** 18n]);
  assert.equal(transferArgs(recipient, " 2.5 ", 18)[1], 2500000000000000000n);
  assert.equal(transferArgs(recipient, "0.000000000000000001", 18)[1], 1n);
  assert.equal(transferArgs(recipient, "9007199254740993", 18)[1], 9007199254740993n * 10n ** 18n);
  for (const amount of ["0", "-1", "1e4", "1,000", "NaN", "", "0.0000000000000000001", "1.0000000000000000000", "9".repeat(80)]) {
    assert.throws(() => transferArgs(recipient, amount, 18));
  }
  assert.throws(() => transferArgs(ZeroAddress, "1", 18), /zero address/);
  assert.throws(() => transferArgs("not-an-address", "1", 18));
});

test("factory creation, chain reads, duplicate rejection, and fixed supply", async () => {
  const artifact = compileFactory();
  const connection = await network.connect();
  let logRequests = 0;
  const limitedRPC = {
    request: async (request) => {
      if (request.method === "eth_getLogs") {
        logRequests++;
        const filter = request.params[0];
        // A stricter limit than the wallet in the bug report: only one block.
        assert.equal(filter.fromBlock, filter.toBlock, "lookup must not scan chain history");
      }
      return connection.provider.request(request);
    }
  };
  const provider = new BrowserProvider(limitedRPC, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0), outsider = await provider.getSigner(1);
    const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, issuer).deploy();
    await deployed.waitForDeployment();
    const address = await deployed.getAddress();
    const factory = new Contract(address, factoryABI, issuer);
    const receipt = await (await factory.createAssetToken(...creationArgs(sample))).wait();
    const { event } = createdEvent(receipt, address);
    assert.equal(event.args.issuer, issuer.address);
    assert.notEqual(event.args.tokenAddress, ZeroAddress);
    assert.notEqual(await provider.getCode(event.args.tokenAddress), "0x");
    const immediate = await readToken(provider, address, sample.assetId, receipt);
    assert.equal(immediate.transactionHash, receipt.hash);
    assert.equal(logRequests, 0, "creation should use receipt without requesting logs");
    const data = await readToken(provider, address, sample.assetId);
    assert.equal(logRequests, 1, "lookup should query only the creation block");
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

test("creation block lookup handles a long chain and old tokens without scanning", async () => {
  const latest = 11752908;
  for (const target of [0, 1, 42000, latest - 1, latest]) {
    let reads = 0;
    const provider = { getBlock: async (number) => {
      reads++;
      return { number, timestamp: 1600000000 + number * 12 };
    } };
    const block = await findCreationBlock(provider, BigInt(1600000000 + target * 12), latest);
    assert.equal(block.number, target);
    assert.ok(reads <= 25, `too many block requests: ${reads}`);
  }
  await assert.rejects(findCreationBlock({ getBlock: async () => null }, 1n, latest), /unavailable/);
  await assert.rejects(findCreationBlock({ getBlock: async (number) => ({ number, timestamp: number * 12 }) }, 13n, 10), /unavailable/);
});

test("mint check does not mistake RPC failure for contract rejection", async () => {
  const provider = { getCode: async () => "0x1234", call: async () => { throw new Error("RPC disconnected"); } };
  await assert.rejects(checkMintRejection(provider, ZeroAddress, ZeroAddress), /RPC disconnected/);
});
