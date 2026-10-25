const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { chromium } = require("playwright-core");

async function connect(port = process.env.CDP_PORT || "9333") {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
  assert.ok(wb, "development workbench is open");
  const ready = Date.now() + 20000;
  while (!(await wb.title()).includes("Extension Development Host") && Date.now() < ready) {
    await wb.waitForTimeout(100);
  }
  assert.match(await wb.title(), /Extension Development Host/);
  const session = await browser.newBrowserCDPSession();
  const pending = new Map();
  const contexts = [];
  let id = 0;
  let app;
  session.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    const m = JSON.parse(message);
    if (m.method === "Runtime.executionContextCreated") contexts.push({ sessionId, id: m.params.context.id });
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (sessionId, method, params) => new Promise((resolve, reject) => {
    const messageId = ++id;
    const timer = setTimeout(() => {
      pending.delete(messageId);
      reject(new Error(`CDP timeout for ${method}`));
    }, 10000);
    pending.set(messageId, (m) => { clearTimeout(timer); resolve(m); });
    session.send("Target.sendMessageToTarget", {
      sessionId, message: JSON.stringify({ id: messageId, method, params }),
    }).catch((e) => { clearTimeout(timer); pending.delete(messageId); reject(e); });
  }).then((m) => {
    if (m.error || m.result?.exceptionDetails) throw new Error("Webview CDP evaluation failed");
    return m.result;
  });
  const attach = async () => {
    contexts.length = 0;
    const attached = new Set();
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      const { targetInfos } = await session.send("Target.getTargets");
      for (const t of targetInfos.filter((t) => t.type === "iframe" && t.url.includes("yaseen.shipwreck"))) {
        if (attached.has(t.targetId)) continue;
        attached.add(t.targetId);
        const { sessionId } = await session.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
        await send(sessionId, "Runtime.enable", {});
      }
      for (const c of contexts) {
        const r = await send(c.sessionId, "Runtime.evaluate", {
          expression: '!!document.querySelector(".app")', contextId: c.id, returnByValue: true,
        }).catch(() => undefined);
        if (r?.result?.value) { app = c; return; }
      }
      await wb.waitForTimeout(100);
    }
    throw new Error("Shipwreck webview context not found");
  };
  const ev = async (expression) => (await send(app.sessionId, "Runtime.evaluate", {
    expression, contextId: app.id, returnByValue: true, awaitPromise: true,
  })).result.value;
  const until = async (expression, timeout = 15000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await ev(expression)) return;
      await wb.waitForTimeout(100);
    }
    throw new Error(`Not observed: ${expression}`);
  };
  const click = async (selector) => {
    await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const target = await ev(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      e.scrollIntoView({ block: "nearest", behavior: "instant" });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert.ok(target, selector);
    await send(app.sessionId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
    await send(app.sessionId, "Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await send(app.sessionId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
    await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  const palette = async (command) => {
    await wb.click(".part.titlebar");
    await wb.keyboard.press("Escape");
    await wb.keyboard.press("F1");
    const input = wb.locator(".quick-input-widget input");
    await input.waitFor({ state: "visible" });
    await input.fill(`>${command}`);
    await wb.getByRole("option", { name: new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    await wb.waitForTimeout(200);
  };
  const type = async (selector, text) => {
    await click(selector);
    await send(app.sessionId, "Input.insertText", { text });
  };
  return { browser, wb, attach, ev, until, click, palette, type };
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shipwreck-smoke-"));
  const workspace = path.join(temp, "workspace");
  const profile = path.join(temp, "profile");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(profile, "User"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sample.txt"), "smoke workspace\n");
  execFileSync("git", ["-C", workspace, "init", "--quiet"]);
  fs.writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify({
    "window.dialogStyle": "custom",
    "workbench.startupEditor": "none",
    "security.workspace.trust.enabled": false,
    "shipwreck.customAgents": ["A", "B"].map((letter) => ({
      name: `Smoke ${letter}`, command: process.execPath,
      args: [path.join(__dirname, "mock-agent.js"), "--name", `Smoke${letter}`,
        "--config-options", "--smoke-tools"],
      env: { SHIPWRECK_MOCK_DIR: path.join(temp, "mock") },
    })),
  }, null, 2));
  const server = require("net").createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const code = process.env.VSCODE_EXECUTABLE ||
    path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe");
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  if (pathKey) env[pathKey] = [...new Set(env[pathKey].split(path.delimiter))].join(path.delimiter);
  const host = spawn(code, [`--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, `--extensions-dir=${path.join(temp, "extensions")}`,
    "--new-window", "--disable-workspace-trust", workspace], { env, stdio: "ignore" });
  let launchError;
  host.on("error", (error) => { launchError = error; });
  let h;
  let passed = 0;
  const check = (name) => { passed++; console.log(`ok: ${name}`); };
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if ((await response.json()).some((target) => target.type === "page")) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    h = await connect(port);
    await h.wb.locator(".onboarding-a-close-btn").waitFor({ state: "visible", timeout: 10000 })
      .then(() => h.wb.locator(".onboarding-a-close-btn").click()).catch(() => {});
    await h.palette("Shipwreck: Open Agent Chat");
    await h.attach();
    await h.until('document.querySelector(".empty-title")?.textContent === "Choose an agent"');
    check("a: Home lists the isolated mock agents");
    await h.click(".empty-agent");
    await h.until('document.querySelector(".mp-effort")?.textContent === "Medium"');
    await h.click(".mp-trigger");
    await h.until('!!document.querySelector(".model-picker [data-model]")');
    await h.click('.model-picker [data-model][aria-label="GPT-5.3-Codex"]');
    await h.until('document.querySelector(".mp-trigger")?.getAttribute("aria-label") === "Agent and model: Smoke A · GPT-5.3-Codex"');
    check("a: mouse model selection updates the live session");
    await h.click(".mp-trigger");
    await h.until('!!document.querySelector(".mp-thought")');
    await h.click('.mp-thought [aria-label="High"]');
    await h.until('document.querySelector(".mp-effort")?.textContent === "High"');
    check("a: mouse effort selection updates the live session");
    const sendPrompt = async (text) => {
      await h.type(".composer textarea", text);
      await h.until(`document.querySelector(".composer textarea").value === ${JSON.stringify(text)}`);
      await h.until('!document.querySelector(".send-btn").disabled');
      await h.click(".send-btn");
      await h.until(`document.querySelector(".composer textarea").value === ""`);
    };
    await sendPrompt("Create hello.txt containing hi");
    await h.until('!!document.querySelector(".permission.pending")');
    check("b: streaming tool call requests permission");
    await h.click(".permission.pending .panel-actions button");
    await h.until('!!document.querySelector(".changes") && !document.querySelector(".send-btn.stop")');
    assert.equal(fs.readFileSync(path.join(workspace, "hello.txt"), "utf8"), "hi");
    assert.equal(await h.ev('document.querySelector(".changes-name").textContent'), "hello.txt");
    check("b: approved tool creates hello.txt and ends the turn");
    await h.click(".changes-head .changes-btn");
    await h.wb.waitForSelector(".monaco-diff-editor");
    check("c: Review opens the real editor diff");
    await h.click(".changes-head .changes-btn:last-child");
    await h.wb.getByRole("button", { name: "Undo", exact: true }).click();
    await h.until('document.querySelector(".changes")?.textContent.includes("Undone")');
    assert.equal(fs.existsSync(path.join(workspace, "hello.txt")), false);
    check("c: Undo removes the newly created file");
    await h.palette("Shipwreck: Agents");
    await h.until('!!document.querySelector(\'.agent-card:has(.agent-card-name[title="Smoke B"]) .primary\')');
    await h.click('.agent-card:has(.agent-card-name[title="Smoke B"]) .primary');
    await h.until('document.querySelector(".mp-trigger")?.getAttribute("aria-label") === "Agent and model: Smoke B · GPT-5.4" && document.querySelector(".mp-effort")?.textContent === "Medium"');
    await h.until('document.querySelector(".continue-chip")?.textContent.includes("Smoke B")');
    check("f: switching mid-thread shows the continue chip");
    await sendPrompt("Recall the first request");
    await h.until('[...document.querySelectorAll(".msg.agent")].some(e=>e.textContent.trim() === "SmokeB remembers hello.txt containing hi")');
    await h.until('!document.querySelector(".send-btn.stop")');
    assert.equal(await h.ev('!!document.querySelector(".continue-chip")'), false);
    check("f: second agent receives and answers from the earlier transcript");
    await h.palette("Shipwreck: Threads");
    await h.until('document.querySelector(".history.threads")?.textContent.includes("Create hello.txt containing hi")');
    check("g: Threads lists the shared conversation");
    await h.click('[aria-label="Back to chat"]');
    await Promise.all([h.wb.waitForEvent("domcontentloaded"), h.palette("Developer: Reload Window")]);
    await h.attach();
    await h.until('!!document.querySelector(".recent .thread-name")');
    await h.click(".recent .thread-name");
    await h.until('[...document.querySelectorAll(".msg.agent")].some(e=>e.textContent.trim() === "SmokeB remembers hello.txt containing hi")');
    assert.equal(await h.ev('document.querySelectorAll(".msg.user").length'), 2);
    check("g: saved transcript restores from Recent after a window reload");
    await h.palette("Shipwreck: New Chat");
    await h.until('document.querySelectorAll(".msg.user").length === 0');
    check("h: New Chat clears the conversation");
    for (const letter of ["A", "B"]) {
      await h.palette("Shipwreck: Agents");
      await h.until(`!!document.querySelector('[aria-label="Uninstall Smoke ${letter}"]')`);
      await h.click(`[aria-label="Uninstall Smoke ${letter}"]`);
      await h.wb.getByRole("button", { name: "Uninstall", exact: true }).click();
      await h.until(`!document.querySelector('[aria-label="Uninstall Smoke ${letter}"]')`);
      if (await h.ev('!!document.querySelector(\'[aria-label="Back to chat"]\')')) {
        await h.click('[aria-label="Back to chat"]');
      }
      check(`h: catalog uninstalls Smoke ${letter}`);
    }
    await h.until('document.querySelector(".empty-title")?.textContent === "Install an agent"');
    assert.equal(await h.ev('!!document.querySelector(".mp-trigger")'), false);
    check("h: uninstalling every agent returns Home without an agent selected");
    console.log(`all ${passed} devhost smoke checks passed`);
  } catch (error) {
    if (h) {
      const screenshot = path.join(temp, "failure.png");
      await h.wb.screenshot({ path: screenshot }).catch(() => {});
      console.error(`failure screenshot: ${screenshot}`);
    }
    throw error;
  } finally {
    if (h) {
      await h.wb.close().catch(() => {});
      await h.browser.close().catch(() => {});
    }
    host.kill();
  }
}

module.exports = { connect };

if (require.main === module) main().then(() => process.exit(0), (error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});
