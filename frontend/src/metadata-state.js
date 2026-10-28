import { metadataDocument, verifyMetadata } from "./metadata-integrity.js";
import { assetRecord } from "./asset-record.js";

function key(data) {
  return `asset-token:creation-metadata:v1:${data.chainId}:${data.address.toLowerCase()}`;
}

export function rememberMetadata(data, record, storage) {
  try { storage?.setItem(key(data), JSON.stringify(record)); }
  catch { /* A blocked/full browser store must not prevent token operations. */ }
}

export function metadataState(data, previous, editor, storage) {
  const sameToken = previous?.address.toLowerCase() === data.address.toLowerCase()
    && previous?.chainId === data.chainId;
  const database = data.database || (sameToken ? previous.database : undefined);
  let description, metadataText, available = false;

  if (database) {
    available = true;
    const preserveEdits = sameToken && database === previous.database;
    description = preserveEdits ? editor.description : database.description;
    metadataText = preserveEdits ? editor.metadataText : JSON.stringify(database.metadata, null, 2);
  } else if (data.creationDocument) {
    available = true;
    description = data.creationDocument.description;
    metadataText = JSON.stringify(data.creationDocument.metadata, null, 2);
    rememberMetadata(data, data.creationDocument, storage);
  } else if (sameToken && previous.metadataAvailable) {
    available = true;
    description = editor.description;
    metadataText = editor.metadataText;
  } else {
    try {
      const saved = JSON.parse(storage?.getItem(key(data)) || "null");
      if (saved) {
        metadataDocument(saved);
        available = true;
        description = saved.description;
        metadataText = JSON.stringify(saved.metadata, null, 2);
      }
    } catch { /* No usable local document: report missing metadata, not tampering. */ }
    if (!available) {
      // Recover an older creation only when a candidate matches its live hash.
      // In particular, blank defaults are never assumed to be the original.
      const candidates = [editor.creationDocument];
      try { candidates.push(assetRecord(data, editor.description || "", editor.metadataText || "{}")); } catch {}
      candidates.push(assetRecord(data, "", "{}"));
      for (const record of candidates) {
        if (!record) continue;
        try {
          if (verifyMetadata(record, data.asset.documentHash).status !== "verified") continue;
          available = true;
          description = record.description;
          metadataText = JSON.stringify(record.metadata, null, 2);
          rememberMetadata(data, record, storage);
          break;
        } catch { /* An incomplete form is not a recoverable document. */ }
      }
    }
  }

  return {
    data: { ...data, database, metadataAvailable: available },
    description: description ?? "", metadataText: metadataText ?? "{}"
  };
}
