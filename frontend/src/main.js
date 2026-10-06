import { BrowserProvider, Contract, ZeroAddress, formatUnits, getAddress } from "ethers";
import { factoryABI, tokenABI, creationArgs, createdEvent, readToken, readLinkedToken, checkMintRejection, transferArgs, readTransferHistory } from "./contracts.js";
import { assetRecord } from "./asset-record.js";
import { fetchAssetRecord, assetRoute } from "./database-api.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
$("factory").value = import.meta.env.VITE_FACTORY_ADDRESS || "";
$("chain").value = import.meta.env.VITE_CHAIN_ID || "11155111";
const initialRoute = assetRoute(window.location);
if (initialRoute) {
  $("lookup-id").value = initialRoute.assetId;
  if (initialRoute.chainId) $("chain").value = initialRoute.chainId;
}
let provider, signer, current, busy = false, generation = 0;
let history;

function reset() {
  generation++;
  provider = signer = current = undefined;
  $("result").replaceChildren();
  clearTransfer();
  clearHistory();
  $("database-form").hidden = true;
  $("database-status").textContent = "Look up an asset to prepare its database record.";
  $("database-details").replaceChildren();
  $("mint-result").textContent = "Connection changed. Reconnect and look up the asset before running the simulation.";
  $("wallet").textContent = "Connection changed. Connect your wallet again.";
}
window.ethereum?.on?.("accountsChanged", reset);
window.ethereum?.on?.("chainChanged", reset);
$("factory").addEventListener("input", reset);
$("chain").addEventListener("input", reset);

async function context(factoryAddress) {
  const startedAt = generation;
  if (!provider || !signer) throw new Error("Connect your wallet first.");
  if (!/^\d+$/.test($("chain").value) || BigInt($("chain").value) <= 0n) throw new Error("Enter a valid chain ID.");
  const chainId = BigInt(await window.ethereum.request({ method: "eth_chainId" }));
  if (chainId !== BigInt($("chain").value)) throw new Error("Wrong network. Switch your wallet to the expected chain ID.");
  const factory = getAddress(factoryAddress || $("factory").value.trim());
  if (await provider.getCode(factory) === "0x") throw new Error("No factory contract found on this network at that address.");
  if (startedAt !== generation) throw new Error("Connection changed. Reconnect and retry.");
  return { provider, signer, factory, generation };
}

function clearTransfer() {
  $("transfer-form").hidden = true;
  $("transfer-summary").textContent = "Connect your wallet and look up an asset to transfer its tokens.";
  $("transfer-result").textContent = "";
}

function clearHistory() {
  history = undefined;
  $("history-rows").replaceChildren();
  $("history-table").hidden = true;
  $("history-refresh").hidden = true;
  $("history-older").hidden = true;
  $("history-status").textContent = "Look up an asset to read its transfer events.";
}

async function loadHistory(ctx, data, older = false) {
  const previous = older ? history : undefined;
  const toBlock = older ? previous?.nextToBlock : data.readBlock;
  if (toBlock == null) return;
  if (!older) clearHistory();
  $("history-refresh").hidden = false;
  $("history-status").textContent = "Reading transfer events from the blockchain...";
  try {
    const page = await readTransferHistory(ctx.provider, data.address, data.creationBlock, toBlock);
    if (ctx.generation !== generation || current?.address !== data.address) return;
    history = {
      entries: [...(previous?.entries || []), ...page.entries],
      fromBlock: page.fromBlock, toBlock: previous?.toBlock ?? page.toBlock,
      nextToBlock: page.nextToBlock
    };
    $("history-rows").replaceChildren();
    for (const entry of history.entries) {
      const row = document.createElement("tr");
      const from = entry.from === ZeroAddress ? "Mint (zero address)" : entry.from;
      for (const value of [from, entry.to, `${formatUnits(entry.value, data.decimals)} ${data.symbol}`, entry.transactionHash]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      $("history-rows").append(row);
    }
    $("history-table").hidden = history.entries.length === 0;
    $("history-older").hidden = history.nextToBlock === null;
    $("history-status").textContent = `${history.entries.length} transfer events in blocks ${history.fromBlock}–${history.toBlock}. ${history.nextToBlock === null ? "All blocks through token creation loaded." : "Load older blocks for earlier events."}`;
  } catch (error) {
    if (ctx.generation === generation && current?.address === data.address) {
      $("history-status").textContent = `History could not load: ${error.shortMessage || error.message}. Retry with ${older ? "Load older blocks" : "Refresh history"}.`;
    }
  }
}

async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => button.disabled = true);
  $("status").textContent = "Working…";
  try { await action(); }
  catch (error) { $("status").textContent = error.reason || error.info?.error?.message || error.error?.message || error.shortMessage || error.message; }
  finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => button.disabled = false);
  }
}

