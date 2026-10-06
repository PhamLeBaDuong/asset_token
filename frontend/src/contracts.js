import { Contract, Interface, MaxUint256, ZeroAddress, ZeroHash, getAddress, parseUnits } from "ethers";

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
  "function transfer(address to,uint256 amount) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function asset() view returns (string assetId,string assetName,string assetType,uint256 valuation,string currency,string metadataURI,bytes32 documentHash,uint256 tokenizedAt,bool active)"
];
export const mintInterface = new Interface(["function mint(address to,uint256 amount)"]);

export function transferArgs(recipient, amount, decimals) {
  const address = getAddress(recipient.trim());
  if (address === ZeroAddress) throw new Error("Recipient cannot be the zero address.");
  const value = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a positive token amount, such as 10000 or 2.5.");
  // Reject excess precision explicitly; never round a user's transfer amount.
  if ((value.split(".")[1]?.length || 0) > Number(decimals)) {
    throw new Error(`This token supports at most ${decimals} decimal places.`);
  }
  const units = parseUnits(value, decimals);
  if (units <= 0n || units > MaxUint256) throw new Error("Transfer amount must be positive and fit within uint256.");
  return [address, units];
}

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

export async function readToken(provider, factoryAddress, assetId, receipt, walletAddress, minimumBlock = 0, expectedTokenAddress) {
  const factory = new Contract(factoryAddress, factoryABI, provider);
  const blockTag = Math.max(await provider.getBlockNumber(), receipt?.blockNumber ?? 0, minimumBlock);
  const at = { blockTag };
  const address = await factory.tokenByAssetId(assetId, at);
  if (address === ZeroAddress) throw new Error("No token is registered for this asset ID.");
  if (expectedTokenAddress && getAddress(address) !== getAddress(expectedTokenAddress)) {
    throw new Error("Database token address does not match the factory's registered token.");
  }
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
  const connectedWallet = walletAddress ? getAddress(walletAddress) : issuer;
  const [name, symbol, decimals, supply, balance, factoryBalance, connectedBalance, network] = await Promise.all([
    token.name(at), token.symbol(at), token.decimals(at), token.totalSupply(at),
    token.balanceOf(issuer, at), token.balanceOf(factoryAddress, at), token.balanceOf(connectedWallet, at), provider.getNetwork()
  ]);
  return { address, factoryAddress: getAddress(factoryAddress), issuer, name, symbol, decimals, supply, balance, factoryBalance, connectedWallet, connectedBalance,
    asset, chainId: network.chainId, readBlock: blockTag, creationBlock: creation.blockNumber,
    transactionHash: creation.transactionHash, blockHash: block.hash };
}

export async function readLinkedToken(provider, record, walletAddress, minimumBlock = 0) {
  const network = await provider.getNetwork();
  if (BigInt(record.chain_id) !== network.chainId) throw new Error(`Wrong network. This database asset is on chain ${record.chain_id}.`);
  const data = await readToken(provider, record.factory_address, record.asset_id, undefined, walletAddress, minimumBlock, record.token_address);
  if (getAddress(record.issuer_address) !== data.issuer ||
      record.creation_transaction_hash.toLowerCase() !== data.transactionHash.toLowerCase() ||
      BigInt(record.creation_block) !== BigInt(data.creationBlock)) {
    throw new Error("Database deployment details do not match the token's factory creation event.");
  }
  return { ...data, database: record };
}

export async function readTransferHistory(provider, tokenAddress, creationBlock, toBlock, blockSpan = 1000) {
  for (const value of [creationBlock, toBlock, blockSpan]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("History block range must use non-negative safe integers.");
  }
  if (blockSpan < 1 || toBlock < creationBlock) throw new Error("Invalid history block range.");
  const token = new Contract(tokenAddress, tokenABI, provider);
  const fromBlock = Math.max(creationBlock, toBlock - blockSpan + 1);
  async function query(from, to) {
    try { return await token.queryFilter(token.filters.Transfer(), from, to); }
    catch (error) {
      const message = [error.message, error.info?.error?.message, error.error?.message].filter(Boolean).join(" ");
      const code = error.info?.error?.code ?? error.error?.code ?? error.code;
      const rangeLimited = code === -32005 || /block range|too many (results|logs)|query returned more|response size|result limit|maximum.*blocks|limited to.*blocks/i.test(message);
      if (!rangeLimited || from === to) throw error;
      const middle = Math.floor((from + to) / 2);
      const first = await query(from, middle);
      const second = await query(middle + 1, to);
      return [...first, ...second];
    }
  }
  const logs = await query(fromBlock, toBlock);
  const entries = logs.map((log) => ({
    from: log.args.from, to: log.args.to, value: log.args.value,
    transactionHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.index
  })).sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return { entries, fromBlock, toBlock, nextToBlock: fromBlock > creationBlock ? fromBlock - 1 : null };
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
