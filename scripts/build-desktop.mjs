import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shouldPackage = process.argv.includes("--package");
const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(rootDir, "artifacts", "desktop");
const desktopPackage = require("../artifacts/desktop/package.json");
const electronVersion = desktopPackage.devDependencies.electron;

function run(args, env = {}) {
  runCommand(pnpm, args, { env: { ...process.env, ...env } });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function rebuildElectronNativeDeps() {
  if (!electronVersion) {
    console.error("Electron version is not declared in artifacts/desktop/package.json.");
    process.exit(1);
  }

  runCommand(
    npm,
    [
      "rebuild",
      "better-sqlite3",
      "--runtime=electron",
      `--target=${electronVersion}`,
      "--disturl=https://electronjs.org/headers",
      "--build-from-source",
    ],
    { cwd: desktopDir },
  );
}

run(["--filter", "@workspace/api-server", "run", "build"]);
run(["--filter", "@workspace/life-sim", "run", "build"], {
  BASE_PATH: "/",
  PORT: "4173",
});
run(["--filter", "@workspace/desktop", "run", "build"]);

if (shouldPackage) {
  rebuildElectronNativeDeps();
  run(["--filter", "@workspace/desktop", "run", "dist"]);
}
