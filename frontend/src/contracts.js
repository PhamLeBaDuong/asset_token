import { Contract, Interface, MaxUint256, ZeroAddress, ZeroHash, getAddress } from "ethers";

export const factoryABI = [
  "function createAssetToken(string tokenName,string tokenSymbol,uint256 initialSupply,string assetId,string assetName,string assetType,uint256 valuation,string currency,string metadataURI,bytes32 documentHash) returns (address)",
  "function tokenByAssetId(string) view returns (address)",
  "function assets(uint256) view returns (string assetId,address tokenAddress,address issuer)",
  "event AssetTokenCreated(string assetId,address indexed tokenAddress,address indexed issuer)"
];
export const tokenABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function asset() view returns (string assetId,string assetName,string assetType,uint256 valuation,string currency,string metadataURI,bytes32 documentHash,uint256 tokenizedAt,bool active)"
];
export const mintInterface = new Interface(["function mint(address to,uint256 amount)"]);

function integer(value, label, max = MaxUint256) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative whole number.`);
  const parsed = BigInt(value);
  if (parsed > max) throw new Error(`${label} is too large.`);
  return parsed;
}

export function creationArgs(values) {
  const required = (key) => {
    const value = String(values[key] ?? "").trim();
    if (!value) throw new Error(`${key} is required.`);
    return value;
  };
  const hash = String(values.documentHash ?? "").trim() || ZeroHash;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Document hash must be exactly 32 bytes (64 hex characters after 0x).");
  return [required("tokenName"), required("tokenSymbol"),
    integer(required("initialSupply"), "Supply", MaxUint256 / (10n ** 18n)),
    required("assetId"), required("assetName"), required("assetType"),
    integer(required("valuation"), "Valuation"), required("currency"), required("metadataURI"), hash];
}

export function createdEvent(receipt, factoryAddress) {
  const abi = new Interface(factoryABI);
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(factoryAddress)) continue;
    try {
      const event = abi.parseLog(log);
      if (event?.name === "AssetTokenCreated") return { event, log };
    } catch { /* Token transfer and role events use a different ABI. */ }
  }
  throw new Error("Transaction confirmed, but no factory creation event was found.");
}

// AssetToken stores its creation timestamp. Locate that block using block
// headers, then request logs for just that block instead of scanning history.
export async function findCreationBlock(provider, timestamp, latestBlock) {
  let low = 0, high = latestBlock;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const block = await provider.getBlock(middle);
    if (!block) throw new Error(`Block ${middle} unavailable. Retry the lookup.`);
    if (BigInt(block.timestamp) < timestamp) low = middle + 1;
    else high = middle;
  }
  const block = await provider.getBlock(low);
  if (!block || BigInt(block.timestamp) !== timestamp) {
    throw new Error("The token creation block is unavailable. Check the network and retry.");
  }
  return block;
}

export async function readToken(provider, factoryAddress, assetId, receipt) {
  const factory = new Contract(factoryAddress, factoryABI, provider);
  const blockTag = Math.max(await provider.getBlockNumber(), receipt?.blockNumber ?? 0);
  const at = { blockTag };
  const address = await factory.tokenByAssetId(assetId, at);
  if (address === ZeroAddress) throw new Error("No token is registered for this asset ID.");
  const token = new Contract(address, tokenABI, provider);
  const asset = await token.asset(at);
  // The issuer is recorded in the factory event, not a token.issuer() getter.
  let creation, block;
  if (receipt) {
    const parsed = createdEvent(receipt, factoryAddress);
    creation = { args: parsed.event.args, blockNumber: receipt.blockNumber, transactionHash: receipt.hash };
    block = await provider.getBlock(receipt.blockNumber);
  } else {
    block = await findCreationBlock(provider, asset.tokenizedAt, blockTag);
    const events = await factory.queryFilter(factory.filters.AssetTokenCreated(null, address), block.number, block.number);
    creation = events.find((event) => event.args.assetId === assetId);
  }
  if (!creation || creation.args.assetId !== assetId || getAddress(creation.args.tokenAddress) !== getAddress(address)) {
    throw new Error("No matching creation event found for this asset. Check the factory address and network.");
  }
  if (!block) throw new Error("Creation block unavailable. Retry the lookup.");
  const issuer = creation.args.issuer;
  const [name, symbol, decimals, supply, balance, factoryBalance, network] = await Promise.all([
    token.name(at), token.symbol(at), token.decimals(at), token.totalSupply(at),
    token.balanceOf(issuer, at), token.balanceOf(factoryAddress, at), provider.getNetwork()
  ]);
  return { address, issuer, name, symbol, decimals, supply, balance, factoryBalance,
    asset, chainId: network.chainId, readBlock: blockTag, creationBlock: creation.blockNumber,
    transactionHash: creation.transactionHash, blockHash: block.hash };
}

export async function checkMintRejection(provider, tokenAddress, caller) {
  if (await provider.getCode(tokenAddress) === "0x") throw new Error("No contract at this address.");
  try {
    await provider.call({ to: tokenAddress, from: caller,
      data: mintInterface.encodeFunctionData("mint", [caller, 1n]) });
  } catch (error) {
    if (error.code === "CALL_EXCEPTION") return true;
    throw error;
  }
  return false;
}
