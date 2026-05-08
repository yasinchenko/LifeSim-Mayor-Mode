import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = path.join(root, "artifacts", "life-sim", "dist", "public");
const apiEntry = path.join(root, "artifacts", "api-server", "dist", "index.mjs");
const host = process.env.HOST ?? "127.0.0.1";
const requestedPort = Number(process.env.PORT ?? 4123);

function assertBuiltArtifacts() {
  const missing = [];
  if (!fs.existsSync(path.join(staticDir, "index.html"))) {
    missing.push("artifacts/life-sim/dist/public/index.html");
  }
  if (!fs.existsSync(apiEntry)) {
    missing.push("artifacts/api-server/dist/index.mjs");
  }

  if (missing.length > 0) {
    console.error("Web preview artifacts are missing:");
    for (const item of missing) console.error(`  - ${item}`);
    console.error("\nRun `pnpm run web:build` first, then `pnpm run web:preview`.");
    process.exit(1);
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findPort(start) {
  for (let port = start; port < start + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${start} to ${start + 49}`);
}

assertBuiltArtifacts();

const port = await findPort(Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 4123);
console.log(`Starting LifeSim web preview at http://${host}:${port}`);

const child = spawn(process.execPath, ["--enable-source-maps", apiEntry], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOST: host,
    PORT: String(port),
    LIFESIM_STATIC_DIR: staticDir,
  },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
