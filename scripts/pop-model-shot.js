/* Capture the model menu and installed-agent submenu. */
const path = require("path");
const { chromium } = require("playwright-core");
const CHROME =
  process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 380, height: 820 } });
  const file = path.resolve(__dirname, "..", "preview", "harness.html");
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  await page.waitForSelector(".app");
  await page.waitForTimeout(600);
  await page.click(".mp-trigger");
  await page.waitForTimeout(300);
  const out = path.resolve(__dirname, "..", "preview", "picker-v2-harness-models.png");
  await page.screenshot({ path: out });
  console.log("wrote", out);
  await page.getByRole("menuitem", { name: "Switch agent", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Affogato", exact: true }).waitFor();
  await page.screenshot({ path: path.resolve(__dirname, "..", "preview", "picker-v2-harness-agents.png") });
  console.log("2 screenshots captured; 0 failures");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
