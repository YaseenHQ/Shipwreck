/* Plain-Node check of the editor integration: file references, buffer-aware
   fs, per-turn change tracking with review/undo, and the IDE tools MCP
   server reached through its stdio bridge. */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const cp = require("child_process");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const out = path.join(os.tmpdir(), `ide-${Date.now()}.cjs`);
esbuild.buildSync({
  stdin: {
    contents: [
      'export * as vscode from "vscode";',
      'export * from "./src/fileRefs";',
      'export * from "./src/acp/clientFs";',
      'export * from "./src/changes";',
      'export * from "./src/ide/server";',
      'export { runTool, IDE_TOOLS } from "./src/ide/tools";',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
  logLevel: "error",
});
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "ideBridge.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(os.tmpdir(), "acp-ideBridge-test.js"),
  logLevel: "error",
});
const bridgePath = path.join(os.tmpdir(), "acp-ideBridge-test.js");
const m = require(out);
const { vscode } = m;

let failures = 0;
let passed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* Real-disk workspace.fs and a WorkspaceEdit that applies to open buffers or disk. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-ide-"));
const sameFile = (a, b) => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
Object.assign(vscode.workspace.fs, {
  readFile: async (u) => new Uint8Array(await fs.promises.readFile(u.fsPath)),
  writeFile: async (u, data) => fs.promises.writeFile(u.fsPath, data),
  createDirectory: async (u) => fs.promises.mkdir(u.fsPath, { recursive: true }),
  stat: async (u) => {
    const s = await fs.promises.stat(u.fsPath);
    return { type: s.isDirectory() ? 2 : 1, ctime: 0, mtime: 0, size: s.size };
  },
});
const edits = [];
vscode.workspace.applyEdit = async (edit) => {
  edits.push(edit);
  for (const op of edit.ops) {
    if (op.kind === "delete") { fs.rmSync(op.uri.fsPath, { force: true }); continue; }
    const doc = vscode.workspace.textDocuments.find((d) => sameFile(d.uri.fsPath, op.uri.fsPath));
    if (doc) doc.text = op.text;
    else fs.writeFileSync(op.uri.fsPath, op.text);
  }
  return true;
};
function openDoc(file, text) {
  const doc = {
    uri: vscode.Uri.file(file),
    text,
    saves: 0,
    getText() { return this.text; },
    positionAt(o) { return { offset: o }; },
    async save() { fs.writeFileSync(file, this.text); this.saves++; return true; },
  };
  vscode.workspace.textDocuments.push(doc);
  return doc;
}
const closeDocs = () => { vscode.workspace.textDocuments.length = 0; };

