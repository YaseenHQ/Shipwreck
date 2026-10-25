/* Headless UI check of config-option composer behavior via the harness
   (cached Playwright Chromium, file:// — no network). Captures
   preview/config-*.png. Any page error or failed assert fails the script. */
const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { chromium } = require("playwright-core");

const CHROME =
  process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";
const file = path.resolve(__dirname, "..", "preview", "harness.html");
const url = (hash = "") => "file:///" + file.replace(/\\/g, "/") + hash;
const shot = (n) => path.resolve(__dirname, "..", "preview", n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
const errors = [];
const t = async (name, fn) => {
  await fn();
  n++;
  console.log(`ok: ${name}`);
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 380, height: 820 } });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.addInitScript(() => {
    window.__initialSnapshots = 0;
    window.addEventListener("message", (e) => {
      if (e.data?.type === "snapshot") window.__initialSnapshots++;
    });
  });
  const ev = (expr) => page.evaluate(expr);
  await page.goto(url());
  await page.waitForSelector(".composer textarea", { timeout: 8000 });
  await page.waitForFunction(() => window.__initialSnapshots >= 2);
  await page.evaluate(() => {
    window.__prefs.modelFavorites = [];
    window.dispatchEvent(new MessageEvent("message", { data: {
      type: "snapshot",
      payload: { ...window.__snapshot, prefs: { ...window.__snapshot.prefs, modelFavorites: [] } },
    } }));
  });

  await t("footer: permissions, model with effort, remaining model options", async () => {
    const labels = await ev(
      `[...document.querySelectorAll(".composer-foot-left button")].map(b => b.getAttribute("aria-label"))`,
    );
    assert.deepStrictEqual(labels, [
      "Add context",
      "Mode: Code",
      "Agent and model: Affogato · Sonnet 4.5",
      "Model options",
    ]);
    const pills = await ev(
      `[...document.querySelectorAll(".mode-pill, .mp-trigger, .traits-pill")].map(b => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, svg: !!b.querySelector("svg, .agent-logo, .agent-logo-img") }; })`,
    );
    assert.strictEqual(pills.length, 3);
    for (const p of pills) {
      assert.ok(p.svg, "pill has icon");
      assert.ok(p.h >= 24 && p.w >= 24, `pill hit area >=24px (got ${p.w}x${p.h})`);
    }
    assert.strictEqual(await ev(`!!document.querySelector(".effort-slider")`), false);
    assert.strictEqual(await ev(`!!document.querySelector(".agent-pill, .cfg-pill.cat-model")`), false);
    assert.strictEqual(await ev(`document.querySelector(".mode-pill .pill-label")?.textContent`), "Code");
    assert.strictEqual(
      await ev(`!!document.querySelector(".mp-trigger .agent-logo, .mp-trigger .agent-logo-img")`),
      false,
      "model trigger has no provider logo",
    );
    assert.strictEqual(await ev(`document.querySelector(".mp-trigger .pill-label").textContent`), "Sonnet 4.5");
    assert.strictEqual(await page.locator(".mp-effort").textContent(), "Medium");
    assert.strictEqual(await page.locator(".mp-trigger").evaluate((e) => e.getBoundingClientRect().height), 28);
  });

  await t("model options button visible when other options exist", async () => {
    assert.strictEqual(
      await ev(`!!document.querySelector('.traits-pill')`),
      true,
    );
  });

  const openPicker = async (pg = page) => {
    await pg.click(".mp-trigger");
    await pg.waitForSelector(".model-picker", { timeout: 3000 });
    await sleep(60);
  };
  const optNames = (pg = page) =>
    pg.locator(".model-picker [data-model], .model-picker .mp-content > [role=menuitemradio]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const sentSince = (i) => ev(`window.__sent.slice(${i})`);
  const switchAgent = async (name) => {
    await page.getByRole("menuitem", { name: "Switch agent", exact: true }).click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
  };

  await t("picker opens on active models with description tooltips, groups, current choice and probe", async () => {
    const before = await ev(`window.__sent.length`);
    await openPicker();
    assert.ok((await sentSince(before)).some((m) => m.type === "probeAgents"));
    assert.strictEqual(await page.getByRole("menu", { name: "Affogato models" }).count(), 1);
    assert.strictEqual((await optNames()).length, 40);
    assert.strictEqual(await page.getByRole("menuitemradio", { name: "Sonnet 4.5", exact: true }).getAttribute("aria-checked"), "true");
    assert.strictEqual(await page.locator(".model-picker .pop-head").allTextContents().then((a) => a.filter((s) => s === "Claude").length), 2);
    assert.strictEqual(await page.getByRole("menuitemradio", { name: "Sonnet 4.5", exact: true }).getAttribute("title"),
      "Sonnet 4.5\nFast everyday coding");
    assert.strictEqual(await ev(`document.activeElement.getAttribute("aria-label")`), "Sonnet 4.5");
    assert.strictEqual(await page.getByRole("textbox", { name: "Search models" }).count(), 1);
    assert.strictEqual(await page.getByRole("button", { name: "Star Sonnet 4.5", exact: true }).getAttribute("aria-pressed"), "false");
    assert.strictEqual(await page.getByRole("menuitem", { name: "Switch agent", exact: true }).textContent(), "AgentAffogato");
    await page.screenshot({ path: shot("config-model.png") });
  });

  await t("Down/Up/Enter pick Haiku and return focus to trigger", async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    assert.strictEqual(await ev(`document.activeElement.getAttribute("aria-label")`), "Haiku 4.5");
    const before = await ev(`window.__sent.length`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "demo-agent", value: "haiku-4.5" });
    assert.strictEqual(await ev(`document.activeElement.classList.contains("mp-trigger")`), true);
  });

  await t("search spans agents, ranks matches and supports empty results", async () => {
    await openPicker();
    const filter = page.getByRole("textbox", { name: "Search models" });
    await filter.fill("gpt-5");
    assert.deepStrictEqual(await optNames(), ["GPT-5", "GPT-5 Codex", "GPT-5 mini", "GPT-5 nano", "GPT-5"]);
    await filter.fill("opencode");
    assert.deepStrictEqual(await optNames(), ["Kimi K2", "GPT-5", "Sonnet 4.5"]);
    await filter.fill("does-not-exist");
    assert.deepStrictEqual(await optNames(), []);
    assert.strictEqual(await page.getByRole("status").last().textContent(), "No models match.");
    await filter.fill("long display");
    assert.deepStrictEqual(await optNames(), ["Sonnet 3.7 with an unusually long display name for truncation"]);
    await page.keyboard.press("Escape");
  });

  await t("Ctrl+digit selects the numbered model and hints appear only while held", async () => {
    await openPicker();
    const before = await ev(`window.__sent.length`);
    assert.deepStrictEqual(await page.locator(".mp-hint").allTextContents(), []);
    await page.keyboard.down("Control");
    assert.deepStrictEqual(await page.locator(".mp-hint").allTextContents(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    await page.keyboard.up("Control");
    assert.deepStrictEqual(await page.locator(".mp-hint").allTextContents(), []);
    await page.keyboard.press("Control+2");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "demo-agent", value: "opus-4.1" });
  });

  await t("favorites persist across reopening and a host snapshot, and can select another agent", async () => {
    await openPicker();
    const before = await ev(`window.__sent.length`);
    await page.getByRole("menuitemradio", { name: "Opus 4.1", exact: true }).hover();
    await page.getByRole("button", { name: "Star Opus 4.1", exact: true }).click();
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "setPref"), {
      type: "setPref", key: "modelFavorites", value: [{ agentId: "demo-agent", value: "opus-4.1" }],
    });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "snapshot",
      payload: { ...window.__snapshot, prefs: { ...window.__snapshot.prefs, ...window.__prefs } },
    } })));
    await openPicker();
    assert.strictEqual(await page.getByRole("button", { name: "Unstar Opus 4.1", exact: true }).getAttribute("aria-pressed"), "true");
    assert.strictEqual((await optNames())[0], "Opus 4.1");
    await page.getByRole("button", { name: "Unstar Opus 4.1", exact: true }).click();
    await page.getByRole("textbox", { name: "Search models" }).fill("kimi opencode");
    await page.getByRole("menuitemradio", { name: "Kimi K2", exact: true }).hover();
    await page.getByRole("button", { name: "Star Kimi K2", exact: true }).click();
    await page.keyboard.press("Escape");
    await openPicker();
    assert.strictEqual((await optNames())[0], "Kimi K2");
    const next = await ev(`window.__sent.length`);
    await page.keyboard.press("Control+1");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(next)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "opencode", value: "kimi-k2" });
    await openPicker();
    await page.getByRole("button", { name: "Unstar Kimi K2", exact: true }).click();
    assert.deepStrictEqual(await ev(`window.__prefs.modelFavorites`), []);
    await page.keyboard.press("Escape");
  });

  await t("picker reasoning section posts the selected effort", async () => {
    await openPicker();
    const before = await ev(`window.__sent.length`);
    await page.getByRole("group", { name: "Effort", exact: true }).getByRole("menuitemradio", { name: "High", exact: true }).click();
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "setConfigOption"),
      { type: "setConfigOption", configId: "effort", value: "high" });
  });

  await t("Ctrl+' toggles the picker", async () => {
    await page.click(".composer textarea");
    await page.keyboard.press("Control+'");
    await page.waitForSelector(".model-picker");
    await page.keyboard.press("Control+'");
    await page.waitForSelector(".model-picker", { state: "detached" });
  });

  await t("Switch agent shows installed agents, current check, status hints and Back", async () => {
    await openPicker();
    await page.getByRole("menuitem", { name: "Switch agent", exact: true }).click();
    assert.deepStrictEqual(await optNames(), ["Affogato", "OpenCode", "Devin", "Qwen Code"]);
    assert.strictEqual(await page.getByRole("menuitemradio", { name: "Affogato", exact: true }).getAttribute("aria-checked"), "true");
    assert.match(await page.getByRole("menuitemradio", { name: "Devin", exact: true }).textContent(), /Sign in needed/);
    assert.match(await page.getByRole("menuitemradio", { name: "Qwen Code", exact: true }).textContent(), /Loading models/);
    await page.getByRole("menuitem", { name: "Back", exact: true }).click();
    assert.strictEqual((await optNames())[0], "Sonnet 4.5");
    await page.keyboard.press("Escape");
  });

  await t("agent then model is one flow; typing filters even a small list", async () => {
    await openPicker();
    const before = await ev(`window.__sent.length`);
    await switchAgent("OpenCode");
    assert.deepStrictEqual(await optNames(), ["Kimi K2", "GPT-5", "Sonnet 4.5"]);
    assert.strictEqual(await page.getByRole("textbox", { name: "Search models" }).count(), 1);
    assert.deepStrictEqual((await sentSince(before)).filter((m) => m.type === "pickModel"), []);
    await page.keyboard.type("kimi opencode");
    assert.strictEqual(await page.getByRole("textbox", { name: "Search models" }).inputValue(), "kimi opencode");
    assert.deepStrictEqual(await optNames(), ["Kimi K2"]);
    await page.keyboard.press("Enter");
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "opencode", value: "kimi-k2" });
    await page.waitForSelector(".model-picker", { state: "detached" });
  });

  await t("auth notice signs in to shown agent and closes", async () => {
    await openPicker();
    await switchAgent("Devin");
    assert.strictEqual(await page.locator(".mp-notice span").textContent(), "Devin needs you to sign in.");
    const before = await ev(`window.__sent.length`);
    await page.getByRole("menuitem", { name: "Sign in", exact: true }).click();
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"), { type: "pickModel", agentId: "devin" });
    await page.waitForSelector(".model-picker", { state: "detached" });
  });

  const pushQwen = (qwen) => page.evaluate((q) => window.dispatchEvent(new MessageEvent("message", { data: {
    type: "agentModels", agentModels: window.__snapshot.agentModels.map((a) => a.agentId === "qwen" ? { ...a, ...q } : a) } })), qwen);
  await t("loading changes to error; Retry reprobes; no-choice agent selects directly", async () => {
    await openPicker();
    await switchAgent("Qwen Code");
    assert.strictEqual(await page.locator(".model-picker [role=status]").textContent(), "Loading models…");
    await pushQwen({ status: "error", message: "Qwen Code exited before listing models." });
    await page.getByText("Qwen Code exited before listing models.", { exact: true }).waitFor();
    const before = await ev(`window.__sent.length`);
    await page.getByRole("menuitem", { name: "Retry", exact: true }).click();
    assert.ok((await sentSince(before)).some((m) => m.type === "probeAgents"));
    await pushQwen({ status: "ready", message: undefined });
    await page.getByRole("menuitem", { name: "Switch agent", exact: true }).click();
    const next = await ev(`window.__sent.length`);
    await page.getByRole("menuitemradio", { name: "Qwen Code", exact: true }).click();
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(next)).find((m) => m.type === "pickModel"), { type: "pickModel", agentId: "qwen" });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "agentModels", agentModels: window.__snapshot.agentModels } })));
  });

  await t("600 models can be filtered then selected with keyboard", async () => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "agentModels", agentModels: window.__snapshot.agentModels.map((a) => a.agentId === "opencode"
        ? { ...a, models: Array.from({ length: 600 }, (_, i) => ({ value: `m${i}`, name: `Model ${i}` })) } : a) } })));
    await openPicker();
    await switchAgent("OpenCode");
    await page.getByRole("textbox", { name: "Search models" }).fill("Model 599");
    assert.deepStrictEqual(await optNames(), ["Model 599"]);
    const before = await ev(`window.__sent.length`);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "opencode", value: "m599" });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "agentModels", agentModels: window.__snapshot.agentModels } })));
  });

  await t("Enter in the filter picks the first matching model", async () => {
    await openPicker();
    await page.getByRole("textbox", { name: "Search models" }).fill("Opus 4.1");
    const before = await ev(`window.__sent.length`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "demo-agent", value: "opus-4.1" });
  });

  await t("opening scrolls the current model into view; reselecting it does not post", async () => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "session", session: { ...window.__session,
        configOptions: window.__session.configOptions.map((o) => o.id === "model" ? { ...o, currentValue: "minimax-m2" } : o) },
    } })));
    await openPicker();
    const current = page.getByRole("menuitemradio", { name: "MiniMax M2", exact: true });
    assert.strictEqual(await current.getAttribute("aria-checked"), "true");
    const visible = await current.evaluate((e) => {
      const row = e.getBoundingClientRect();
      const menu = e.closest(".model-picker").getBoundingClientRect();
      return row.top >= menu.top && row.bottom <= menu.bottom;
    });
    assert.strictEqual(visible, true);
    const before = await ev(`window.__sent.length`);
    await page.keyboard.press("Enter");
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).filter((m) => m.type === "pickModel"), []);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "session", session: window.__session,
    } })));
  });

  await t("clicking Opus posts pickModel, not another composer action", async () => {
    await openPicker();
    const before = await ev(`window.__sent.length`);
    await page.getByRole("menuitemradio", { name: "Opus 4.1", exact: true }).click();
    await page.waitForSelector(".model-picker", { state: "detached" });
    assert.deepStrictEqual((await sentSince(before)).find((m) => m.type === "pickModel"),
      { type: "pickModel", agentId: "demo-agent", value: "opus-4.1" });
    assert.deepStrictEqual((await sentSince(before)).filter((m) => m.type === "setMode" || m.type === "setConfigOption"), []);
  });

  await t("Browse agents opens the catalog", async () => {
    await openPicker();
    await page.getByRole("menuitem", { name: "Switch agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "Browse agents…", exact: true }).click();
    await page.waitForSelector(".model-picker", { state: "detached" });
    await page.waitForSelector(".catalog");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".composer");
  });
  await t("config mode pill posts setConfigOption, never setMode", async () => {
    await page.click('button[aria-label="Mode: Code"]');
    await page.waitForSelector(".popover", { timeout: 3000 });
    const before = await ev(`window.__sent.length`);
    await ev(`(() => {
      [...document.querySelectorAll(".popover .pop-item")]
        .find((e) => e.textContent.includes("Ask")).click();
    })()`);
    await sleep(200);
    const msgs = await ev(`window.__sent.slice(${before})`);
    assert.ok(msgs.some((m) => m.type === "setConfigOption" && m.configId === "agentmode" && m.value === "ask"));
    assert.ok(!(await ev(`window.__sent.some(m => m.type === "setMode")`)));
    await sleep(150);
  });

  await t("reasoning/effort is a choice list, not a slider", async () => {
    await page.click('button[aria-label="Mode: Code"]');
    await page.waitForSelector(".popover", { timeout: 3000 });
    await page.keyboard.press("Escape");
    await sleep(150);
    await openPicker();
    assert.strictEqual(await ev(`!!document.querySelector(".effort-slider")`), false);
    assert.strictEqual(await ev(`document.querySelector(".mp-thought .pop-head").textContent`), "Effort");
    assert.ok((await ev(`document.querySelectorAll('.mp-thought [role="menuitemradio"]').length`)) >= 5);
    assert.strictEqual(
      await ev(`document.querySelector('.mp-thought [role="menuitemradio"][aria-checked="true"] .pop-label').textContent`),
      "Medium",
    );
    assert.ok(await ev(`document.activeElement.getAttribute("role") === "menuitemradio"`), "selected row focused");
    await page.screenshot({ path: shot("config-reasoning.png") });
    const before = await ev(`window.__sent.length`);
    await page.click('.mp-thought [aria-label="High"]');
    await sleep(150);
    const msgs = await ev(`window.__sent.slice(${before})`);
    assert.ok(msgs.some((m) => m.type === "setConfigOption" && m.configId === "effort" && m.value === "high"), JSON.stringify(msgs));
    assert.strictEqual(await ev(`!!document.querySelector(".model-picker")`), false, "picking a level closes the menu");
    assert.ok(await ev(`document.activeElement.classList.contains("mp-trigger")`), "focus back on the model button");
  });

  await t("model options menu excludes effort and retains unknown and uncategorized options", async () => {
    await page.click('.traits-pill');
    await page.waitForSelector(".traits-menu", { timeout: 3000 });
    const names = await ev(
      `[...document.querySelectorAll(".traits-menu .cfg-row .pop-label")].map(e => e.textContent)`,
    );
    for (const want of [
      "Verbosity", "Service tier",
      "Prompt caching", "Flavor", "Autonomy level", "Retries",
      "Extended reasoning", "Fast mode",
    ]) {
      assert.ok(names.includes(want), `missing ${want}`);
    }
    for (const gone of ["Mode", "Model", "Effort"]) assert.ok(!names.includes(gone), `${gone} repeated`);
    assert.deepStrictEqual(
      await ev(`[...document.querySelectorAll(".traits-menu .pop-head")].map(e => e.textContent)`),
      [],
    );
    // unknown-category option keeps its own name — no "Model" pill for it
    for (const a of ["Flavor", "Autonomy level", "Retries"]) {
      assert.strictEqual(
        await ev(`!!document.querySelector('.traits-menu .cfg-row-btn[aria-label^="${a}:"]')`),
        true,
        `missing control ${a}`,
      );
    }
    const pillLabels = await ev(
      `[...document.querySelectorAll(".cfg-pill")].map(b => b.getAttribute("aria-label"))`,
    );
    assert.ok(!pillLabels.some((l) => /Flavor|Autonomy|Retries/.test(l)));
    await page.screenshot({ path: shot("config-traits.png") });
  });

  await t("settings boolean posts boolean setConfigOption", async () => {
    const before = await ev(`window.__sent.length`);
    await ev(`document.querySelector('.traits-menu input[aria-label="Fast mode"]').click()`);
    await sleep(200);
    const msgs = await ev(`window.__sent.slice(${before})`);
    assert.ok(msgs.some((m) => m.type === "setConfigOption" && m.configId === "fast" && m.value === true));
  });

  await t("select row opens its choices in place and picking one posts a typed setConfigOption", async () => {
    await page.click('.traits-menu .cfg-row-btn[aria-label^="Retries:"]');
    await page.waitForSelector(".traits-menu .pop-back", { timeout: 3000 });
    const before = await ev(`window.__sent.length`);
    await page.click('.traits-menu [role="menuitemradio"][aria-checked="false"]');
    await sleep(200);
    const msgs = await ev(`window.__sent.slice(${before})`);
    assert.ok(
      msgs.some((m) => m.type === "setConfigOption" && m.configId === "retries" && typeof m.value === "string"),
      `expected retries setConfigOption, got ${JSON.stringify(msgs)}`,
    );
    assert.strictEqual(await ev(`!!document.querySelector(".traits-menu")`), false, "menu closes after a pick");
    await page.click(".traits-pill");
    await page.waitForSelector(".traits-menu", { timeout: 3000 });
  });

  await t("Back returns from a choice list to the options", async () => {
    await page.click('.traits-menu .cfg-row-btn[aria-label^="Retries:"]');
    await page.waitForSelector(".traits-menu .pop-back", { timeout: 3000 });
    await page.click(".traits-menu .pop-back");
    await sleep(100);
    assert.strictEqual(await ev(`!!document.querySelector('.traits-menu .cfg-row-btn[aria-label^="Retries:"]')`), true);
  });

  await t("Tab moves between settings controls", async () => {
    await ev(`document.querySelector('.traits-menu [data-popitem]').focus()`);
    await page.keyboard.press("Tab");
    await sleep(100);
    const ok = await ev(
      `document.activeElement && document.activeElement.closest(".traits-menu")`,
    );
    assert.ok(ok, "focus stayed inside settings on Tab");
  });

  await t("config update while a settings row is focused does not steal focus", async () => {
    const sel = '.traits-menu .cfg-row-btn[aria-label^="Retries:"]';
    await page.focus(sel);
    await sleep(100);
    await ev(`(() => {
      const snap = window.__session;
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "session", session: { ...snap, configOptions: snap.configOptions.slice() } },
      }));
    })()`);
    await sleep(250);
    assert.match(
      await ev(`document.activeElement && document.activeElement.getAttribute("aria-label")`),
      /^Retries: /,
    );
    // and the settings popover is still open
    assert.strictEqual(await ev(`!!document.querySelector(".traits-menu")`), true);
  });

  await t("Escape closes popover and restores focus to the trigger", async () => {
    await page.keyboard.press("Escape");
    await sleep(200);
    assert.strictEqual(await ev(`!!document.querySelector(".popover")`), false);
    assert.strictEqual(
      await ev(`document.activeElement.getAttribute("aria-label")`),
      "Model options",
    );
  });

  await t("option removal closes a stale config popover", async () => {
    await page.click('button[aria-label="Mode: Code"]');
    await page.waitForSelector(".popover", { timeout: 3000 });
    await ev(`(() => {
      const snap = { sessionId: "s-1", agentId: "demo-agent", cwd: "", busy: false,
        createdAt: 0, configOptions: [
          { id: "effort", name: "Effort", type: "select", category: "thought_level",
            currentValue: "medium", options: [{value:"low",name:"Low"},{value:"medium",name:"Medium"}] },
        ] };
      window.dispatchEvent(new MessageEvent("message", { data: { type: "session", session: snap } }));
    })()`);
    await sleep(300);
    assert.strictEqual(await ev(`!!document.querySelector(".popover")`), false);
    assert.strictEqual(await ev(`document.querySelectorAll(".mode-pill").length`), 0);
    assert.strictEqual(
      await ev(`!!document.querySelector(".traits-pill")`),
      false,
    );
    assert.strictEqual(await page.locator(".mp-effort").textContent(), "Medium");
    await openPicker();
    await page.click('.mp-thought [aria-label="Low"]');
    assert.strictEqual(await page.locator(".model-picker").count(), 0);
    assert.ok((await ev(`window.__sent`)).some(m =>
      m.type === "setConfigOption" && m.configId === "effort" && m.value === "low"));
    // without a live model option the trigger falls back to the catalog
    assert.strictEqual(
      await ev(`document.querySelector(".mp-trigger").getAttribute("aria-label")`),
      "Agent and model: Affogato · Sonnet 4.5",
    );
  });

  await t("effort slash action opens its choices in the model picker", async () => {
    await page.fill(".composer textarea", "/Effort");
    await page.waitForSelector(".slash-menu", { timeout: 3000 });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".mp-thought", { timeout: 3000 });
    assert.strictEqual(await page.locator(".traits-menu").count(), 0);
    assert.strictEqual(await page.locator(".mp-thought [aria-label='Low']").count(), 1);
    await page.keyboard.press("Escape");
  });

  await t("empty config update removes pills and settings control", async () => {
    await ev(`(() => {
      const snap = { sessionId: "s-1", agentId: "demo-agent", cwd: "", busy: false,
        createdAt: 0, configOptions: [] };
      window.dispatchEvent(new MessageEvent("message", { data: { type: "session", session: snap } }));
    })()`);
    await sleep(300);
    assert.strictEqual(await ev(`document.querySelectorAll(".mode-pill").length`), 0);
    assert.strictEqual(
      await ev(`!!document.querySelector('.traits-pill')`),
      false,
    );
  });

  // 300px light pass: settings reachable at narrow width; pills keep hit area.
  const page2 = await browser.newPage({ viewport: { width: 300, height: 640 } });
  page2.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page2.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page2.goto(url("#light"));
  await page2.waitForSelector(".composer textarea", { timeout: 8000 });
  await page2.waitForTimeout(800);
  await t("300px: pills keep >=24px hit area, settings/picker trigger/send in viewport", async () => {
    const rects = await page2.evaluate(`(() => {
      const vw = window.innerWidth;
      const grab = (s) => [...document.querySelectorAll(s)].map((b) => {
        const r = b.getBoundingClientRect();
        return { sel: s, w: r.width, h: r.height, right: r.right, vis: r.width > 0 };
      });
      return grab(".mode-pill").concat(
        grab('.traits-pill'),
        grab(".mp-trigger"),
        grab('button[aria-label="Send"]'),
      );
    })()`);
    for (const r of rects) {
      assert.ok(r.vis && r.h >= 24 && r.w >= 24, `hit area ${r.sel} ${r.w}x${r.h}`);
      assert.ok(r.right <= 300 + 1, `in viewport ${r.sel}`);
    }
  });
  await t("settings control reachable at 300px", async () => {
    await page2.click('.traits-pill');
    await page2.waitForSelector(".traits-menu", { timeout: 3000 });
    const box = await page2.evaluate(
      `document.querySelector(".traits-menu").getBoundingClientRect().width`,
    );
    assert.ok(box > 100, "settings popover rendered");
    await page2.screenshot({ path: shot("config-traits-300-light.png") });
    await page2.keyboard.press("Escape");
    await sleep(150);
  });
  await t("300px light: picker fits without horizontal scroll; long name has tooltip", async () => {
    await openPicker(page2);
    const menu = page2.locator(".model-picker");
    const box = await menu.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 300 && box.y >= 0, JSON.stringify(box));
    assert.strictEqual(await menu.evaluate((e) => e.scrollWidth <= e.clientWidth), true);
    const long = page2.getByRole("menuitemradio", { name: "Sonnet 3.7 with an unusually long display name for truncation", exact: true });
    assert.match(await long.getAttribute("title"), /^Sonnet 3.7 with an unusually long display name/);
    await long.scrollIntoViewIfNeeded();
    assert.strictEqual(await long.locator(".pop-label").evaluate((e) => e.scrollWidth > e.clientWidth), true);
    await page2.screenshot({ path: shot("picker-v2-harness-300-light.png") });
    await page2.keyboard.press("Escape");
  });
  // --- popover toggle behavior (anchor-aware outside click) ---
  const page3 = await browser.newPage({ viewport: { width: 490, height: 640 } });
  page3.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page3.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page3.goto(url());
  await page3.waitForSelector(".composer textarea", { timeout: 8000 });
  await page3.waitForTimeout(700);
  const ev3 = (expr) => page3.evaluate(expr);

  await t("same trigger toggles closed; other trigger swaps menus", async () => {
    await page3.click(".mp-trigger");
    await page3.waitForSelector(".popover", { timeout: 3000 });
    // second click on the same trigger must close, not close+reopen
    await page3.click(".mp-trigger");
    await sleep(200);
    assert.strictEqual(await ev3(`!!document.querySelector(".popover")`), false);
    // clicking another trigger swaps directly to that menu
    await page3.click(".mp-trigger");
    await page3.waitForSelector(".popover", { timeout: 3000 });
    await page3.click('.traits-pill');
    await sleep(200);
    assert.strictEqual(
      await ev3(`!!document.querySelector(".traits-menu")`),
      true,
      "settings menu did not open",
    );
    assert.strictEqual(
      await ev3(`document.querySelectorAll(".popover").length`),
      1,
      "two popovers open",
    );
    // outside click dismisses (point above the popover, off the composer)
    await page3.mouse.click(60, 60);
    await sleep(200);
    assert.strictEqual(await ev3(`!!document.querySelector(".popover")`), false);
  });

  await t("typing and snapshot updates keep the popover open", async () => {
    await page3.click('.traits-pill');
    await page3.waitForSelector(".traits-menu", { timeout: 3000 });
    await page3.click(".composer textarea");
    await page3.keyboard.type("hello");
    await sleep(150);
    assert.strictEqual(await ev3(`!!document.querySelector(".traits-menu")`), true);
    await ev3(`(() => {
      const snap = window.__session;
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "session", session: { ...snap, configOptions: snap.configOptions.slice() } },
      }));
    })()`);
    await sleep(200);
    assert.strictEqual(await ev3(`!!document.querySelector(".traits-menu")`), true);
    await page3.keyboard.press("Escape");
    await sleep(150);
  });

  await t("viewport resize keeps an open menu visible", async () => {
    await page3.click(".mp-trigger");
    await page3.waitForSelector(".popover", { timeout: 3000 });
    await page3.screenshot({ path: shot("composer-compact-490-model.png") });
    await page3.setViewportSize({ width: 665, height: 640 });
    await sleep(250);
    assert.strictEqual(await ev3(`!!document.querySelector(".popover")`), true);
    const r = await ev3(
      `document.querySelector(".popover").getBoundingClientRect().toJSON()`,
    );
    assert.ok(r.width > 100 && r.bottom <= 641, "popover still laid out");
    await page3.keyboard.press("Escape");
    await sleep(150);
  });

  // --- compact layout across widths, long agent name ---
  const footerChecks = async (pg, evFn, w) => {
    const res = await evFn(`(() => {
      const foot = document.querySelector(".composer-foot").getBoundingClientRect();
      const left = document.querySelector(".composer-foot-left");
      const btns = [...document.querySelectorAll(
        ".composer-foot-left button, .composer-foot-right button")];
      return {
        overflow: left.scrollWidth - left.clientWidth,
        items: btns.map((b) => {
          const r = b.getBoundingClientRect();
          return { label: b.getAttribute("aria-label") || b.className,
            w: r.width, h: r.height, left: r.left, right: r.right,
            footL: foot.left, footR: foot.right };
        }),
      };
    })()`);
    assert.ok(res.overflow <= 0, `foot-left scrolls at ${w}px (overflow ${res.overflow})`);
    for (const b of res.items) {
      assert.ok(b.w >= 24 && b.h >= 24, `${b.label} hit area ${b.w}x${b.h} at ${w}px`);
      assert.ok(b.left >= b.footL - 1 && b.right <= b.footR + 1,
        `${b.label} outside footer at ${w}px`);
    }
    assert.ok(
      await evFn(`!!document.querySelector('.traits-pill')`),
      `thinking button missing at ${w}px`,
    );
  };

  for (const w of [300, 490, 665]) {
    const pw = await browser.newPage({ viewport: { width: w, height: 640 } });
    pw.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    pw.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await pw.goto(url());
    await pw.waitForSelector(".composer textarea", { timeout: 8000 });
    await pw.waitForTimeout(600);
    // long agent name must not push controls out
    await pw.evaluate(`(() => {
      const snap = window.__snapshot;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "snapshot",
        payload: { ...snap, agents: snap.agents.map((a, i) =>
          i === 0 ? { ...a, name: "Google Antigravity Gemini CLI Edition" } : a) } } }));
    })()`);
    await pw.waitForTimeout(400);
    const evw = (expr) => pw.evaluate(expr);
    await t(`${w}px: all footer controls >=24px, inside footer, no left-scroll`, async () => {
      await footerChecks(pw, evw, w);
    });
    await t(`${w}px: mode label only when it fits; trigger names agent + model, shows the model; thinking button present`, async () => {
      assert.strictEqual(
        await evw(`(() => { const l = document.querySelector(".mode-pill .pill-label"); return !!l && getComputedStyle(l).display !== "none"; })()`),
        w > 300,
      );
      assert.strictEqual(await evw(`document.querySelector(".mp-trigger .pill-label").textContent`), "Sonnet 4.5");
      assert.strictEqual(
        await evw(`document.querySelector(".mp-trigger")?.getAttribute("aria-label")`),
        "Agent and model: Google Antigravity Gemini CLI Edition · Sonnet 4.5",
      );
      assert.strictEqual(
        await evw(`!!document.querySelector('.traits-pill[aria-label="Model options"]')`),
        true,
      );
      assert.strictEqual(
        await evw(`!!document.querySelector(".mp-trigger .agent-logo, .mp-trigger .agent-logo-img")`),
        false,
      );
    });
    await pw.screenshot({ path: shot(`composer-compact-${w}.png`) });
    await pw.close();
  }

  await t("legacy modes: labeled pill, full names in menu", async () => {
    await page3.evaluate(`(() => {
      const snap = window.__session;
      window.dispatchEvent(new MessageEvent("message", { data: { type: "session",
        session: { ...snap, configOptions: [] } } }));
    })()`);
    await sleep(300);
    const pill = await ev3(
      `document.querySelector(".mode-pill")?.getAttribute("aria-label")`,
    );
    assert.strictEqual(pill, "Mode: Code");
    assert.strictEqual(await ev3(`document.querySelector(".mode-pill .pill-label")?.textContent`), "Code");
    await page3.click('button[aria-label="Mode: Code"]');
    await page3.waitForSelector(".popover", { timeout: 3000 });
    const rows = await ev3(
      `[...document.querySelectorAll(".popover .pop-label")].map(e => e.textContent)`,
    );
    for (const want of ["Ask", "Plan", "Code", "Full access"]) {
      assert.ok(rows.includes(want), `missing mode row ${want}`);
    }
    await page3.keyboard.press("Escape");
  });

  // --- prompt ack: draft clears only on promptAccepted ---
  const p4 = await browser.newPage({ viewport: { width: 500, height: 640 } });
  p4.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  p4.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await p4.goto(url());
  await p4.waitForSelector(".composer textarea", { timeout: 8000 });
  // The harness re-dispatches its snapshot at ~3s (fixture session is busy) —
  // wait past it before clearing busy, or the resnapshot flips it back on.
  await p4.waitForTimeout(3400);
  const ev4 = (expr) => p4.evaluate(expr);
  const sentFrom = async (i) => ev4(`window.__sent.slice(${i})`);
  const taVal = () => ev4(`document.querySelector(".composer textarea").value`);
  // the fixture session is busy — clear it so Send is enabled
  await ev4(`(() => {
    const s = window.__session;
    window.dispatchEvent(new MessageEvent("message", { data: { type: "session", session: { ...s, busy: false } } }));
  })()`);
  await sleep(200);

  await t("send carries requestId; rejected send keeps the draft", async () => {
    await p4.click(".composer textarea");
    await p4.keyboard.type("first draft");
    const i = await ev4(`window.__sent.length`);
    await p4.click('button[aria-label="Send"]');
    await sleep(200);
    const msgs = await sentFrom(i);
    const m = msgs.find((x) => x.type === "sendPrompt");
    assert.ok(m && m.requestId && m.text === "first draft", "sendPrompt with requestId");
    assert.strictEqual(await taVal(), "first draft", "draft held until ack");
    await p4.evaluate((rid) => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "promptRejected", requestId: rid, reason: "nope" },
      }));
    }, m.requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "first draft", "rejected send keeps draft");
  });

  await t("double-click sends once; accepted send clears submitted text", async () => {
    const i = await ev4(`window.__sent.length`);
    // Synchronous DOM clicks — Playwright's auto-wait would park the second
    // click on the disabled button instead of racing the pending state.
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await sleep(200);
    const msgs = (await sentFrom(i)).filter((x) => x.type === "sendPrompt");
    assert.strictEqual(msgs.length, 1, `one sendPrompt (${msgs.length})`);
    await p4.evaluate((rid) => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "promptAccepted", requestId: rid },
      }));
    }, msgs[0].requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "", "accepted send clears draft");
  });

  await t("text edited after submission survives an accept", async () => {
    await p4.click(".composer textarea");
    await p4.keyboard.type("base");
    const i = await ev4(`window.__sent.length`);
    await p4.click('button[aria-label="Send"]');
    await sleep(200);
    await p4.click(".composer textarea");
    await p4.keyboard.type(" +more");
    const msgs = (await sentFrom(i)).filter((x) => x.type === "sendPrompt");
    await p4.evaluate((rid) => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "promptAccepted", requestId: rid },
      }));
    }, msgs[0].requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "base +more", "edits since submission kept");
  });

  await t("auth_required: textarea editable, send disabled", async () => {
    // Replay the EXACT snapshot message the controller posts in
    // auth_required — exported by lifecycle-check into
    // preview/lifecycle-auth-snapshot.json. If it's missing, lifecycle-check
    // must run first; do not substitute a hand-authored fixture.
    const snapMsg = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, "..", "preview", "lifecycle-auth-snapshot.json"),
      "utf8",
    ));
    assert.strictEqual(snapMsg.type, "snapshot", "exported message is a snapshot");
    assert.strictEqual(snapMsg.payload.connection.status, "auth_required",
      "exported snapshot is auth_required");
    assert.ok(snapMsg.payload.authMethods.length >= 1,
      "exported snapshot carries auth methods");
    await p4.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), snapMsg);
    await sleep(200);
    await p4.click(".composer textarea");
    await p4.keyboard.type(" draft-in-auth");
    assert.strictEqual(
      await ev4(`document.querySelector(".composer textarea").disabled`),
      false,
      "textarea editable during auth",
    );
    assert.strictEqual(
      await ev4(`document.querySelector('button[aria-label="Send"]').disabled`),
      true,
      "send disabled until connected",
    );
    // auth banner surfaces with its methods while transcript stays rendered
    assert.ok(await ev4(`!!document.querySelector(".auth-card")`), "sign-in card visible");
    assert.ok(await ev4(`document.querySelectorAll(".auth-card button").length >= 1`),
      "auth methods render as buttons");
    assert.ok(await ev4(`document.querySelectorAll(".msg").length > 0`),
      "existing entries stay rendered under auth banner");
    const v = await taVal();
    assert.ok(v.includes("base +more") && v.includes("draft-in-auth"),
      `draft retained under auth (got "${v}")`);
    await p4.screenshot({ path: shot("lifecycle-auth-draft.png") });
    // clear the draft so later tests start clean, then reconnect
    await ev4(`window.dispatchEvent(new MessageEvent("message", {
      data: { type: "connection", agentId: "demo-agent", status: "connected" },
    }))`);
    await sleep(150);
    await ev4(`(() => { const t = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  });

  await t("reject keeps edits + attachments; accept removes only submitted", async () => {
    // host pushes an attachment chip
    await ev4(`window.dispatchEvent(new MessageEvent("message", {
      data: { type: "attachment", attachment: {
        uri: "file:///ws/a.ts", name: "a.ts", kind: "file" } },
    }))`);
    await p4.click(".composer textarea");
    await p4.keyboard.type("with-att");
    const i = await ev4(`window.__sent.length`);
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await sleep(200);
    const m = (await sentFrom(i)).find((x) => x.type === "sendPrompt");
    assert.ok(m.attachments.length === 1, "attachment included in send");
    // edit the draft while in flight, then reject: everything stays
    await p4.click(".composer textarea");
    await p4.keyboard.type(" +edit");
    await p4.evaluate((rid) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "promptRejected", requestId: rid, reason: "nope" },
    })), m.requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "with-att +edit", "reject keeps edited draft");
    assert.ok(await ev4(`!!document.querySelector(".attach-row")`), "reject keeps attachments");
    assert.ok(await ev4(`!!document.querySelector(".send-err")`), "reject reason shown inline");
    // resend, then a STALE ack for the old requestId must do nothing
    const j = await ev4(`window.__sent.length`);
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await sleep(200);
    const m2 = (await sentFrom(j)).find((x) => x.type === "sendPrompt");
    await p4.evaluate((rid) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "promptAccepted", requestId: rid },
    })), m.requestId); // old id — should be inert
    await sleep(150);
    assert.strictEqual(await taVal(), "with-att +edit", "stale ack does not clear newer send");
    await p4.evaluate((rid) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "promptAccepted", requestId: rid },
    })), m2.requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "", "current ack clears");
    assert.strictEqual(await ev4(`document.querySelectorAll(".attach-row").length`), 0,
      "accept removed submitted attachments");
  });

  await t("unmount mid-flight: late ack cannot clear a remounted draft", async () => {
    // send → switch to the threads view (Composer unmounts, ack unsubscribed)
    await p4.click(".composer textarea");
    await p4.keyboard.type("pending-unmount");
    const i = await ev4(`window.__sent.length`);
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await sleep(200);
    const m = (await sentFrom(i)).find((x) => x.type === "sendPrompt");
    assert.ok(m && m.requestId, "sendPrompt issued before unmount");
    await ev4(`window.dispatchEvent(new MessageEvent("message", {
      data: { type: "openHistory" } }))`);
    await sleep(200);
    assert.ok(!(await ev4(`!!document.querySelector(".composer")`)),
      "composer unmounted in threads view");
    // remount and type a fresh draft, THEN the stale ack lands
    await p4.keyboard.press("Escape");
    await sleep(200);
    await p4.click(".composer textarea");
    await p4.keyboard.type("new draft");
    await p4.evaluate((rid) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "promptAccepted", requestId: rid },
    })), m.requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "new draft",
      "late ack after remount does not clear the new draft");
  });

  await t("raw text sent verbatim; leading/trailing space preserved", async () => {
    await ev4(`(() => { const t = document.querySelector(".composer textarea");
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(t, ""); t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await p4.click(".composer textarea");
    await p4.keyboard.type("  spaced  ");
    const i = await ev4(`window.__sent.length`);
    await ev4(`document.querySelector('button[aria-label="Send"]').click()`);
    await sleep(200);
    const m = (await sentFrom(i)).find((x) => x.type === "sendPrompt");
    assert.strictEqual(m.text, "  spaced  ", "sendPrompt carries verbatim text");
    await p4.evaluate((rid) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "promptAccepted", requestId: rid },
    })), m.requestId);
    await sleep(150);
    assert.strictEqual(await taVal(), "", "verbatim accept clears exact text");
  });

  await browser.close();
  if (errors.length) {
    console.log("PAGE ERRORS:");
    for (const e of errors) console.log("  " + e);
    process.exit(1);
  }
  console.log(`all ${n} configoptions UI checks passed`);
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