function show(data) {
  if (current?.address !== data.address || current?.chainId !== data.chainId) {
    $("asset-description").value = "";
    $("asset-metadata").value = "{}";
  }
  if (data.database && current?.database !== data.database) {
    $("asset-description").value = data.database.description;
    $("asset-metadata").value = JSON.stringify(data.database.metadata, null, 2);
  }
  current = data;
  $("mint-result").textContent = "Asset loaded. You can now check extra mint rejection. No wallet popup is expected.";
  const amount = (value) => `${formatUnits(value, data.decimals)} ${data.symbol}`;
  const rows = {
    "Token contract": data.address, "Issuer": data.issuer, "Token": `${data.name} (${data.symbol})`,
    "Chain ID": data.chainId, "Creation transaction": data.transactionHash,
    "Creation block": data.creationBlock, "Creation block hash": data.blockHash,
    "Balances read at block": data.readBlock, "Total supply": amount(data.supply),
    "Issuer balance": amount(data.balance), "Factory balance": amount(data.factoryBalance),
    "Connected wallet": data.connectedWallet, "Your balance": amount(data.connectedBalance),
    "Asset ID": data.asset.assetId, "Asset name": data.asset.assetName,
    "Asset type": data.asset.assetType, "Valuation": `${data.asset.valuation} ${data.asset.currency}`,
    "Metadata URI": data.asset.metadataURI, "Document hash": data.asset.documentHash,
    "Tokenized at": new Date(Number(data.asset.tokenizedAt) * 1000).toISOString(), "Active": data.asset.active
  };
  $("result").replaceChildren();
  for (const [label, value] of Object.entries(rows)) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = String(value);
    $("result").append(dt, dd);
  }
  $("transfer-summary").textContent = `Token: ${data.address} | Your balance: ${amount(data.connectedBalance)}`;
  $("transfer-form").hidden = false;
  $("database-form").hidden = false;
  $("database-status").textContent = "The download will include this token's address, issuer, chain ID, and your off-chain fields.";
  $("database-details").replaceChildren();
  if (data.database) {
    for (const [label, value] of Object.entries({
      "Database asset": data.database.asset_id,
      "Saved description": data.database.description,
      "Saved metadata": JSON.stringify(data.database.metadata, null, 2)
    })) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      $("database-details").append(dt, dd);
    }
    $("database-status").textContent = "Asset loaded from PostgreSQL. Token details and balances read from its linked blockchain contract.";
  }
}

async function loadDatabaseAsset(assetId, updateRoute = true) {
  if (!provider || !signer) throw new Error("Connect your wallet first.");
  const startedAt = generation;
  current = undefined;
  clearTransfer();
  clearHistory();
  $("result").replaceChildren();
  $("database-details").replaceChildren();
  $("database-form").hidden = true;
  $("database-status").textContent = "Loading the saved asset from PostgreSQL...";
  try {
    const record = await fetchAssetRecord(assetId, $("chain").value);
    if (startedAt !== generation) throw new Error("Connection changed. Reconnect and retry.");
    const ctx = await context(record.factory_address);
    const data = await readLinkedToken(ctx.provider, record, await ctx.signer.getAddress());
    if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
    $("factory").value = data.factoryAddress;
    $("lookup-id").value = record.asset_id;
    show(data);
    if (updateRoute) window.history.pushState({}, "", `/assets/${encodeURIComponent(record.asset_id)}?chainId=${record.chain_id}`);
    await loadHistory(ctx, data);
    $("status").textContent = "Database asset loaded; balances and transfer history read from its token contract.";
  } catch (error) {
    if (startedAt === generation) $("database-status").textContent = `Database lookup failed: ${error.shortMessage || error.message}`;
    throw error;
  }
}

