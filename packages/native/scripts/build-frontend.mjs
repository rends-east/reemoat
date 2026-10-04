/**
 * `tauri build`'s `beforeBuildCommand`: builds `packages/web`, then drops its source maps,
 * which `frontendDist` would otherwise embed in every binary. Rewrites `dist` under a running `pnpm cp` (Q5.15).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dist = join(root, "packages/web/dist");

// Windows `pnpm` is `pnpm.cmd`, which Node refuses to spawn without a shell (CVE-2024-27980);
// the arguments are literals, which is what makes the shell safe.
const built = spawnSync("pnpm", ["--filter", "@reemoat/web", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.status !== 0) process.exit(built.status ?? 1);

let dropped = 0;
let bytes = 0;
const sweep = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(path);
    } else if (entry.name.endsWith(".map")) {
      bytes += statSync(path).size;
      unlinkSync(path);
      dropped += 1;
    }
  }
};
sweep(dist);
process.stdout.write(
  `  dropped ${dropped} source map${dropped === 1 ? "" : "s"}, ${(bytes / 1_000_000).toFixed(1)} MB, before embedding\n`,
);
