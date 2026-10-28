import { Contract, ContractFactory, formatEther, formatUnits, getAddress } from "ethers";
import { fundingArtifact, escrowABI, campaignStates, campaignTerms, paymentUnits, readCampaign, campaignActions, savedCampaigns, rememberCampaign } from "./funding.js";

export function mountFundingUI({ document, storage, getContext, run, setStatus, refreshAsset }) {
  const $ = (id) => document.getElementById(id);
  const actions = ["approve", "activate", "finalize", "settle", "claimTokens", "claimRefund", "reclaimFailedTokens", "reclaimRemainder"];
  let asset, loaded, revision = 0;

  function clearCampaign() {
    revision++;
    loaded = undefined;
    $("campaign-details").replaceChildren();
    $("campaign-note").textContent = "";
    $("campaign-progress").hidden = true;
    $("campaign-contribute-form").hidden = true;
    for (const name of actions) $(`campaign-${name}`).hidden = true;
  }

  function reset() {
    clearCampaign();
    asset = undefined;
    $("campaign-controls").hidden = true;
    $("campaign-summary").textContent = "Look up an asset to create or load a funding campaign.";
    $("campaign-address").value = "";
    $("campaign-saved").replaceChildren();
  }

  function setAsset(data) {
    if (!asset || asset.address !== data.address || asset.chainId !== data.chainId || asset.connectedWallet !== data.connectedWallet) {
      clearCampaign();
      $("campaign-address").value = "";
    }
    asset = data;
    $("campaign-controls").hidden = false;
    $("campaign-create-form").hidden = getAddress(data.connectedWallet) !== getAddress(data.issuer);
    $("campaign-summary").textContent = `${data.asset.assetName} funding | ${data.symbol} | Only the original issuer can create a campaign here.`;
    showSaved();
  }

  function showSaved() {
    $("campaign-saved").replaceChildren();
    for (const address of savedCampaigns(storage, asset)) {
      const option = document.createElement("option");
      option.value = address;
      $("campaign-saved").append(option);
    }
  }

  async function session() {
    if (!asset) throw new Error("Look up an asset first.");
    const version = revision;
    const data = asset;
    const ctx = await getContext();
    const wallet = await ctx.signer.getAddress();
    function check() {
      if (version !== revision || asset?.address !== data.address) throw new Error("Asset or wallet changed. Reconnect, then reload the campaign.");
    }
    check();
    if (getAddress(wallet) !== getAddress(data.connectedWallet)) throw new Error("Wallet changed. Reconnect and look up the asset again.");
    return { ctx, wallet, data, check };
  }

  function render(data, wallet) {
    loaded = data;
    const allowed = campaignActions(data, wallet);
    const tokenAmount = (value) => `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
    const rows = {
      "Campaign address (share with investors)": data.address,
      "Status": campaignStates[Number(data.state)] + (data.state === 1n && data.timestamp >= data.deadline ? " — deadline passed; finalize to enable refunds" : ""),
      "Issuer": data.issuer,
      "Funding goal / hard cap": `${formatEther(data.fundingGoal)} ETH`,
      "Raised": `${formatEther(data.totalRaised)} ETH`,
      "Deadline": new Date(Number(data.deadline) * 1000).toLocaleString(),
      "Offered tokens": tokenAmount(data.offeredTokens),
      "Your contribution": `${formatEther(data.contribution)} ETH`,
      "Your token allocation": `${tokenAmount(data.allocation)}${data.claimed ? " (claimed)" : data.state === 3n ? " (campaign failed; no token claim)" : ""}`,
      "Your refund": data.refunded ? "Already refunded" : data.state === 3n ? `${formatEther(data.contribution)} ETH` : "Available only if the campaign fails",
      "Refunded total": `${formatEther(data.totalRefunded)} ETH`
    };
    if (data.state === 0n) {
      rows["Issuer tokens available"] = tokenAmount(data.issuerBalance);
      rows["Approved for escrow"] = tokenAmount(data.allowance);
    }
    $("campaign-details").replaceChildren();
    for (const [label, value] of Object.entries(rows)) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      $("campaign-details").append(dt, dd);
    }
    const progress = Number(data.totalRaised * 10000n / data.fundingGoal) / 100;
    $("campaign-progress").hidden = false;
    $("campaign-progress").value = progress;
    $("campaign-progress").textContent = `${progress}%`;
    for (const name of actions) $(`campaign-${name}`).hidden = !allowed[name];
    $("campaign-contribute-form").hidden = !allowed.contribute;
    $("campaign-remaining").textContent = `Remaining: ${formatEther(data.fundingGoal - data.totalRaised)} ETH. Payments above this amount are rejected.`;
    $("campaign-note").textContent = data.state === 0n
      ? `Setup: approve the offered tokens, then activate. Approval grants permission; activation deposits the tokens.${data.issuerBalance < data.offeredTokens ? " The issuer currently lacks enough tokens to activate." : ""}${data.timestamp >= data.deadline ? " This campaign's deadline has passed; create a new round." : ""}`
      : "Refresh to read the latest state. Each action requires a wallet transaction and network gas.";
  }

  async function refresh(address, sessionData, minimumBlock = 0) {
    const { ctx, wallet, data, check } = sessionData;
    const result = await readCampaign(ctx.provider, address, data, wallet, minimumBlock);
    check();
    rememberCampaign(storage, data, result.address);
    $("campaign-address").value = result.address;
    showSaved();
    render(result, wallet);
    return result;
  }

  $("campaign-address").addEventListener("input", clearCampaign);
  $("campaign-load-form").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const address = $("campaign-address").value;
      clearCampaign();
      const active = await session();
      await refresh(address, active);
      setStatus("Campaign loaded from the blockchain.");
    });
  };

  $("campaign-create-form").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const active = await session();
      const { ctx, wallet, data, check } = active;
      if (getAddress(wallet) !== getAddress(data.issuer)) throw new Error("Only the asset's original issuer can create its campaign here.");
      const block = await ctx.provider.getBlock("latest");
      const balance = await new Contract(data.address, escrowABI, ctx.provider).balanceOf(wallet);
      const args = campaignTerms({ ...data, connectedBalance: balance }, {
        goal: $("campaign-goal").value, offered: $("campaign-offered").value, deadline: $("campaign-deadline").value
      }, block.timestamp);
      check();
      setStatus("Confirm campaign creation in your wallet.");
      const contract = await new ContractFactory(fundingArtifact.abi, fundingArtifact.bytecode, ctx.signer).deploy(...args);
      const address = await contract.getAddress();
      const tx = contract.deploymentTransaction();
      setStatus(`Campaign submitted: ${address}. Transaction: ${tx.hash}. Waiting for confirmation.`);
      const receipt = await tx.wait();
      // Preserve discovery even if a wallet change happened during confirmation.
      rememberCampaign(storage, data, address);
      try {
        check();
        $("campaign-address").value = address;
        await refresh(address, active, receipt.blockNumber);
      } catch (error) {
        throw new Error(`Campaign created: ${address}. Transaction: ${receipt.hash}. Reload it to continue. ${error.message}`);
      }
      setStatus(`Campaign created: ${address}. Next: approve tokens, then activate.`);
    });
  };

  async function transact(name, value) {
    const address = loaded?.address;
    if (!address) throw new Error("Load a campaign first.");
    const active = await session();
    const { ctx, wallet, data, check } = active;
    // Re-read before every transaction: another investor may have just filled the cap.
    const fresh = await refresh(address, active);
    if (!campaignActions(fresh, wallet)[name]) throw new Error("This action is unavailable in the current campaign state. Details refreshed.");
    if (name === "contribute" && value > fresh.fundingGoal - fresh.totalRaised) throw new Error("Contribution exceeds the remaining funding goal.");
    check();
    setStatus(`Confirm ${name} in your wallet.`);
    const contract = new Contract(address, fundingArtifact.abi, ctx.signer);
    const tx = name === "approve"
      ? await new Contract(data.address, escrowABI, ctx.signer).approve(address, fresh.offeredTokens)
      : name === "contribute" ? await contract.contribute({ value })
      : await contract[name === "finalize" ? "finalizeCampaign" : name]();
    setStatus(`Submitted: ${tx.hash}. Waiting for confirmation.`);
    const receipt = await tx.wait();
    try {
      check();
      await refresh(address, active, receipt.blockNumber);
      await refreshAsset(ctx, data, receipt.blockNumber);
      check();
      if (name === "contribute") $("campaign-amount").value = "";
    } catch (error) {
      throw new Error(`Transaction confirmed: ${receipt.hash}. Refresh the asset and campaign. ${error.message}`);
    }
    setStatus(`Confirmed ${name}. Transaction: ${receipt.hash}. Balances refreshed.`);
  }

  for (const name of actions) $(`campaign-${name}`).onclick = () => run(() => transact(name));
  $("campaign-contribute-form").onsubmit = (event) => {
    event.preventDefault();
    run(() => transact("contribute", paymentUnits($("campaign-amount").value)));
  };
  reset();
  return { reset, setAsset };
}
