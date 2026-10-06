import { createPool } from "./database.js";
import { createApp } from "./app.js";

const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid API_PORT.");
const pool = createPool();
const server = createApp(pool);
server.listen(port, host, () => console.log(`Asset API listening on http://${host}:${port}`));
server.on("error", (error) => {
  console.error(`API failed to listen (${error.code || "unknown"}).`);
  pool.end().finally(() => { process.exitCode = 1; });
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => pool.end()));
}
