// Lazy dependency loader: import a package, and if it isn't installed anywhere
// Node can resolve, install it into a shared cache dir and load it from there —
// so the visual-check scripts run without the user pre-installing anything.
//
// Resolution order (first hit wins):
//   1. Normal resolution from this script  → a project/global install the user already has.
//   2. The shared cache dir                → a copy a previous run installed.
//   3. Install into the cache dir, then load it.
//
// The cache dir never touches the target project's package.json / node_modules.
// Override its location with FIGMA_EXPORT_DEP_CACHE; opt out of auto-install with
// FIGMA_EXPORT_NO_INSTALL=1 (then a missing dep is a hard error with the fix command).
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE =
  process.env.FIGMA_EXPORT_DEP_CACHE ||
  join(homedir(), ".cache", "figma-export-visual-check");
const require = createRequire(import.meta.url);

// Resolve `pkg` to a file path, optionally only searching `paths`, then load it
// via dynamic import so both ESM-only and CommonJS packages work. Dynamic-importing
// a CJS file puts its module.exports on `.default` (named exports are best-effort),
// so unwrap `.default` to hand back the package's real export object/function.
async function importFrom(pkg, paths) {
  const resolved = require.resolve(pkg, paths ? { paths } : undefined);
  const m = await import(pathToFileURL(resolved).href);
  return m.default ?? m;
}

export async function loadDep(pkg) {
  try {
    return await importFrom(pkg); // 1. already resolvable from here
  } catch {}
  try {
    return await importFrom(pkg, [CACHE]); // 2. previously cached
  } catch {}

  if (process.env.FIGMA_EXPORT_NO_INSTALL) {
    console.error(
      `[visual-check] "${pkg}" is not installed and auto-install is disabled.\n` +
        `  Install it yourself:  npm i -D ${pkg}`,
    );
    process.exit(2);
  }

  // 3. install into the cache dir and load from there
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  if (!existsSync(join(CACHE, "package.json")))
    writeFileSync(
      join(CACHE, "package.json"),
      JSON.stringify({ name: "figma-export-visual-check", private: true }) + "\n",
    );
  console.error(`[visual-check] installing ${pkg} into ${CACHE} (one-time) …`);
  execSync(`npm i ${pkg}`, { cwd: CACHE, stdio: "inherit" });
  return importFrom(pkg, [CACHE]);
}
