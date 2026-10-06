import { createPool } from "../src/database.js";

const pool = createPool();
try {
  const { rows } = await pool.query(`SELECT asset_id, chain_id::text, token_address
    FROM public.assets ORDER BY id DESC LIMIT 5`);
  console.log(`Connected to asset_token.public.assets. Latest records returned: ${rows.length}.`);
  for (const row of rows) console.log(`${row.asset_id} | chain ${row.chain_id} | ${row.token_address}`);
} catch (error) {
  console.error(`Database check failed (${error.code || "unknown"}). Check server/.env and remote database access.`);
  process.exitCode = 1;
} finally { await pool.end(); }
