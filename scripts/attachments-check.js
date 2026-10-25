"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");
const acp = require("@agentclientprotocol/sdk");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipwreck-attachments-"));
for (const [name, entry] of [
  ["host", "src/chatProvider.ts"], ["attachments", "src/attachments.ts"], ["store", "src/threads/store.ts"],
]) {
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "cjs",
    outfile: path.join(tmp, `${name}.cjs`), alias: { vscode: path.join(__dirname, "vscode-shim.js") },
  });
}
const { ChatController } = require(path.join(tmp, "host.cjs"));
const { attachmentFromBytes } = require(path.join(tmp, "attachments.cjs"));
const { ThreadStore } = require(path.join(tmp, "store.cjs"));
const M = acp.methods.agent;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok: ${name}`); };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const image = () => attachmentFromBytes("attachment:red/red.png", "red.png", Buffer.from(png, "base64"), "image/png");
const textFile = () => attachmentFromBytes("attachment:notes/notes.txt", "notes.txt", Buffer.from("hello\nworld"));
const controllers = [];

async function controller(capabilities) {
  const dir = fs.mkdtempSync(path.join(tmp, "host-"));
  const state = new Map();
  const c = new ChatController({
    globalStorageUri: { fsPath: dir }, subscriptions: [],
    globalState: { get: (k, d) => state.get(k) ?? d, update: async (k, v) => state.set(k, v) },
  }, {}, {
    descriptors: () => [{ id: "test", name: "Test", installed: true }],
    launchSpec: async () => ({ command: "test-agent", args: [], env: {} }),
  });
  controllers.push(c);
  c.didAutoConnect = true;
  const calls = [];
  const conn = {
    connected: false,
    start: async () => {
      conn.connected = true;
      return conn.initResponse = { agentCapabilities: { promptCapabilities: capabilities } };
    },
    stop: async () => { conn.connected = false; },
    request: async (method, params) => {
      calls.push({ method, params });
      return method === M.session.prompt ? { stopReason: "end_turn" } : { sessionId: "session-test" };
    },
  };
  const Pool = c.pool.constructor;
  c.pool.dispose();
  c.pool = new Pool(() => conn);
  const messages = [];
  const warnings = [];
  globalThis.__acpShimWarning = (text) => warnings.push(text);
  c.bind({ postMessage: async (m) => { messages.push(m); return true; }, onDidReceiveMessage: () => {} });
  await c.init();
  await c.selectAgent("test");
  return { c, calls, messages, warnings, prompt: () => calls.filter((x) => x.method === M.session.prompt).at(-1)?.params.prompt };
}

(async () => {
  await test("image reaches ACP and the local user transcript exactly", async () => {
    const h = await controller({ image: true });
    await h.c.sendPrompt("What color?", [image()]);
    assert.deepEqual(h.prompt(), [
      { type: "text", text: "What color?" },
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    assert.deepEqual(h.c.model.entries.find((e) => e.kind === "user").parts, h.prompt());
  });
  await test("browser text file becomes embedded resource text", async () => {
    const h = await controller({ embeddedContext: true });
    await h.c.sendPrompt("Read this", [textFile()]);
    assert.deepEqual(h.prompt(), [
      { type: "text", text: "Read this" },
      { type: "resource", resource: { uri: "attachment:notes/notes.txt", mimeType: "text/plain", text: "hello\nworld" } },
    ]);
  });
  await test("browser text file is fenced when embeddedContext is absent", async () => {
    const h = await controller({});
    await h.c.sendPrompt("Read this", [textFile()]);
    assert.deepEqual(h.prompt(), [
      { type: "text", text: "Read this" },
      { type: "text", text: "File: notes.txt\n```\nhello\nworld\n```" },
    ]);
  });
  await test("oversize image is rejected before encoding; text still sends", async () => {
    const att = attachmentFromBytes("attachment:big/big.png", "big.png", Buffer.alloc(5 * 1024 * 1024 + 1), "image/png");
    assert.deepEqual(att, { uri: "attachment:big/big.png", name: "big.png", kind: "rejected", error: "Image exceeds 5 MB." });
    const h = await controller({ image: true });
    await h.c.sendPrompt("Keep this text", [att]);
    assert.deepEqual(h.prompt(), [{ type: "text", text: "Keep this text" }]);
    assert.deepEqual(h.warnings, ["big.png: Image exceeds 5 MB."]);
  });
  await test("host rechecks oversize data even if the browser is bypassed", async () => {
    const h = await controller({ image: true });
    await h.c.sendPrompt("Text", [{ ...image(), data: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }]);
    assert.deepEqual(h.prompt(), [{ type: "text", text: "Text" }]);
  });
  await test("unsupported image does not block text or silently disappear", async () => {
    const h = await controller({});
    await h.c.sendPrompt("Send text", [image()]);
    assert.deepEqual(h.prompt(), [{ type: "text", text: "Send text" }]);
    assert.deepEqual(h.warnings, ["red.png: This agent doesn't support images."]);
  });
  await test("unsupported image-only send rejects with explanation and no turn", async () => {
    const h = await controller({});
    await h.c.sendPrompt("", [image()], "image-only");
    assert.deepEqual(h.messages.find((m) => m.type === "promptRejected"),
      { type: "promptRejected", requestId: "image-only", reason: "red.png: This agent doesn't support images." });
    assert.equal(h.calls.filter((x) => x.method === M.session.prompt).length, 0);
  });
  await test("binary and oversize text files have explicit rejected attachment kinds", async () => {
    assert.deepEqual(attachmentFromBytes("attachment:bin", "data.bin", Buffer.from([0, 255, 42])),
      { uri: "attachment:bin", name: "data.bin", kind: "rejected", error: "Binary files aren't supported." });
    assert.deepEqual(attachmentFromBytes("attachment:large", "large.txt", Buffer.alloc(1024 * 1024 + 1, 65)),
      { uri: "attachment:large", name: "large.txt", kind: "rejected", error: "Text file exceeds 1 MB." });
  });
  await test("Explorer image URI uses bytes; workspace text keeps resource links", async () => {
    const h = await controller({ image: true });
    globalThis.__acpShimFs = {
      stat: async () => ({ type: 1, size: Buffer.from(png, "base64").length }),
      readFile: async () => Buffer.from(png, "base64"),
    };
    try {
      await h.c.attachUris([pathToFileURL(path.join(tmp, "red.png")).href, pathToFileURL(path.join(tmp, "notes.txt")).href]);
      const atts = h.messages.filter((m) => m.type === "attachment").map((m) => m.attachment);
      assert.equal(atts[0].kind, "image");
      await h.c.sendPrompt("", atts);
      assert.deepEqual(h.prompt(), [
        { type: "image", data: png, mimeType: "image/png" },
        { type: "resource_link", uri: atts[1].uri, name: "notes.txt", mimeType: undefined },
      ]);
    } finally { delete globalThis.__acpShimFs; }
  });
  await test("thread saves reference images once and restore the original parts", async () => {
    const dir = path.join(tmp, "storage");
    const store = new ThreadStore(dir);
    const entries = [{ id: "u1", kind: "user", ts: 1, parts: [{ type: "image", mimeType: "image/png", data: png }] }];
    store.put({ id: "t1", title: "Image", createdAt: 1, updatedAt: 1, agents: [], backing: [] }, entries);
    await store.flush();
    const imageDir = path.join(dir, "threads", "t1.json.images");
    const imageFile = path.join(imageDir, fs.readdirSync(imageDir)[0]);
    const mtime = fs.statSync(imageFile).mtimeMs;
    store.setEntries("t1", entries);
    await store.flush();
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "threads", "t1.json"), "utf8"));
    assert.deepEqual(Object.keys(persisted[0].parts[0]).sort(), ["imageRef", "mimeType", "type"]);
    assert.equal(fs.readdirSync(imageDir).length, 1);
    assert.equal(fs.statSync(imageFile).mtimeMs, mtime);
    assert.deepEqual(await new ThreadStore(dir).entriesOf("t1"), entries);
    fs.unlinkSync(imageFile);
    assert.deepEqual((await new ThreadStore(dir).entriesOf("t1"))[0].parts,
      [{ type: "text", text: "[Image unavailable]" }]);
    store.setEntries("t1", entries);
    await store.flush();
    await store.delete("t1");
    assert.equal(fs.existsSync(imageDir), false);
  });
  console.log(`\n${passed} passed, 0 failed`);
})().catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    delete globalThis.__acpShimWarning;
    for (const c of controllers) { c.dispose(); await c.threadStore.flush(); }
  });
