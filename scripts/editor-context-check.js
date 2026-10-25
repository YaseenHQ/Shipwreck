"use strict";
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");
const acp = require("@agentclientprotocol/sdk");
const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipwreck-editor-context-"));
esbuild.buildSync({
  stdin: {
    contents: 'export * as vscode from "vscode"; export { ChatController } from "./src/chatProvider"; export { registerAddToChatCommands } from "./src/editorIntegration"; export { buildPrompt } from "./src/promptAttachments"; export { buildHandoff, buildTranscript } from "./src/threads/handoff";',
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", outfile: path.join(tmp, "host.cjs"),
  alias: { vscode: path.join(__dirname, "vscode-shim.js") }, logLevel: "error",
});
const { vscode, ChatController, registerAddToChatCommands, buildPrompt, buildHandoff, buildTranscript } = require(path.join(tmp, "host.cjs"));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok: ${name}`); };
const controllers = [];
const events = {};
for (const [owner, name] of [
  [vscode.window, "onDidChangeActiveTextEditor"], [vscode.window, "onDidChangeTextEditorSelection"],
  [vscode.workspace, "onDidChangeTextDocument"], [vscode.workspace, "onDidChangeConfiguration"],
  [vscode.languages, "onDidChangeDiagnostics"],
]) {
  const emitter = events[name] = new vscode.EventEmitter();
  owner[name] = emitter.event;
}
const uri = vscode.Uri.file(path.join(tmp, "App.tsx"));
const otherUri = vscode.Uri.file(path.join(tmp, "Other.ts"));
const range = (sl, sc, el, ec) => ({
  start: { line: sl, character: sc }, end: { line: el, character: ec },
  contains(p) {
    return (p.line > sl || p.line === sl && p.character >= sc)
      && (p.line < el || p.line === el && p.character <= ec);
  },
});
const text = "function outer() {\n  function inner() {\n    return 42;\n  }\n}\n";
const document = {
  uri, getText: (r) => r ? text.slice(document.offsetAt(r.start), document.offsetAt(r.end)) : text,
  offsetAt: (p) => text.split("\n").slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character,
};
const select = (r, empty = false) => {
  vscode.window.activeTextEditor = { document, selection: { ...r, active: r.start, isEmpty: empty } };
};
select(range(0, 0, 0, 0), true);
const commands = new Map();
vscode.commands.registerCommand = (name, fn) => {
  commands.set(name, fn);
  return new vscode.Disposable(() => commands.delete(name));
};
let diagnostics = [];
vscode.languages.getDiagnostics = (u) => u.toString() === uri.toString() ? diagnostics : [];
const gitChange = new vscode.EventEmitter();
const repository = {
  state: { indexChanges: [], workingTreeChanges: [], untrackedChanges: [], onDidChange: gitChange.event },
};
const gitApi = {
  repositories: [repository], onDidOpenRepository: new vscode.EventEmitter().event,
  onDidCloseRepository: new vscode.EventEmitter().event,
};
vscode.extensions.getExtension = (name) => name === "vscode.git"
  ? { isActive: true, exports: { getAPI: () => gitApi } } : undefined;

async function host(capabilities = {}) {
  const state = new Map();
  const c = new ChatController({
    globalStorageUri: { fsPath: fs.mkdtempSync(path.join(tmp, "storage-")) }, subscriptions: [],
    globalState: { get: (k, d) => state.get(k) ?? d, update: async (k, v) => state.set(k, v) },
  }, {}, {
    descriptors: () => [{ id: "test", name: "Test", installed: true }],
    launchSpec: async () => ({ command: "test-agent", args: [], env: {} }),
  });
  controllers.push(c);
  c.didAutoConnect = true;
  const calls = [];
  const connection = {
    connected: false,
    start: async () => {
      connection.connected = true;
      return connection.initResponse = { agentCapabilities: { promptCapabilities: capabilities } };
    },
    stop: async () => { connection.connected = false; },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === acp.methods.agent.session.list) return { sessions: [] };
      return method === acp.methods.agent.session.prompt ? { stopReason: "end_turn" } : { sessionId: "test-session" };
    },
  };
  const Pool = c.pool.constructor;
  c.pool.dispose();
  c.pool = new Pool(() => connection);
  const messages = [];
  c.bind({ postMessage: async (m) => { messages.push(m); return true; }, onDidReceiveMessage: () => {} });
  await c.init();
  await c.selectAgent("test");
  return {
    c, messages,
    prompt: () => calls.filter((x) => x.method === acp.methods.agent.session.prompt).at(-1).params.prompt,
    context: () => messages.filter((m) => m.type === "editorContext").at(-1),
    toggle: (enabled) => c.onMessage({ type: "setEditorContext", uri: uri.toString(), enabled }),
    send: (attachments = [], text = "Review") => c.onMessage({ type: "sendPrompt", text, attachments }),
  };
}
const review = { type: "text", text: "Review" };
const link = { type: "resource_link", uri: uri.toString(), name: "App.tsx" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const h = await host({ embeddedContext: true });
  await test("file-only context reaches ACP as a resource link even with embeddedContext", async () => {
    await h.send();
    assert.deepEqual(h.prompt(), [review, link]);
    assert.equal(h.context().context.name, "App.tsx");
  });
  await test("selection text and one-based inclusive line range reach ACP as an embedded resource", async () => {
    select(range(1, 0, 4, 0));
    events.onDidChangeTextEditorSelection.fire();
    await sleep(180);
    assert.deepEqual(h.context().context.selection, {
      range: { startLine: 2, endLine: 4 }, text: "  function inner() {\n    return 42;\n  }\n",
    });
    await h.send();
    assert.deepEqual(h.prompt(), [review, {
      type: "resource", resource: { uri: `${uri}#L2-4`, mimeType: "text/plain", text: "  function inner() {\n    return 42;\n  }\n" },
    }]);
  });
  await test("toggle off survives selection changes and sends no automatic context", async () => {
    await h.toggle(false);
    select(range(2, 4, 2, 14));
    events.onDidChangeTextEditorSelection.fire();
    await sleep(180);
    assert.equal(h.context().enabled, false);
    await h.send();
    assert.deepEqual(h.prompt(), [review]);
    assert.equal(h.context().enabled, true);
  });
  await test("editor changes reset the per-message toggle", async () => {
    await h.toggle(false);
    vscode.window.activeTextEditor = { document: { ...document, uri: otherUri }, selection: { isEmpty: true } };
    events.onDidChangeActiveTextEditor.fire();
    assert.equal(h.context().enabled, true);
    await h.send();
    assert.deepEqual(h.prompt(), [review, { type: "resource_link", uri: otherUri.toString(), name: "Other.ts" }]);
    select(range(0, 0, 0, 0), true);
    events.onDidChangeActiveTextEditor.fire();
  });
  await test("diagnostics add exact problem text and counts without hints", async () => {
    diagnostics = [
      { severity: 0, range: range(11, 0, 11, 1), code: { value: "TS2322" }, message: "Type number\nis not assignable" },
      { severity: 1, range: range(2, 0, 2, 1), code: 6133, message: "Unused value" },
      { severity: 3, range: range(0, 0, 0, 1), message: "Hint" },
    ];
    events.onDidChangeDiagnostics.fire();
    await sleep(180);
    assert.deepEqual(h.context().context.diagnostics, {
      error: 1, warning: 1, items: [
        { line: 12, severity: "error", code: "TS2322", message: "Type number is not assignable" },
        { line: 3, severity: "warning", code: "6133", message: "Unused value" },
      ],
    });
    await h.send();
    assert.deepEqual(h.prompt(), [review, {
      type: "text", text: "Problems in App.tsx:\nL12 error TS2322 Type number is not assignable\nL3 warning 6133 Unused value",
    }, link]);
  });
  await test("diagnostics stay on attachment parts, not in user words or handoffs", async () => {
    const fileContext = { diagnostics: h.context().context.diagnostics };
    const attachment = { kind: "file", uri: uri.toString(), name: "App.tsx",
      contextSource: "active-editor", fileContext };
    for (const att of [attachment, { ...attachment, kind: "text-file", text: "code", mimeType: "text/plain" }]) {
      const built = await buildPrompt("Review", [att], { embeddedContext: true }, async () => "");
      assert.deepEqual(built.parts.filter((p) => p.type === "text"), [review]);
      assert.deepEqual(built.parts[1].fileContext, fileContext);
      assert.equal(built.blocks[1].text,
        "Problems in App.tsx:\nL12 error TS2322 Type number is not assignable\nL3 warning 6133 Unused value");
      const entries = [{ id: "user", kind: "user", ts: 1, parts: built.parts }];
      assert.equal(buildTranscript(entries, (id) => id), "### User\nReview");
      assert.equal(buildHandoff(entries, { budgetBytes: 64000, agentName: (id) => id, currentAgentId: "next" }).text,
        "Context from earlier in this thread. This is background — the user's new request follows after it.\n\n### User\nReview");
    }
  });
  await test("thread titles use typed words or the file name despite agent title updates", async () => {
    for (const [typed, expected] of [["Review", "Review"], ["", "App.tsx"]]) {
      select(range(1, 0, 4, 0));
      const fresh = await host();
      await fresh.send([], typed);
      const user = fresh.c.model.entries.find((e) => e.kind === "user");
      assert.deepEqual(user.parts.filter((p) => p.type === "text"), typed ? [review] : []);
      assert.equal(fresh.c.threadStore.get(fresh.c.activeThreadId).title, expected);
      fresh.c.onSessionUpdate({ sessionId: "test-session",
        update: { sessionUpdate: "session_info_update", title: "Problems in App.tsx: L12 error" } });
      assert.equal(fresh.c.threadStore.get(fresh.c.activeThreadId).title, expected);
      const meta = fresh.c.threadStore.get(fresh.c.activeThreadId);
      fresh.c.applyBackgroundUpdate({ model: fresh.c.model, session: fresh.c.session,
        owner: { threadId: meta.id } }, { sessionId: "test-session",
        update: { sessionUpdate: "session_info_update", title: "Background problems" } });
      assert.equal(fresh.c.threadStore.get(meta.id).title, expected);
      await fresh.c.threadStore.flush();
      assert.equal(JSON.parse(fs.readFileSync(path.join(fresh.c.threadStore.root(), "index.json"), "utf8"))[0].title, expected);
    }
    select(range(0, 0, 0, 0), true);
  });
  await test("explicit file attachments carry live diagnostics and Git metadata", async () => {
    repository.state.workingTreeChanges = [{ uri, status: 5 }];
    await h.c.addAttachments([{ kind: "file", uri: uri.toString(), name: "App.tsx" }]);
    const attachment = h.messages.filter((m) => m.type === "attachment").at(-1).attachment;
    assert.equal(attachment.fileContext.git, "M");
    assert.equal(attachment.fileContext.diagnostics.error, 1);
    await h.c.onMessage({ type: "watchFiles", uris: [uri.toString()] });
    diagnostics = [];
    events.onDidChangeDiagnostics.fire();
    await sleep(180);
    assert.deepEqual(h.messages.filter((m) => m.type === "fileContext").at(-1), {
      type: "fileContext", uri: uri.toString(), context: { diagnostics: { error: 0, warning: 0, items: [] }, git: "M" },
    });
    await h.send([attachment]);
    assert.deepEqual(h.prompt(), [review, {
      type: "resource", resource: { uri: uri.toString(), mimeType: "text/plain", text: "" },
    }]);
  });
  await test("Git status updates modified, staged added, and untracked markers", async () => {
    repository.state.workingTreeChanges = [];
    repository.state.indexChanges = [{ uri, status: 1 }];
    gitChange.fire();
    await sleep(180);
    assert.equal(h.context().context.git, "A");
    repository.state.indexChanges = [];
    repository.state.untrackedChanges = [{ uri, status: 7 }];
    gitChange.fire();
    await sleep(180);
    assert.equal(h.context().context.git, "U");
    repository.state.untrackedChanges = [];
  });
  await test("problem text caps at 20 items and 300 characters per message", async () => {
    diagnostics = Array.from({ length: 25 }, (_, i) => ({
      severity: 0, range: range(i, 0, i, 1), message: "x".repeat(400),
    }));
    await h.send();
    assert.equal(h.context().context.diagnostics.error, 25);
    assert.equal(h.context().context.diagnostics.items.length, 20);
    assert.equal(h.context().context.diagnostics.items[0].message.length, 300);
    assert.equal(h.prompt()[1].text, "Problems in App.tsx:\n"
      + Array.from({ length: 20 }, (_, i) => `L${i + 1} error ${"x".repeat(300)}`).join("\n")
      + "\n5 more problems omitted.");
    diagnostics = [];
  });
  await test("untitled and output editors never add context", async () => {
    for (const scheme of ["untitled", "output"]) {
      vscode.window.activeTextEditor = {
        document: { ...document, uri: { scheme, toString: () => `${scheme}:test` } },
        selection: { isEmpty: true },
      };
      await h.send();
      assert.deepEqual(h.prompt(), [review]);
      assert.equal(h.context().context, undefined);
    }
    select(range(0, 0, 0, 0), true);
  });
  await test("setting default off still exposes a chip that can be enabled for one message", async () => {
    globalThis.__acpShimConfig = { "context.activeFile": false };
    events.onDidChangeConfiguration.fire({ affectsConfiguration: (key) => key === "shipwreck.context.activeFile" });
    await h.send();
    assert.deepEqual(h.prompt(), [review]);
    await h.toggle(true);
    await h.send();
    assert.deepEqual(h.prompt(), [review, link]);
    assert.equal(h.context().enabled, false);
    delete globalThis.__acpShimConfig;
    events.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  });
  await test("symbol command attaches the innermost enclosing symbol and its exact range", async () => {
    const registrations = registerAddToChatCommands(h.c);
    select(range(2, 6, 2, 6), true);
    globalThis.__acpShimCommand = (command) => command === "vscode.executeDocumentSymbolProvider" ? [{
      range: range(0, 0, 4, 1), children: [{ range: range(1, 2, 3, 3), children: [] }],
    }] : undefined;
    await commands.get("shipwreck.addSymbolToChat")();
    const attachment = h.messages.filter((m) => m.type === "attachment").at(-1).attachment;
    assert.deepEqual({ range: attachment.range, text: attachment.text, kind: attachment.kind }, {
      range: { startLine: 2, endLine: 4 }, text: "function inner() {\n    return 42;\n  }", kind: "selection",
    });
    await h.toggle(false);
    await h.send([attachment]);
    assert.deepEqual(h.prompt(), [review, {
      type: "resource", resource: { uri: `${uri}#L2-4`, mimeType: "text/plain", text: "function inner() {\n    return 42;\n  }" },
    }]);
    registrations.forEach((r) => r.dispose());
    delete globalThis.__acpShimCommand;
  });
  await test("Alt+K command snapshots selection before chat focus changes", async () => {
    const registrations = registerAddToChatCommands(h.c);
    select(range(2, 4, 2, 14));
    await commands.get("shipwreck.addSelectionToChat")();
    const attachment = h.messages.filter((m) => m.type === "attachment").at(-1).attachment;
    assert.deepEqual({ range: attachment.range, text: attachment.text }, {
      range: { startLine: 3, endLine: 3 }, text: "return 42;",
    });
    registrations.forEach((r) => r.dispose());
  });
  await test("selection falls back to a range link plus literal text without embeddedContext", async () => {
    const fallback = await host({});
    await fallback.send();
    assert.deepEqual(fallback.prompt(), [review, {
      type: "resource_link", uri: `${uri}#L3-3`, name: "App.tsx", mimeType: undefined,
    }, { type: "text", text: "return 42;" }]);
  });
  await test("command and menu contributions expose symbol attach and Alt+K", async () => {
    const { contributes } = require("../package.json");
    assert.deepEqual(contributes.commands.find((c) => c.command === "shipwreck.addSymbolToChat"),
      { command: "shipwreck.addSymbolToChat", title: "Add Symbol to Chat", category: "Shipwreck" });
    assert.equal(contributes.menus["editor/context"].find((c) => c.command === "shipwreck.addSymbolToChat").when,
      "editorTextFocus && resourceScheme == file");
    assert.deepEqual(contributes.keybindings.find((c) => c.command === "shipwreck.addSelectionToChat"),
      { command: "shipwreck.addSelectionToChat", key: "alt+k", when: "editorTextFocus" });
  });
  await test("unchanged context does not post duplicate editor or file metadata", async () => {
    events.onDidChangeTextEditorSelection.fire();
    await sleep(180);
    const count = h.messages.filter((m) => m.type === "editorContext" || m.type === "fileContext").length;
    events.onDidChangeDiagnostics.fire();
    await sleep(180);
    assert.equal(h.messages.filter((m) => m.type === "editorContext" || m.type === "fileContext").length, count);
    await h.c.onMessage({ type: "watchFiles", uris: [] });
    diagnostics = [{ severity: 0, range: range(0, 0, 0, 1), message: "Changed" }];
    const fileCount = h.messages.filter((m) => m.type === "fileContext").length;
    events.onDidChangeDiagnostics.fire();
    await sleep(180);
    assert.equal(h.messages.filter((m) => m.type === "fileContext").length, fileCount);
    assert.equal(h.context().context.diagnostics.error, 1);
    diagnostics = [];
  });
  await test("Git may be absent without losing file context", async () => {
    vscode.extensions.getExtension = () => undefined;
    select(range(0, 0, 0, 0), true);
    const noGit = await host();
    await noGit.send();
    assert.deepEqual(noGit.prompt(), [review, link]);
    assert.equal(noGit.context().context.git, undefined);
  });
  await test("active file context defaults on when the setting is absent", async () => {
    globalThis.__acpShimConfig = {};
    events.onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
    await h.send();
    assert.deepEqual(h.prompt(), [review, link]);
    delete globalThis.__acpShimConfig;
  });
  await uiChecks();
  console.log(`\n${passed} passed, 0 failed`);
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  delete globalThis.__acpShimConfig;
  delete globalThis.__acpShimCommand;
  for (const c of controllers) { c.dispose(); await c.threadStore.flush(); }
});

