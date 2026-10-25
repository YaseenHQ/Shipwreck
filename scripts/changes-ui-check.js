/* Headless UI check of the changes card and agent-markdown file links via
   the file harness (cached Playwright Chromium, no network). Captures
   preview/changes-*.png. Any page error, console error, or failed assert
   fails the script. */
const path = require("path");
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
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  const ev = (code) => page.evaluate(`(() => { return (${code}); })()`);
  /** Messages posted while fn runs, excluding the harness's own traffic. */
  const posted = async (fn) => {
    const n0 = await ev(`window.__sent.length`);
    await fn();
    await sleep(120);
    return (await ev(`window.__sent`)).slice(n0).filter((m) => m.type !== "setPref");
  };
  const load = async (hash) => {
    // A hash-only change would not reload the harness.
    await page.goto("about:blank");
    await page.goto(url(hash));
    await page.waitForSelector(".changes", { timeout: 15000 });
    // The harness re-dispatches its fixture snapshot ~3s after load.
    await sleep(3400);
  };

  await load("#changes");

  await t("header: count, total stats, Review and Undo", async () => {
    assert.strictEqual(await ev(`document.querySelector(".changes-title").textContent`), "5 files changed");
    const stats = await ev(`document.querySelector(".changes-head .changes-stats").textContent`);
    assert.strictEqual(stats, "+297−11", "totals over all files");
    assert.ok(await ev(`!!document.querySelector(".changes-head .tool-diffstats .diff-add")`), "reuses diff stat styling");
    const btns = await ev(`[...document.querySelectorAll(".changes-head .changes-btn")].map(b => b.textContent)`);
    assert.deepStrictEqual(btns, ["Review", "Undo"]);
  });

  await t("Review posts reviewChanges for the entry", async () => {
    const m = await posted(() => page.click(".changes-head .changes-btn >> text=Review"));
    assert.deepStrictEqual(m, [{ type: "reviewChanges", entryId: "c-ch" }]);
  });

  await t("Undo posts revertChanges for the entry", async () => {
    const m = await posted(() => page.click(".changes-head .changes-btn >> text=Undo"));
    assert.deepStrictEqual(m, [{ type: "revertChanges", entryId: "c-ch" }]);
  });

  await t("rows: name, relative dir, new badge, stats, full path title", async () => {
    const rows = await ev(`[...document.querySelectorAll(".changes-row")].map(r => ({
      name: r.querySelector(".changes-name").textContent,
      dir: r.querySelector(".changes-dir")?.textContent ?? "",
      badge: !!r.querySelector(".changes-badge"),
      title: r.querySelector(".changes-file").title,
    }))`);
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(rows[0], { name: "registry.ts", dir: "acp client/src", badge: false, title: "D:\\acp client\\src\\registry.ts" });
    assert.deepStrictEqual(rows[1].name + "|" + rows[1].dir + "|" + rows[1].badge, "Changes.tsx|acp client/webview/components|true");
    assert.strictEqual(rows[4].name, "README.md");
    assert.strictEqual(rows[4].dir, "acp client", "root file shows the folder name in a multi-root workspace");
  });

  await t("row click posts reviewChanges with the path", async () => {
    const m = await posted(() => page.click(".changes-row:nth-child(1) .changes-file"));
    assert.deepStrictEqual(m, [{ type: "reviewChanges", entryId: "c-ch", path: "D:\\acp client\\src\\registry.ts" }]);
  });

  await t("rows are keyboard reachable buttons with visible focus", async () => {
    await page.focus(".changes-row:nth-child(2) .changes-file");
    await page.keyboard.press("Tab");
    const label = await ev(`document.activeElement.getAttribute("aria-label")`);
    assert.strictEqual(label, "Undo changes to Changes.tsx", "Tab reaches the row's undo button");
    assert.strictEqual(await ev(`getComputedStyle(document.activeElement).opacity`), "1", "focused undo is visible");
    const m = await posted(() => page.keyboard.press("Enter"));
    assert.deepStrictEqual(m, [{ type: "revertChanges", entryId: "c-ch", path: "D:\\acp client\\webview\\components\\Changes.tsx" }]);
    await page.focus(".changes-row:nth-child(1) .changes-file");
    const outline = await ev(`getComputedStyle(document.activeElement).outlineStyle`);
    assert.notStrictEqual(outline, "none", "focus ring on row");
  });

  await t("per-row undo appears on hover and posts with path", async () => {
    assert.strictEqual(await ev(`getComputedStyle(document.querySelector(".changes-row:nth-child(3) .changes-undo")).opacity`), "0");
    await page.hover(".changes-row:nth-child(3)");
    await sleep(80);
    assert.strictEqual(await ev(`getComputedStyle(document.querySelector(".changes-row:nth-child(3) .changes-undo")).opacity`), "1");
    const m = await posted(() => page.click(".changes-row:nth-child(3) .changes-undo"));
    assert.deepStrictEqual(m, [{ type: "revertChanges", entryId: "c-ch", path: "D:\\acp client\\webview\\styles.css" }]);
  });

  await t("reverted row: dimmed, Undone label, no undo button", async () => {
    const r = await ev(`(() => { const r = document.querySelectorAll(".changes-row")[4];
      return { cls: r.className, undone: r.querySelector(".changes-undone")?.textContent,
        undo: !!r.querySelector(".changes-undo"), stats: !!r.querySelector(".changes-stats"),
        op: getComputedStyle(r.querySelector(".changes-name")).opacity }; })()`);
    assert.deepStrictEqual(r, { cls: "changes-row reverted", undone: "Undone", undo: false, stats: false, op: "0.55" });
  });

  await t("Undo hidden once every file is reverted", async () => {
    const files = await ev(`[...document.querySelectorAll(".changes-file")].map(b => b.title)`);
    await page.evaluate((files) => window.dispatchEvent(new MessageEvent("message", { data: { type: "entryUpsert", entry: {
      id: "c-ch", kind: "changes", ts: Date.now(),
      files: files.map((p) => ({ path: p, add: 1, del: 1 })), reverted: files } } })), files);
    await sleep(120);
    const btns = await ev(`[...document.querySelectorAll(".changes-head .changes-btn")].map(b => b.textContent)`);
    assert.deepStrictEqual(btns, ["Review"]);
    assert.strictEqual(await ev(`document.querySelectorAll(".changes-row.reverted").length`), 5);
    assert.strictEqual(await ev(`document.querySelectorAll(".changes-undo").length`), 0);
  });

  await t("file-link inline code posts openFile with the exact text", async () => {
    const links = await ev(`[...document.querySelectorAll(".msg.agent code.file-link")].map(c => c.textContent)`);
    assert.deepStrictEqual(links, ["src/registry.ts:42", "webview/App.tsx", "README.md", "src\\threads\\store.ts#L12"]);
    for (const p of links) {
      const m = await posted(() => ev(`[...document.querySelectorAll(".msg.agent code.file-link")].find(c => c.textContent === ${JSON.stringify(p)}).click()`));
      assert.deepStrictEqual(m, [{ type: "openFile", path: p }]);
    }
    assert.strictEqual(await ev(`getComputedStyle(document.querySelector(".msg.agent code.file-link")).cursor`), "pointer");
  });

  await t("file-link code opens with Enter", async () => {
    await page.focus(".msg.agent code.file-link");
    const m = await posted(() => page.keyboard.press("Enter"));
    assert.deepStrictEqual(m, [{ type: "openFile", path: "src/registry.ts:42" }]);
  });

  await t("relative and file:// markdown links post openFile", async () => {
    let m = await posted(() => page.click(".msg.agent a >> text=the installer"));
    assert.deepStrictEqual(m, [{ type: "openFile", path: "src/installer.ts#L12" }]);
    m = await posted(() => page.click(".msg.agent a >> text=types"));
    assert.deepStrictEqual(m, [{ type: "openFile", path: "D:/acp client/src/types.ts:5" }]);
    assert.ok(await ev(`location.hash === "#changes"`), "no navigation happened");
  });

  await t("http link still posts openExternal", async () => {
    const m = await posted(() => page.click(".msg.agent a >> text=the docs"));
    assert.deepStrictEqual(m, [{ type: "openExternal", url: "https://example.com/docs" }]);
  });

  await t("non-path inline code is not linkified", async () => {
    const plain = await ev(`[...document.querySelectorAll(".msg.agent code:not(.file-link)")].filter(c => !c.closest("pre")).map(c => c.textContent)`);
    assert.deepStrictEqual(plain, ["e.g.", "1.2.3", "package@1.0", "npm run build", "Node.js", "window.location"]);
    const m = await posted(() => ev(`[...document.querySelectorAll(".msg.agent code")].find(c => c.textContent === "1.2.3").click()`));
    assert.deepStrictEqual(m, []);
  });

  await t("nothing inside fenced code is linkified", async () => {
    assert.strictEqual(await ev(`document.querySelectorAll(".msg.agent pre .file-link, .msg.agent .codeblock .file-link").length`), 0);
    assert.ok(await ev(`document.querySelector(".msg.agent pre").textContent.includes("src/registry.ts:42")`));
    const m = await posted(() => page.click(".msg.agent pre"));
    assert.deepStrictEqual(m, []);
  });

  await t("user messages keep plain inline code", async () => {
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "entryUpsert", entry: {
      id: "c-u2", kind: "user", ts: Date.now(), parts: [{ type: "text", text: "Look at `src/registry.ts` please" }] } } })));
    await sleep(120);
    assert.strictEqual(await ev(`document.querySelectorAll(".msg.user .file-link").length`), 0);
  });

  await load("#changes-many");

  await t("more than 6 files: 6 rows and a Show more toggle", async () => {
    assert.strictEqual(await ev(`document.querySelector(".changes-title").textContent`), "9 files changed");
    assert.strictEqual(await ev(`document.querySelectorAll(".changes-row").length`), 6);
    assert.strictEqual(await ev(`document.querySelector(".changes-more").textContent`), "Show 3 more");
    assert.strictEqual(await ev(`document.querySelector(".changes-more").getAttribute("aria-expanded")`), "false");
    await page.click(".changes-more");
    await sleep(80);
    assert.strictEqual(await ev(`document.querySelectorAll(".changes-row").length`), 9);
    assert.strictEqual(await ev(`document.querySelector(".changes-more").textContent`), "Show less");
    const last = await ev(`[...document.querySelectorAll(".changes-row")].pop().querySelector(".changes-dir").textContent`);
    assert.strictEqual(last, "belle", "file in the second folder is relative to it");
    await page.click(".changes-more");
    await sleep(80);
    assert.strictEqual(await ev(`document.querySelectorAll(".changes-row").length`), 6);
    await page.click(".changes-more");
    await sleep(80);
  });

  await page.screenshot({ path: shot("changes-380.png") });

  await t("300px: no horizontal overflow, rows stay inside the card", async () => {
    await page.setViewportSize({ width: 300, height: 760 });
    await sleep(200);
    const r = await ev(`(() => {
      const card = document.querySelector(".changes").getBoundingClientRect();
      const bad = [];
      // Text inside .changes-label is clipped by it; the label itself is checked.
      for (const el of document.querySelectorAll(".changes *:not(.changes-label *)")) {
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > card.right + 0.5 || b.left < card.left - 0.5)) bad.push(el.className);
      }
      const m = document.querySelector(".messages");
      return { bad, docOver: document.documentElement.scrollWidth > innerWidth,
        msgOver: m.scrollWidth > m.clientWidth,
        nameTrunc: [...document.querySelectorAll(".changes-label")].some(n => n.scrollWidth > n.clientWidth) };
    })()`);
    assert.deepStrictEqual(r.bad, [], "children inside card");
    assert.strictEqual(r.docOver, false, "document does not scroll sideways");
    assert.strictEqual(r.msgOver, false, "messages do not scroll sideways");
    assert.strictEqual(r.nameTrunc, true, "long file name truncates");
  });

  await page.screenshot({ path: shot("changes-300.png") });

  await page.setViewportSize({ width: 380, height: 760 });
  await load("#changes-light");
  await page.hover(".changes-row:nth-child(2)");
  await sleep(100);
  await page.screenshot({ path: shot("changes-light.png") });

  await browser.close();
  if (pageErrors.length) {
    for (const e of pageErrors) console.log(`FAIL: ${e}`);
    failures += pageErrors.length;
  }
  if (failures) {
    console.log(`${failures} changes UI checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} changes UI checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
