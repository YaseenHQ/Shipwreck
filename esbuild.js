const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const bridgeConfig = {
  entryPoints: ["src/ideBridge.ts"],
  bundle: true,
  outfile: "dist/ideBridge.js",
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: false,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/main.tsx", "webview/styles.css"],
  bundle: true,
  outdir: "dist",
  outExtension: { ".js": ".webview.js" },
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  const ext = await esbuild.context(extensionConfig);
  const bridge = await esbuild.context(bridgeConfig);
  const web = await esbuild.context(webviewConfig);
  if (watch) {
    await Promise.all([ext.watch(), bridge.watch(), web.watch()]);
    console.log("watching…");
  } else {
    await Promise.all([ext.rebuild(), bridge.rebuild(), web.rebuild()]);
    await ext.dispose();
    await bridge.dispose();
    await web.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
