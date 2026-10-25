"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v2check-"));
process.env.ACP_SHIM_WS = tmp;
globalThis.__acpShimConfig = { acpV2: true };
const out = path.join(os.tmpdir(), `v2check-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "chatProvider.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
});
const { ChatController } = require(out);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return false;
    await sleep(20);
  }
  return true;
};
let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}`); }
};
process.on("unhandledRejection", (e) => {
  console.error("FAIL: unhandledRejection", e);
  process.exit(1);
});

const v2Log = path.join(tmp, "v2.jsonl");
const v1Dir = path.join(tmp, "v1");
const editedFile = path.join(tmp, "demo.txt");
const installer = {
  descriptors: () => [
    { id: "V", name: "Agent V", installed: true },
    { id: "A", name: "Agent A", installed: true },
  ],
  launchSpec: async (id) => id === "V"
    ? { command: process.execPath, args: [path.join(__dirname, "mock-agent-v2.js")],
        env: { ...process.env, MOCK_V2_LOG: v2Log, MOCK_V2_FILE: editedFile }, description: "V spec" }
    : { command: process.execPath, args: [path.join(__dirname, "mock-agent.js"), "--name", "EchoA"],
        env: { ...process.env, SHIPWRECK_MOCK_DIR: v1Dir }, description: "A spec" },
};
const v2Reqs = (m) => fs.existsSync(v2Log)
  ? fs.readFileSync(v2Log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.method === m)
  : [];

const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), "v2check-ctx-"));
const messages = [];
const context = {
  globalState: {
    _m: new Map(),
    get(k, d) { return this._m.has(k) ? this._m.get(k) : d; },
    async update(k, v) { this._m.set(k, v); },
  },
  globalStorageUri: { fsPath: ctxDir },
  subscriptions: [],
};
const c = new ChatController(context, {}, installer);
c.didAutoConnect = true;
c.bind({ postMessage: async (m) => messages.push(m) > 0, onDidReceiveMessage: () => {} });
c.chatVisible = true;

