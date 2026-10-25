/* Enumerate webview iframes inside the workbench and screenshot them. */
const path = require("path");
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.connectOverCDP("http://localhost:9223");
  const ctx = browser.contexts()[0];
  const workbench = ctx.pages().find((p) => p.url().includes("workbench.html"));
  if (!workbench) throw new Error("no workbench");
  await workbench.bringToFront();
  await workbench.waitForTimeout(1000);

  const frames = workbench.frames();
  console.log("frames:", frames.length);
  for (const f of frames) {
    console.log(" -", f.url().slice(0, 140));
  }

  // Screenshot each iframe element by its bounding box on the workbench page.
  const handles = await workbench.$$("iframe, webview");
  console.log("iframe elements:", handles.length);
  let i = 0;
  for (const h of handles) {
    const box = await h.boundingBox();
    const src = (await h.getAttribute("src"))?.slice(0, 120);
    console.log(`[${i}] src=${src} box=${JSON.stringify(box)}`);
    if (box && box.width > 20 && box.height > 20) {
      await workbench.screenshot({
        path: path.resolve(__dirname, "..", "preview", `frame-${i}.png`),
        clip: box,
      });
    }
    i++;
  }
  await browser.close();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
