"use strict";
const assert = require("assert/strict");
const path = require("path");
const { chromium } = require("playwright-core");
const CHROME = process.env.PW_CHROME ||
  "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe";
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok: ${name}`); };

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 820 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("file:///" + path.resolve(__dirname, "../preview/harness.html").replace(/\\/g, "/") + "#home");
    await page.waitForSelector(".composer textarea");
    await page.waitForFunction(() => !!window.__snapshot);
    await page.waitForTimeout(3100);
    const snapshot = async (image) => {
      await page.evaluate((image) => {
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "snapshot", payload: { ...window.__snapshot, entries: [],
            session: { ...window.__session, busy: false }, promptCapabilities: { image } },
        } }));
      }, image);
    };
    await snapshot(true);
    const transfer = async (mode, kind) => {
      return page.evaluate(async ({ mode, kind }) => {
        const dt = new DataTransfer();
        if (kind === "image") {
          const c = document.createElement("canvas");
          c.width = c.height = 64;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#ff0000";
          ctx.fillRect(0, 0, 64, 64);
          const blob = await new Promise((r) => c.toBlob(r, "image/png"));
          dt.items.add(new File([blob], "red-square.png", { type: "image/png" }));
        } else if (kind === "text") {
          dt.items.add(new File(["hello\nworld"], "notes.txt", { type: "text/plain" }));
        } else if (kind === "oversize") {
          dt.items.add(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
        } else if (kind === "binary") {
          dt.items.add(new File([new Uint8Array([0, 255, 42])], "data.bin"));
        } else if (kind === "uri") {
          dt.setData("application/vnd.code.uri-list", "file:///C:/workspace/red.png");
          dt.items.add(new File(["duplicate"], "red.png", { type: "image/png" }));
        } else {
          dt.setData("text/plain", "plain clipboard text");
        }
        const ta = document.querySelector(".composer textarea");
        const e = mode === "paste"
          ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        ta.dispatchEvent(e);
        return e.defaultPrevented;
      }, { mode, kind });
    };
    const lastPrompt = () => page.evaluate(() => window.__sent.filter((m) => m.type === "sendPrompt").at(-1));
    const ack = async () => page.evaluate(() => {
      const m = window.__sent.filter((m) => m.type === "sendPrompt").at(-1);
      window.dispatchEvent(new MessageEvent("message", { data: { type: "promptAccepted", requestId: m.requestId } }));
    });
    const remove = () => page.locator(".attach-chip .chip-x").click();
    await test("plain text paste is not intercepted and creates no attachment", async () => {
      await page.locator("textarea").fill("Existing draft");
      assert.equal(await transfer("paste", "plain"), false);
      assert.equal(await page.locator("textarea").inputValue(), "Existing draft");
      assert.equal(await page.locator(".attach-chip").count(), 0);
    });
    await test("image paste shows removable thumbnail and submits image bytes", async () => {
      assert.equal(await transfer("paste", "image"), true);
      await page.waitForSelector(".attach-thumb");
      assert.equal(await page.locator(".attach-thumb").evaluate((e) => e.naturalWidth), 64);
      assert.equal(await page.locator(".attach-chip").innerText(), "red-square.png");
      await page.screenshot({ path: path.resolve(__dirname, "../preview/paste-harness-chip.png") });
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const m = await lastPrompt();
      assert.equal(m.text, "Existing draft");
      assert.deepEqual(m.attachments.map(({ kind, name, mimeType }) => ({ kind, name, mimeType })),
        [{ kind: "image", name: "red-square.png", mimeType: "image/png" }]);
      assert.ok(m.attachments[0].data.startsWith("iVBORw0KGgo"));
      await ack();
      await page.waitForSelector(".attach-chip", { state: "detached" });
    });
    await test("OS image drop shares the paste path and the remove control works", async () => {
      assert.equal(await transfer("drop", "image"), true);
      await page.waitForSelector(".attach-thumb");
      await remove();
      assert.equal(await page.locator(".attach-chip").count(), 0);
    });
    await test("Explorer URI wins over duplicate File payload", async () => {
      await transfer("drop", "uri");
      assert.deepEqual(await page.evaluate(() => window.__sent.filter((m) => m.type === "attachUris").at(-1)),
        { type: "attachUris", uris: ["file:///C:/workspace/red.png"] });
      assert.equal(await page.locator(".attach-chip").count(), 0);
    });
    await test("OS text file paste reads actual File bytes", async () => {
      await transfer("paste", "text");
      await page.waitForSelector(".attach-chip");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const m = await lastPrompt();
      assert.deepEqual(m.attachments.map(({ kind, name, text, mimeType }) => ({ kind, name, text, mimeType })),
        [{ kind: "text-file", name: "notes.txt", text: "hello\nworld", mimeType: "text/plain" }]);
      await ack();
      await page.waitForSelector(".attach-chip", { state: "detached" });
    });
    await test("oversize image and binary file show inline rejection on their chip", async () => {
      await transfer("paste", "oversize");
      await page.waitForSelector(".attach-error-text");
      assert.equal(await page.locator(".attach-error-text").innerText(), "Image exceeds 5 MB.");
      await remove();
      await transfer("drop", "binary");
      await page.waitForSelector(".attach-error-text");
      assert.equal(await page.locator(".attach-error-text").innerText(), "Binary files aren't supported.");
      await remove();
    });
    await test("unsupported image has tooltip, cannot send alone, and does not block text", async () => {
      await snapshot(false);
      await transfer("paste", "image");
      await page.waitForSelector(".attach-error");
      assert.equal(await page.locator(".attach-chip").getAttribute("title"), "This agent doesn't support images.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      assert.equal(await page.locator(".send-err").innerText(), "This agent doesn't support images.");
      await page.locator("textarea").fill("Send my text");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const m = await lastPrompt();
      assert.equal(m.text, "Send my text");
      assert.deepEqual(m.attachments, []);
      await ack();
      assert.equal(await page.locator(".send-err").innerText(), "This agent doesn't support images.");
    });
    await test("transcript renders image parts without broken sources", async () => {
      await page.evaluate(() => {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, 64, 64);
        window.dispatchEvent(new MessageEvent("message", { data: { type: "entriesReplace",
          sessionId: window.__session.sessionId, entries: [{ id: "image-user", kind: "user", ts: 1,
            parts: [{ type: "text", text: "What color is this square?" },
              { type: "image", mimeType: "image/png", data: c.toDataURL().split(",")[1] }] }] } }));
      });
      await page.waitForSelector(".part-image");
      await page.waitForFunction(() => document.querySelector(".part-image").naturalWidth === 64);
      assert.equal(await page.locator(".part-image").evaluate((e) => e.naturalWidth), 64);
      await page.screenshot({ path: path.resolve(__dirname, "../preview/paste-harness-transcript.png") });
    });
    assert.deepEqual(errors, []);
    console.log(`\n${passed} passed, 0 failed`);
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
