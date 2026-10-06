export function assetRecord(data, description, metadataText) {
  const metadata = JSON.parse(metadataText.trim() || "{}");
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new Error("Off-chain metadata must be a JSON object.");
  }
  return {
    asset_id: data.asset.assetId,
    name: data.asset.assetName,
    description: description.trim(),
    asset_type: data.asset.assetType,
    valuation: data.asset.valuation.toString(),
    currency: data.asset.currency,
    metadata_uri: data.asset.metadataURI,
    metadata,
    document_hash: data.asset.documentHash.toLowerCase(),
    token_address: data.address.toLowerCase(),
    issuer_address: data.issuer.toLowerCase(),
    factory_address: data.factoryAddress.toLowerCase(),
    chain_id: data.chainId.toString(),
    creation_transaction_hash: data.transactionHash.toLowerCase(),
    creation_block: data.creationBlock.toString()
  };
}
