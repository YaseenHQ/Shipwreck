/* CDP-attached VS Code: click a title-bar action (or dispatch a webview event) and screenshot the sidebar. */
const path = require("path");
const { chromium } = require("playwright-core");

const PORT = process.env.CDP_PORT || "9334";
const OUT = process.env.SHOT_OUT || "devhost-view.png";
const ACTION = process.env.ACTION || ""; // e.g. "Agents", "Threads"

(async () => {
  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
  await wb.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await wb.waitForTimeout(1500);
  if (ACTION) {
    await wb.click(`.part.sidebar .actions-container [aria-label="${ACTION}"]`, { timeout: 8000 });
    await wb.waitForTimeout(Number(process.env.WAIT || 1200));
  }
  const sidebar = await wb.$(".part.sidebar");
  const box = sidebar && (await sidebar.boundingBox());
  await wb.screenshot({ path: path.resolve(__dirname, "..", "preview", OUT), clip: box ?? undefined });
  console.log("done", JSON.stringify(box));
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
