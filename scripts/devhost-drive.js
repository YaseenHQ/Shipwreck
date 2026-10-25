/* Drive the Extension Development Host over CDP (port 9333).
   Usage: node scripts/devhost-drive.js '<json steps>'
   Steps: {cmd:"Title in palette"} {key:"Control+L"} {wait:ms} {shot:"name.png"}
          {click:"workbench css"} {web:"js run in the ACP webview"} {webclick:"css in webview"}
          {notes:true} prints visible notifications. {wbeval:"js run in the workbench page"} */
const path = require("path");
const { chromium } = require("playwright-core");
const PORT = process.env.CDP_PORT || "9333";
const steps = JSON.parse(process.argv[2]?.startsWith("@")
  ? require("fs").readFileSync(process.argv[2].slice(1), "utf8")
  : process.argv[2] || "[]");
const out = (n) => path.resolve(__dirname, "..", "preview", n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function webviewFrame(wb) {
  for (let i = 0; i < 20; i++) {
    for (const f of wb.frames()) {
      try {
        if (await f.evaluate(() => !!document.querySelector(".app"))) return f;
      } catch {}
    }
    await sleep(500);
  }
  return undefined;
}

let webCall;
async function webviewEval(browser, expression) {
  if (!webCall) {
    const session = await browser.newBrowserCDPSession();
    const { targetInfos } = await session.send("Target.getTargets");
    const targets = targetInfos.filter((t) => t.type === "iframe" && t.url.includes("vscode-webview") && t.url.includes("yaseen.shipwreck"));
    let msgId = 0;
    const pending = new Map();
    const contexts = [];
    session.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      const m = JSON.parse(message);
      if (m.method === "Runtime.executionContextCreated") contexts.push({ sessionId, id: m.params.context.id });
      else if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const raw = (sessionId, expr, contextId) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, resolve);
      session.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) } }) }).catch(reject);
    }).then((m) => {
      if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400));
      return m.result?.result?.value;
    });
    for (const t of targets) {
      const { sessionId } = await session.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
      msgId++;
      await session.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: msgId, method: "Runtime.enable", params: {} }) });
    }
    await sleep(1200);
    for (const c of contexts) {
      const ok = await raw(c.sessionId, `!!document.querySelector(".app")`, c.id).catch(() => false);
      if (ok) { webCall = (e) => raw(c.sessionId, e, c.id); break; }
    }
    if (!webCall) throw new Error(`ACP webview context not found (${targets.length} targets)`);
  }
  return webCall(expression);
}

(async () => {  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
  const wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
  if (!wb) throw new Error("no workbench page");
  await wb.waitForSelector(".monaco-workbench", { timeout: 30000 });
  for (const s of steps) {
    if (s.wait) await sleep(s.wait);
    if (s.cmd) {
      await wb.keyboard.press("Control+Shift+P");
      await wb.waitForSelector(".quick-input-widget input", { timeout: 8000 });
      await wb.keyboard.type(s.cmd, { delay: 10 });
      await sleep(600);
      await wb.keyboard.press("Enter");
      await sleep(s.after ?? 1500);
    }
    if (s.wbeval) console.log("wb:", JSON.stringify(await wb.evaluate(s.wbeval).catch((e) => "ERR " + e.message)));
    if (s.key) { await wb.keyboard.press(s.key); await sleep(400); }
    if (s.type) { await wb.keyboard.type(s.type, { delay: 10 }); await sleep(300); }
    if (s.click) { await wb.click(s.click, { timeout: 5000 }).catch((e) => console.log("click failed", s.click, e.message)); await sleep(800); }
    if (s.web || s.webclick) {
      if (s.webclick) {
        const ok = await webviewEval(browser, `(() => { const el = document.querySelector(${JSON.stringify(s.webclick)}); if (!el) return false; el.click(); return true; })()`).catch((e) => "ERR " + e.message);
        console.log("webclick", s.webclick, ok);
      }
      if (s.web) console.log("web:", JSON.stringify(await webviewEval(browser, s.web).catch((e) => "ERR " + e.message)));
      await sleep(s.after ?? 600);
    }
    if (s.notes) {
      const t = await wb.$$eval(".notifications-toasts .notification-list-item, .notification-toast", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
      console.log("notifications:", JSON.stringify(t));
    }
    if (s.shot) {
      const cdp = await wb.context().newCDPSession(wb);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      require("fs").writeFileSync(out(s.shot), Buffer.from(data, "base64"));
      await cdp.detach();
      console.log("shot", s.shot);
    }
  }
  await browser.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
