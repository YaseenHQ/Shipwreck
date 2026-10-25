/* Builds shipwreck-icon.svg from shipwreck.svg and renders the PNG icon set. Run: node media/brand/render.js */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const CHROME =
  process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";
const dir = __dirname;
const site = path.resolve(dir, "..", "..", "site", "assets");

function iconSvg(glyph) {
  const inner = glyph.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#151a24"/>
      <stop offset="1" stop-color="#0b0d12"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <svg x="76" y="70" width="360" height="360" viewBox="0 0 64 64" fill="#f4f6fb" color="#f4f6fb">${inner}</svg>
</svg>
`;
}

function ogHtml(icon) {
  return `<html><body style="margin:0;width:1200px;height:630px;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box;
  background:radial-gradient(900px 480px at 50% -120px, rgba(26,124,255,0.28), transparent 70%), #0b0d12;color:#f4f6fb;
  font-family:'Segoe UI','Inter',system-ui,sans-serif">
  ${icon.replace("<svg ", '<svg width="240" height="240" style="flex:none;filter:drop-shadow(0 18px 40px rgba(0,82,214,0.35))" ')}
  <div>
    <div style="font-size:30px;font-weight:600;color:#9aa3b5;letter-spacing:-0.01em">Shipwreck for VS Code</div>
    <div style="margin-top:14px;font-size:66px;line-height:1.05;font-weight:800;letter-spacing:-0.035em">Run any ACP coding agent inside VS Code</div>
    <div style="margin-top:22px;font-size:26px;color:#9aa3b5">shipwreck.yaseen.zip</div>
  </div>
</body></html>`;
}

const outputs = [
  ["icon-128.png", 128, dir],
  ["icon-256.png", 256, dir],
  ["icon-512.png", 512, dir],
  ["favicon-32.png", 32, dir],
  ["apple-touch-icon-180.png", 180, dir],
];

(async () => {
  const glyph = fs.readFileSync(path.join(dir, "shipwreck.svg"), "utf8");
  const icon = iconSvg(glyph);
  fs.writeFileSync(path.join(dir, "shipwreck-icon.svg"), icon);
  const browser = await chromium.launch({ executablePath: CHROME });
  // Tiny viewports stall headless screenshots, so every size renders as an element in a fixed page.
  const page = await browser.newPage({ viewport: { width: 760, height: 600 } });
  const shoot = async (svg, size, file, background = "transparent") => {
    await page.setContent(
      `<html><body style="margin:0;background:${background}">` +
        svg.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `) +
        "</body></html>",
    );
    await page.locator("svg").first().screenshot({ path: file, omitBackground: background === "transparent" });
    console.log("wrote", file);
  };
  for (const [name, size, out] of outputs) await shoot(icon, size, path.join(out, name));
  if (fs.existsSync(site)) {
    fs.copyFileSync(path.join(dir, "icon-512.png"), path.join(site, "icon-512.png"));
    fs.copyFileSync(path.join(dir, "favicon-32.png"), path.join(site, "favicon.png"));
    fs.copyFileSync(path.join(dir, "apple-touch-icon-180.png"), path.join(site, "apple-touch-icon.png"));
    console.log("copied icons to", site);
    const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await og.setContent(ogHtml(icon));
    await og.screenshot({ path: path.join(site, "og.png") });
    await og.close();
    console.log("wrote", path.join(site, "og.png"));
  }
  if (process.argv.includes("--sheet")) {
    const g = glyph.replace(/currentColor/g, "#f4f6fb");
    const cell = (s, svg) =>
      `<img width="${s}" height="${s}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`;
    const sheetPage = await browser.newPage({ viewport: { width: 760, height: 190 } });
    await sheetPage.setContent(
      `<html><body style="margin:0;padding:20px;background:#1e1e1e;display:flex;gap:24px;align-items:center">` +
        [16, 24, 32, 64, 128].map((s) => cell(s, g)).join("") +
        [32, 128].map((s) => cell(s, icon)).join("") +
        `<div style="background:#f3f3f3;padding:8px;display:flex;gap:8px;color:#222">${cell(16, glyph.replace(/currentColor/g, "#424242"))}${cell(32, glyph.replace(/currentColor/g, "#424242"))}</div>` +
        "</body></html>",
    );
    await sheetPage.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
    const sheet = path.join(require("os").tmpdir(), "shipwreck-sheet.png");
    await sheetPage.screenshot({ path: sheet });
    console.log("wrote", sheet);
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
