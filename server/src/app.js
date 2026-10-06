import { createServer } from "node:http";

const maxUint256 = (1n << 256n) - 1n;
const assetQuery = `SELECT id::text, asset_id, name, description, asset_type,
  valuation::text, currency, metadata_uri, metadata, document_hash,
  token_address, issuer_address, factory_address, chain_id::text,
  creation_transaction_hash, creation_block::text, created_at, updated_at
  FROM public.assets WHERE asset_id = $1 AND chain_id = $2::numeric`;

function reply(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

export function createApp(pool, logError = (error) => console.error(`Database query failed (${error.code || "unknown"}).`)) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return reply(res, 405, { error: "This API supports reads only. Import asset records using the server script." });
      }
      if (url.pathname === "/api/health") {
        await pool.query("SELECT 1 FROM public.assets LIMIT 1");
        return reply(res, 200, { status: "ok", database: "asset_token" });
      }
      const match = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
      if (!match) return reply(res, 404, { error: "API route not found." });
      let assetId;
      try { assetId = decodeURIComponent(match[1]); }
      catch { return reply(res, 400, { error: "Invalid asset ID encoding." }); }
      const chainId = url.searchParams.get("chainId") || "";
      if (!assetId.trim() || assetId.length > 512 || !/^\d{1,78}$/.test(chainId) || BigInt(chainId) <= 0n || BigInt(chainId) > maxUint256) {
        return reply(res, 400, { error: "Provide an asset ID and a positive whole-number chainId." });
      }
      const { rows } = await pool.query(assetQuery, [assetId, BigInt(chainId).toString()]);
      if (!rows.length) return reply(res, 404, { error: "No database asset found for this ID and chain. Import its downloaded record first." });
      return reply(res, 200, { asset: rows[0] });
    } catch (error) {
      logError(error);
      return reply(res, 503, { error: "Asset database is unavailable. Check the API connection settings and remote assets table." });
    }
  });
}
