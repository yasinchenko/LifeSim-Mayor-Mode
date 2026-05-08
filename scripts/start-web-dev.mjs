import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiEntry = path.join(root, "artifacts", "api-server", "dist", "index.mjs");
const webRoot = path.join(root, "artifacts", "life-sim");
const viteEntry = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
const host = process.env.HOST ?? "127.0.0.1";

function assertFile(file, hint) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(root, file)}.`);
    console.error(hint);
    process.exit(1);
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function findPort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${start} to ${start + 49}`);
}

assertFile(apiEntry, "Run `pnpm --filter @workspace/api-server run build` first.");
assertFile(viteEntry, "Run `pnpm install` first.");

const apiPort = await findPort(Number(process.env.API_PORT ?? 4123));
const webPort = await findPort(Number(process.env.PORT ?? 4173));
const apiUrl = `http://${host}:${apiPort}`;
const webUrl = `http://${host}:${webPort}`;

console.log(`Starting API at ${apiUrl}`);
const api = spawn(process.execPath, ["--enable-source-maps", apiEntry], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: host,
    PORT: String(apiPort),
  },
});

console.log(`Starting Vite web preview at ${webUrl}`);
const vite = spawn(process.execPath, [viteEntry, "--config", "vite.config.ts", "--host", "0.0.0.0"], {
  cwd: webRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: host,
    PORT: String(webPort),
    API_PROXY_TARGET: apiUrl,
  },
});

function stopAll(signal) {
  api.kill(signal);
  vite.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopAll(signal));
}

api.on("exit", (code) => {
  vite.kill("SIGTERM");
  process.exit(code ?? 0);
});

vite.on("exit", (code) => {
  api.kill("SIGTERM");
  process.exit(code ?? 0);
});
