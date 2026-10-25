/* Attach to a running VS Code via CDP, run a command, screenshot webview targets. */
const path = require("path");
const { chromium } = require("playwright-core");

const CMD = process.env.VSC_CMD || "Poolside: Show Sidebar";
const OUT = process.env.SHOT_OUT || "ref-shot.png";

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9223");
  const ctx = browser.contexts()[0];
  const workbench = ctx.pages().find((p) => p.url().includes("workbench.html"));
  if (!workbench) throw new Error("no workbench page");
  await workbench.waitForSelector(".monaco-workbench", { timeout: 20000 });
  await workbench.waitForTimeout(1500);
  await workbench.bringToFront();
  await workbench.mouse.click(640, 400);
  await workbench.waitForTimeout(400);

  // Trigger the command through the quick-open palette.
  await workbench.keyboard.press("Control+Shift+P");
  await workbench.waitForSelector(".quick-input-widget input", { timeout: 8000 });
  await workbench.keyboard.type(CMD, { delay: 10 });
  await workbench.waitForTimeout(600);
  await workbench.screenshot({ path: path.resolve(__dirname, "..", "preview", "cmd-palette.png") });
  await workbench.keyboard.press("Enter");
  await workbench.waitForTimeout(4000);

  // Enumerate targets again — webviews live in separate pages.
  for (const p of ctx.pages()) {
    console.log("page:", p.url().slice(0, 120));
  }
  const webviews = ctx.pages().filter((p) => /vscode-webview|webview/.test(p.url()));
  console.log("webview targets:", webviews.length);

  let i = 0;
  for (const w of webviews) {
    try {
      await w.waitForTimeout(500);
      await w.screenshot({ path: path.resolve(__dirname, "..", "preview", `${OUT.replace(".png", "")}-${i}.png`) });
      i++;
    } catch (e) {
      console.log("shot failed:", e.message.slice(0, 120));
    }
  }
  await workbench.screenshot({ path: path.resolve(__dirname, "..", "preview", "workbench.png") });
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
