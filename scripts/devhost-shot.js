/* Attach to the Extension Development Host on :9333, open the ACP view,
   and screenshot the sidebar (view title bar + webview). */
const path = require("path");
const { chromium } = require("playwright-core");

const PORT = process.env.CDP_PORT || "9333";
const OUT = process.env.SHOT_OUT || "devhost-sidebar.png";

(async () => {
  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const ctx = browser.contexts()[0];
  const wb = ctx.pages().find((p) => p.url().includes("workbench"));
  if (!wb) throw new Error("no workbench page");
  await wb.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await wb.waitForTimeout(2500);
  await wb.bringToFront();

  // Open the ACP view via the command palette.
  await wb.keyboard.press("Control+Shift+P");
  await wb.waitForSelector(".quick-input-widget input", { timeout: 8000 });
  await wb.keyboard.type("Shipwreck: Open Agent Chat", { delay: 15 });
  await wb.waitForTimeout(700);
  await wb.keyboard.press("Enter");
  await wb.waitForTimeout(2500);

  // Screenshot the whole sidebar (includes the view title bar).
  const sidebar = await wb.$(".part.sidebar, .part.auxiliarybar");
  if (sidebar) {
    const box = await sidebar.boundingBox();
    console.log("sidebar box", JSON.stringify(box));
    if (box) {
      await wb.screenshot({
        path: path.resolve(__dirname, "..", "preview", OUT),
        clip: box,
      });
    }
  }
  await wb.screenshot({ path: path.resolve(__dirname, "..", "preview", "devhost-full.png") });
  console.log("done");
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