$("connect").onclick = () => run(async () => {
  if (!window.ethereum) throw new Error("Install a browser wallet such as MetaMask first.");
  provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  const network = await provider.getNetwork();
  $("wallet").textContent = `Connected wallet: ${await signer.getAddress()} · Chain ${network.chainId}`;
  $("status").textContent = "Wallet connected. Verify the factory address and expected chain before creating.";
  const route = assetRoute(window.location);
  if (route) await loadDatabaseAsset(route.assetId, false);
});

$("create-form").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const ctx = await context();
    const args = creationArgs(Object.fromEntries(new FormData(event.target)));
    const factory = new Contract(ctx.factory, factoryABI, ctx.signer);
    $("status").textContent = "Confirm token creation in your wallet…";
    const tx = await factory.createAssetToken(...args);
    $("status").textContent = `Submitted: ${tx.hash}. Waiting for confirmation…`;
    const receipt = await tx.wait();
    const { event: creation } = createdEvent(receipt, ctx.factory);
    if (ctx.generation !== generation) throw new Error(`Transaction confirmed: ${receipt.hash}. Reconnect on its original network and look up the asset.`);
    $("lookup-id").value = args[3];
    $("status").textContent = `Created ${creation.args.tokenAddress}. Transaction: ${receipt.hash}`;
    try {
      const data = await readToken(ctx.provider, ctx.factory, args[3], receipt, await ctx.signer.getAddress());
      if (ctx.generation === generation) {
        show(data);
        await loadHistory(ctx, data);
      }
    } catch (error) {
      throw new Error(`Creation succeeded: ${creation.args.tokenAddress}. Transaction: ${receipt.hash}. Reading details failed: ${error.shortMessage || error.message}. Use lookup to retry.`);
    }
  });
};

$("lookup-form").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const ctx = await context();
    current = undefined;
    clearTransfer();
    clearHistory();
    $("database-form").hidden = true;
    $("database-details").replaceChildren();
    $("mint-result").textContent = "Loading asset. Wait for lookup to finish before running the simulation.";
    $("result").replaceChildren();
    const data = await readToken(ctx.provider, ctx.factory, $("lookup-id").value.trim(), undefined, await ctx.signer.getAddress());
    if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
    show(data);
    window.history.replaceState({}, "", "/");
    await loadHistory(ctx, data);
    $("status").textContent = "Token details and balances retrieved from the blockchain.";
  });
};

$("mint-check").onclick = () => run(async () => {
  const startedAt = generation;
  $("mint-result").textContent = "Checking extra mint rejection with your wallet's RPC. No wallet approval is needed...";
  try {
    if (!current) throw new Error("Connect your wallet and successfully look up an asset first, then press this button again.");
    const tokenAddress = current.address;
    const ctx = await context();
    const rejected = await checkMintRejection(ctx.provider, tokenAddress, await ctx.signer.getAddress());
    if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
    const message = rejected
      ? "Expected result: extra mint call rejected. The supplied contract has no public mint function. No tokens were minted and no gas was spent."
      : "Unexpected result: the extra mint call did not revert. This token may not match the supplied fixed-supply contract. No transaction was sent.";
    $("mint-result").textContent = message;
    $("status").textContent = message;
  } catch (error) {
    if (startedAt === generation) {
      $("mint-result").textContent = `Simulation could not complete: ${error.reason || error.info?.error?.message || error.error?.message || error.shortMessage || error.message}`;
    }
    throw error;
  }
});

