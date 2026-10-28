import { Contract, MaxUint256, getAddress, parseUnits } from "ethers";
import artifact from "./generated/funding-campaign.js";

export { artifact as fundingArtifact };
export const campaignStates = ["Setup", "Active", "Successful", "Failed", "Settled"];
export const escrowABI = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)"
];

export function paymentUnits(value, decimals = 18) {
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Enter a positive decimal amount.");
  const units = parseUnits(text, decimals);
  if (units <= 0n || units > MaxUint256) throw new Error("Amount must be positive and fit within uint256.");
  return units;
}

export function campaignTerms(asset, values, timestamp) {
  const milliseconds = Date.parse(values.deadline);
  if (!Number.isFinite(milliseconds)) throw new Error("Enter a valid deadline.");
  const deadline = BigInt(Math.floor(milliseconds / 1000));
  if (deadline <= BigInt(timestamp)) throw new Error("Deadline must be in the future.");
  const offered = paymentUnits(values.offered, asset.decimals);
  if (offered > asset.connectedBalance) throw new Error("Your token balance is smaller than the offered amount.");
  return [getAddress(asset.address), paymentUnits(values.goal), deadline, offered];
}

// Ignore only constructor-written immutable slots when comparing compiled code.
// A contract that merely imitates our getters must not receive token approval.
export function matchesCampaignCode(code) {
  if (typeof code !== "string" || code.length !== artifact.runtime.length) return false;
  // Every reference to the same immutable must contain the same value, too.
  for (const ranges of Object.values(artifact.immutableReferences)) {
    const values = ranges.map(({ start, length }) => code.slice(2 + start * 2, 2 + (start + length) * 2).toLowerCase());
    if (values.some((value) => value !== values[0])) return false;
  }
  function normalize(value) {
    const bytes = value.slice(2).toLowerCase().split("");
    for (const ranges of Object.values(artifact.immutableReferences)) {
      for (const { start, length } of ranges) bytes.fill("0", start * 2, (start + length) * 2);
    }
    return bytes.join("");
  }
  return normalize(code) === normalize(artifact.runtime);
}

export async function readCampaign(provider, address, asset, wallet, minimumBlock = 0) {
  address = getAddress(address.trim());
  const blockTag = Math.max(await provider.getBlockNumber(), minimumBlock);
  const at = { blockTag };
  const code = await provider.getCode(address, blockTag);
  if (!matchesCampaignCode(code)) throw new Error("This address does not contain this application's FundingCampaign contract.");
  const contract = new Contract(address, artifact.abi, provider);
  const names = ["issuer", "assetToken", "fundingGoal", "deadline", "offeredTokens", "state", "totalRaised",
    "claimedContributions", "totalTokensClaimed", "remainderReclaimed", "escrowReturned", "totalRefunded"];
  const values = await Promise.all(names.map((name) => contract[name](at)));
  const data = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  if (getAddress(data.assetToken) !== getAddress(asset.address)) throw new Error("Campaign belongs to a different asset token.");
  if (getAddress(data.issuer) !== getAddress(asset.issuer)) throw new Error("Campaign issuer does not match this asset's original issuer.");
  const [contribution, claimed, refunded, allowance, balance, block] = await Promise.all([
    contract.contributions(wallet, at), contract.tokensClaimed(wallet, at), contract.refundClaimed(wallet, at),
    new Contract(asset.address, escrowABI, provider).allowance(data.issuer, address, at),
    new Contract(asset.address, escrowABI, provider).balanceOf(data.issuer, at), provider.getBlock(blockTag)
  ]);
  if (!block) throw new Error("Campaign block unavailable. Refresh and retry.");
  return { ...data, address, contribution, claimed, refunded, allowance, issuerBalance: balance,
    timestamp: BigInt(block.timestamp), readBlock: blockTag,
    allocation: contribution * data.offeredTokens / data.fundingGoal };
}

export function campaignActions(data, wallet) {
  const issuer = getAddress(wallet) === getAddress(data.issuer);
  const beforeDeadline = data.timestamp < data.deadline;
  return {
    approve: issuer && data.state === 0n && beforeDeadline && data.allowance < data.offeredTokens,
    activate: issuer && data.state === 0n && beforeDeadline && data.allowance >= data.offeredTokens && data.issuerBalance >= data.offeredTokens,
    contribute: data.state === 1n && beforeDeadline,
    finalize: data.state === 1n && !beforeDeadline,
    settle: issuer && data.state === 2n,
    claimTokens: data.state === 4n && data.contribution > 0n && !data.claimed,
    claimRefund: data.state === 3n && data.contribution > 0n && !data.refunded,
    reclaimFailedTokens: issuer && data.state === 3n && !data.escrowReturned,
    reclaimRemainder: issuer && data.state === 4n && data.claimedContributions === data.totalRaised && !data.remainderReclaimed
  };
}

export function campaignStorageKey(asset) {
  return `asset-funding:${asset.chainId}:${asset.address.toLowerCase()}`;
}

export function savedCampaigns(storage, asset) {
  try {
    const values = JSON.parse(storage?.getItem(campaignStorageKey(asset)) || "[]");
    return Array.isArray(values) ? [...new Set(values.filter((value) => typeof value === "string").map(getAddress))] : [];
  } catch { return []; }
}

export function rememberCampaign(storage, asset, address) {
  const addresses = [getAddress(address), ...savedCampaigns(storage, asset).filter((value) => value !== getAddress(address))];
  try { storage?.setItem(campaignStorageKey(asset), JSON.stringify(addresses)); } catch { /* Address remains visible if storage is blocked. */ }
  return addresses;
}
