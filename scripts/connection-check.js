/* Plain-Node check of AgentConnection generation isolation: overlapping
   starts, duplicate close/exit notification, intentional stop, hung
   initialize deadline, and retired-generation callback gating. The real
   AgentConnection runs against synthetic stdio ACP agents (node). Bundled
   via esbuild with the vscode shim. */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const out = path.join(os.tmpdir(), `conn-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "acp", "connection.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
});
const { AgentConnection } = require(out);

// --- synthetic agent: minimal ndjson ACP server ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conn-agent-"));
const agentJs = path.join(dir, "agent.js");
fs.writeFileSync(
  agentJs,
  `const readline = require("readline");
const delay = Number(process.env.MOCK_DELAY || 0);
const exitAfter = process.env.MOCK_EXIT_AFTER === "1";
const pushAfter = Number(process.env.MOCK_PUSH_AFTER || 0);
const reqAfter = Number(process.env.MOCK_REQ_AFTER || 0);
const stderrAfter = Number(process.env.MOCK_STDERR_AFTER || 0);
const rl = readline.createInterface({ input: process.stdin });
if (pushAfter) setTimeout(() => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "late" } } } }) + "\\n");
}, pushAfter);
if (reqAfter) setTimeout(() => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 991,
    method: "session/request_permission", params: { sessionId: "s-1",
      toolCall: { toolCallId: "x", title: "late perm" }, options: [] } }) + "\\n");
}, reqAfter);
if (stderrAfter) setTimeout(() => process.stderr.write("late stderr\\n"), stderrAfter);
rl.on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!("method" in m) || m.id === undefined) return;
  const respond = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") {
    if (process.env.MOCK_INIT_LOG) require("fs").appendFileSync(process.env.MOCK_INIT_LOG, line + "\\n");
    if (process.env.MOCK_REJECT_HYBRID === "1" && m.params.info) {
      return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id,
        error: { code: -32602, message: "unknown field info" } }) + "\\n");
    }
    if (process.env.MOCK_HANG === "1") return;      // never respond
    if (process.env.MOCK_DIE === "1") process.exit(0); // die without answering
    await new Promise((r) => setTimeout(r, delay));
    respond({ protocolVersion: Number(process.env.MOCK_VERSION || 1),
      agentCapabilities: { promptCapabilities: {}, sessionCapabilities: {} },
      authMethods: [], agentInfo: { name: "synth", title: "Synth" } });
    if (exitAfter) process.exit(0);
  } else if (m.method === "session/new") {
    respond({ sessionId: "s-1" });
  } else if (m.method === "session/prompt") {
    respond({ stopReason: "end_turn" });
  } else respond({});
});`,
);

const spec = (env = {}) => ({
  command: process.execPath,
  args: [agentJs],
  env: { ...process.env, ...env },
  description: "synthetic agent",
});

// Anything unhandled is a bug — retired connections already swallow their
// own close rejections inside AgentConnection.
process.on("unhandledRejection", (e) => {
  console.error("unhandledRejection", e);
  process.exit(1);
});

const delegate = () => {
  const d = {
    closed: [], updates: 0, perms: 0, stderr: "",
    onSessionUpdate: () => d.updates++,
    requestPermission: async () => { d.perms++; return { outcome: { outcome: "cancelled" } }; },
    createElicitation: async () => ({ action: "cancel" }),
    onElicitationComplete: () => {},
    onConnectionClosed: (r) => d.closed.push(r),
    onStderr: (t) => (d.stderr += t),
  };
  return d;
};
const terminals = { creates: 0, create() { this.creates++; return { terminalId: "t" }; },
  output: async () => ({}), waitForExit: async () => ({ exitCode: 0 }), kill() {}, release() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}`); }
};

