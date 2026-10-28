import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import solc from "solc";
import { network } from "hardhat";
import { BrowserProvider, ContractFactory } from "ethers";

const allowedMethods = new Set([
  "eth_chainId", "eth_accounts", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getCode", "eth_getBalance", "eth_getTransactionCount", "eth_getTransactionByHash",
  "eth_getTransactionReceipt", "eth_estimateGas", "eth_call", "eth_sendTransaction",
  "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas", "eth_getLogs", "net_version"
]);

export async function createDemoSession() {
  const require = createRequire(import.meta.url);
  const sources = Object.fromEntries(["asset_factory.sol", "asset_token.sol"].map((name) => [name, {
    content: readFileSync(new URL(`../../smart_contracts/${name}`, import.meta.url), "utf8")
  }]));
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } }
  }), { import: (path) => ({ contents: readFileSync(require.resolve(path), "utf8") }) }));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const connection = await network.connect();
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  try {
    const issuer = await provider.getSigner(0);
    const artifact = output.contracts["asset_factory.sol"].AssetTokenFactory;
    const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, issuer).deploy();
    await factory.waitForDeployment();
    const assetId = "demo-coffee";
    await (await factory.createAssetToken("Duong Coffee Token", "DCOF", 100000n, assetId,
      "Duong Coffee", "Business", 500000n, "USD", "urn:demo:coffee", "0x" + "0".repeat(64))).wait();
    const accounts = await Promise.all([0, 1, 2, 3].map(async (index) => ({
      name: ["Issuer / business owner", "Alice / investor", "Bob / investor", "Carol / investor"][index],
      address: (await provider.getSigner(index)).address
    })));
    const info = { sessionId: randomUUID(), chainId: String((await provider.getNetwork()).chainId),
      factory: await factory.getAddress(), token: await factory.tokenByAssetId(assetId), assetId, accounts };
    return {
      info,
      request: async ({ method, params = [] }) => {
        if (!allowedMethods.has(method)) throw new Error("RPC method unavailable in the local demo.");
        return connection.provider.request({ method, params });
      },
      advance: async (address) => {
        const { default: artifact } = await import("../src/generated/funding-campaign.js");
        const { Contract } = await import("ethers");
        const campaign = new Contract(address, artifact.abi, provider);
        if ((await campaign.assetToken()).toLowerCase() !== info.token.toLowerCase()) throw new Error("Load a campaign for the demo asset first.");
        const now = (await provider.getBlock("latest")).timestamp;
        const deadline = Number(await campaign.deadline());
        await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Math.max(now + 1, deadline + 1)] });
        await connection.provider.request({ method: "evm_mine", params: [] });
      },
      close: async () => { provider.destroy(); await connection.close(); }
    };
  } catch (error) { provider.destroy(); await connection.close(); throw error; }
}

// This plugin exists only in Vite's local development server, never the build.
export function localDemoPlugin() {
  let sessionPromise;
  return {
    name: "local-funding-demo", apply: "serve",
    configureServer(server) {
      server.httpServer?.once("close", () => { sessionPromise?.then((session) => session.close()).catch(() => {}); });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__demo/")) return next();
        const send = (status, value) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
        try {
          const host = new URL(`http://${req.headers.host}`);
          if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return send(403, { error: "Local demo is available on localhost only." });
          if (req.headers.origin && new URL(req.headers.origin).host !== host.host) return send(403, { error: "Cross-origin demo access rejected." });
          if (req.method !== "POST") return send(405, { error: "Use POST." });
          if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "Use application/json." });
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1000000) return send(413, { error: "Request too large." });
          }
          const args = JSON.parse(body || "{}");
          if (req.url === "/__demo/start") {
            sessionPromise ||= createDemoSession().catch((error) => { sessionPromise = undefined; throw error; });
            return send(200, (await sessionPromise).info);
          }
          if (!sessionPromise) return send(400, { error: "Start the local demo first." });
          const session = await sessionPromise;
          if (req.url === "/__demo/rpc") return send(200, { result: await session.request(args) });
          if (req.url === "/__demo/advance") { await session.advance(args.address); return send(200, { ok: true }); }
          return send(404, { error: "Unknown demo endpoint." });
        } catch (error) {
          console.error("Local demo request failed:", error.message);
          return send(400, { error: { message: error.message, code: error.code, data: error.data } });
        }
      });
    }
  };
}
