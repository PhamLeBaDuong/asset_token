import { BrowserProvider, Contract, formatUnits, getAddress } from "ethers";
import { factoryABI, creationArgs, createdEvent, readToken, checkMintRejection } from "./contracts.js";
import "./style.css";

const $ = (id) => document.getElementById(id);
$("factory").value = import.meta.env.VITE_FACTORY_ADDRESS || "";
$("chain").value = import.meta.env.VITE_CHAIN_ID || "11155111";
let provider, signer, current, busy = false, generation = 0;

function reset() {
  generation++;
  provider = signer = current = undefined;
  $("result").replaceChildren();
  $("mint-check").disabled = true;
  $("wallet").textContent = "Connection changed. Connect your wallet again.";
}
window.ethereum?.on?.("accountsChanged", reset);
window.ethereum?.on?.("chainChanged", reset);
$("factory").addEventListener("input", reset);
$("chain").addEventListener("input", reset);

async function context() {
  if (!provider || !signer) throw new Error("Connect your wallet first.");
  if (!/^\d+$/.test($("chain").value) || BigInt($("chain").value) <= 0n) throw new Error("Enter a valid chain ID.");
  const chainId = BigInt(await window.ethereum.request({ method: "eth_chainId" }));
  if (chainId !== BigInt($("chain").value)) throw new Error("Wrong network. Switch your wallet to the expected chain ID.");
  const factory = getAddress($("factory").value.trim());
  if (await provider.getCode(factory) === "0x") throw new Error("No factory contract found on this network at that address.");
  return { provider, signer, factory, generation };
}

async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach((button) => button.disabled = true);
  $("status").textContent = "Working…";
  try { await action(); }
  catch (error) { $("status").textContent = error.reason || error.shortMessage || error.message; }
  finally {
    busy = false;
    document.querySelectorAll("button").forEach((button) => button.disabled = false);
    $("mint-check").disabled = !current;
  }
}

function show(data) {
  current = data;
  const amount = (value) => `${formatUnits(value, data.decimals)} ${data.symbol}`;
  const rows = {
    "Token contract": data.address, "Issuer": data.issuer, "Token": `${data.name} (${data.symbol})`,
    "Chain ID": data.chainId, "Creation transaction": data.transactionHash,
    "Creation block": data.creationBlock, "Creation block hash": data.blockHash,
    "Balances read at block": data.readBlock, "Total supply": amount(data.supply),
    "Issuer balance": amount(data.balance), "Factory balance": amount(data.factoryBalance),
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
}

$("connect").onclick = () => run(async () => {
  if (!window.ethereum) throw new Error("Install a browser wallet such as MetaMask first.");
  provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  const network = await provider.getNetwork();
  $("wallet").textContent = `Issuer wallet: ${await signer.getAddress()} · Chain ${network.chainId}`;
  $("status").textContent = "Wallet connected. Verify the factory address and expected chain before creating.";
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
      const data = await readToken(ctx.provider, ctx.factory, args[3]);
      if (ctx.generation === generation) show(data);
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
    $("result").replaceChildren();
    const data = await readToken(ctx.provider, ctx.factory, $("lookup-id").value.trim());
    if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
    show(data);
    $("status").textContent = "Token details and balances retrieved from the blockchain.";
  });
};

$("mint-check").onclick = () => run(async () => {
  const ctx = await context();
  const rejected = await checkMintRejection(ctx.provider, current.address, await ctx.signer.getAddress());
  if (ctx.generation !== generation) throw new Error("Connection changed. Reconnect and retry.");
  $("status").textContent = rejected
    ? "Extra mint call reverted in blockchain simulation. The supplied token contract has no public mint function; its initial supply is fixed."
    : "The simulated mint call did not revert. This token may not match the supplied fixed-supply contract; no transaction was sent.";
});
