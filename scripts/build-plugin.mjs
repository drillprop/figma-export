// Builds the Figma plugin: bundles plugin/src/code.ts -> plugin/code.js, and
// bundles plugin/src/ui.ts, inlining it into plugin/ui.html (Figma loads the UI
// as a single HTML string, so the script must be inlined, not referenced).
//
//   node scripts/build-plugin.mjs           one-shot build
//   node scripts/build-plugin.mjs --watch    rebuild on change
import * as esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const shared = { bundle: true, target: "es2017", logLevel: "info" };

const codeCtx = await esbuild.context({
  ...shared,
  entryPoints: ["plugin/src/code.ts"],
  outfile: "plugin/code.js",
  format: "iife",
});

const inlineHtml = {
  name: "inline-html",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const js = result.outputFiles?.[0]?.text ?? "";
      const template = await readFile("plugin/ui.template.html", "utf8");
      // Function replacement avoids `$`-pattern interpretation in the bundle.
      const html = template.replace("__UI_SCRIPT__", () => `<script>\n${js}\n</script>`);
      await writeFile("plugin/ui.html", html);
      console.log("built plugin/ui.html");
    });
  },
};

const uiCtx = await esbuild.context({
  ...shared,
  entryPoints: ["plugin/src/ui.ts"],
  write: false,
  format: "iife",
  plugins: [inlineHtml],
});

if (watch) {
  await Promise.all([codeCtx.watch(), uiCtx.watch()]);
  console.log("watching plugin sources — Ctrl+C to stop");
} else {
  await Promise.all([codeCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([codeCtx.dispose(), uiCtx.dispose()]);
  console.log("plugin build complete");
}
