/* Screenshot the webview harness with the cached Playwright Chromium. */
const path = require("path");
const { chromium } = require("playwright-core");

const CHROME =
  process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";

(async () => {
  const width = Number(process.env.SHOT_W || 380);
  const height = Number(process.env.SHOT_H || 820);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log("[page]", m.type(), m.text());
  });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  const file = path.resolve(__dirname, "..", "preview", "harness.html");
  await page.goto("file:///" + file.replace(/\\/g, "/") + (process.env.SHOT_HASH || ""));
  await page.waitForSelector(".app", { timeout: 8000 });
  await page.waitForTimeout(Number(process.env.SHOT_WAIT || 700));
  if (process.env.SHOT_CLICK) {
    await page.click(process.env.SHOT_CLICK);
    await page.waitForTimeout(250);
  }
  if (process.env.SHOT_CLICK2) {
    await page.click(process.env.SHOT_CLICK2);
    await page.waitForTimeout(250);
  }
  if (process.env.SHOT_SLASH) {
    await page.click(".composer textarea");
    await page.keyboard.type("/");
    await page.waitForTimeout(300);
  }
  if (process.env.SHOT_TYPE) {
    await page.evaluate((value) => {
      const ta = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(ta, value);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
    }, process.env.SHOT_TYPE);
    await page.waitForTimeout(250);
  }
  const out = path.resolve(__dirname, "..", "preview", process.env.SHOT_OUT || "shot.png");
  await page.screenshot({ path: out });
  if (process.env.SHOT_FULL === "1") {
    await page.screenshot({ path: out.replace(/\.png$/, "-full.png"), fullPage: true });
  }
  console.log("wrote", out);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