(async () => {
  // 1. Slow start superseded by a fast one: old init must not publish.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    const slow = c.start(spec({ MOCK_DELAY: "500" }));
    // Attach the rejection handler immediately — an awaited-later rejection
    // would be unhandled.
    const slowRes = slow.then(() => "resolved").catch((e) => e.message);
    const fast = c.start(spec({ MOCK_DELAY: "0" }));
    await fast;
    ok(c.connected, "fast generation connects");
    ok(!!c.initResponse, "initResponse published by current generation");
    ok((await slowRes) === "superseded by a newer agent start", "slow start rejected superseded");
    await sleep(700);
    ok(d.closed.length === 0, `retired generation close ignored (${d.closed.length})`);
    await c.stop();
    ok(d.closed.length === 0, "intentional stop after overlap: no close event");
  }

  // 2. Process exit + stream close → exactly one closed notification.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    await c.start(spec({ MOCK_EXIT_AFTER: "1" }));
    await sleep(800);
    ok(d.closed.length === 1, `dup close/exit deduped (${d.closed.length})`);
    ok(!c.connected, "connection reports down after exit");
    await c.stop();
  }

  // 3. Intentional stop: identities retired first — no close event, no restart.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    await c.start(spec());
    ok(c.connected, "baseline connected");
    await c.stop();
    await sleep(400);
    ok(d.closed.length === 0, "stop(): no close notification");
    ok(!c.connected && !c.initResponse, "stop(): init + conn cleared");
  }

  // 4. start() after start() without explicit stop: old generation retired.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    await c.start(spec());
    await c.start(spec());
    ok(c.connected, "second start connected");
    await sleep(400);
    ok(d.closed.length === 0, `old generation retired silently (${d.closed.length})`);
    await c.stop();
  }

  // 5. Retired generation's late notifications/requests/stderr are inert.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    // Old gen pushes a notification, a permission request, and stderr AFTER
    // the newer generation has taken over.
    const oldStart = c.start(spec({
      MOCK_PUSH_AFTER: "400", MOCK_REQ_AFTER: "400", MOCK_STDERR_AFTER: "400",
    }));
    const oldRes = oldStart.then(() => "resolved").catch((e) => e.message);
    await c.start(spec({ MOCK_PUSH_AFTER: "350" }));
    await oldRes;
    await sleep(800);
    ok(d.updates === 1, `retired gen update ignored, current seen (${d.updates})`);
    ok(d.perms === 0, `retired gen permission request never reached delegate (${d.perms})`);
    ok(!/late stderr/.test(d.stderr), "retired gen stderr not forwarded");
    ok(terminals.creates === 0, "retired gen never created a terminal");
    await c.stop();
  }

  // 6. Agent that dies during initialize → bounded failure.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    const p = c.start(spec({ MOCK_DIE: "1" }));
    const res = await p.then(() => "resolved").catch((e) => e.message);
    ok(typeof res === "string" && res !== "resolved", `dead/failed init rejects (${res})`);
    ok(!c.connected, "failed generation leaves connection down");
  }

  // 6b. Agent answering an unsupported protocol version is rejected.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    const res = await c.start(spec({ MOCK_VERSION: "2" })).then(() => "resolved").catch((e) => e.message);
    ok(/ACP version 2; this extension supports version 1/.test(res), `unsupported version rejected (${res})`);
    ok(!c.connected && !c.initResponse, "unsupported version leaves connection down");
    await c.stop();
  }

  {
    const logPath = path.join(dir, "init-off.jsonl");
    const c = new AgentConnection(delegate(), terminals);
    await c.start(spec({ MOCK_INIT_LOG: logPath }));
    const sent = JSON.parse(fs.readFileSync(logPath, "utf8").trim()).params;
    ok(sent.protocolVersion === 1 && !("info" in sent) && !("capabilities" in sent),
      "setting off: v1-only initialize");
    ok(Object.keys(sent).join() === "protocolVersion,clientCapabilities,clientInfo",
      `setting off: initialize fields unchanged (${Object.keys(sent).join()})`);
    ok(c.protocolVersion === 1, "setting off: v1 connection");
    await c.stop();
  }

  {
    const c = new AgentConnection(delegate(), terminals);
    const res = await c.start({ command: process.execPath,
      args: [path.join(__dirname, "mock-agent-v2.js")], env: { ...process.env }, description: "mock v2" })
      .then(() => "resolved").catch((e) => e.message);
    ok(res !== "resolved" && !c.connected, `setting off: v2-only agent rejected (${res})`);
    await c.stop();
  }

  globalThis.__acpShimConfig = { acpV2: true };
  {
    const logPath = path.join(dir, "init-on.jsonl");
    const c = new AgentConnection(delegate(), terminals);
    await c.start(spec({ MOCK_INIT_LOG: logPath }));
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const sent = JSON.parse(lines[0]).params;
    ok(lines.length === 1, "setting on, v1 agent: one initialize");
    ok(sent.protocolVersion === 2 && sent.info?.name === "shipwreck" && !!sent.capabilities,
      "setting on: initialize carries v2 fields");
    ok(sent.clientCapabilities?.fs?.readTextFile === true && sent.clientCapabilities.terminal === true,
      "setting on: initialize keeps v1 fs/terminal capabilities");
    ok(c.connected && c.protocolVersion === 1, "setting on, v1 agent: v1 selected");
    const res = await c.request("session/new", { cwd: dir, mcpServers: [] });
    ok(res.sessionId === "s-1", "setting on, v1 agent: v1 requests work");
    await c.stop();
  }

  {
    const logPath = path.join(dir, "init-reject.jsonl");
    const c = new AgentConnection(delegate(), terminals);
    await c.start(spec({ MOCK_INIT_LOG: logPath, MOCK_REJECT_HYBRID: "1" }));
    const sent = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).params);
    ok(sent.length === 2 && !!sent[0].info && !("info" in sent[1]) && sent[1].protocolVersion === 1,
      `rejected hybrid: one v1-only retry (${sent.length})`);
    ok(c.connected && c.protocolVersion === 1, "rejected hybrid: connected on v1");
    await c.stop();
  }

  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    const init = await c.start({ command: process.execPath,
      args: [path.join(__dirname, "mock-agent-v2.js")], env: { ...process.env }, description: "mock v2" });
    ok(c.connected && c.protocolVersion === 2 && init.protocolVersion === 2, "setting on, v2 agent: v2 selected");
    ok(init.agentInfo?.name === "mock-v2", "v2 init: info read as agentInfo");
    ok(init.authMethods?.[0]?.id === "login", "v2 init: methodId read as id");
    ok(init.agentCapabilities?.promptCapabilities?.embeddedContext === true &&
      init.agentCapabilities.promptCapabilities.image === false, "v2 init: prompt markers as booleans");
    const caps = init.agentCapabilities?.sessionCapabilities ?? {};
    ok(!!caps.list && !!caps.resume && !!caps.close && !!caps.delete && init.agentCapabilities.loadSession,
      "v2 init: baseline session capabilities");
    const res = await c.request("session/new", { cwd: dir, mcpServers: [] });
    ok(/^s2-/.test(res.sessionId) && res.configOptions?.[0]?.id === "mode", "v2: session/new with config options");
    await c.request("authenticate", { methodId: "login" });
    ok(true, "v2: authenticate maps to auth/login");
    await c.stop();
    ok(d.closed.length === 0, "v2: stop() sends no close notification");
  }

  {
    const c = new AgentConnection(delegate(), terminals);
    const res = await c.start(spec({ MOCK_VERSION: "3" })).then(() => "resolved").catch((e) => e.message);
    ok(/ACP version 3/.test(res) && !c.connected, `setting on: version 3 rejected (${res})`);
    await c.stop();
  }
  globalThis.__acpShimConfig = undefined;

  // 7. Hung initialize → real 30s deadline, actionable error, connection down.
  {
    const d = delegate();
    const c = new AgentConnection(d, terminals);
    const t0 = Date.now();
    const res = await c.start(spec({ MOCK_HANG: "1" }))
      .then(() => "resolved")
      .catch((e) => e.message);
    const elapsed = Date.now() - t0;
    ok(/initialize within 30s/.test(res), `hung init rejects with deadline error (${res})`);
    ok(elapsed >= 29_000 && elapsed < 40_000, `deadline hit at ~30s (${elapsed}ms)`);
    ok(!c.connected && !c.initResponse, "hung init leaves connection down");
    ok(d.closed.length === 0, "hung init: no spurious close notification");
    await c.stop();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures) {
    console.log(`${failures} connection checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} connection checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
