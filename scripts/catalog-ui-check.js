/* Headless UI check of the Catalog All/Installed fix via the file harness
   (cached Playwright Chromium — no network). Real Catalog component driven
   by host messages. Captures preview/catalog-*.png. Any page error,
   console error, or failed assert fails the script. */
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

let failures = 0;
let passed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok: ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL: ${name}\n  ${e.message}`);
  }
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  const ev = (code) => page.evaluate(`(() => { return (${code}); })()`);
  const sent = () => page.evaluate("window.__sent");
  const cards = () => ev(`[...document.querySelectorAll(".agent-card")].map(c => c.querySelector(".agent-card-name").textContent)`);
  const sendAgents = (agents) =>
    page.evaluate((a) => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "agents", agents: a },
    })), agents);

  await page.goto(url("#catalog"));
  // The harness re-dispatches its fixture snapshot ~3s after load — wait
  // past it before pushing custom agent lists.
  await page.waitForSelector(".catalog", { timeout: 15000 });
  await sleep(3600);
  const baseAgents = await ev(`window.__snapshot.agents`);
  assert.ok(Array.isArray(baseAgents) && baseAgents.length === 5, "fixture exposes 5 agents");

  await t("All tab: one grid, 5 unique cards, no section headers", async () => {
    const names = await cards();
    assert.strictEqual(names.length, 5, `5 cards (got ${names.length})`);
    assert.strictEqual(new Set(names).size, 5, "cards unique");
    assert.strictEqual(await ev(`document.querySelectorAll(".catalog-grid").length`), 1,
      "exactly one catalog-grid");
    assert.strictEqual(await ev(`document.querySelectorAll(".catalog-section").length`), 0,
      "no Installed/Registry section split");
    const count = await ev(`document.querySelector(".catalog-title .dim.small").textContent`);
    assert.strictEqual(count, "5", "count label matches filtered cards");
  });

  await t("Installed tab: 4 cards, all Open + Installed label, none Install", async () => {
    await page.click(`.catalog-tab >> text=Installed`);
    await sleep(150);
    const names = await cards();
    assert.strictEqual(names.length, 4, `4 installed cards (got ${names.length})`);
    assert.strictEqual(
      await ev(`[...document.querySelectorAll(".agent-card")].filter(c =>
        [...c.querySelectorAll("button")].some(b => b.textContent.trim() === "Open")).length`),
      4, "every installed card has Open");
    assert.strictEqual(
      await ev(`[...document.querySelectorAll(".agent-card")].filter(c =>
        [...c.querySelectorAll("button")].some(b => /Install/.test(b.textContent))).length`),
      0, "no Install buttons on installed cards");
    assert.strictEqual(
      await ev(`document.querySelectorAll(".agent-card .agent-card-installed").length`), 4,
      "each card carries the Installed label");
    const count = await ev(`document.querySelector(".catalog-title .dim.small").textContent`);
    assert.strictEqual(count, "4", "count matches installed cards");
  });

  await t("tab toggles: aria-pressed tracks selection reliably", async () => {
    for (let i = 0; i < 3; i++) {
      await page.click(`.catalog-tab >> text=All`);
      await sleep(80);
      assert.strictEqual(await ev(`document.querySelector('.catalog-tab:nth-child(1)').getAttribute("aria-pressed")`), "true");
      assert.strictEqual(await ev(`document.querySelector('.catalog-tab:nth-child(2)').getAttribute("aria-pressed")`), "false");
      assert.strictEqual((await cards()).length, 5);
      await page.click(`.catalog-tab >> text=Installed`);
      await sleep(80);
      assert.strictEqual(await ev(`document.querySelector('.catalog-tab:nth-child(1)').getAttribute("aria-pressed")`), "false");
      assert.strictEqual(await ev(`document.querySelector('.catalog-tab:nth-child(2)').getAttribute("aria-pressed")`), "true");
      assert.strictEqual((await cards()).length, 4);
    }
  });

  await t("search intersects both tabs; query persists across tab switches", async () => {
    await ev(`(() => { const i = document.querySelector(".catalog-search input");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(i, "gemini"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await sleep(150);
    await page.click(`.catalog-tab >> text=All`);
    await sleep(100);
    assert.deepStrictEqual(await cards(), ["Gemini CLI"], "All+query: only Gemini");
    await page.click(`.catalog-tab >> text=Installed`);
    await sleep(100);
    assert.strictEqual((await cards()).length, 0, "Installed+query: nothing");
    assert.strictEqual(await ev(`document.querySelector(".catalog-search input").value`),
      "gemini", "query persisted across switch");
    assert.ok(await ev(`document.body.textContent.includes("No agents match")`),
      "query empty state shown");
    await page.click(`.link-btn >> text=Clear search`);
    await sleep(100);
    assert.strictEqual(await ev(`document.querySelector(".catalog-search input").value`),
      "", "Clear search empties the field");
    assert.strictEqual((await cards()).length, 4, "Clear search restores installed cards");
  });

  await t("all uninstalled while Installed active: empty state + Browse agents", async () => {
    await sendAgents(baseAgents.map((a) => ({ ...a, installed: false })));
    await sleep(150);
    assert.strictEqual((await cards()).length, 0, "no installed cards");
    assert.ok(await ev(`document.body.textContent.includes("No installed agents yet.")`),
      "installed empty state text");
    await page.click(`.link-btn >> text=Browse agents`);
    await sleep(150);
    assert.strictEqual(await ev(`document.querySelector('.catalog-tab:nth-child(1)').getAttribute("aria-pressed")`),
      "true", "Browse agents switched to All");
    assert.strictEqual((await cards()).length, 5, "All shows the five agents");
  });

  await t("empty All with no agents: plain empty state", async () => {
    await sendAgents([]);
    await sleep(150);
    assert.ok(await ev(`document.body.textContent.includes("No agents available.")`),
      "All empty state text");
    assert.ok(!(await ev(`document.body.textContent.includes("No installed agents yet.")`)),
      "no installed-specific copy on All tab");
  });

  await t("agent update installed false->true inserts card once on Installed tab", async () => {
    await sendAgents(baseAgents.map((a) => ({ ...a, installed: false })));
    await sleep(120);
    await page.click(`.catalog-tab >> text=Installed`);
    await sleep(120);
    await sendAgents(baseAgents.map((a) =>
      a.id === "gemini" ? { ...a, installed: true } : { ...a, installed: false }));
    await sleep(150);
    const names = await cards();
    assert.deepStrictEqual(names, ["Gemini CLI"], "newly installed agent appears");
    assert.strictEqual(names.filter((n) => n === "Gemini CLI").length, 1, "inserted once");
  });

  await t("custom installed descriptor renders; registry installed no duplicate", async () => {
    const custom = {
      id: "local-x", name: "Local Agent", description: "custom installed",
      source: "custom", installed: true, installKind: "custom",
    };
    await sendAgents([...baseAgents, custom]);
    await sleep(150);
    const names = await cards();
    assert.strictEqual(names.filter((n) => n === "Local Agent").length, 1,
      "custom installed agent shown once on Installed tab");
    assert.strictEqual(names.length, 5, "4 registry-installed + 1 custom = 5");
    await sendAgents(baseAgents);
    await sleep(120);
    assert.strictEqual((await cards()).length, 4, "fixture restored");
  });

  await t("Open posts selectAgent and returns to chat", async () => {
    const n0 = (await sent()).length;
    await ev(`(() => { const c = [...document.querySelectorAll(".agent-card")]
      .find((x) => x.querySelector(".agent-card-name").textContent === "OpenCode");
      [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === "Open").click();
      return true; })()`);
    await sleep(200);
    const s = await sent();
    const sel = s.slice(n0).find((m) => m.type === "selectAgent");
    assert.ok(sel && sel.agentId === "opencode", `selectAgent opencode posted`);
    assert.ok(await ev(`!!document.querySelector(".composer")`), "back on chat view");
  });

  await t("Refresh posts refreshRegistry", async () => {
    await ev4open();
    const n0 = (await sent()).length;
    await page.click(".catalog-refresh");
    await sleep(150);
    const s = await sent();
    assert.ok(s.slice(n0).some((m) => m.type === "refreshRegistry"),
      "refreshRegistry posted");
  });

  await t("card footer buttons stay inside their card at 900/380/300", async () => {
    for (const w of [900, 380, 300]) {
      await page.setViewportSize({ width: w, height: 700 });
      await sleep(150);
      const over = await ev(`(() => {
        const bad = [];
        for (const c of document.querySelectorAll(".agent-card")) {
          const cr = c.getBoundingClientRect();
          const name = c.querySelector(".agent-card-name").textContent;
          for (const b of c.querySelectorAll("button")) {
            const br = b.getBoundingClientRect();
            if (br.left < cr.left - 0.5 || br.right > cr.right + 0.5)
              bad.push(name + ":" + b.textContent.trim());
          }
        }
        return bad; })()`);
      assert.deepStrictEqual(over, [], `${w}px: buttons inside cards (over: ${over})`);
    }
    await page.setViewportSize({ width: 900, height: 700 });
    await sleep(150);
  });

  await t("history remains visible in a conversation and with no selected agent", async () => {
    const send = (data) => page.evaluate((data) =>
      window.dispatchEvent(new MessageEvent("message", { data })), data);
    const thread = { id: "state-history", title: "Saved state history", createdAt: 1,
      updatedAt: Date.now(), backing: [], agents: [], entryCount: 1,
      workspace: await ev("window.__snapshot.workspace.folders[0].path") };
    await send({ type: "closeView" });
    await send({ type: "snapshot", payload: {
      ...await ev("window.__snapshot"), activeAgentId: "opencode",
      threads: [thread], entries: [{ id: "state-user", kind: "user", ts: 1,
        parts: [{ type: "text", text: "Current transcript" }] }],
    } });
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator(".recent .thread-name").textContent(), "Saved state history");
    assert.strictEqual(await page.getByText("Current transcript", { exact: true }).count(), 1);
    await send({ type: "agents", agents: [], activeAgentId: null });
    await send({ type: "entriesReplace", sessionId: "", entries: [] });
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator(".recent .thread-name").textContent(), "Saved state history");
    assert.strictEqual(await page.getByText("Install an agent", { exact: true }).count(), 1);
    await send({ type: "snapshot", payload: await ev("window.__snapshot") });
  });

  await t("native history scopes session IDs and late lists to their agent", async () => {
    const send = (data) => page.evaluate((data) =>
      window.dispatchEvent(new MessageEvent("message", { data })), data);
    await send({ type: "snapshot", payload: {
      ...await ev("window.__snapshot"), activeAgentId: "opencode", canListSessions: true,
      nativeSessions: [{ sessionId: "open-native", title: "Open native history" }],
      threads: [{ id: "other-thread", title: "Other agent thread", createdAt: 1, updatedAt: 1,
        agents: ["other-agent"], backing: [{ agentId: "other-agent", sessionId: "open-native",
          coveredEntries: 1, lastUsedAt: 1 }] }],
    } });
    await send({ type: "openHistory" });
    await page.getByText("Open native history", { exact: true }).waitFor();
    assert.strictEqual(await page.getByText("Open native history", { exact: true }).count(), 1);
    await send({ type: "nativeSessions", agentId: "other-agent",
      sessions: [{ sessionId: "other-native", title: "Other native history" }] });
    await page.waitForTimeout(100);
    assert.strictEqual(await page.getByText("Open native history", { exact: true }).count(), 1);
    assert.strictEqual(await page.getByText("Other native history", { exact: true }).count(), 0);
    await send({ type: "nativeSessions", agentId: "opencode",
      sessions: [{ sessionId: "new-native", title: "New native history" }] });
    await page.getByText("New native history", { exact: true }).waitFor();
    assert.strictEqual(await page.getByText("Open native history", { exact: true }).count(), 0);
    await send({ type: "closeView" });
    await send({ type: "snapshot", payload: await ev("window.__snapshot") });
  });

  async function ev4open() {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "openCatalog" },
    })));
    await sleep(250);
  }

  // screenshots
  await ev4open();
  await page.screenshot({ path: shot("catalog-all.png") });
  await page.click(`.catalog-tab >> text=Installed`);
  await sleep(150);
  await page.screenshot({ path: shot("catalog-installed.png") });
  await page.setViewportSize({ width: 300, height: 640 });
  await sleep(200);
  await page.screenshot({ path: shot("catalog-installed-300.png") });

  await browser.close();
  if (pageErrors.length) {
    for (const e of pageErrors) console.log(`FAIL: ${e}`);
    failures += pageErrors.length;
  }
  if (failures) {
    console.log(`${failures} catalog UI checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} catalog UI checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
