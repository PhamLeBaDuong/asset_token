import { ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { creationArgs } from "./contracts.js";

export function parseMetadata(text) {
  const value = JSON.parse(text.trim() || "{}");
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Metadata must be a JSON object.");
  canonicalJSON(value); // Check numbers before the document is committed.
  return value;
}

// Application format v1: recursively sorted keys, compact JSON, UTF-8, no
// Unicode normalization. Whole numbers outside JS's safe range must be strings.
// This is our documented format, not a claim of RFC 8785 compliance.
export function canonicalJSON(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("Metadata numbers must be finite; encode large whole numbers as strings.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(",")}}`;
  }
  throw new Error("Metadata must contain only JSON values.");
}

export function metadataDocument(record) {
  const fields = ["asset_id", "name", "asset_type", "valuation", "currency", "metadata_uri", "description"];
  for (const field of fields) {
    if (typeof record[field] !== "string") throw new Error(`Metadata field ${field} must be a string.`);
  }
  if (!/^\d+$/.test(record.valuation)) throw new Error("Metadata valuation must be a whole-number string.");
  if (!record.metadata || Array.isArray(record.metadata) || typeof record.metadata !== "object") throw new Error("Metadata must be a JSON object.");
  return {
    schema: "asset-metadata-v1",
    assetId: record.asset_id, name: record.name, assetType: record.asset_type,
    valuation: record.valuation, currency: record.currency, metadataURI: record.metadata_uri,
    description: record.description, metadata: record.metadata
  };
}

export function hashMetadata(record) {
  const document = metadataDocument(record);
  const canonical = canonicalJSON(document);
  return { document, canonical, hash: keccak256(toUtf8Bytes(canonical)) };
}

export function creationMetadata(values, description, metadataText) {
  const args = creationArgs({ ...values, documentHash: "" });
  const record = {
    asset_id: args[3], name: args[4], asset_type: args[5], valuation: args[6].toString(),
    currency: args[7], metadata_uri: args[8], description: description.trim(), metadata: parseMetadata(metadataText)
  };
  return { ...hashMetadata(record), record };
}

export function verifyMetadata(record, onChainHash) {
  const computed = hashMetadata(record);
  if (!/^0x[0-9a-f]{64}$/i.test(onChainHash)) throw new Error("Invalid on-chain document hash.");
  const anchored = onChainHash.toLowerCase();
  return {
    ...computed, onChainHash: anchored,
    status: anchored === ZeroHash ? "unanchored" : computed.hash === anchored ? "verified" : "failed",
    databaseHashMatches: typeof record.document_hash === "string" && record.document_hash.toLowerCase() === anchored
  };
}
