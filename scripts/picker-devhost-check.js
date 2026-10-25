const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const port = process.env.CDP_PORT || "9334";
const out = (name) => path.resolve(__dirname, "..", "preview", `picker-${name}.png`);
let passed = 0;
const polishFailures = [];

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const wb = browser.contexts()[0].pages().find((p) => p.url().includes("workbench"));
    assert.match(await wb.title(), /acp client-picker/);
    const session = await browser.newBrowserCDPSession();
    let id = 0;
    const pending = new Map();
    const contexts = [];
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
      if (m.error || m.result?.exceptionDetails) throw new Error(JSON.stringify(m.error ?? m.result.exceptionDetails));
      return m.result;
    });
    let app;
    const attach = async () => {
      contexts.length = 0;
      const attached = new Set();
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const { targetInfos } = await session.send("Target.getTargets");
        for (const t of targetInfos.filter((t) => t.type === "iframe" && t.url.includes("yaseen.shipwreck"))) {
          if (attached.has(t.targetId)) continue;
          attached.add(t.targetId);
          const { sessionId } = await session.send("Target.attachToTarget", { targetId: t.targetId, flatten: false });
          await send(sessionId, "Runtime.enable", {});
        }
        for (const c of contexts) {
          const result = await send(c.sessionId, "Runtime.evaluate", {
            expression: '!!document.querySelector(".app")', contextId: c.id, returnByValue: true,
          }).catch(() => undefined);
          if (result?.result?.value) { app = c; return; }
        }
        await wb.waitForTimeout(100);
      }
      throw new Error("Shipwreck webview context not found");
    };
    const ev = async (expression) => (await send(app.sessionId, "Runtime.evaluate", {
      expression, contextId: app.id, returnByValue: true, awaitPromise: true,
    })).result.value;
    const until = async (expression) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (await ev(expression)) return;
        await wb.waitForTimeout(50);
      }
      throw new Error(`Not observed: ${expression}`);
    };
    const click = async (selector) => {
      const target = await ev(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null;
        e.scrollIntoView({ block: "nearest" });
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2,
          width: innerWidth, height: innerHeight };
      })()`);
      assert.ok(target, selector);
      const frame = await wb.locator("iframe.webview.ready").boundingBox();
      await wb.mouse.click(frame.x + target.x * frame.width / target.width,
        frame.y + target.y * frame.height / target.height);
    };
    const key = (type, key, code, modifiers = 0) => send(app.sessionId, "Input.dispatchKeyEvent", {
      type, key, code, modifiers,
      windowsVirtualKeyCode: key === "Control" ? 17 : key === "Escape" ? 27 : key === "ArrowDown" ? 40 : key.charCodeAt(0),
    });
    const escape = async () => {
      await key("keyDown", "Escape", "Escape");
      await key("keyUp", "Escape", "Escape");
      await until('!document.querySelector(".model-picker")');
    };
    const open = async () => {
      await click(".mp-trigger");
      await until('!!document.querySelector(".model-picker [data-model]")');
    };
    const palette = async (command) => {
      await wb.click(".part.titlebar");
      await wb.keyboard.press("Control+Shift+P");
      const input = wb.locator(".quick-input-widget input");
      await input.waitFor({ state: "visible" });
      await input.fill(`>${command}`);
      await wb.getByRole("option", { name: new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
    };
    const shot = async (name) => {
      const pane = wb.locator(".part.auxiliarybar");
      const box = await pane.boundingBox();
      const height = Math.min(500, box.height);
      const clip = { x: box.x, y: box.y + box.height - height, width: box.width, height };
      if (name.endsWith("-closed")) {
        await ev("document.activeElement?.blur()");
        await wb.mouse.move(box.x + 5, box.y + 5);
      }
      await ev("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const cdp = await wb.context().newCDPSession(wb);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { ...clip, scale: 1 } });
      fs.writeFileSync(out(name), Buffer.from(data, "base64"));
      await cdp.detach();
      console.log("shot", out(name));
    };
    const check = (name) => { passed++; console.log(`ok: ${name}`); };
    const keyboardFocus = async (name) => {
      await key("keyDown", "ArrowDown", "ArrowDown");
      await key("keyUp", "ArrowDown", "ArrowDown");
      await until('document.activeElement?.matches(".model-picker [data-popitem]:focus-visible")');
      assert.equal(await ev('getComputedStyle(document.activeElement).outlineStyle'), "solid");
      assert.ok(parseFloat(await ev('getComputedStyle(document.activeElement).outlineWidth')) > 0);
      check(`${name} keyboard navigation retains the focus ring`);
    };
    const polish = async (name, expectedChecks) => {
      await until('document.activeElement?.matches(".model-picker [data-popitem]")');
      const metrics = await ev(`(() => {
        const active = document.activeElement, s = getComputedStyle(active);
        const rows = [...document.querySelectorAll(".model-picker .pop-item")];
        return {
          active: active.getAttribute("aria-label"), outline: s.outlineStyle,
          outlineWidth: s.outlineWidth, shadow: s.boxShadow, background: s.backgroundColor,
          checks: [...document.querySelectorAll(".model-picker .pop-check")].map(e => e.getBoundingClientRect().right),
          widths: rows.map(e => e.getBoundingClientRect().width),
          effortControls: [...document.querySelectorAll(".composer-foot button")].filter(e =>
            e.querySelector(".mp-effort") || e.getAttribute("aria-label")?.startsWith("Thinking:")).length,
        };
      })()`);
      console.log(name, JSON.stringify(metrics));
      const range = (values) => Math.max(...values) - Math.min(...values);
      const assertions = [
        [() => assert.ok(metrics.outline === "none" || metrics.outlineWidth === "0px"), "pointer active row has no outline"],
        [() => assert.equal(metrics.shadow, "none"), "pointer active row has no shadow ring"],
        [() => assert.notEqual(metrics.background, "rgba(0, 0, 0, 0)"), "pointer active row has a background"],
        [() => assert.equal(metrics.checks.length, expectedChecks), "selected checks exist"],
        [() => assert.ok(range(metrics.checks) <= 1), `check alignment spread ${range(metrics.checks)}px <= 1px`],
        [() => assert.ok(range(metrics.widths) <= 1), `row width spread ${range(metrics.widths)}px <= 1px`],
        [() => assert.equal(metrics.effortControls, 1), "effort appears in exactly one composer control"],
      ];
      for (const [run, rule] of assertions) {
        try { run(); check(`${name}: ${rule}`); }
        catch { polishFailures.push(`${name}: ${rule}`); console.log(`FAIL: ${name}: ${rule}`); }
      }
    };
    await Promise.all([wb.waitForEvent("domcontentloaded"), palette("Developer: Reload Window")]);
    await attach();
    const pane = await wb.locator(".part.auxiliarybar").boundingBox();
    if (pane.width < 420) {
      await wb.mouse.move(pane.x - 2, pane.y + 100);
      await wb.mouse.down();
      await wb.mouse.move(pane.x - (420 - pane.width), pane.y + 100, { steps: 10 });
      await wb.mouse.up();
    }
    if (await ev('!!document.querySelector(".model-picker")')) await escape();
    await open();
    await click('.model-picker [aria-label="Switch agent"]');
    await click('.model-picker [aria-label="Codex"]');
    await click('.model-picker [data-model][aria-label="GPT-5.4"]');
    await until('document.querySelector(".mp-trigger")?.getAttribute("aria-label") === "Agent and model: Codex · GPT-5.4"');
    await open();
    if (await ev('!!document.querySelector(\'.mp-star[aria-label="Unstar GPT-5.4 mini"]\')')) {
      await click('.mp-star[aria-label="Unstar GPT-5.4 mini"]');
    }
    await click('.mp-thought [aria-label="Medium"]');
    for (const theme of ["Dark Modern", "Light Modern"]) {
      const settingsPath = path.join(process.env.TEMP, "shipwreck-picker-host", "User", "settings.json");
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      settings["workbench.colorTheme"] = `Default ${theme}`;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      await until(`document.body.getAttribute("data-vscode-theme-name") === ${JSON.stringify(theme)}`);
      const name = theme.startsWith("Dark") ? "dark" : "light";
      await shot(`${name}-closed`);
      await open();
      const style = await ev(`(() => {
        const menu = document.querySelector(".model-picker");
        const trigger = document.querySelector(".mp-trigger");
        const row = menu.querySelector("[data-model]");
        const s = getComputedStyle(menu), r = getComputedStyle(row), t = getComputedStyle(trigger);
        return { width: menu.getBoundingClientRect().width, height: menu.getBoundingClientRect().height,
          padding: s.padding, radius: s.borderRadius, triggerHeight: trigger.getBoundingClientRect().height,
          triggerPadding: t.padding, text: r.fontSize, rowPadding: r.padding };
      })()`);
      assert.deepEqual({ ...style, height: 0, width: 0 }, {
        width: 0, height: 0, padding: "4px", radius: "12px", triggerHeight: 28,
        triggerPadding: "0px 8px", text: "12px", rowPadding: "4px 8px",
      });
      assert.ok(style.width >= 254 && style.width <= 280);
      assert.ok(style.height <= 316);
      check(`${theme} uses the measured menu and trigger dimensions`);
      await polish(`${theme} models`, 2);
      assert.equal(await ev('getComputedStyle(document.querySelector(\'.mp-star[aria-label="Star GPT-5.4"]\')).opacity'), "0");
      check(`${theme} pointer-focused model keeps an unstarred favorite control hidden`);
      await shot(`${name}-open`);
      await click('.model-picker [aria-label="Switch agent"]');
      await until('!!document.querySelector(\'.model-picker [aria-label="Claude"]\')');
      await polish(`${theme} agents`, 1);
      await shot(`${name}-agents`);
      await keyboardFocus(`${theme} agents`);
      await click('.model-picker [aria-label="Back"]');
      await until('!!document.querySelector(".mp-search")');
      await ev('document.querySelector(".mp-search").focus()');
      await send(app.sessionId, "Input.insertText", { text: "mini" });
      await until('document.querySelectorAll("[data-model]").length === 2');
      assert.deepEqual(await ev('[...document.querySelectorAll("[data-model] .pop-label")].map(e=>e.textContent)'), ["GPT-5.4 mini", "GPT-5.4 mini"]);
      await shot(`${name}-search`);
      await escape();
      await open();
      await key("keyDown", "Control", "ControlLeft", 2);
      await until('document.querySelectorAll(".mp-hint").length === 3');
      await shot(`${name}-ctrl`);
      await key("keyUp", "Control", "ControlLeft");
      await until('document.querySelectorAll(".mp-hint").length === 0');
      await keyboardFocus(`${theme} models`);
      assert.equal(await ev('getComputedStyle(document.activeElement.closest(".mp-model-row").querySelector(".mp-star")).opacity'), "1");
      check(`${theme} keyboard-focused model reveals its favorite control`);
      await escape();
      check(`${theme} supports agent navigation, cross-agent search, Escape and held-Ctrl hints`);
    }
    await open();
    await click('.mp-star[aria-label="Star GPT-5.4 mini"]');
    await escape();
    await Promise.all([wb.waitForEvent("domcontentloaded"), palette("Developer: Reload Window")]);
    await attach();
    await until('document.querySelector(".mp-effort")?.textContent === "Medium"');
    await open();
    assert.equal(await ev('document.querySelector("[data-model]").getAttribute("aria-label")'), "GPT-5.4 mini");
    assert.equal(await ev('document.querySelector(\'.mp-star[aria-label="Unstar GPT-5.4 mini"]\').getAttribute("aria-pressed")'), "true");
    assert.equal(await ev('getComputedStyle(document.querySelector(\'.mp-star[aria-label="Unstar GPT-5.4 mini"]\')).opacity'), "1");
    await polish("Light Modern favorites", 2);
    await shot("light-favorites");
    check("favorites persist through a real extension-host reload");
    await key("keyDown", "1", "Digit1", 2);
    await key("keyUp", "1", "Digit1");
    await until('document.querySelector(".mp-trigger").getAttribute("aria-label") === "Agent and model: Codex · GPT-5.4 mini"');
    check("Ctrl+1 changes the live agent model to the first favorite");
    await open();
    await click('.mp-thought [aria-label="High"]');
    await until('document.querySelector(".mp-effort").textContent === "High"');
    check("reasoning selection updates the live trigger");
    await open();
    await click('.model-picker [aria-label="Switch agent"]');
    await click('.model-picker [aria-label="Claude"]');
    await click('.model-picker [data-model][aria-label="GPT-5.3-Codex"]');
    await until('document.querySelector(".mp-trigger").getAttribute("aria-label") === "Agent and model: Claude · GPT-5.3-Codex"');
    check("agent drill-in and model selection switch the live session");
    assert.deepEqual(polishFailures, [], "picker polish regressions");
    console.log(`all ${passed} picker dev-host checks passed; 11 screenshots captured`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