async function uiChecks() {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROME ||
    "C:\\Users\\moham\\AppData\\Local\\ms-playwright\\chromium-1208\\chrome-win64\\chrome.exe" });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("file:///" + path.join(root, "preview", "harness.html").replace(/\\/g, "/") + "#home");
    await page.waitForSelector(".composer textarea");
    await page.waitForTimeout(3100);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: {
      type: "snapshot", payload: { ...window.__snapshot, entries: [],
        session: { ...window.__session, busy: false } },
    } })));
    const deliver = (message) => page.evaluate((data) =>
      window.dispatchEvent(new MessageEvent("message", { data })), message);
    const context = {
      uri: "file:///C:/workspace/App.tsx", name: "App.tsx",
      selection: { range: { startLine: 12, endLine: 30 }, text: "selected code" },
      diagnostics: { error: 2, warning: 1, items: [] }, git: "M",
    };
    await test("composer renders live selection range, problem count, and Git status", async () => {
      await deliver({ type: "editorContext", context, enabled: true });
      assert.equal(await page.locator(".editor-context-chip").textContent(), "App.tsx:12-30M3");
      assert.equal(await page.locator(".editor-context-chip").getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator(".editor-context-chip .file-problems").getAttribute("title"), "2 errors, 1 warnings");
    });
    await test("keyboard toggle asks the host to exclude context and reflects its reply", async () => {
      await page.locator(".editor-context-chip").focus();
      await page.keyboard.press("Space");
      assert.deepEqual(await page.evaluate(() => window.__sent.filter((m) => m.type === "setEditorContext").at(-1)),
        { type: "setEditorContext", uri: context.uri, enabled: false });
      await deliver({ type: "editorContext", context, enabled: false });
      assert.equal(await page.locator(".editor-context-chip").getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator(".editor-context-chip.context-disabled").count(), 1);
    });
    await test("explicit attachment chips receive live problem and Git updates", async () => {
      await deliver({ type: "attachment", attachment: { kind: "file", uri: context.uri, name: context.name } });
      await deliver({ type: "fileContext", uri: context.uri,
        context: { diagnostics: { error: 1, warning: 0, items: [] }, git: "A" } });
      assert.equal(await page.locator(".attach-chip").textContent(), "App.tsxA1");
      assert.equal(await page.locator(".attach-chip .file-problems").getAttribute("title"), "1 errors, 0 warnings");
      assert.deepEqual(await page.evaluate(() => window.__sent.filter((m) => m.type === "watchFiles").at(-1)),
        { type: "watchFiles", uris: [context.uri] });
      await page.screenshot({ path: path.join(root, "preview", "ide-harness-context-380.png") });
    });
    await test("composer submits explicit attachments only, leaving automatic context to the host", async () => {
      await deliver({ type: "editorContext", context, enabled: true });
      await page.locator(".composer textarea").fill("Review");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const prompt = await page.evaluate(() => window.__sent.filter((m) => m.type === "sendPrompt").at(-1));
      assert.equal(prompt.text, "Review");
      assert.deepEqual(prompt.attachments, [{
        kind: "file", uri: context.uri, name: context.name,
        fileContext: { diagnostics: { error: 1, warning: 0, items: [] }, git: "A" },
      }]);
      await deliver({ type: "promptAccepted", requestId: prompt.requestId });
      await page.waitForSelector(".attach-chip", { state: "detached" });
      await deliver({ type: "editorContext", context, enabled: false });
      assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    });
    await test("transcript chips retain problem counts without diagnostic text in the user bubble", async () => {
      const fileContext = { diagnostics: { error: 1, warning: 0,
        items: [{ line: 1, severity: "error", message: "Bad type" }] } };
      const entries = [];
      for (const kind of ["file", "text-file"]) {
        const { parts } = await buildPrompt("Review", [{
          kind, uri: context.uri, name: context.name, fileContext,
          ...(kind === "file" ? { contextSource: "active-editor" } : { text: "code", mimeType: "text/plain" }),
        }], { embeddedContext: true }, async () => "");
        entries.push({ id: kind, kind: "user", ts: 1, parts });
      }
      await page.evaluate((entries) => window.dispatchEvent(new MessageEvent("message", { data: {
        type: "snapshot", payload: { ...window.__snapshot, entries,
          session: { ...window.__session, busy: false } },
      } })), entries);
      assert.deepEqual(await page.locator(".msg.user .file-problems").allTextContents(), ["1", "1"]);
      assert.deepEqual(await page.locator(".msg.user .md").allTextContents(), ["Review\n", "Review\n", "code\n"]);
      assert.equal(await page.locator(".msg.user").getByText("Bad type", { exact: false }).count(), 0);
    });
    await test("context chips fit a 300px composer and disappear for non-file editors", async () => {
      await page.setViewportSize({ width: 300, height: 820 });
      const box = await page.locator(".editor-context-chip").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 300);
      await page.screenshot({ path: path.join(root, "preview", "ide-harness-context-300.png") });
      await deliver({ type: "editorContext", enabled: true });
      assert.equal(await page.locator(".editor-context-chip").count(), 0);
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
  }
}
