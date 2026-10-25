/* Plain-Node check of ChatController lifecycle correctness: agent switching
   mid-thread, auth flows, prompt admission lock, stale-generation isolation.
   Host bundled via esbuild with the vscode shim; connection/installer/
   terminals injected as fakes. Synthetic prompts only; temp dirs per test. */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");
const acp = require("@agentclientprotocol/sdk");

const root = path.join(__dirname, "..");
const out = path.join(os.tmpdir(), `lifecycle-${Date.now()}.cjs`);
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
/** Resolves once the controller has sent the prompt; a fixed sleep raced disk latency. */
const turnStarted = async (c) => {
  const t0 = Date.now();
  while (!c.runningTurn && Date.now() - t0 < 2000) await sleep(1);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const authErr = () => Object.assign(new Error("authentication required"), { code: -32000 });
const notFound = () => Object.assign(new Error("method not found"), { code: -32601 });

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}`); }
};

/* ---------- fakes ---------- */
const agents = [
  { id: "A", name: "Agent A", installed: true },
  { id: "B", name: "Agent B", installed: true },
  { id: "C", name: "Agent C", installed: true },
];

/* One fake process per agent, as the controller's pool keeps them. Handlers,
   the call log and the start log are shared so a test can script "the agent"
   without caring which process answers. */
function makeFakes() {
  const calls = [];
  const handlers = new Map();
  const starts = [];
  const byAgent = new Map();
  const fakeFor = (agentId) => {
    if (byAgent.has(agentId)) return byAgent.get(agentId);
    const conn = {
      agentId,
      connected: false,
      initResponse: undefined,
      spec: undefined,
      start: async (spec) => {
        starts.push(spec);
        await handlers.get("__start")?.(agentId);
        conn.spec = spec;
        conn.connected = true;
        conn.initResponse = handlers.get("__init")
          ? handlers.get("__init")()
          : {
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { embeddedContext: true },
                sessionCapabilities: { resume: {} },
              },
              authMethods: [{ id: "a1", name: "Sign in" }],
            };
        return conn.initResponse;
      },
      stop: async () => {
        conn.connected = false;
        conn.initResponse = undefined;
      },
      request: async (method, params) => {
        calls.push({ method, params, agentId });
        const h = handlers.get(method);
        if (h) return h(params, agentId);
        if (method === M.session.prompt) return { stopReason: "end_turn" };
        return { sessionId: `s-${method.split("/")[1]}-${calls.length}` };
      },
      notify: async (method, params) => {
        calls.push({ method, params, agentId, notification: true });
      },
    };
    byAgent.set(agentId, conn);
    return conn;
  };
  return { calls, handlers, starts, byAgent, fakeFor };
}

/* Test-facing view: shared logs plus the active agent's connection state. */
function makeConnView(c, fakes) {
  const scratch = {};
  const target = () => (c.activeAgentId ? fakes.fakeFor(c.activeAgentId) : scratch);
  const view = {
    calls: fakes.calls,
    starts: fakes.starts,
    of: (agentId) => fakes.fakeFor(agentId),
    on: (method, fn) => fakes.handlers.set(method, fn),
    off: (method) => fakes.handlers.delete(method),
    byMethod: (m) => fakes.calls.filter((x) => x.method === m),
  };
  for (const key of ["connected", "initResponse", "spec"]) {
    Object.defineProperty(view, key, {
      get: () => target()[key],
      set: (v) => { target()[key] = v; },
    });
  }
  return view;
}

function makeController(tmp, sharedState) {
  const messages = [];
  const context = {
    globalState: sharedState ?? {
      _m: new Map(),
      get(k, d) { return this._m.has(k) ? this._m.get(k) : d; },
      async update(k, v) { this._m.set(k, v); },
    },
    globalStorageUri: { fsPath: tmp },
    subscriptions: [],
  };
  const installer = {
    _delay: new Map(),
    _agents: agents.map((a) => ({ ...a })),
    descriptors: () => installer._agents,
    launchSpec: async (id) => {
      const d = installer._delay.get(id);
      if (d) await d.promise;
      return {
        command: `bin-${id}`,
        args: ["--serve"],
        env: { AGENT_ENV: id, SHARED: "spec" },
        description: `${id} spec`,
      };
    },
  };
  const c = new ChatController(context, {}, installer);
  c.didAutoConnect = true; // bind() would auto-select the first installed agent
  const fakes = makeFakes();
  const Pool = c.pool.constructor;
  c.pool.dispose();
  c.pool = new Pool((agentId) => fakes.fakeFor(agentId));
  c.conn = makeConnView(c, fakes);
  c.terminals = {
    created: [],
    exits: new Map(),
    create(p) {
      const id = `t-${this.created.length}`;
      this.created.push({ id, ...p });
      return { terminalId: id };
    },
    waitForExit(id) {
      const d = deferred();
      this.exits.set(id, d);
      return d.promise;
    },
    kill() {},
    release() {},
    output: async () => ({}),
    dispose() {},
  };
  c.msgs = messages;
  c.bind({
    postMessage: async (m) => messages.push(m) > 0,
    onDidReceiveMessage: () => {},
  });
  c._tmp = tmp;
  return c;
}
const lastMsg = (c, type) => [...c.msgs].reverse().find((m) => m.type === type);

(async () => {
  /* 1. Baseline: select A, prompt accepted, thread created with coverage. */
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), "lc1-"));
  {
    const c = makeController(t1);
    await c.init();
    await c.selectAgent("A");
    ok(c.conn.starts.length === 1, "A: one start");
    ok(c.conn.byMethod(M.session.new).length === 1, "A: session/new once");
    ok(c.session?.agentId === "A", "A: session established");

    await c.sendPrompt("hello A", [], "req-1");
    ok(!!lastMsg(c, "promptAccepted"), "A: prompt accepted ack posted");
    const tid = c.activeThreadId;
    ok(!!tid, "A: thread created on first prompt");
    const meta = c.threadStore.get(tid);
    ok(meta.backing.length === 1 && meta.backing[0].agentId === "A", "A: backing recorded");
    ok(meta.backing[0].coveredEntries === c.model.entries.length, "A: coverage advanced on success");

    // reselecting same ready agent is a no-op (no extra session/new)
    await c.selectAgent("A");
    ok(c.conn.byMethod(M.session.new).length === 1, "same-agent select: no new session/new");
    ok(c.activeThreadId === tid, "same-agent select keeps thread");
  }

  /* 2. Switch to B mid-thread: thread kept, B gets handoff context. */
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "lc2-"));
  {
    const c = makeController(t2);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("plan it", []);
    const tid = c.activeThreadId;
    const nEntries = c.model.entries.length;

    await c.selectAgent("B");
    ok(c.activeThreadId === tid, "switch B: same thread");
    ok(c.pendingAgentId === "B", "switch B: continue chip survives session resolution");
    ok(lastMsg(c, "snapshot").payload.pendingAgentId === "B",
      "switch B: ready snapshot keeps the continue chip");
    ok(c.model.entries.length === nEntries, "switch B: entries preserved");
    ok(c.conn.starts.length === 2, "switch B: B spawned");
    ok(c.session?.agentId === "B", "switch B: session resolved up front");

    await c.sendPrompt("implement it", []);
    ok(c.pendingAgentId === undefined, "switch B: sending clears the continue chip");
    const prompt = c.conn.byMethod(M.session.prompt).at(-1);
    const kinds = prompt.params.prompt.map((b) => b.type);
    ok(kinds.includes("resource_link") && kinds.filter((k) => k === "text").length >= 2,
      `B prompt has handoff+transcript blocks (${kinds})`);
    ok(prompt.params.prompt.some((b) => b.type === "text" && /earlier in this thread/.test(b.text)),
      "B prompt includes handoff context text");
    ok(prompt.params.prompt.some((b) => b.type === "text" && b.text === "implement it"),
      "B prompt keeps user's verbatim text");
  }

  /* 3. B auth-required → authenticate → same thread, handoff preserved. */
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), "lc3-"));
  {
    const c = makeController(t3);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("work", []);
    const tid = c.activeThreadId;
    const nEntries = c.model.entries.length;

    // B requires auth on session/new
    c.conn.on(M.session.new, async () => { throw authErr(); });
    await c.selectAgent("B");
    ok(c.connectionStatus === "auth_required", "B auth: status auth_required");
    ok(c.activeThreadId === tid, "B auth: thread kept");
    ok(c.pendingAgentId === "B", "B auth: pending target kept");
    ok(c.model.entries.length === nEntries, "B auth: entries kept");
    // auth_required snapshots still carry the agent's auth methods (banner).
    const snap = lastMsg(c, "snapshot");
    ok(snap?.payload?.authMethods?.length >= 1, "B auth: snapshot has authMethods");
    // Export the exact serialized controller snapshot for the headless App
    // test — the UI check replays this message verbatim, not a fixture.
    fs.writeFileSync(
      path.join(__dirname, "..", "preview", "lifecycle-auth-snapshot.json"),
      JSON.stringify(snap, null, 2),
    );

    // sign-in succeeds → session established on same thread, no newSession
    c.conn.off(M.session.new);
    c.conn.initResponse.authMethods = [{ id: "a1", name: "Sign in" }];
    await c.authenticate();
    ok(c.connectionStatus === "connected", "auth success: connected");
    ok(c.activeThreadId === tid, "auth success: same thread");
    ok(c.session?.agentId === "B", "auth success: B session established");
    await c.sendPrompt("go", []);
    const prompt = c.conn.byMethod(M.session.prompt).at(-1);
    ok(prompt.params.prompt.some((b) => b.type === "text" && /earlier in this thread/.test(b.text)),
      "auth success: prompt includes A history");
  }

  /* 4. Sign-in failure stays auth_required; no newSession; coverage intact. */
  const t4 = fs.mkdtempSync(path.join(os.tmpdir(), "lc4-"));
  {
    const c = makeController(t4);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("hi", []);
    const tid = c.activeThreadId;
    const cov = c.threadStore.get(tid).backing[0].coveredEntries;

    c.conn.on(M.session.new, async () => { throw authErr(); });
    c.conn.on(M.authenticate, async () => { throw authErr(); });
    await c.selectAgent("B");
    const newsBefore = c.conn.byMethod(M.session.new).length;
    await c.authenticate();
    ok(c.connectionStatus === "auth_required", "auth fail: stays auth_required");
    ok(c.conn.byMethod(M.session.new).length === newsBefore, "auth fail: no session/new");
    ok(c.activeThreadId === tid, "auth fail: thread kept");
    ok(c.threadStore.get(tid).backing[0].coveredEntries === cov, "auth fail: coverage unchanged");
  }

  /* 5. Late auth for B after switching back to A doesn't touch A. */
  const t5 = fs.mkdtempSync(path.join(os.tmpdir(), "lc5-"));
  {
    const c = makeController(t5);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("hi", []);
    const tid = c.activeThreadId;

    c.conn.on(M.session.new, async () => { throw authErr(); });
    await c.selectAgent("B");
    const authGate = deferred();
    c.conn.off(M.authenticate);
    c.conn.on(M.authenticate, () => authGate.promise);
    const authP = c.authenticate();

    // user switches back to A while sign-in is still open
    c.conn.off(M.session.new);
    c.conn.on(M.session.resume, async () => ({}));
    await c.selectAgent("A");
    const newsAt = c.conn.byMethod(M.session.new).length;
    authGate.resolve({});
    await authP;
    await sleep(50);
    ok(c.activeAgentId === "A", "late auth: selection stays A");
    ok(c.session?.agentId === "A", "late auth: session is A's");
    ok(c.activeThreadId === tid, "late auth: thread unchanged");
    ok(c.conn.byMethod(M.session.new).length === newsAt,
      "late auth: stale B completion ran no session/new");
  }

  /* 6. Slow B launchSpec then C: only C starts. */
  const t6 = fs.mkdtempSync(path.join(os.tmpdir(), "lc6-"));
  {
    const c = makeController(t6);
    await c.init();
    await c.selectAgent("A");
    const bGate = deferred();
    c.installer._delay.set("B", bGate); // B launchSpec is slow
    const selB = c.selectAgent("B");    // in-flight, stuck on launchSpec
    await sleep(30);
    await c.selectAgent("C");
    await sleep(30);
    ok(c.activeAgentId === "C", "slow B then C: active agent is C");
    ok(c.conn.starts.length === 2, `slow B then C: only C started (${c.conn.starts.length})`);
    ok(!c.conn.starts.some((s) => s.command === "bin-B"),
      "slow B then C: B never started a process");
    // Now let the stale B launch resolve — it must not disturb C.
    bGate.resolve();
    await selB;
    await sleep(50);
    ok(c.activeAgentId === "C", "slow B resolved: C still active");
    ok(c.session?.agentId === "C", "slow B resolved: session is C's");
    ok(!c.conn.starts.some((s) => s.command === "bin-B"),
      "slow B resolved: still no B process");
  }

  /* 7. Duplicate sends: second rejected, one prompt request. */
  const t7 = fs.mkdtempSync(path.join(os.tmpdir(), "lc7-"));
  {
    const c = makeController(t7);
    await c.init();
    await c.selectAgent("A");
    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const p1 = c.sendPrompt("one", [], "r1");
    const p2 = c.sendPrompt("two", [], "r2");
    await sleep(30);
    gate.resolve({ stopReason: "end_turn" });
    await Promise.all([p1, p2]);
    ok(c.conn.byMethod(M.session.prompt).length === 1, "dup sends: single prompt request");
    const acc = c.msgs.filter((m) => m.type === "promptAccepted").map((m) => m.requestId);
    const rej = c.msgs.filter((m) => m.type === "promptRejected").map((m) => m.requestId);
    ok(acc.includes("r1") && rej.includes("r2"), `dup sends: r1 accepted r2 rejected (${acc}/${rej})`);
    ok(c.model.entries.filter((e) => e.kind === "user").length === 1, "dup sends: one user entry");
  }

  /* 8. A switch during a running turn sends it to the background: it keeps
     streaming into its own thread, finishes there, and B works meanwhile. */
  const t8 = fs.mkdtempSync(path.join(os.tmpdir(), "lc8-"));
  {
    const c = makeController(t8);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const aSid = c.session.sessionId;
    const gate = deferred();
    c.conn.on(M.session.prompt, (p) => (p.sessionId === aSid ? gate.promise : { stopReason: "end_turn" }));
    const p = c.sendPrompt("slow turn", [], "r-slow");
    await turnStarted(c);
    ok(c.promptInFlight, "busy: turn running");
    await c.selectAgent("B");
    ok(c.activeAgentId === "B" && c.session?.agentId === "B", "busy switch: B selected with its own session");
    ok(c.activeThreadId === undefined, "busy switch: B starts a fresh chat");
    ok(!c.promptInFlight, "busy switch: composer free again");
    const act = lastMsg(c, "threadActivity")?.activity ?? [];
    ok(act.some((a) => a.threadId === tid && a.agentId === "A" && a.state === "running"),
      "busy switch: thread marked running");
    ok(c.conn.of("A").connected, "busy switch: A process kept alive");
    await c.deleteThread(tid);
    ok(!!c.threadStore.get(tid), "busy: running thread cannot be deleted");

    const shown = c.msgs.length;
    c.delegateFor("A").onSessionUpdate({
      sessionId: aSid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "background reply" } },
    });
    ok(!c.model.entries.some((e) => JSON.stringify(e).includes("background reply")),
      "background: B's view untouched");
    ok(!c.msgs.slice(shown).some((m) => m.type === "entryUpsert" || m.type === "entryAppend"),
      "background: nothing posted for the hidden turn");

    await c.sendPrompt("b work", [], "r-b");
    ok(c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-b"),
      "parallel: B prompt accepted while A runs");

    gate.resolve({ stopReason: "end_turn" });
    await p;
    await sleep(10);
    const done = lastMsg(c, "threadActivity")?.activity ?? [];
    ok(done.some((a) => a.threadId === tid && a.state === "done"), "background: finished turn marked done");
    const stored = await c.threadStore.entriesOf(tid);
    ok(stored.some((e) => JSON.stringify(e).includes("background reply")),
      "background: reply persisted to its thread");
    ok(c.threadStore.get(tid).backing.find((b) => b.agentId === "A").coveredEntries === stored.length,
      "background: coverage advanced on completion");
    ok(c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-slow"),
      "background: original prompt was accepted once");

    await c.openThread(tid);
    ok(c.activeThreadId === tid && c.model.entries.some((e) => JSON.stringify(e).includes("background reply")),
      "reopen: finished thread shows the reply");
    ok(!(lastMsg(c, "threadActivity")?.activity ?? []).some((a) => a.threadId === tid),
      "reopen: activity cleared");
  }

  /* 8b. Reopening a thread whose turn is still running puts it back on screen. */
  const t8b = fs.mkdtempSync(path.join(os.tmpdir(), "lc8b-"));
  {
    const c = makeController(t8b);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const aSid = c.session.sessionId;
    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const p = c.sendPrompt("slow turn", []);
    await turnStarted(c);
    await c.newSession();
    ok(c.activeThreadId === undefined && c.session && c.session.sessionId !== aSid,
      "busy newSession: fresh chat while the turn runs");
    const chunk = (text) => c.delegateFor("A").onSessionUpdate({
      sessionId: aSid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    chunk("while away");
    await c.openThread(tid);
    ok(c.activeThreadId === tid && c.session?.sessionId === aSid, "bring back: running session on screen");
    ok(c.promptInFlight, "bring back: turn owns the composer again");
    ok(c.model.entries.some((e) => JSON.stringify(e).includes("while away")),
      "bring back: updates made while hidden are shown");
    const replaced = lastMsg(c, "entriesReplace");
    ok(replaced?.sessionId === aSid && replaced.entries.length === c.model.entries.length,
      "bring back: view gets the whole transcript");
    ok(!(lastMsg(c, "threadActivity")?.activity ?? []).some((a) => a.threadId === tid),
      "bring back: no longer listed as background");
    const shown = c.msgs.length;
    chunk(" and");
    chunk(" back");
    ok(!c.msgs.slice(shown).some((m) => m.type === "entryAppend"), "deltas: held until the frame ends");
    await sleep(30);
    const appends = c.msgs.slice(shown).filter((m) => m.type === "entryAppend");
    ok(appends.length === 1 && appends[0].sessionId === aSid && appends[0].text === " and back",
      "deltas: chunks of one part merge into one append");
    chunk(" again");
    c.pushMarker("ordering probe");
    const tail = c.msgs.slice(shown + appends.length);
    const ia = tail.findIndex((m) => m.type === "entryAppend" && m.text === " again");
    const iu = tail.findIndex((m) => m.type === "entryUpsert" && m.entry?.title === "ordering probe");
    ok(ia >= 0 && iu > ia, "deltas: a queued append is sent before the next message");
    await c.sendPrompt("concurrent", [], "r-busy");
    ok(c.msgs.some((m) => m.type === "promptRejected" && m.requestId === "r-busy"),
      "busy: second send rejected not queued");
    gate.resolve({ stopReason: "end_turn" });
    await p;
    ok(!c.promptInFlight, "bring back: turn released at the end");
    ok(c.threadStore.get(tid).backing.find((b) => b.agentId === "A").coveredEntries === c.model.entries.length,
      "bring back: coverage advanced");
    ok(c.model.entries.some((e) => e.kind === "user" && e.parts?.[0]?.text === "slow turn"),
      "busy: transcript stable");
  }

  /* 8c. switchWhileRunning = "ask": dismiss keeps everything, Keep running
     backgrounds, Stop cancels and the cancelled turn leaves no activity. */
  const t8c = fs.mkdtempSync(path.join(os.tmpdir(), "lc8c-"));
  {
    const asked = [];
    let answer;
    globalThis.__acpShimConfig = { switchWhileRunning: "ask" };
    globalThis.__acpShimWarning = async (msg) => { asked.push(msg); return answer; };
    try {
      const c = makeController(t8c);
      await c.init();
      await c.selectAgent("A");
      let gate = deferred();
      c.conn.on(M.session.prompt, () => gate.promise);
      let p = c.sendPrompt("first", []);
      await turnStarted(c);
      const tid1 = c.activeThreadId;
      await c.selectAgent("B");
      ok(asked.length === 1, "ask: dialog shown");
      ok(c.activeAgentId === "A" && c.promptInFlight && c.activeThreadId === tid1,
        "ask dismissed: nothing changes");
      answer = "Keep running";
      await c.newSession();
      ok(c.activeThreadId === undefined && !c.promptInFlight, "ask keep running: turn backgrounded");
      gate.resolve({ stopReason: "end_turn" });
      await p;

      gate = deferred();
      p = c.sendPrompt("second", []);
      await turnStarted(c);
      const tid2 = c.activeThreadId;
      const sid2 = c.session.sessionId;
      answer = "Stop";
      await c.selectAgent("B");
      ok(c.conn.byMethod(M.session.cancel).some((x) => x.params.sessionId === sid2),
        "ask stop: cancel sent to the running session");
      ok(c.activeAgentId === "B", "ask stop: switch goes ahead");
      gate.resolve({ stopReason: "cancelled" });
      await p;
      await sleep(10);
      const act = lastMsg(c, "threadActivity")?.activity ?? [];
      ok(!act.some((a) => a.threadId === tid2), "ask stop: cancelled turn leaves no activity");
      ok(act.some((a) => a.threadId === tid1 && a.state === "done"), "ask: earlier background turn still done");
    } finally {
      delete globalThis.__acpShimConfig;
      delete globalThis.__acpShimWarning;
    }
  }

  /* 8d. A background turn that needs approval says so and waits for the user. */
  const t8d = fs.mkdtempSync(path.join(os.tmpdir(), "lc8d-"));
  {
    const infos = [];
    globalThis.__acpShimInfo = async (msg) => { infos.push(msg); return undefined; };
    try {
      const c = makeController(t8d);
      c.chatVisible = true;
      await c.init();
      await c.selectAgent("A");
      await c.sendPrompt("seed", []);
      const tid = c.activeThreadId;
      const aSid = c.session.sessionId;
      const gate = deferred();
      c.conn.on(M.session.prompt, (q) => (q.sessionId === aSid ? gate.promise : { stopReason: "end_turn" }));
      const p = c.sendPrompt("needs a write", []);
      await turnStarted(c);
      await c.selectAgent("B");
      const permP = c.delegateFor("A").requestPermission({
        sessionId: aSid,
        toolCall: { toolCallId: "tc", title: "write file" },
        options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
      });
      await sleep(5);
      const act = lastMsg(c, "threadActivity")?.activity ?? [];
      ok(act.some((a) => a.threadId === tid && a.state === "needs_input"), "bg approval: thread marked needs input");
      ok(infos.length === 1 && /needs your input/.test(infos[0]), "bg approval: notification shown");
      ok(!c.needsApproval && !c.model.entries.some((e) => e.kind === "permission"),
        "bg approval: B's chat not blocked");
      await c.openThread(tid);
      const card = c.model.entries.find((e) => e.kind === "permission" && e.state === "pending");
      ok(!!card && c.needsApproval, "bg approval: card shown in its own thread");
      c.resolvePermission(card.id, "ok");
      const res = await permP;
      ok(res.outcome.outcome === "selected" && res.outcome.optionId === "ok", "bg approval: answer reaches A");
      gate.resolve({ stopReason: "end_turn" });
      await p;
      ok(!c.promptInFlight, "bg approval: turn finished in the foreground");
    } finally {
      delete globalThis.__acpShimInfo;
    }
  }
  /* 8e. Stop answers a pending approval as cancelled (ACP session/cancel rule). */
  const t8e = fs.mkdtempSync(path.join(os.tmpdir(), "lc8e-"));
  {
    const c = makeController(t8e);
    c.chatVisible = true;
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const sid = c.session.sessionId;
    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const p = c.sendPrompt("needs a write", []);
    await turnStarted(c);
    const permP = c.delegateFor("A").requestPermission({
      sessionId: sid,
      toolCall: { toolCallId: "tc", title: "write file" },
      options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
    });
    await sleep(5);
    ok(c.needsApproval, "stop: approval pending before cancel");
    c.cancelTurn();
    const res = await Promise.race([permP, sleep(500).then(() => ({ outcome: { outcome: "still pending" } }))]);
    ok(res.outcome.outcome === "cancelled", `stop: pending approval answered cancelled (${res.outcome.outcome})`);
    const card = c.model.entries.find((e) => e.kind === "permission");
    ok(card?.state === "cancelled" && !c.needsApproval, "stop: approval card closed");
    gate.resolve({ stopReason: "cancelled" });
    await p;
    ok(!c.promptInFlight, "stop: turn ends on the prompt response");
  }
  /* 9. resume unsupported falls back to fresh+history; auth does not. */
  const t9 = fs.mkdtempSync(path.join(os.tmpdir(), "lc9-"));
  {
    const c = makeController(t9);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    // give thread a backing for B pointing at an old session
    const meta = c.threadStore.get(tid);
    meta.backing.push({ agentId: "B", sessionId: "s-old-b", coveredEntries: 0, lastUsedAt: 1 });
    c.threadStore.updateMeta(tid, { backing: meta.backing });

    c.conn.on(M.session.resume, async () => { throw notFound(); });
    await c.selectAgent("B");
    ok(c.conn.byMethod(M.session.new).length >= 2, "resume -32601: fell back to session/new");
    ok(c.session?.agentId === "B", "resume -32601: B session established");
  }
  const t9b = fs.mkdtempSync(path.join(os.tmpdir(), "lc9b-"));
  {
    const c = makeController(t9b);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const meta = c.threadStore.get(tid);
    meta.backing.push({ agentId: "B", sessionId: "s-old-b", coveredEntries: 0, lastUsedAt: 1 });
    c.threadStore.updateMeta(tid, { backing: meta.backing });
    c.conn.on(M.session.resume, async () => { throw authErr(); });
    const newsBefore = c.conn.byMethod(M.session.new).length;
    await c.selectAgent("B");
    ok(c.connectionStatus === "auth_required", "resume auth: auth_required");
    ok(c.conn.byMethod(M.session.new).length === newsBefore,
      "resume auth: no silent session/new");
  }

  /* 10. Terminal auth env merge + deferred exit → session restored. */
  const t10 = fs.mkdtempSync(path.join(os.tmpdir(), "lc10-"));
  {
    const c = makeController(t10);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    c.conn.on(M.session.new, async () => { throw authErr(); });
    c.conn.on("__init", () => ({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      authMethods: [{ id: "term", name: "Sign in", type: "terminal", args: ["--login"], env: { SHARED: "method", M_ENV: "yes" } }],
    }));
    // re-spawn so initResponse picks up authMethods
    await c.selectAgent("B");
    const created = c.terminals.created.length;
    const p = c.authenticate("term");
    await sleep(20);
    ok(c.terminals.created.length === created + 1, "terminal auth: terminal created");
    const env = new Map(c.terminals.created.at(-1).env.map((e) => [e.name, e.value]));
    ok(env.get("AGENT_ENV") === "B" && env.get("SHARED") === "method" && env.get("M_ENV") === "yes",
      `terminal auth: env merged spec+method (${JSON.stringify([...env])})`);
    c.conn.off(M.session.new); // signed in — session/new succeeds now
    c.terminals.exits.get(`t-${created}`).resolve({ exitCode: 0 });
    await p;
    await sleep(30);
    ok(c.connectionStatus === "connected", "terminal auth success: connected");
  }

  /* 11. Unknown methodId does not authenticate the first method. */
  const t11 = fs.mkdtempSync(path.join(os.tmpdir(), "lc11-"));
  {
    const c = makeController(t11);
    await c.init();
    c.conn.initResponse = { authMethods: [{ id: "a1", name: "m1" }], agentCapabilities: {} };
    await c.authenticate("nope");
    ok(c.conn.byMethod(M.authenticate).length === 0, "unknown methodId: no authenticate call");
  }

  /* 12. Prompt ack on preflight failure keeps draft. */
  const t12 = fs.mkdtempSync(path.join(os.tmpdir(), "lc12-"));
  {
    const c = makeController(t12);
    await c.init();
    // no agent selected yet
    await c.sendPrompt("hello", [], "r9");
    ok(!!lastMsg(c, "promptRejected"), "no agent: prompt rejected");
    ok(!lastMsg(c, "promptAccepted"), "no agent: not accepted");
  }

  /* 13. C sign-in succeeds while B's auth is still pending. */
  const t13 = fs.mkdtempSync(path.join(os.tmpdir(), "lc13-"));
  {
    const c = makeController(t13);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;

    c.conn.on(M.session.new, async () => { throw authErr(); });
    await c.selectAgent("B");
    const bGate = deferred();
    c.conn.on(M.authenticate, () => bGate.promise);
    const bAuth = c.authenticate(); // hangs — must not block C
    await sleep(20);

    // switch to C — also auth-required at first, then allowed
    c.conn.on("__init", () => ({
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      authMethods: [{ id: "c1", name: "C sign-in" }],
    }));
    await c.selectAgent("C");
    ok(c.connectionStatus === "auth_required", "B pending: C auth_required");
    c.conn.off(M.session.new);
    c.conn.on(M.authenticate, async () => ({}));
    await c.authenticate("c1");
    ok(c.connectionStatus === "connected", "B pending: C sign-in connected");
    ok(c.session?.agentId === "C", "B pending: C session established");
    ok(c.activeThreadId === tid, "B pending: same thread");

    // late B auth resolution changes nothing
    const newsAt = c.conn.byMethod(M.session.new).length;
    bGate.resolve({});
    await bAuth;
    await sleep(50);
    ok(c.activeAgentId === "C", "late B auth: C stays active");
    ok(c.conn.byMethod(M.session.new).length === newsAt,
      "late B auth: no session churn");
  }

  /* 14. Streaming chunk + failed prompt: coverage stays, retry carries delta. */
  const t14 = fs.mkdtempSync(path.join(os.tmpdir(), "lc14-"));
  {
    const c = makeController(t14);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const cov0 = c.threadStore.get(tid).backing[0].coveredEntries;

    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const p = c.sendPrompt("failed attempt", []);
    await turnStarted(c);
    // a chunk arrives mid-turn — streaming must NOT advance coverage
    c.onSessionUpdate({
      sessionId: c.session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      },
    });
    await sleep(10);
    gate.reject(Object.assign(new Error("connection lost"), { code: -32603 }));
    await p;
    ok(c.threadStore.get(tid).backing[0].coveredEntries === cov0,
      "failed prompt: coverage unchanged after streamed chunk");

    // next successful prompt's handoff still includes the failed message
    c.conn.off(M.session.prompt);
    await c.sendPrompt("retry", []);
    const prompt = c.conn.byMethod(M.session.prompt).at(-1);
    ok(prompt.params.prompt.some((b) =>
      b.type === "text" && /failed attempt/.test(b.text) && /earlier in this thread/.test(b.text)),
      "retry prompt: handoff carries missed user message");
  }

  /* 15. Slow openThread loses to a newer selection. */
  const t15 = fs.mkdtempSync(path.join(os.tmpdir(), "lc15-"));
  {
    const c = makeController(t15);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("first", []);
    const t1 = c.activeThreadId;
    await c.newSession();
    await c.sendPrompt("second", []);
    const t2 = c.activeThreadId;
    ok(t1 && t2 && t1 !== t2, "slow open: two threads exist");

    const gate = deferred();
    const origEntriesOf = c.threadStore.entriesOf.bind(c.threadStore);
    c.threadStore.entriesOf = async (id) => { await gate.promise; return origEntriesOf(id); };
    const open = c.openThread(t1);   // in-flight on the read
    await sleep(20);
    await c.selectAgent("B");        // bumps the generation
    gate.resolve();
    await open;
    await sleep(20);
    ok(c.activeThreadId === t2, "slow open: stale read did not reopen T1");
    ok(c.pendingAgentId === "B" || c.activeAgentId === "B",
      "slow open: selection moved to B");
  }

  /* 16. Empty prompt rejected once; persist failure rejects + rolls back. */
  const t16 = fs.mkdtempSync(path.join(os.tmpdir(), "lc16-"));
  {
    const c = makeController(t16);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt(" ", [], "r-empty");
    ok(c.msgs.filter((m) => m.type === "promptRejected" && m.requestId === "r-empty").length === 1,
      "empty prompt: exactly one rejection");
    ok(!c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-empty"),
      "empty prompt: never accepted");

    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const n0 = c.model.entries.length;
    const origFlush = c.threadStore.flush.bind(c.threadStore);
    c.threadStore.flush = async () => { throw new Error("disk full"); };
    await c.sendPrompt("persist me", [], "r-pf");
    ok(c.msgs.some((m) => m.type === "promptRejected" && m.requestId === "r-pf"),
      "persist fail: rejected once");
    ok(!c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-pf"),
      "persist fail: not accepted");
    ok(c.model.entries.length === n0, "persist fail: appended entries rolled back");
    ok(c.conn.byMethod(M.session.prompt).length === 1,
      "persist fail: no prompt request sent");
    c.threadStore.flush = origFlush;
    // The rolled-back user entry must not linger in the store snapshot —
    // a later successful flush must not persist the rejected message.
    await c.threadStore.flush();
    const reloaded = new c.threadStore.constructor(c.threadStore.root());
    await reloaded.load();
    ok(!(await reloaded.entriesOf(tid)).some((e) =>
      e.kind === "user" && e.parts?.[0]?.text === "persist me"),
      "persist fail: rejected message absent from reloaded store");
    await c.sendPrompt("persist me", [], "r-pf2");
    ok(c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-pf2"),
      "persist restored: retry accepted");
    ok(c.model.entries.filter((e) => e.kind === "user" &&
      e.parts?.[0]?.text === "persist me").length === 1,
      "persist restored: single user entry");
  }

  /* 17. Transport death mid-prompt: error, release, one restart, no replay. */
  const t17 = fs.mkdtempSync(path.join(os.tmpdir(), "lc17-"));
  {
    const c = makeController(t17);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const cov0 = c.threadStore.get(tid).backing[0].coveredEntries;

    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const p = c.sendPrompt("dying turn", [], "r-die");
    await turnStarted(c);
    // transport dies mid-prompt
    const startsBefore = c.conn.starts.length;
    c.conn.connected = false;
    c.conn.initResponse = undefined;
    c.onConnectionClosed("process exited");
    ok(c.connectionStatus === "error", "mid-prompt death: error status surfaced");
    gate.reject(new Error("ACP connection closed"));
    await p;
    await sleep(50);
    ok(c.conn.starts.length === startsBefore + 1,
      `mid-prompt death: one restart (${startsBefore} -> ${c.conn.starts.length})`);
    ok(c.activeAgentId === "A" && c.activeThreadId === tid,
      "mid-prompt death: same agent+thread after restart");
    ok(c.conn.byMethod(M.session.prompt).length === 2,
      "mid-prompt death: no prompt replay");
    ok(c.threadStore.get(tid).backing[0].coveredEntries === cov0,
      "mid-prompt death: coverage not advanced");
  }

  /* 18. Fresh backing supersession: prompts reuse it; later switch picks it. */
  const t18 = fs.mkdtempSync(path.join(os.tmpdir(), "lc18-"));
  {
    const c = makeController(t18);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const meta = c.threadStore.get(tid);
    meta.backing.push({ agentId: "B", sessionId: "s-old-b", coveredEntries: 0, lastUsedAt: 1 });
    c.threadStore.updateMeta(tid, { backing: meta.backing });

    c.conn.on(M.session.resume, async () => { throw notFound(); });
    await c.selectAgent("B");
    const freshId = c.session?.sessionId;
    ok(freshId && freshId !== "s-old-b", "fresh backing: new session after resume failure");
    const newsAfterSelect = c.conn.byMethod(M.session.new).length;
    const promptsBefore = c.conn.byMethod(M.session.prompt).length;
    await c.sendPrompt("p1", []);
    await c.sendPrompt("p2", []);
    const prompts = c.conn.byMethod(M.session.prompt).slice(promptsBefore);
    ok(prompts.length === 2 && prompts.every((x) => x.params.sessionId === freshId),
      "fresh backing: consecutive prompts use same session");
    ok(c.conn.byMethod(M.session.new).length === newsAfterSelect,
      "fresh backing: no extra session/new per prompt");
    ok(c.threadStore.get(tid).backing.filter((b) => b.agentId === "B").length === 1,
      "fresh backing: stale B backing retired");

    // switch away and back — B's process and session are still live
    await c.selectAgent("A");
    c.conn.off(M.session.resume);
    const resumes = [];
    c.conn.on(M.session.resume, async (params) => { resumes.push(params.sessionId); return {}; });
    const startsBeforeBack = c.conn.starts.length;
    await c.selectAgent("B");
    ok(c.conn.starts.length === startsBeforeBack, "fresh backing: switch back reuses B's process");
    ok(resumes.length === 0 && c.session?.sessionId === freshId,
      `fresh backing: switch back reattaches ${freshId} with no agent call (resumes ${resumes})`);

    // once B's process is gone, resolution resumes the fresh backing
    await c.selectAgent("A");
    await c.conn.of("B").stop();
    await c.selectAgent("B");
    ok(resumes[0] === freshId, `fresh backing: restarted B resumes ${freshId} (got ${resumes[0]})`);
  }

  /* 19. Auth revalidation never reports connected on a stale handle. */
  const t19 = fs.mkdtempSync(path.join(os.tmpdir(), "lc19-"));
  {
    const c = makeController(t19);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const tid = c.activeThreadId;
    const staleSid = c.session.sessionId;

    // prompt hits the auth wall: status auth_required, handle still stale
    c.conn.on(M.session.prompt, async () => { throw authErr(); });
    await c.sendPrompt("blocked", []);
    ok(c.connectionStatus === "auth_required", "auth wall: status auth_required");
    ok(c.session?.sessionId === staleSid, "auth wall: handle retained");
    c.conn.off(M.session.prompt);

    // authenticate succeeds but re-attaching the backing still needs auth —
    // must NOT report connected on the stale handle.
    const resumedAs = [];
    c.conn.on(M.session.resume, async (p) => { resumedAs.push(p.sessionId); throw authErr(); });
    await c.authenticate();
    ok(c.connectionStatus === "auth_required",
      "auth revalidate: still auth_required after failed resume");
    ok(c.session === null, "auth revalidate: stale handle cleared");
    ok(c.activeThreadId === tid, "auth revalidate: thread kept");
    ok(resumedAs[0] === staleSid, "auth revalidate: probed the real backing");

    // retry succeeds — resume attaches and reports connected, same thread
    c.conn.off(M.session.resume);
    c.conn.on(M.session.resume, async () => ({}));
    await c.authenticate();
    ok(c.connectionStatus === "connected", "auth retry: connected after valid resume");
    ok(c.session?.sessionId === staleSid, "auth retry: re-attached same session");
    ok(c.activeThreadId === tid, "auth retry: same thread");
  }

  /* 20. Draft session handle is revalidated after authenticate, not trusted. */
  const t20 = fs.mkdtempSync(path.join(os.tmpdir(), "lc20-"));
  {
    const c = makeController(t20);
    await c.init();
    await c.selectAgent("A");
    await c.newSession();
    const sid = c.session.sessionId;
    ok(c.activeThreadId === undefined, "draft: no thread yet");
    // simulate the handle going stale: auth failure left status auth_required
    c.setConnection("auth_required");
    const resumedAs = [];
    c.conn.on(M.session.resume, async (p) => { resumedAs.push(p.sessionId); return {}; });
    await c.authenticate();
    ok(c.connectionStatus === "connected", "draft auth: connected after revalidation");
    ok(resumedAs[0] === sid, "draft auth: existing handle revalidated by resume");
    ok(c.session?.sessionId === sid, "draft auth: same session kept");

    // if the revalidation itself hits auth, stay auth_required — no fresh new
    c.setConnection("auth_required");
    c.conn.off(M.session.resume);
    c.conn.on(M.session.resume, async () => { throw authErr(); });
    const newsBefore = c.conn.byMethod(M.session.new).length;
    await c.authenticate();
    ok(c.connectionStatus === "auth_required", "draft re-auth: stays auth_required");
    ok(c.session === null, "draft re-auth: stale handle cleared");
    ok(c.conn.byMethod(M.session.new).length === newsBefore,
      "draft re-auth: no session/new minted");
  }

  /* 21. Transport death while awaiting the persistence barrier → rejected, no RPC. */
  const t21 = fs.mkdtempSync(path.join(os.tmpdir(), "lc21-"));
  {
    const c = makeController(t21);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const prompts0 = c.conn.byMethod(M.session.prompt).length;
    const starts0 = c.conn.starts.length;

    const gate = deferred();
    const origFlush = c.threadStore.flush.bind(c.threadStore);
    c.threadStore.flush = async () => { await gate.promise; return origFlush(); };
    const p = c.sendPrompt("dies in flush", [], "r-flushdie");
    await sleep(30);
    // transport dies while the send is parked inside flush
    c.conn.connected = false;
    c.conn.initResponse = undefined;
    c.onConnectionClosed("process exited");
    gate.resolve();
    await p;
    await sleep(30);
    ok(c.msgs.some((m) => m.type === "promptRejected" && m.requestId === "r-flushdie"),
      "flush death: rejected once");
    ok(!c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-flushdie"),
      "flush death: never accepted");
    ok(c.conn.byMethod(M.session.prompt).length === prompts0,
      "flush death: no RPC on dead connection");
    ok(c.conn.starts.length === starts0 + 1,
      "flush death: exactly one deferred restart");
    ok(c.activeAgentId === "A", "flush death: same agent after restart");
    ok(!c.model.entries.some((e) => e.kind === "user" &&
      e.parts?.[0]?.text === "dies in flush"),
      "flush death: rejected message removed from transcript");
    c.threadStore.flush = origFlush;
    await c.threadStore.flush();
    ok(!(await c.threadStore.entriesOf(c.activeThreadId)).some((e) =>
      e.kind === "user" && e.parts?.[0]?.text === "dies in flush"),
      "flush death: rejected message removed from stored entries");
  }

  /* 22. Transcript write failure rejects pre-accept — no dangling link. */
  const t22 = fs.mkdtempSync(path.join(os.tmpdir(), "lc22-"));
  {
    const c = makeController(t22);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed history", []);
    const tid = c.activeThreadId;
    const n0 = c.model.entries.length;

    // switch to B so the next prompt carries a handoff + transcript link
    c.conn.on(M.session.resume, async () => ({}));
    await c.selectAgent("B");
    ok(c.session?.agentId === "B", "handoff fail: B session attached");

    // fail only the transcript write
    const fsp = require("fs").promises;
    const origWrite = fsp.writeFile;
    fsp.writeFile = (file, ...rest) =>
      /transcript\.md$/.test(String(file))
        ? Promise.reject(new Error("disk full"))
        : origWrite(file, ...rest);
    const prompts0 = c.conn.byMethod(M.session.prompt).length;
    try {
      await c.sendPrompt("ctx", [], "r-tx");
    } finally {
      fsp.writeFile = origWrite;
    }
    ok(c.msgs.some((m) => m.type === "promptRejected" && m.requestId === "r-tx"),
      "transcript fail: rejected");
    ok(!c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-tx"),
      "transcript fail: not accepted");
    ok(c.conn.byMethod(M.session.prompt).length === prompts0,
      "transcript fail: no prompt RPC with missing link");
    ok(c.model.entries.length === n0, "transcript fail: no partial entries appended");
    ok(c.activeThreadId === tid, "transcript fail: thread kept");
  }

  /* 23. Agent forgot the session: re-attach once, resend once, never loop. */
  const t23 = fs.mkdtempSync(path.join(os.tmpdir(), "lc23-"));
  {
    const c = makeController(t23);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const sid = c.session.sessionId;
    let calls = 0;
    c.conn.on(M.session.prompt, async () => {
      if (calls++ === 0) throw new Error(`Session ${sid} not found`);
      return { stopReason: "end_turn" };
    });
    const resumes = [];
    c.conn.on(M.session.resume, async (p) => { resumes.push(p.sessionId); return {}; });
    const prompts0 = c.conn.byMethod(M.session.prompt).length;
    await c.sendPrompt("after eviction", [], "r-nf");
    ok(resumes.length === 1 && resumes[0] === sid, `not found: resumed ${sid} once (${resumes})`);
    ok(c.conn.byMethod(M.session.prompt).length === prompts0 + 2, "not found: prompt resent once");
    ok(c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "r-nf"),
      "not found: prompt accepted");
    ok(!c.model.entries.some((e) => e.kind === "notice" && /Prompt failed/.test(e.title ?? "")),
      "not found: no failure marker after recovery");

    c.conn.on(M.session.prompt, async () => { throw new Error("session not found"); });
    const prompts1 = c.conn.byMethod(M.session.prompt).length;
    await c.sendPrompt("still gone", [], "r-nf2");
    ok(c.conn.byMethod(M.session.prompt).length === prompts1 + 2,
      "not found twice: one retry, no loop");
  }

  /* 24. A pooled inactive agent cannot drive the UI. */
  const t24 = fs.mkdtempSync(path.join(os.tmpdir(), "lc24-"));
  {
    const c = makeController(t24);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("seed", []);
    const aSid = c.session.sessionId;
    await c.selectAgent("B");
    ok(c.conn.of("A").connected && c.conn.of("B").connected, "pool: A stays live while B active");
    const n = c.model.entries.length;
    const res = await c.delegateFor("A").requestPermission({
      sessionId: aSid,
      toolCall: { toolCallId: "tc", title: "write" },
      options: [{ optionId: "o", name: "Allow", kind: "allow_once" }],
    });
    ok(res.outcome.outcome === "cancelled", "inactive agent: permission declined");
    c.delegateFor("A").onSessionUpdate({
      sessionId: aSid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ghost" } },
    });
    ok(c.model.entries.length === n, "inactive agent: no cards or updates reach the thread");
    const startsBefore = c.conn.starts.length;
    await c.selectAgent("A");
    ok(c.conn.starts.length === startsBefore, "pool: switching back to A starts nothing");
  }
  /* 25. Prewarm starts the last-used agent only for someone who has used one. */
  const t25 = fs.mkdtempSync(path.join(os.tmpdir(), "lc25-"));
  {
    const fresh = makeController(t25);
    await fresh.init();
    fresh.didAutoConnect = false;
    fresh.prewarm();
    await sleep(20);
    ok(fresh.conn.starts.length === 0, "prewarm: first run starts nothing");

    const c = makeController(t25);
    await c.init();
    await c.context.globalState.update("shipwreck.lastAgent", "B");
    c.activeAgentId = "B";
    c.didAutoConnect = false;
    c.prewarm();
    await sleep(20);
    ok(c.conn.starts.length === 1 && c.conn.starts[0].command === "bin-B", "prewarm: last agent started");
    ok(c.session?.agentId === "B" && c.connectionStatus === "connected", "prewarm: session ready before any view");
    c.bind({ postMessage: async () => true, onDidReceiveMessage: () => {} });
    await sleep(10);
    ok(c.conn.starts.length === 1, "prewarm: opening the view starts nothing more");
  }

  /* 26. Changing acp.mcpServers reaches live sessions: the idle on-screen one
     re-attaches now, a running one after its turn, pooled ones when opened. */
  const t26 = fs.mkdtempSync(path.join(os.tmpdir(), "lc26-"));
  {
    try {
      const c = makeController(t26);
      await c.init();
      await c.selectAgent("A");
      await c.sendPrompt("first thread", []);
      const tid1 = c.activeThreadId;
      const sid1 = c.session.sessionId;
      await c.newSession();
      await c.sendPrompt("second thread", []);
      const sid2 = c.session.sessionId;
      const resumes = () => c.conn.byMethod(M.session.resume);
      const withFs = (x) => x.params.mcpServers?.some((s) => s.name === "fs" && s.command === "mcp-fs");

      globalThis.__acpShimConfig = { mcpServers: { fs: { command: "mcp-fs" } } };
      const before = resumes().length;
      c.mcpServersChanged();
      await sleep(20);
      const now = resumes().slice(before);
      ok(now.length === 1 && now[0].params.sessionId === sid2 && withFs(now[0]),
        "mcp change: idle on-screen session re-attached with the new servers");
      ok(c.session?.sessionId === sid2, "mcp change: same session kept");

      await c.openThread(tid1);
      const opened = resumes().slice(before + 1);
      ok(opened.length === 1 && opened[0].params.sessionId === sid1 && withFs(opened[0]),
        "mcp change: pooled session re-attached when opened");

      const gate = deferred();
      c.conn.on(M.session.prompt, () => gate.promise);
      const p = c.sendPrompt("long", []);
      await turnStarted(c);
      globalThis.__acpShimConfig = { mcpServers: { git: { command: "mcp-git" } } };
      const busyBefore = resumes().length;
      c.mcpServersChanged();
      await sleep(10);
      ok(resumes().length === busyBefore, "mcp change: running turn not interrupted");
      gate.resolve({ stopReason: "end_turn" });
      await p;
      await sleep(20);
      const after = resumes().slice(busyBefore);
      ok(after.length === 1 && after[0].params.sessionId === sid1 &&
        after[0].params.mcpServers.some((s) => s.name === "git"),
        "mcp change: running session re-attached after its turn");

      await c.newSession();
      const news = c.conn.byMethod(M.session.new).length;
      globalThis.__acpShimConfig = { mcpServers: { web: { command: "mcp-web" } } };
      c.mcpServersChanged();
      await sleep(20);
      const fresh = c.conn.byMethod(M.session.new);
      ok(fresh.length === news + 1 && fresh.at(-1).params.mcpServers.some((s) => s.name === "web"),
        "mcp change: empty draft gets a fresh session with the new servers");
    } finally {
      delete globalThis.__acpShimConfig;
    }
  }
  /* 27. Probing learns other agents' models; the probe's session becomes the
     agent's next new chat; fresh lists are not probed again. */
  const modelHandler = () => {
    let n = 0;
    return (p, agentId) => ({
      sessionId: `s-${agentId}-${++n}`,
      configOptions: [{
        id: "model", name: "Model", category: "model", type: "select",
        currentValue: `${agentId}-small`,
        options: [{ value: `${agentId}-small`, name: "Small" }, { value: `${agentId}-big`, name: "Big" }],
      }],
    });
  };
  const setConfigHandler = (p) => ({
    configOptions: [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: p.value,
      options: [{ value: p.value.replace(/-(small|big)$/, "-small"), name: "Small" },
        { value: p.value.replace(/-(small|big)$/, "-big"), name: "Big" }],
    }],
  });
  const catalogOf = (c) => lastMsg(c, "agentModels")?.agentModels ?? lastMsg(c, "snapshot")?.payload?.agentModels ?? [];
  const t27 = fs.mkdtempSync(path.join(os.tmpdir(), "lc27-"));
  {
    const c = makeController(t27);
    c.conn.on(M.session.new, modelHandler());
    await c.init();
    await c.selectAgent("A");
    c.probeAgents();
    await sleep(40);
    const cat = catalogOf(c);
    const b = cat.find((e) => e.agentId === "B");
    ok(b?.status === "ready" && b.models.length === 2 && b.configId === "model" && b.currentValue === "B-small",
      "probe: B's models learned");
    ok(cat.find((e) => e.agentId === "C")?.status === "ready", "probe: C's models learned");
    ok(cat.find((e) => e.agentId === "A")?.models.length === 2, "probe: active agent listed from its live session");
    ok(c.conn.starts.filter((s) => s.command === "bin-B").length === 1, "probe: B started once");
    ok(c.conn.of("B").connected && c.conn.of("C").connected, "probe: within the pool limit the processes stay up");
    const bNews = () => c.conn.byMethod(M.session.new).filter((x) => x.agentId === "B").length;
    const before = bNews();
    await c.selectAgent("B");
    ok(c.session?.agentId === "B" && c.session.sessionId === "s-B-2" && bNews() === before,
      "spare: switching to B reuses the probe's session, no session/new");
    const startsNow = c.conn.starts.length;
    c.probeAgents();
    await sleep(20);
    ok(c.conn.starts.length === startsNow, "probe: fresh lists are not probed again");
    await c.newSession();
    ok(bNews() === before + 1, "spare: used only once");
  }

  /* 28. Probe failures: sign-in needed keeps the process for the sign-in;
     other errors stop it. */
  const t28 = fs.mkdtempSync(path.join(os.tmpdir(), "lc28-"));
  {
    const c = makeController(t28);
    const models = modelHandler();
    c.conn.on(M.session.new, (p, agentId) => {
      if (agentId === "B") throw new Error("boom");
      if (agentId === "C") throw authErr();
      return models(p, agentId);
    });
    await c.init();
    await c.selectAgent("A");
    c.probeAgents();
    await sleep(40);
    const cat = catalogOf(c);
    const b = cat.find((e) => e.agentId === "B");
    ok(b?.status === "error" && /boom/.test(b.message ?? ""), "probe error: reported with its message");
    ok(cat.find((e) => e.agentId === "C")?.status === "auth_required", "probe auth: marked needs sign-in");
    ok(!c.conn.of("B").connected, "probe error: process stopped");
    ok(c.conn.of("C").connected, "probe auth: process kept for the sign-in");
  }

  /* 29. Picking a model on another agent switches agent and sets it; the pick
     sticks for that agent's new chats; a same-agent pick only sets the model. */
  const t29 = fs.mkdtempSync(path.join(os.tmpdir(), "lc29-"));
  {
    const c = makeController(t29);
    c.conn.on(M.session.new, modelHandler());
    c.conn.on(M.session.setConfigOption, setConfigHandler);
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("plan", []);
    const tid = c.activeThreadId;
    const sets = () => c.conn.byMethod(M.session.setConfigOption);
    await c.pickModel("A", "A-big");
    ok(sets().length === 1 && sets()[0].agentId === "A" && sets()[0].params.value === "A-big" &&
      c.activeAgentId === "A", "same-agent pick: model set, no switch");

    await c.pickModel("B", "B-big");
    ok(c.activeAgentId === "B" && c.session?.agentId === "B", "cross-agent pick: switched to B");
    ok(c.activeThreadId === tid, "cross-agent pick: thread kept (handoff)");
    const bSets = sets().filter((x) => x.agentId === "B");
    ok(bSets.length === 1 && bSets[0].params.value === "B-big" && bSets[0].params.sessionId === c.session.sessionId,
      "cross-agent pick: model set once on B's session");
    ok(catalogOf(c).find((e) => e.agentId === "B")?.preferredValue === "B-big", "pick: remembered for B");

    await c.newSession();
    await sleep(10);
    const again = sets().filter((x) => x.agentId === "B");
    ok(again.length === 2 && again[1].params.value === "B-big" && again[1].params.sessionId === c.session.sessionId,
      "preferred model: applied to B's next new chat");
    await c.pickModel("B", "B-big");
    ok(sets().filter((x) => x.agentId === "B").length === 2, "pick of the current model sends nothing");
  }

  /* 30. The catalog survives a reload; an interrupted probe is not shown as running. */
  const t30 = fs.mkdtempSync(path.join(os.tmpdir(), "lc30-"));
  {
    const c = makeController(t30);
    c.conn.on(M.session.new, modelHandler());
    await c.init();
    await c.selectAgent("A");
    c.probeAgents();
    await sleep(40);
    const saved = c.context.globalState.get("shipwreck.agentModels");
    saved.push({ agentId: "X", status: "probing", models: [], checkedAt: 1 });
    saved.find((e) => e.agentId === "C").status = "probing";
    const c2 = makeController(t30, c.context.globalState);
    const list = lastMsg(c2, "snapshot")?.payload?.agentModels ?? [];
    ok(list.find((e) => e.agentId === "B")?.models.length === 2, "reload: B's models kept");
    ok(!list.some((e) => e.agentId === "X"), "reload: probe that never finished is dropped");
    const cc = list.find((e) => e.agentId === "C");
    ok(cc?.status === "ready" && cc.checkedAt === 0, "reload: interrupted probe with models becomes stale ready");
  }

  /* 31. Switching to an agent while its probe is starting reuses that process. */
  const t31 = fs.mkdtempSync(path.join(os.tmpdir(), "lc31-"));
  {
    const c = makeController(t31);
    c.conn.on(M.session.new, modelHandler());
    await c.init();
    await c.selectAgent("A");
    const gate = deferred();
    c.conn.on("__start", (agentId) => (agentId === "B" ? gate.promise : undefined));
    c.probeAgents();
    await sleep(10);
    const sel = c.selectAgent("B");
    await sleep(10);
    gate.resolve();
    await sel;
    await sleep(20);
    ok(c.conn.starts.filter((s) => s.command === "bin-B").length === 1, "probe race: B started once");
    ok(c.session?.agentId === "B" && c.connectionStatus === "connected", "probe race: switch completed on the probe's process");
  }

  /* 32. A turn that writes files gets a changes card; review and undo work from it. */
  const t32 = fs.mkdtempSync(path.join(os.tmpdir(), "lc32-"));
  {
    globalThis.__acpShimFs = {
      readFile: async (u) => new Uint8Array(await fs.promises.readFile(u.fsPath)),
      writeFile: async (u, data) => fs.promises.writeFile(u.fsPath, data),
      createDirectory: async (u) => fs.promises.mkdir(u.fsPath, { recursive: true }),
    };
    const commands = [];
    globalThis.__acpShimCommand = (...a) => { commands.push(a); };
    const file = path.join(t32, "work.ts");
    fs.writeFileSync(file, "old\n");
    const c = makeController(t32);
    await c.init();
    await c.selectAgent("A");
    const ideNew = c.conn.byMethod(M.session.new).at(-1);
    ok(ideNew.params.mcpServers.some((s) => s.name === "vscode" && s.env.some((e) => e.name === "ACP_IDE_PIPE")),
      "ide tools: session/new carries the vscode MCP server");
    c.conn.on(M.session.prompt, async (params) => {
      await c.delegateFor("A").beforeWriteFile(params.sessionId, file);
      fs.writeFileSync(file, "new\nmore\n");
      return { stopReason: "end_turn" };
    });
    await c.sendPrompt("edit it", []);
    await sleep(50);
    const card = c.model.entries.find((e) => e.kind === "changes");
    ok(card && card.files.length === 1 && card.files[0].add === 2 && card.files[0].del === 1,
      "changes: card added after the turn");
    ok(c.msgs.some((m) => m.type === "entryUpsert" && m.entry.kind === "changes"), "changes: card sent to the view");
    ok(c.model.entries.at(-1) === card, "changes: card is the turn's last entry");
    const stored = await c.threadStore.entriesOf(c.activeThreadId);
    ok(stored.some((e) => e.kind === "changes"), "changes: card persisted with the thread");
    await c.onMessage({ type: "reviewChanges", entryId: card.id });
    ok(commands.some((a) => a[0] === "vscode.diff"), "changes: Review opens the diff editor");
    globalThis.__acpShimWarning = () => "Undo";
    await c.onMessage({ type: "revertChanges", entryId: card.id });
    ok(fs.readFileSync(file, "utf8") === "old\n", "changes: Undo restores the file");
    const undone = c.model.entries.find((e) => e.id === card.id);
    ok(undone.reverted?.length === 1 && c.msgs.at(-1).type === "entryUpsert" && c.msgs.at(-1).entry.reverted?.length === 1,
      "changes: card marked undone");
    delete globalThis.__acpShimWarning;
    c.conn.off(M.session.prompt);
    await c.sendPrompt("just talk", []);
    await sleep(30);
    ok(c.model.entries.filter((e) => e.kind === "changes").length === 1, "changes: a turn without edits adds no card");
    const keptFile = path.join(t32, "kept.ts");
    fs.writeFileSync(keptFile, "keep baseline\n");
    let editTurn = 0;
    c.conn.on(M.session.prompt, async (params) => {
      await c.delegateFor("A").beforeWriteFile(params.sessionId, file);
      await c.delegateFor("A").beforeWriteFile(params.sessionId, keptFile);
      fs.writeFileSync(file, `edit ${++editTurn}\n`);
      fs.writeFileSync(keptFile, `keep ${editTurn}\n`);
      return { stopReason: "end_turn" };
    });
    await c.sendPrompt("first edits", []);
    await sleep(50);
    await c.sendPrompt("second edits", []);
    await sleep(50);
    const outstanding = c.model.entries.filter((e) => e.kind === "changes" && e.id !== card.id);
    const entryIds = outstanding.map((e) => e.id);
    let confirmations = 0;
    globalThis.__acpShimWarning = () => { confirmations++; return "Undo"; };
    const commandStart = commands.length;
    await c.onMessage({ type: "editsReview", entryIds: [...entryIds].reverse() });
    await c.onMessage({ type: "editsUndo", entryIds: [...entryIds].reverse(), path: file });
    ok(fs.readFileSync(file, "utf8") === "old\n" && fs.readFileSync(keptFile, "utf8") === "keep 2\n" &&
      confirmations === 1 && commands.slice(commandStart).filter((a) => a[0] === "vscode.changes").length === 1 &&
      entryIds.every((id) => c.model.entries.find((e) => e.id === id).reverted?.includes(file)),
      "edits: one review and confirmation, earliest baseline restored across turns, both cards marked undone");
    await c.onMessage({ type: "editsKeep", entryIds });
    const keptEntries = await c.threadStore.entriesOf(c.activeThreadId);
    ok(fs.readFileSync(keptFile, "utf8") === "keep 2\n" && confirmations === 1 &&
      entryIds.every((id) => keptEntries.find((e) => e.id === id).files.find((f) => f.path === keptFile).kept),
      "edits: Keep persists every outstanding file without changing disk or confirming");
    delete globalThis.__acpShimWarning;
    c.conn.off(M.session.prompt);
    globalThis.__acpShimConfig = { ideTools: false };
    await c.newSession();
    ok(!c.conn.byMethod(M.session.new).at(-1).params.mcpServers.some((s) => s.name === "vscode"),
      "ide tools: off by setting");
    delete globalThis.__acpShimConfig;
    delete globalThis.__acpShimFs;
    delete globalThis.__acpShimCommand;
  }

  {
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-state-")));
    await c.init();
    await c.selectAgent("A");
    await c.sendPrompt("keep this transcript", []);
    const tid = c.activeThreadId;
    const sid = c.session.sessionId;
    const errors = [];
    globalThis.__acpShimError = (text) => errors.push(text);
    c.conn.on(M.session.new, async () => { throw new Error("synthetic new-chat failure"); });
    await c.newSession();
    delete globalThis.__acpShimError;
    ok(c.activeThreadId === tid && c.session.sessionId === sid &&
      c.model.entries.some((e) => e.kind === "user" && e.parts[0].text === "keep this transcript"),
      "failed new chat: original thread, session and transcript retained");
    ok(errors[0] === "Could not create session: synthetic new-chat failure",
      "failed new chat: error shown");

    c.postSnapshot();
    c.msgs.length = 0;
    await c.onMessage({ type: "ready" });
    ok(lastMsg(c, "snapshot")?.payload.entries?.some((e) =>
      e.kind === "user" && e.parts[0].text === "keep this transcript"),
      "webview ready: full current transcript restored");

    c.conn.off(M.session.new);
    c.conn.on(M.session.list, async (_, id) => ({
      sessions: [{ sessionId: `${id}-native`, title: `${id} native history` }],
    }));
    await c.listNativeSessions();
    await c.selectAgent("B");
    ok(lastMsg(c, "snapshot")?.payload.nativeSessions?.every((s) => s.sessionId !== "A-native") === true,
      "agent switch: snapshot never relabels A native sessions as B");
    await c.listNativeSessions();
    ok(lastMsg(c, "nativeSessions")?.agentId === "B" &&
      lastMsg(c, "nativeSessions").sessions[0].sessionId === "B-native",
      "native history: list carries its owning agent");
    await c.selectAgent("A");
    ok(lastMsg(c, "snapshot")?.payload.nativeSessions?.[0]?.sessionId === "A-native",
      "agent switch: cached native history belongs to selected agent");

    c.installer._agents = [];
    c.notifyAgentsChanged();
    await sleep(10);
    const snap = lastMsg(c, "snapshot")?.payload;
    ok(snap?.activeAgentId === null && snap.session === null &&
      snap.connection.status === "disconnected" && snap.entries?.length === 0,
      "uninstall all: explicit null selection and empty Home state");
    ok(lastMsg(c, "closeView")?.type === "closeView" &&
      c.context.globalState.get("shipwreck.lastAgent") === undefined,
      "uninstall all: return Home and forget last agent");
    ok(!c.conn.of("A").connected && !c.conn.of("B").connected &&
      c.pool.liveAgents().length === 0 && c.threadStore.get(tid).title === "keep this transcript",
      "uninstall all: pooled processes stopped and saved history retained");
    c.dispose();
  }
  {
    const seed = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-stale-")));
    await seed.context.globalState.update("shipwreck.lastAgent", "removed-agent");
    const c = makeController(seed._tmp, seed.context.globalState);
    await c.init();
    ok(c.activeAgentId === null && c.context.globalState.get("shipwreck.lastAgent") === undefined,
      "restart: stale last agent reconciled to Home");
    c.didAutoConnect = false;
    c.prewarm();
    await sleep(10);
    ok(c.conn.starts.length === 0 && lastMsg(c, "snapshot")?.payload.activeAgentId === null,
      "restart: stale selection never starts another agent implicitly");
    seed.dispose();
    c.dispose();
  }
  {
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-remove-probe-")));
    await c.init();
    await c.selectAgent("A");
    const gate = deferred();
    c.installer._delay.set("B", gate);
    const probe = c.probeAgent("B");
    c.installer._agents = c.installer._agents.filter((a) => a.id !== "B");
    c.notifyAgentsChanged();
    gate.resolve();
    await probe;
    ok(!c.conn.starts.some((s) => s.command === "bin-B") && !c.conn.of("B").connected,
      "uninstall during probe: removed agent never starts after delayed launch resolution");
    c.dispose();
  }
  {
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-busy-new-")));
    await c.init();
    await c.selectAgent("A");
    const gate = deferred();
    c.conn.on(M.session.prompt, () => gate.promise);
    const prompt = c.sendPrompt("keep running here", []);
    await turnStarted(c);
    const tid = c.activeThreadId;
    const sid = c.session.sessionId;
    c.conn.on(M.session.new, async () => { throw new Error("busy new-chat failure"); });
    await c.newSession();
    ok(c.activeThreadId === tid && c.session?.sessionId === sid && c.promptInFlight,
      "failed busy new chat: running thread restored to the foreground");
    gate.resolve({ stopReason: "end_turn" });
    await prompt;
    c.dispose();
  }
  {
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-scope-")));
    const gate = deferred();
    globalThis.__acpShimConfig = { "threads.scope": "workspace" };
    globalThis.__acpShimUpdate = async (key, value) => {
      await gate.promise;
      globalThis.__acpShimConfig[key] = value;
    };
    try {
      const changed = c.onMessage({ type: "setThreadsScope", scope: "all" });
      gate.resolve();
      await changed;
      ok(lastMsg(c, "snapshot")?.payload.threadsScope === "all",
        "scope change: snapshot waits for configuration persistence");
    } finally {
      delete globalThis.__acpShimConfig;
      delete globalThis.__acpShimUpdate;
      c.dispose();
    }
  }
  {
    const installerOut = path.join(os.tmpdir(), `installer-state-${Date.now()}.cjs`);
    esbuild.buildSync({
      entryPoints: [path.join(root, "src", "installer.ts")], bundle: true, platform: "node",
      format: "cjs", outfile: installerOut,
      alias: { vscode: path.join(__dirname, "vscode-shim.js") },
    });
    const { Installer } = require(installerOut);
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-custom-")));
    globalThis.__acpShimConfig = { customAgents: [
      { name: "Remove", command: "remove" }, { name: "Keep", command: "keep" },
    ] };
    globalThis.__acpShimUpdate = async (key, value) => { globalThis.__acpShimConfig[key] = value; };
    try {
      const installer = new Installer(c.context, { agents: () => [] });
      await installer.uninstall("custom:Remove");
      ok(JSON.stringify(installer.descriptors().map((a) => a.id)) === '["custom:Keep"]',
        "custom uninstall: removes the configured agent and retains the other");
    } finally {
      delete globalThis.__acpShimConfig;
      delete globalThis.__acpShimUpdate;
      c.dispose();
    }
  }
  {
    const c = makeController(fs.mkdtempSync(path.join(os.tmpdir(), "lc-race-")));
    await c.init();
    const gate = deferred();
    let minted = 0;
    c.conn.on(M.session.new, async () => {
      const sessionId = `race-${++minted}`;
      await gate.promise;
      return { sessionId };
    });
    const selecting = c.selectAgent("A");
    for (let i = 0; i < 200 && c.conn.byMethod(M.session.new).length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    const sending = c.sendPrompt("first message", [], "race-1");
    await new Promise((r) => setImmediate(r));
    gate.resolve();
    await Promise.all([selecting, sending]);
    ok(c.conn.byMethod(M.session.new).length === 1, "select + immediate send: one session/new");
    ok(c.msgs.some((m) => m.type === "promptAccepted" && m.requestId === "race-1"),
      "select + immediate send: the first message is accepted");
    ok(!c.msgs.some((m) => m.type === "promptRejected" && m.requestId === "race-1"),
      "select + immediate send: the first message is not rejected");
    c.dispose();
  }
  if (failures) {
    console.log(`${failures} lifecycle checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} lifecycle checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
