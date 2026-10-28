import { test } from "node:test";
import assert from "node:assert/strict";
import { ZeroHash, id } from "ethers";
import { canonicalJSON, creationMetadata, hashMetadata, parseMetadata, verifyMetadata } from "../src/metadata-integrity.js";

const fields = {
  tokenName: "Duong Coffee Token", tokenSymbol: "DCOF", initialSupply: "100000",
  assetId: "coffee-cp2-001", assetName: "Duong Coffee", assetType: "Business",
  valuation: "500000", currency: "USD", metadataURI: "urn:asset:coffee-cp2-001"
};
const commitment = creationMetadata(fields, "Coffee shop", '{"location":"Indianapolis","documents":["business-info.json"]}');

test("canonical format has sorted nested keys, compact UTF-8 JSON, and stable array order", () => {
  assert.equal(canonicalJSON({ z: 1, a: { y: "café", b: true }, arr: [null, false, 0.5] }), '{"a":{"b":true,"y":"café"},"arr":[null,false,0.5],"z":1}');
  const expected = '{"assetId":"coffee-cp2-001","assetType":"Business","currency":"USD","description":"Coffee shop","metadata":{"documents":["business-info.json"],"location":"Indianapolis"},"metadataURI":"urn:asset:coffee-cp2-001","name":"Duong Coffee","schema":"asset-metadata-v1","valuation":"500000"}';
  assert.equal(commitment.canonical, expected);
  assert.equal(commitment.hash, id(expected));
  const reordered = creationMetadata(fields, "Coffee shop", '{\n"documents": ["business-info.json"], "location": "Indianapolis"\n}');
  assert.equal(reordered.hash, commitment.hash);
  assert.notEqual(canonicalJSON([1, 2]), canonicalJSON([2, 1]));
});

test("creation normalization and export use the same commitment fields", () => {
  const normalized = creationMetadata({ ...fields, assetId: " coffee-cp2-001 ", valuation: "0500000" }, " Coffee shop ", '{"documents":["business-info.json"],"location":"Indianapolis"}');
  assert.equal(normalized.hash, commitment.hash);
  assert.equal(hashMetadata(JSON.parse(JSON.stringify(commitment.record))).hash, commitment.hash);
  for (const [field, value] of Object.entries({ asset_id: "different", name: "Changed", asset_type: "Property", valuation: "900000", currency: "EUR", metadata_uri: "urn:changed", description: "Changed", metadata: { location: "Changed" } })) {
    assert.notEqual(hashMetadata({ ...commitment.record, [field]: value }).hash, commitment.hash, `${field} must be committed`);
  }
});

test("verification trusts the live on-chain hash, including when a changed DB hash is recomputed", () => {
  const record = { ...commitment.record, document_hash: commitment.hash };
  assert.equal(verifyMetadata(record, commitment.hash).status, "verified");
  const changed = { ...record, valuation: "900000" };
  changed.document_hash = hashMetadata(changed).hash;
  const failed = verifyMetadata(changed, commitment.hash);
  assert.equal(failed.status, "failed");
  assert.equal(failed.databaseHashMatches, false);
  assert.equal(verifyMetadata(record, ZeroHash).status, "unanchored");
  const badHashCopy = verifyMetadata({ ...record, document_hash: ZeroHash }, commitment.hash);
  assert.equal(badHashCopy.status, "verified", "unchanged content still matches the authoritative hash");
  assert.equal(badHashCopy.databaseHashMatches, false, "the corrupted DB hash copy must be reported separately");
});

test("invalid and unsafe numeric metadata cannot be committed or falsely verified", () => {
  for (const text of ["null", "[]", "{broken", '{"count":9007199254740993}', '{"count":1e400}']) {
    assert.throws(() => parseMetadata(text));
  }
  assert.deepEqual(parseMetadata('{"count":"9007199254740993"}'), { count: "9007199254740993" });
  assert.throws(() => hashMetadata({ ...commitment.record, valuation: 500000 }), /string/);
  assert.throws(() => canonicalJSON({ missing: undefined }), /JSON values/);
  assert.throws(() => verifyMetadata(commitment.record, "0x1234"), /on-chain/);
});
