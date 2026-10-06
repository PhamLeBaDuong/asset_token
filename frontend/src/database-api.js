export async function fetchAssetRecord(assetId, chainId, request = fetch) {
  const response = await request(`/api/assets/${encodeURIComponent(assetId)}?chainId=${encodeURIComponent(chainId)}`);
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The asset API did not return JSON. Start the API server and retry."); }
  if (!response.ok) throw new Error(result.error || "Asset lookup failed.");
  if (!result.asset) throw new Error("The asset API returned no asset record.");
  return result.asset;
}

export function assetRoute(location) {
  const match = location.pathname.match(/^\/assets\/([^/]+)$/);
  if (!match) return null;
  try {
    return { assetId: decodeURIComponent(match[1]), chainId: new URLSearchParams(location.search).get("chainId") };
  } catch { return null; }
}
