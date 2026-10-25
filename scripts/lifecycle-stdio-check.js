/* End-to-end lifecycle check with the REAL ChatController + REAL
   AgentConnection over stdio NDJSON to minimal synthetic ACP subprocesses
   (node). vscode is shimmed; installer.launchSpec points process.execPath
   at a test-owned agent script per agent. No real agents/credentials/files.
   Synthetic agent state (auth flag, sessions) persists in mkdtemp files so
   restarts behave like a real provider process.
   Scenario: A prompt -> switch B (auth wall) -> authenticate -> B prompt
   carries handoff -> back to A (live process, no RPC) -> back to B (no
   re-auth) -> B process stops -> back to B (real resume) -> refused-auth
   variant keeps thread/draft pre-accept. */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");
const acp = require("@agentclientprotocol/sdk");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcstdio-"));
// The vscode shim's workspace folder becomes the agent's spawn cwd — point
// it at a real directory BEFORE the bundle loads the shim, or
// child_process.spawn fails ENOENT.
process.env.ACP_SHIM_WS = tmp;
const out = path.join(os.tmpdir(), `stdio-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "chatProvider.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
});
const { ChatController } = require(out);

const M = acp.methods.agent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
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

/* ---------- synthetic agent subprocess ---------- */
const agentScript = path.join(tmp, "agent.js");
fs.writeFileSync(agentScript, `const rl = require("readline").createInterface({ input: process.stdin });
const fs = require("fs"), path = require("path");
const dir = process.env.AGENT_DIR, id = process.env.AGENT_ID;
const stateFile = path.join(dir, "state.json");
const logFile = path.join(dir, "requests.jsonl");
const load = () => fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
  : { authed: process.env.AGENT_ID === "A", sessions: {}, n: 0 };
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
let st = load();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ok = (rid, result) => send({ jsonrpc: "2.0", id: rid, result });
const err = (rid, code, message) => send({ jsonrpc: "2.0", id: rid, error: { code, message } });
const log = (m, p) => fs.appendFileSync(logFile, JSON.stringify({ method: m, params: p }) + "\\n");
const authed = () => load().authed;
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!("method" in m) || m.id === undefined) return;
  log(m.method, m.params);
  const p = m.params || {};
  if (m.method === "initialize") {
    return ok(m.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { resume: {}, list: {} },
      },
      authMethods: id === "B" ? [{ id: "signin", name: "Sign in" }] : [],
      agentInfo: { name: id, title: "Agent " + id },
    });
  }
  if (m.method === "authenticate") {
    if (process.env.MOCK_REFUSE_AUTH === "1") return err(m.id, -32000, "authentication refused");
    st = load(); st.authed = true; save(st);
    return ok(m.id, {});
  }
  if (m.method === "session/new") {
    if (!authed()) return err(m.id, -32000, "authentication required");
    st = load(); st.n++;
    const sid = "s-" + id + "-" + st.n;
    st.sessions[sid] = { createdAt: Date.now() };
    save(st);
    return ok(m.id, { sessionId: sid });
  }
  if (m.method === "session/resume" || m.method === "session/load") {
    if (!authed()) return err(m.id, -32000, "authentication required");
    if (!load().sessions[p.sessionId]) return err(m.id, -32601, "session not found");
    return ok(m.id, {});
  }
  if (m.method === "session/list") {
    if (!authed()) return err(m.id, -32000, "authentication required");
    return ok(m.id, {
      sessions: Object.keys(load().sessions).map((s) => ({
        sessionId: s, title: "", cwd: "x", updatedAt: new Date().toISOString(),
      })),
    });
  }
  if (m.method === "session/prompt") {
    if (!authed()) return err(m.id, -32000, "authentication required");
    st = load();
    st.sessions[p.sessionId] = st.sessions[p.sessionId] || { createdAt: Date.now() };
    (st.sessions[p.sessionId].replies = st.sessions[p.sessionId].replies || []).push(
      id + " reply " + (st.sessions[p.sessionId].replies.length + 1));
    save(st);
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: p.sessionId,
      update: { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: id + " reply " + st.sessions[p.sessionId].replies.length } },
    } });
    return ok(m.id, { stopReason: "end_turn" });
  }
  return ok(m.id, {});
});
`);

const dirA = path.join(tmp, "A"), dirB = path.join(tmp, "B"),
  dirB2 = path.join(tmp, "B2");
fs.mkdirSync(dirA); fs.mkdirSync(dirB); fs.mkdirSync(dirB2);
const reqs = (d) =>
  fs.existsSync(path.join(d, "requests.jsonl"))
    ? fs.readFileSync(path.join(d, "requests.jsonl"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l))
    : [];
const reqsOf = (d, m) => reqs(d).filter((r) => r.method === m);

/* ---------- controller ---------- */
const ctxDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcstdio-ctx-"));
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
const spawnEnv = (refuse) => ({ ...process.env, ...(refuse ? { MOCK_REFUSE_AUTH: "1" } : {}) });
let refuseNextB = false;
const installer = {
  descriptors: () => [
    { id: "A", name: "Agent A", installed: true },
    { id: "B", name: "Agent B", installed: true },
  ],
  launchSpec: async (id) => ({
    command: process.execPath,
    args: [agentScript],
    env: {
      ...spawnEnv(id === "B" && refuseNextB),
      AGENT_DIR: id === "A" ? dirA : refuseNextB ? dirB2 : dirB,
      AGENT_ID: id,
    },
    description: `${id} spec`,
  }),
};

const c = new ChatController(context, {}, installer);
c.didAutoConnect = true; // bind() would auto-select the first installed agent
c.msgs = messages;
c.bind({ postMessage: async (m) => messages.push(m) > 0, onDidReceiveMessage: () => {} });
const lastMsg = (type) => [...messages].reverse().find((m) => m.type === type);

(async () => {
  await c.init();

  /* A: real spawn, session/new, prompt with a streamed chunk. */
  await c.selectAgent("A");
  ok(c.connectionStatus === "connected", "A: connected over stdio");
  ok(c.session?.agentId === "A", "A: session established");
  await c.sendPrompt("seed hello", [], "r-a1");
  ok(messages.some((m) => m.type === "promptAccepted" && m.requestId === "r-a1"),
    "A: promptAccepted");
  await sleep(100); // let the streamed chunk land in the model
  const tid = c.activeThreadId, sidA = c.session.sessionId;
  ok(!!tid, "A: thread created");
  const nA = c.model.entries.length;
  ok(c.model.entries.some((e) => e.kind === "agent"), "A: streamed reply landed");
  ok(reqsOf(dirA, "initialize").length === 1, "A: one initialize RPC");

  /* Switch to B: auth wall on session/new -> auth_required snapshot with B's
     methods only; thread + entries untouched. */
  await c.selectAgent("B");
  ok(c.connectionStatus === "auth_required", "B: auth_required from real -32000");
  const snap = lastMsg("snapshot");
  ok(snap?.payload?.connection?.status === "auth_required", "B: snapshot auth_required");
  ok(snap?.payload?.authMethods?.length === 1 && snap.payload.authMethods[0].id === "signin",
    "B: snapshot exposes only B's auth methods");
  ok(snap?.payload?.activeAgentId === "B" || c.pendingAgentId === "B",
    "B: snapshot targets B, not stale A data");
  ok(c.activeThreadId === tid, "B: thread kept through auth wall");
  ok(c.model.entries.length === nA, "B: entries untouched");
  ok(reqsOf(dirB, "session/new").length === 1, "B: session/new probed auth");

  /* Sign in -> same thread, fresh B session via session/new. */
  await c.authenticate();
  ok(c.connectionStatus === "connected", "B: connected after authenticate");
  ok(c.activeThreadId === tid, "B: same thread after sign-in");
  const sidB = c.session.sessionId;
  ok(c.session?.agentId === "B" && sidB, "B: session established");

  /* B prompt must carry the handoff: A's transcript link + context text +
     verbatim user text. */
  await c.sendPrompt("follow up B", [], "r-b1");
  ok(messages.some((m) => m.type === "promptAccepted" && m.requestId === "r-b1"),
    "B: promptAccepted");
  const bPrompt = reqsOf(dirB, "session/prompt").at(-1);
  ok(bPrompt.params.prompt.some((b) => b.type === "resource_link" && /transcript\.md/.test(b.uri)),
    "B prompt: real transcript resource_link");
  ok(bPrompt.params.prompt.some((b) => b.type === "text" &&
      /earlier in this thread/.test(b.text) && /seed hello/.test(b.text)),
    "B prompt: handoff text includes A turn");
  ok(bPrompt.params.prompt.some((b) => b.type === "text" && b.text === "follow up B"),
    "B prompt: verbatim user text");

  /* Back to A: its process stayed alive, so the session reattaches with no RPC. */
  await c.selectAgent("A");
  ok(c.session?.sessionId === sidA, "A: original session reattached");
  ok(reqsOf(dirA, "session/resume").length === 0 && reqsOf(dirA, "session/load").length === 0,
    "A: live session needs no resume/load");
  ok(reqsOf(dirA, "initialize").length === 1, "A: process reused across the switch");
  await c.sendPrompt("again A", [], "r-a2");
  const aPrompt = reqsOf(dirA, "session/prompt").at(-1);
  ok(aPrompt.params.prompt.some((b) => b.type === "text" && /follow up B/.test(b.text)),
    "A prompt: includes B delta");
  ok(!aPrompt.params.prompt.some((b) => b.type === "text" && /seed hello/.test(b.text)),
    "A prompt: omits already-covered seed turn");

  /* Back to B: still signed in on its live process -> no authenticate, no resume. */
  const bAuth0 = reqsOf(dirB, "authenticate").length;
  await c.selectAgent("B");
  ok(c.connectionStatus === "connected", "B: reconnects without auth wall");
  ok(c.session?.sessionId === sidB, "B: reattached its session");
  ok(reqsOf(dirB, "session/resume").length === 0, "B: live session needs no resume");
  ok(reqsOf(dirB, "authenticate").length === bAuth0, "B: no extra authenticate");

  /* Switches keep each agent's one process; nothing restarts on its own. */
  await c.selectAgent("A");
  await sleep(300);
  ok(reqsOf(dirA, "initialize").length === 1 && reqsOf(dirB, "initialize").length === 1,
    `switches: one process per agent, kept across switches ` +
    `(A=${reqsOf(dirA, "initialize").length} B=${reqsOf(dirB, "initialize").length})`);

  /* B's process goes away while A is active: the next switch to B starts a
     fresh process and resumes the stored session over real stdio. */
  await c.pool.connection("B").stop();
  await sleep(100);
  await c.selectAgent("B");
  ok(reqsOf(dirB, "initialize").length === 2, "B restart: one new process");
  ok(c.session?.sessionId === sidB, "B restart: same session");
  ok(reqsOf(dirB, "session/resume").some((r) => r.params.sessionId === sidB),
    "B restart: real session/resume hit the agent");
  ok(reqsOf(dirB, "authenticate").length === bAuth0, "B restart: no extra authenticate");
  ok(reqsOf(dirA, "initialize").length === 1, "B restart: A untouched");

  /* Refused-auth variant: fresh controller, B refuses authenticate ->
     stays auth_required, thread kept, next prompt rejected pre-accept. */
  refuseNextB = true;
  const ctxDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lcstdio-ctx2-"));
  const messages2 = [];
  const context2 = {
    globalState: {
      _m: new Map(),
      get(k, d) { return this._m.has(k) ? this._m.get(k) : d; },
      async update(k, v) { this._m.set(k, v); },
    },
    globalStorageUri: { fsPath: ctxDir2 },
    subscriptions: [],
  };
  const c2 = new ChatController(context2, {}, installer);
  c2.didAutoConnect = true;
  c2.msgs = messages2;
  c2.bind({ postMessage: async (m) => messages2.push(m) > 0, onDidReceiveMessage: () => {} });
  await c2.init();
  await c2.selectAgent("A");
  await c2.sendPrompt("seed2", [], "r2-a1");
  const tid2 = c2.activeThreadId;
  const n2 = c2.model.entries.length;
  await c2.selectAgent("B");
  ok(c2.connectionStatus === "auth_required", "refuse: B auth wall");
  await c2.authenticate();
  ok(c2.connectionStatus === "auth_required", "refuse: stays auth_required");
  ok(c2.activeThreadId === tid2, "refuse: thread kept");
  const prompts2 = reqsOf(dirB2, "session/prompt").length;
  await c2.sendPrompt("draft while auth", [], "r2-b1");
  ok(messages2.some((m) => m.type === "promptRejected" && m.requestId === "r2-b1"),
    "refuse: prompt rejected pre-accept");
  ok(!messages2.some((m) => m.type === "promptAccepted" && m.requestId === "r2-b1"),
    "refuse: not accepted");
  ok(reqsOf(dirB2, "session/prompt").length === prompts2, "refuse: no prompt RPC sent");
  ok(c2.model.entries.length === n2, "refuse: no user entry inserted");

  await c2.dispose();
  await c.dispose();
  await c.threadStore.flush();

  if (failures) {
    console.log(`${failures} stdio lifecycle checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} stdio lifecycle checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