$("transfer-form").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    if (!current) throw new Error("Look up an asset before transferring.");
    const asset = current;
    const ctx = await context();
    const args = transferArgs($("transfer-recipient").value, $("transfer-amount").value, asset.decimals);
    const wallet = await ctx.signer.getAddress();
    if (ctx.generation !== generation || current !== asset || wallet !== asset.connectedWallet) {
      throw new Error("Connection changed. Reconnect and look up the asset again.");
    }
    const token = new Contract(asset.address, tokenABI, ctx.signer);
    $("transfer-result").textContent = "Confirm the transfer in your wallet.";
    $("status").textContent = "Confirm the transfer in your wallet.";
    let receipt;
    try {
      const tx = await token.transfer(...args);
      if (ctx.generation === generation) {
        $("transfer-result").textContent = `Submitted: ${tx.hash}. Waiting for confirmation...`;
        $("status").textContent = $("transfer-result").textContent;
      }
      receipt = await tx.wait();
    } catch (error) {
      if (ctx.generation === generation) $("transfer-result").textContent = `Transfer did not complete: ${error.reason || error.shortMessage || error.message}`;
      throw error;
    }
    if (ctx.generation !== generation) {
      throw new Error(`Transfer confirmed: ${receipt.hash}. Reconnect on its original network and look up the asset to refresh balances.`);
    }
    $("transfer-result").textContent = `Transfer confirmed. Transaction: ${receipt.hash}`;
    try {
      // A transfer receipt is not a factory creation receipt. Use its block only
      // to ensure reads include the confirmed transfer, even with RPC caching.
      const data = asset.database
        ? await readLinkedToken(ctx.provider, asset.database, wallet, receipt.blockNumber)
        : await readToken(ctx.provider, ctx.factory, asset.asset.assetId, undefined, wallet, receipt.blockNumber);
      if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and look up the asset.");
      show(data);
      $("transfer-amount").value = "";
      $("status").textContent = `Transfer confirmed: ${receipt.hash}. Balances refreshed from the blockchain.`;
      await loadHistory(ctx, data);
    } catch (error) {
      if (ctx.generation === generation) {
        current = undefined;
        $("transfer-form").hidden = true;
        $("transfer-summary").textContent = "Transfer confirmed. Look up the asset again to refresh balances.";
      }
      throw new Error(`Transfer confirmed: ${receipt.hash}. Balance refresh failed: ${error.shortMessage || error.message}. Use lookup to retry.`);
    }
  });
};

for (const [button, older] of [["history-refresh", false], ["history-older", true]]) {
  $(button).onclick = () => run(async () => {
    if (!current) throw new Error("Look up an asset first.");
    const data = current;
    const ctx = await context();
    const latest = older ? data.readBlock : Math.max(data.readBlock, await ctx.provider.getBlockNumber());
    if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
    await loadHistory(ctx, { ...data, readBlock: latest }, older);
    $("status").textContent = $("history-status").textContent;
  });
}

$("database-form").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    if (!current) throw new Error("Look up an asset first.");
    const data = current;
    const ctx = await context();
    if (ctx.generation !== generation || current !== data) throw new Error("Connection changed. Look up the asset again.");
    const record = assetRecord(data, $("asset-description").value, $("asset-metadata").value);
    const url = URL.createObjectURL(new Blob([JSON.stringify(record) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `asset-${record.chain_id}-${record.token_address}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $("database-status").textContent = "Asset record downloaded. Import this file on the PostgreSQL server to save it.";
    $("status").textContent = $("database-status").textContent;
  });
};

$("lookup-db").onclick = () => run(() => loadDatabaseAsset($("lookup-id").value.trim()));
window.addEventListener("popstate", () => {
  const route = assetRoute(window.location);
  if (route) {
    $("lookup-id").value = route.assetId;
    if (route.chainId && route.chainId !== $("chain").value) {
      $("chain").value = route.chainId;
      reset();
    }
    if (provider && signer) run(() => loadDatabaseAsset(route.assetId, false));
  }
});