const textOf = (e) => (e.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
const agentSaid = (s) => c.model.entries.some((e) => e.kind === "agent" && textOf(e) === s);
const tool = (id) => c.model.entries.find((e) => e.kind === "tool" && e.tool.toolCallId === id)?.tool;

(async () => {
  await c.init();
  await c.selectAgent("V");
  ok(c.connectionStatus === "connected", "V: connected");
  ok(c.pool.connection("V").protocolVersion === 2, "V: v2 negotiated");
  ok(c.session?.configOptions?.some((o) => o.id === "mode" && o.category === "mode"),
    "V: mode config option from session/new");
  ok(v2Reqs("session/new")[0]?.params.mcpServers.every((s) => s.type === "stdio"),
    "V: MCP servers sent with type stdio");

  await c.sendPrompt("hello", [], "r1");
  ok(messages.some((m) => m.type === "promptAccepted" && m.requestId === "r1"), "plain: promptAccepted");
  ok(agentSaid("v2 reply to hello"), "plain: reply landed");
  ok(!c.session.busy, "plain: turn ended at idle");
  ok(c.model.entries.filter((e) => e.kind === "user").length === 1, "plain: user message not duplicated");

  await c.sendPrompt("idle-before-ack", [], "r2");
  ok(agentSaid("v2 reply to idle-before-ack") && !c.session.busy, "idle before ack: turn still ends");

  await c.sendPrompt("tool", [], "r3");
  const edit = tool("edit-1");
  const diff = edit?.content?.find((x) => x.type === "diff");
  ok(diff?.path === editedFile && diff.oldText === "keep\nold line\n" && diff.newText === "keep\nnew line\n",
    "tool: git patch shown as a text diff");
  ok(edit?.status === "completed" && edit.content.some((x) => x.type === "content" && x.content.text === "edited"),
    "tool: patch fields kept, content chunk appended");
  await sleep(300);
  const run = tool("run-1");
  const term = run?.content?.find((x) => x.type === "terminal");
  ok(run?.title === undefined && run.status === "completed", "tool: null clears the title");
  ok(term?.output === "building\ndone\n" && term.exitStatus?.exitCode === 0,
    `tool: display terminal output in the card (${JSON.stringify(term?.output)})`);
  ok(agentSaid("tool done"), "tool: unknown update ignored, reply landed");
  const agents = c.model.entries.filter((e) => e.kind === "agent");
  const cleared = agents.findIndex((e) => e.parts.length === 0);
  ok(cleared >= 0 && agents.length === cleared + 2 && textOf(agents[cleared + 1]) === "tool done",
    "tool: a cleared message keeps its empty entry in place");

  const permTurn = c.sendPrompt("permission", [], "r4");
  const permShown = await waitFor(() =>
    c.model.entries.some((e) => e.kind === "permission" && e.state === "pending"));
  const perm = c.model.entries.find((e) => e.kind === "permission");
  ok(permShown && perm.toolCall.title === "Run the test suite", "permission: card shows the request title");
  ok(perm?.description === "Runs npm test in the workspace." && perm.command === "npm test",
    "permission: description and command on the card");
  c.resolvePermission(perm.id, "allow");
  await permTurn;
  ok(agentSaid("permission allow") && !c.session.busy, "permission: answer reached the agent");

  const cancelTurn = c.sendPrompt("cancel", [], "r5");
  await waitFor(() => agentSaid("working"));
  ok(c.session.busy, "cancel: turn running");
  c.cancelTurn();
  await cancelTurn;
  ok(!c.session.busy, "cancel: turn ended at idle cancelled");
  ok(v2Reqs("session/cancel").length === 1, "cancel: session/cancel sent");

  const prompts = v2Reqs("session/prompt").length;
  const resumes = v2Reqs("session/resume").length;
  await c.sendPrompt("fail", [], "r6");
  ok(c.model.entries.some((e) => e.kind === "notice" && e.severity === "error" &&
      /Prompt failed: session not found while running/.test(e.title)),
    "fail: idle error shown");
  ok(v2Reqs("session/prompt").length === prompts + 1 && v2Reqs("session/resume").length === resumes,
    "fail: an inserted prompt is not retried");

  await c.setConfigOption("mode", "code");
  const set = v2Reqs("session/set_config_option").at(-1)?.params;
  ok(set?.type === "id" && set.value === "code", "config: set_config_option sends type id");
  ok(c.session.configOptions.find((o) => o.id === "mode")?.currentValue === "code", "config: options updated");

  const tid = c.activeThreadId, sidV = c.session.sessionId;
  await c.selectAgent("A");
  ok(c.pool.connection("A").protocolVersion === 1, "A: v1 agent stays on v1 with the setting on");
  await c.sendPrompt("hi A", [], "r7");
  ok(await waitFor(() => c.model.entries.some((e) => e.kind === "agent" && /EchoA received/.test(textOf(e)))),
    "A: v1 reply landed");

  await c.pool.connection("V").stop();
  await sleep(100);
  await c.selectAgent("V");
  const resume = v2Reqs("session/resume").at(-1)?.params;
  ok(c.session?.sessionId === sidV && resume?.sessionId === sidV && !resume.replayFrom,
    "V restart: reattach is session/resume without replay");
  ok(c.activeThreadId === tid, "V restart: same thread");
  await c.threadStore.flush();
  const stored = await c.threadStore.entriesOf(tid);
  ok(stored.some((e) => e.kind === "agent" && textOf(e) === "v2 reply to hello") &&
    stored.some((e) => e.kind === "agent" && /EchoA received/.test(textOf(e))),
    "thread: stored transcript holds v1 and v2 turns");

  await c.dispose();
  await c.threadStore.flush();
  if (failures) {
    console.log(`${failures} v2 checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} v2 checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
