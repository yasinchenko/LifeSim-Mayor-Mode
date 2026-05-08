import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const shouldPackage = process.argv.includes("--package");

function run(args, env = {}) {
  const result = spawnSync(pnpm, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(["--filter", "@workspace/api-server", "run", "build"]);
run(["--filter", "@workspace/life-sim", "run", "build"], {
  BASE_PATH: "/",
  PORT: "4173",
});
run(["--filter", "@workspace/desktop", "run", "build"]);

if (shouldPackage) {
  run(["--filter", "@workspace/desktop", "run", "dist"]);
}
