const path = require("path");
const { chromium } = require("playwright-core");
const CHROME = "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";

(async () => {
  const b = await chromium.launch({ executablePath: CHROME });
  const p = await b.newPage({
    viewport: { width: Number(process.env.SHOT_W || 380), height: Number(process.env.SHOT_H || 820) },
    deviceScaleFactor: 2,
  });
  await p.goto("file:///" + path.resolve("preview/harness.html").replace(/\\/g, "/"));
  await p.waitForSelector(".app");
  await p.waitForTimeout(700);
  const tools = await p.$$(".tool");
  console.log("tools:", tools.length);
  for (const t of tools) {
    const bb = await t.boundingBox();
    const cls = await t.getAttribute("class");
    const txt = (await t.innerText()).slice(0, 80).replace(/\n/g, " | ");
    console.log(cls, JSON.stringify(bb), "->", txt);
  }
  const diffs = await p.$$(".diff");
  console.log("diffs:", diffs.length);
  const info = await p.evaluate(() => {
    const t = document.querySelector(".tool");
    const h = t.querySelector(".tool-head");
    const cs = getComputedStyle(h);
    const tc = getComputedStyle(t);
    const m = getComputedStyle(document.querySelector(".messages"));
    return {
      tool: { display: tc.display, height: tc.height, overflow: tc.overflow },
      head: { display: cs.display, fontSize: cs.fontSize, padding: cs.padding, height: cs.height },
      messages: { display: m.display, gap: m.gap },
    };
  });
  console.log(JSON.stringify(info));
  await p.screenshot({ path: "preview/zoom.png" });
  await b.close();
})();
