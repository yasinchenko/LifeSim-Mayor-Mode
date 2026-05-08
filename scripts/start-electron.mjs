import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const command = process.platform === "win32" ? "electron.cmd" : "electron";
const env = { ...process.env };
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(command, ["."], {
  cwd: path.join(repoRoot, "artifacts", "desktop"),
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 0);
