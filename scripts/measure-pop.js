/* Measure popover vs trigger alignment in the harness. */
const path = require("path");
const { chromium } = require("playwright-core");
const CHROME =
  process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";

(async () => {
  const width = Number(process.env.SHOT_W || 380);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width, height: 820 } });
  const file = path.resolve(__dirname, "..", "preview", "harness.html");
  await page.goto("file:///" + file.replace(/\\/g, "/"));
  await page.waitForSelector(".app");
  await page.waitForTimeout(600);
  const targets = [
    ["picker", ".mp-trigger"],
    ["mode", 'button[aria-label^="Mode"]'],
    ["effort", 'button[aria-label^="Thinking"]'],
    ["plus", 'button[aria-label="Add context"]'],
  ];
  for (const [name, sel] of targets) {
    await page.click(sel);
    await page.waitForTimeout(300);
    const r = await page.evaluate((s) => {
      const pop = document.querySelector(".popover");
      const trg = document.querySelector(s);
      if (!pop || !trg) return "missing";
      const pr = pop.getBoundingClientRect();
      const tr = trg.getBoundingClientRect();
      return {
        dLeft: +(pr.left - tr.left).toFixed(1),
        dRight: +(pr.right - tr.right).toFixed(1),
      };
    }, sel);
    console.log(name, JSON.stringify(r));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
