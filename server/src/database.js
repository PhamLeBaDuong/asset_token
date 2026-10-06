import pg from "pg";

export function databaseConfig(env = process.env) {
  // Explicit settings keep this API connected to the asset database rather
  // than inheriting a DATABASE_URL from the other project.
  if (env.DB_NAME !== "asset_token") throw new Error("DB_NAME must be asset_token.");
  if (!env.DB_HOST || !env.DB_USER || !env.DB_PASSWORD) throw new Error("Set DB_HOST, DB_USER, and DB_PASSWORD in server/.env.");
  const port = Number(env.DB_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DB_PORT.");
  return {
    host: env.DB_HOST, port, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
    max: 5, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 10000
  };
}

export function createPool(env = process.env) {
  const pool = new pg.Pool(databaseConfig(env));
  pool.on("error", (error) => console.error(`Database connection error (${error.code || "unknown"}).`));
  return pool;
}
