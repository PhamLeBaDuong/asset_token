import { defineConfig } from "vite";
import { localDemoPlugin } from "./scripts/demo-server.mjs";

export default defineConfig({
  plugins: [localDemoPlugin()],
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
  preview: { proxy: { "/api": "http://127.0.0.1:3001" } }
});
