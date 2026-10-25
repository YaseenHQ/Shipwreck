/* Reload the CDP-attached VS Code window, open the ACP view, screenshot the sidebar. */
const path = require("path");
const { chromium } = require("playwright-core");

const PORT = process.env.CDP_PORT || "9334";
const OUT = process.env.SHOT_OUT || "installed-sidebar.png";

async function palette(wb, text) {
  await wb.keyboard.press("Control+Shift+P");
  await wb.waitForSelector(".quick-input-widget input", { timeout: 8000 });
  await wb.keyboard.type(text, { delay: 15 });
  await wb.waitForTimeout(700);
  await wb.keyboard.press("Enter");
}

(async () => {
  let browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  let wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
  if (process.env.RELOAD !== "0") {
    await palette(wb, "Developer: Reload Window");
    await new Promise((r) => setTimeout(r, 6000));
    await browser.close();
    browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
    wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
  }
  await wb.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await wb.waitForTimeout(2000);
  await palette(wb, "Shipwreck: Open Agent Chat");
  await wb.waitForTimeout(Number(process.env.WAIT || 9000));
  const sidebar = await wb.$(".part.sidebar");
  const box = sidebar && (await sidebar.boundingBox());
  await wb.screenshot({ path: path.resolve(__dirname, "..", "preview", OUT), clip: box ?? undefined });
  console.log("done", JSON.stringify(box));
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
