# Committed metadata format: asset-metadata-v1

The frontend hashes a defined projection of an asset record, not the raw download
file, PostgreSQL's JSONB text, or the pretty-printed JSON in an editor.

The projection contains:

```json
{
  "schema": "asset-metadata-v1",
  "assetId": "coffee-cp2-001",
  "name": "Duong Coffee",
  "assetType": "Business",
  "valuation": "500000",
  "currency": "USD",
  "metadataURI": "urn:asset:coffee-cp2-001",
  "description": "Coffee shop",
  "metadata": {"location": "Indianapolis", "documents": ["business-info.json"]}
}
```

Object keys are sorted recursively by JavaScript's default string ordering.
Arrays retain their order. Values are serialized as compact JSON, without spaces
or a trailing newline, then encoded as UTF-8 and hashed using ethers `keccak256`.
Strings are not Unicode-normalized. This application format is not advertised as
an implementation of RFC 8785. Whitespace/key order in an input JSON document does
not change its hash; changes inside string values do.

Valuation is an exact whole-number string. At creation, the contract-bound form
fields and description are trimmed, and valuation is normalized to its integer
decimal string. When verifying a saved row, those saved strings are used exactly;
they are not trimmed to hide edits. Metadata numbers must be finite and whole
numbers must be within JavaScript's safe integer range. Use strings for exact large
integers or exact high-precision decimal values.

Token/issuer/factory addresses, chain ID, transaction hashes, timestamps, token
balances/supply, and `document_hash` itself are outside the projection. Addresses
and creation details are checked separately by the deployment-link reader.
Transfers and database timestamp updates therefore do not invalidate metadata.
The hash is recorded on chain before the token address is known.

`creationMetadata` builds this document before token creation. `assetRecord`
exports the same committed values alongside deployment details. The database
importer stores those fields. `verifyMetadata` reconstructs the document from
the saved row and compares its hash with `AssetToken.asset().documentHash` read
from the blockchain. A database hash copy is reported separately and is never
the authoritative expected hash.

The original creation document is also cached in the browser under its chain ID
and token address. It is saved once creation confirms, before follow-up RPC reads.
A loaded PostgreSQL record takes precedence over this cache, so local storage
cannot hide database tampering. When no original document is available, the app
can recover the current form values or blank defaults only if their hash matches
the token. Otherwise it reports missing metadata without an integrity verdict.
Download/import remains the durable save flow; a hash cannot recover a lost
description or JSON document.

A zero on-chain hash is unanchored. Old tokens created with another document
format may fail this check. The supplied contract has no setter for its asset
hash; use a newly created token for this demonstration. Matching a hash proves
consistency with the recorded document, not the truth of the document's claims.