async function main() {
  /* ---- parseFileRef ---- */
  const p = m.parseFileRef;
  ok(eq(p("src/a.ts:12:3"), { path: "src/a.ts", line: 12, column: 3 }), "ref: path:line:col");
  ok(eq(p("src/a.ts:12"), { path: "src/a.ts", line: 12, column: undefined }), "ref: path:line");
  ok(eq(p("src/a.ts#L7"), { path: "src/a.ts", line: 7, column: undefined }), "ref: #L line");
  ok(eq(p("src/a.ts#L7-L9"), { path: "src/a.ts", line: 7, column: undefined }), "ref: #L range keeps first line");
  ok(eq(p("C:\\x\\a.ts"), { path: "C:\\x\\a.ts" }), "ref: drive colon is not a line");
  ok(eq(p("C:\\x\\a.ts:5"), { path: "C:\\x\\a.ts", line: 5, column: undefined }), "ref: drive path with line");
  const fu = p("file:///C:/x/a%20b.ts#L3C2");
  ok(fu.line === 3 && fu.column === 2 && /a b\.ts$/.test(fu.path), "ref: file URL keeps its #L position", fu);
  ok(eq(p("a%20b.md"), { path: "a b.md" }), "ref: percent-decoded");

  /* ---- resolveFileRef ---- */
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  const aTs = path.join(tmp, "src", "a.ts");
  fs.writeFileSync(aTs, "one\ntwo\nthree\n");
  const r1 = await m.resolveFileRef("src/a.ts", [tmp]);
  ok(r1 && sameFile(r1.fsPath, aTs), "resolve: relative to a root");
  const r2 = await m.resolveFileRef("./src/a.ts", [path.join(tmp, "nope"), tmp]);
  ok(r2 && sameFile(r2.fsPath, aTs), "resolve: ./ prefix, second root");
  ok(sameFile((await m.resolveFileRef(aTs, [])).fsPath, aTs), "resolve: absolute");
  ok((await m.resolveFileRef(path.join(tmp, "src"), [])) === undefined, "resolve: directory is not a file");
  let globbed;
  vscode.workspace.findFiles = async (g) => { globbed = g; return [vscode.Uri.file(aTs)]; };
  const r3 = await m.resolveFileRef("a.ts", [path.join(tmp, "nope")]);
  ok(globbed === "**/a.ts" && r3 && sameFile(r3.fsPath, aTs), "resolve: falls back to a workspace search", globbed);
  globbed = undefined;
  ok((await m.resolveFileRef("../a.ts", [path.join(tmp, "nope")])) === undefined && globbed === undefined,
    "resolve: no search for paths that climb out");
  vscode.workspace.findFiles = async () => [];

  /* ---- clientFs ---- */
  ok((await m.readTextFile(aTs)) === "one\ntwo\nthree\n", "fs: reads disk when not open");
  ok((await m.readTextFile(aTs, 2, 1)) === "two", "fs: line + limit slice");
  const doc = openDoc(aTs, "unsaved buffer\n");
  ok((await m.readTextFile(aTs)) === "unsaved buffer\n", "fs: reads the open buffer, not disk");
  ok((await m.readTextFile(aTs.toUpperCase())) === "unsaved buffer\n" || process.platform !== "win32",
    "fs: buffer match ignores case on Windows");
  edits.length = 0;
  await m.writeTextFile(aTs, "agent text\n");
  ok(edits.length === 1 && edits[0].ops[0].kind === "replace", "fs: open file written through a WorkspaceEdit");
  ok(doc.text === "agent text\n" && doc.saves === 1, "fs: buffer updated and saved");
  ok(fs.readFileSync(aTs, "utf8") === "agent text\n", "fs: saved content on disk");
  closeDocs();
  const deep = path.join(tmp, "new", "dir", "b.txt");
  edits.length = 0;
  await m.writeTextFile(deep, "fresh");
  ok(fs.readFileSync(deep, "utf8") === "fresh" && edits.length === 0, "fs: closed file written to disk, parents created");
  ok((await m.currentTextIfExists(path.join(tmp, "missing.txt"))) === undefined, "fs: missing file → undefined");

  /* ---- ChangeTracker: client writes ---- */
  const store = path.join(tmp, "changes");
  const t = new m.ChangeTracker(store);
  const edited = path.join(tmp, "src", "edit.ts");
  const created = path.join(tmp, "src", "created.ts");
  const untouched = path.join(tmp, "src", "same.ts");
  fs.writeFileSync(edited, "a\nb\nc\n");
  fs.writeFileSync(untouched, "same\n");
  t.begin("s1");
  await t.beforeWrite("s1", edited);
  await m.writeTextFile(edited, "a\nB\nc\nd\n");
  await t.beforeWrite("s1", edited);
  await m.writeTextFile(edited, "a\nB\nc\nd\ne\n");
  await t.beforeWrite("s1", created);
  await m.writeTextFile(created, "x\ny\n");
  await t.beforeWrite("s1", untouched);
  await m.writeTextFile(untouched, "same\n");
  await t.beforeWrite("other", edited);
  const entry = await t.finish("s1");
  ok(entry && entry.kind === "changes" && entry.files.length === 2, "changes: two files changed, unchanged one dropped", entry);
  const fe = entry.files.find((f) => sameFile(f.path, edited));
  const fc = entry.files.find((f) => sameFile(f.path, created));
  ok(fe && fe.add === 3 && fe.del === 1 && !fe.created, "changes: stats measured from the pre-turn snapshot", fe);
  ok(fc && fc.created === true && fc.add === 2 && fc.del === 0, "changes: new file flagged created", fc);
  ok((await t.finish("s1")) === undefined, "changes: finish is one-shot");
  t.begin("s0");
  ok((await t.finish("s0")) === undefined, "changes: a turn without edits adds no card");
  const loadSaved = async (tracker, id) => {
    for (let i = 0; i < 150; i++) {
      const saved = await tracker.load(id);
      if (saved) return saved;
      await sleep(20);
    }
  };
  const rec = await loadSaved(t, entry.id);
  ok(rec && rec.files.length === 2 && rec.files.some((f) => f.before === "a\nb\nc\n"), "changes: record saved for undo");
  ok((await t.load("../../etc/passwd")) === undefined, "changes: load rejects odd ids");

  /* ---- ChangeTracker: agent-side edits reported in tool calls ---- */
  const agentFile = path.join(tmp, "src", "agent.ts");
  fs.writeFileSync(agentFile, "let v = 1;\nkeep();\n");
  const t2 = new m.ChangeTracker(store);
  t2.begin("s2");
  // In-progress call: snapshot taken before the agent writes.
  t2.noteUpdate("s2", { sessionUpdate: "tool_call", toolCallId: "c1", kind: "edit", status: "pending",
    locations: [{ path: agentFile }] });
  await Promise.all([...t2.turns.get("s2").files.values()].map((f) => f.before));
  fs.writeFileSync(agentFile, "let v = 2;\nkeep();\n");
  // First seen after it ran: rebuild the before text from the diff.
  const lateFile = path.join(tmp, "src", "late.ts");
  fs.writeFileSync(lateFile, "head\nNEW LINE\ntail\n");
  t2.noteUpdate("s2", { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed",
    content: [{ type: "diff", path: lateFile, oldText: "old line", newText: "NEW LINE" }] });
  t2.noteUpdate("s2", { sessionUpdate: "tool_call", toolCallId: "c3", kind: "edit", status: "completed",
    content: [{ type: "diff", path: "relative.ts", oldText: "a", newText: "b" }] });
  t2.noteUpdate("s2", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } });
  const e2 = await t2.finish("s2");
  ok(e2 && e2.files.length === 2, "agent edits: both files listed, relative path ignored", e2);
  const rec2 = await loadSaved(t2, e2.id);
  const lateRec = rec2.files.find((f) => sameFile(f.path, lateFile));
  ok(lateRec && lateRec.before === "head\nold line\ntail\n", "agent edits: before text rebuilt from the reported diff", lateRec);
  ok(rec2.files.find((f) => sameFile(f.path, agentFile)).before === "let v = 1;\nkeep();\n",
    "agent edits: pending call snapshotted before the write");

  /* ---- review ---- */
  const cmds = [];
  vscode.commands.executeCommand = async (...a) => { cmds.push(a); };
  let n = 0;
  const diffUri = (label, content) => ({ label, content, n: n++ });
  await t.review(rec, diffUri, edited);
  ok(cmds.length === 1 && cmds[0][0] === "vscode.diff" && cmds[0][1].content === "a\nb\nc\n" && sameFile(cmds[0][2].fsPath, edited),
    "review: one file opens the diff editor (before ↔ live file)", cmds[0] && cmds[0][0]);
  cmds.length = 0;
  await t.review(rec, diffUri);
  ok(cmds.length === 1 && cmds[0][0] === "vscode.changes" && cmds[0][2].length === 2, "review: several files open the multi-file diff");
  cmds.length = 0;
  vscode.commands.executeCommand = async (...a) => { cmds.push(a); if (a[0] === "vscode.changes") throw new Error("no such command"); };
  await t.review(rec, diffUri);
  ok(cmds.length === 2 && cmds[1][0] === "vscode.diff", "review: falls back to a single diff on old VS Code");

  /* ---- undo ---- */
  let asked;
  globalThis.__acpShimWarning = (msg, opts, ...items) => { asked = { msg, opts, items }; return undefined; };
  ok(eq(await t.revert(rec), []), "undo: cancelled confirm changes nothing");
  ok(fs.readFileSync(edited, "utf8") === "a\nB\nc\nd\ne\n" && fs.existsSync(created), "undo: files untouched after cancel");
  ok(asked && asked.opts.modal === true && !/Changed since/.test(asked.opts.detail), "undo: modal confirm, no later-edit warning");
  fs.writeFileSync(edited, "a\nB\nc\nd\ne\nuser\n");
  globalThis.__acpShimWarning = (msg, opts, ...items) => { asked = { msg, opts, items }; return "Undo"; };
  const done = await t.revert(rec);
  ok(done.length === 2, "undo: both files restored");
  ok(/Changed since the agent's edits: edit\.ts/.test(asked.opts.detail), "undo: warns about edits made after the turn", asked.opts.detail);
  ok(fs.readFileSync(edited, "utf8") === "a\nb\nc\n", "undo: edited file back to its pre-turn text");
  ok(!fs.existsSync(created), "undo: created file deleted");
  const unknown = { files: [{ path: edited, before: undefined, afterHash: null }] };
  ok(eq(await t.revert(unknown), []), "undo: unknown original is refused");
  delete globalThis.__acpShimWarning;

  /* ---- IDE tools: dispatch ---- */
  const server = new m.IdeToolsServer(bridgePath, "9.9.9");
  const init = await server.dispatch("initialize", { protocolVersion: "2025-03-26" });
  ok(init.protocolVersion === "2025-03-26" && init.capabilities.tools && init.serverInfo.version === "9.9.9",
    "ide: initialize echoes a supported protocol version");
  ok((await server.dispatch("initialize", { protocolVersion: "1999-01-01" })).protocolVersion === "2025-06-18",
    "ide: unknown protocol version → latest");
  const list = await server.dispatch("tools/list", {});
  const names = list.tools.map((x) => x.name);
  ok(["get_diagnostics", "get_open_editors", "get_selection", "find_definition", "find_references", "get_hover",
    "search_symbols", "get_document_symbols", "open_file", "get_workspace_folders"].every((x) => names.includes(x)),
  "ide: tools/list carries every tool", names);
  ok(list.tools.every((x) => x.inputSchema && x.inputSchema.type === "object" && x.description), "ide: every tool has a schema");
  let threw;
  try { await server.dispatch("bogus", {}); } catch (e) { threw = e; }
  ok(threw && threw.code === -32601, "ide: unknown method → -32601");

  const D = (line, ch, severity, message, source) => ({
    range: { start: { line, character: ch }, end: { line, character: ch + 1 } }, severity, message, source,
  });
  vscode.languages.getDiagnostics = (uri) => uri
    ? [D(0, 4, 0, "bad type", "ts")]
    : [[vscode.Uri.file(aTs), [D(0, 4, 0, "bad\n  type", "ts"), D(2, 0, 1, "unused", "eslint"), D(1, 0, 3, "hint")]]];
  const diag = await server.dispatch("tools/call", { name: "get_diagnostics", arguments: {} });
  const dtext = diag.content[0].text;
  ok(!diag.isError && /a\.ts:1:5 error \[ts\] bad type/.test(dtext) && /:3:1 warning \[eslint\] unused/.test(dtext) && !/hint/.test(dtext),
    "ide: get_diagnostics lists errors and warnings, one line each", dtext);
  const derr = await server.dispatch("tools/call", { name: "get_diagnostics", arguments: { severity: "error" } });
  ok(!/unused/.test(derr.content[0].text), "ide: severity filter");
  vscode.languages.getDiagnostics = () => [];
  ok(/No problems/.test((await server.dispatch("tools/call", { name: "get_diagnostics", arguments: { path: "src/a.ts" } })).content[0].text),
    "ide: clean file reported as such");
  const bad = await server.dispatch("tools/call", { name: "find_definition", arguments: { path: "a.ts" } });
  ok(bad.isError && /"line" is required/.test(bad.content[0].text), "ide: argument errors come back as tool errors", bad);
  const unk = await server.dispatch("tools/call", { name: "nope", arguments: {} });
  ok(unk.isError, "ide: unknown tool is a tool error");
  const tabUri = vscode.Uri.file(aTs);
  vscode.window.tabGroups = { all: [{ isActive: true, tabs: [
    { input: new vscode.TabInputText(tabUri), isActive: true, isDirty: true },
    { input: { notText: true }, isActive: false, isDirty: false },
  ] }] };
  const editors = await server.dispatch("tools/call", { name: "get_open_editors", arguments: {} });
  ok(/\(active, unsaved\)/.test(editors.content[0].text) && editors.content[0].text.split("\n").length === 1,
    "ide: open editors with active/unsaved flags, non-text tabs skipped", editors.content[0].text);

  /* ---- IDE tools: stdio bridge end-to-end ---- */
  const spec = server.mcpServer();
  ok(spec.name === "vscode" && spec.command === process.execPath && spec.args[0] === bridgePath, "bridge: MCP server entry");
  const env = Object.fromEntries(spec.env.map((e) => [e.name, e.value]));
  ok(env.ELECTRON_RUN_AS_NODE === "1" && env.ACP_IDE_PIPE && /^[0-9a-f]{32}$/.test(env.ACP_IDE_TOKEN), "bridge: env carries pipe + token");
  await sleep(50);
  const run = (tokenOverride) => {
    const child = cp.spawn(spec.command, spec.args, {
      env: { ...process.env, ...env, ...(tokenOverride ? { ACP_IDE_TOKEN: tokenOverride } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    return { child, lines, exited, send: (o) => child.stdin.write(JSON.stringify(o) + "\n") };
  };
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(20); }
    return false;
  };
  const b = run();
  b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_workspace_folders", arguments: {} } });
  await waitFor(() => b.lines.length >= 3);
  ok(b.lines.length === 3, "bridge: one reply per request, none for the notification", b.lines.length);
  ok(b.lines[0] && b.lines[0].id === 1 && b.lines[0].result.serverInfo, "bridge: initialize answered");
  ok(b.lines[1] && b.lines[1].id === 2 && b.lines[1].result.tools.length === m.IDE_TOOLS.length, "bridge: tools/list answered");
  ok(b.lines[2] && /ws-test/.test(b.lines[2].result.content[0].text), "bridge: tools/call runs in the extension host");
  b.child.stdin.end();
  ok((await Promise.race([b.exited, sleep(3000).then(() => "hung")])) === 0, "bridge: exits when the agent closes stdin");

  const evil = run("0".repeat(32));
  evil.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const code = await Promise.race([evil.exited, sleep(3000).then(() => "hung")]);
  ok(code !== "hung" && evil.lines.length === 0, "bridge: wrong token is dropped without a reply", code);
  if (code === "hung") evil.child.kill();

  server.dispose();
  const after = run();
  const afterCode = await Promise.race([after.exited, sleep(3000).then(() => "hung")]);
  ok(afterCode === 1, "bridge: exits with an error once the server is gone", afterCode);
  if (afterCode === "hung") after.child.kill();
}

main()
  .catch((e) => { failures++; console.log("FAIL: crashed", e); })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (failures) { console.log(`${failures} ide checks failed (${passed} passed)`); process.exit(1); }
    console.log(`all ${passed} ide checks passed`);
    process.exit(0);
  });
