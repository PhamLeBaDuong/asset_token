import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { databaseConfig } from "../src/database.js";

async function withApi(pool, action) {
  const server = createApp(pool, () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await action(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("asset lookup uses parameters and preserves exact numbers", async () => {
  const assetId = "coffee-001' OR 1=1 --";
  const row = { asset_id: assetId, chain_id: "11155111", valuation: "9007199254740993", metadata: { note: "Owner's shop" } };
  await withApi({ query: async (sql, params) => {
    assert.match(sql, /asset_id = \$1 AND chain_id = \$2::numeric/);
    assert.equal(sql.includes(assetId), false);
    assert.deepEqual(params, [assetId, "11155111"]);
    return { rows: [row] };
  } }, async (base) => {
    const response = await fetch(`${base}/api/assets/${encodeURIComponent(assetId)}?chainId=11155111`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { asset: row });
  });
});

test("invalid chain IDs and missing asset IDs do not query the database", async () => {
  await withApi({ query: async () => { assert.fail("invalid request reached PostgreSQL"); } }, async (base) => {
    for (const chainId of ["", "0", "-1", "1.5", "abc", "9".repeat(79), (1n << 256n).toString()]) {
      const response = await fetch(`${base}/api/assets/coffee-001?chainId=${encodeURIComponent(chainId)}`);
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(`${base}/api/assets/%20?chainId=1`)).status, 400);
  });
});

test("missing records and database errors have distinct responses without leaking secrets", async () => {
  await withApi({ query: async () => ({ rows: [] }) }, async (base) => {
    const response = await fetch(`${base}/api/assets/coffee-001?chainId=11155111`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /Import/);
  });
  await withApi({ query: async () => { throw new Error("secret database password"); } }, async (base) => {
    const response = await fetch(`${base}/api/assets/coffee-001?chainId=11155111`);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("secret"), false);
  });
});

test("health checks the assets table and the API rejects writes", async () => {
  let reads = 0;
  await withApi({ query: async (sql) => {
    reads++;
    assert.match(sql, /FROM public.assets/);
    return { rows: [] };
  } }, async (base) => {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).database, "asset_token");
    const rejected = await fetch(`${base}/api/assets/coffee-001`, { method: "POST" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET");
    assert.equal(reads, 1);
  });
});

test("API config targets asset_token and ignores another project's DATABASE_URL", () => {
  const env = { DB_HOST: "167.233.214.178", DB_PORT: "5432", DB_NAME: "asset_token", DB_USER: "postgres", DB_PASSWORD: "test-only", DATABASE_URL: "postgres://other-host/soccer_booking" };
  const config = databaseConfig(env);
  assert.equal(config.host, env.DB_HOST);
  assert.equal(config.port, 5432);
  assert.equal(config.database, "asset_token");
  assert.equal(config.connectionString, undefined);
  assert.throws(() => databaseConfig({ ...env, DB_NAME: "soccer_booking" }), /asset_token/);
  assert.throws(() => databaseConfig({ ...env, DB_PASSWORD: "" }), /DB_PASSWORD/);
});
