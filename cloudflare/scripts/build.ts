import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
for (const worker of ["browser", "agent"]) {
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--outdir",
      resolve("dist", worker),
      "--config",
      resolve(worker, "wrangler.jsonc"),
    ],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
