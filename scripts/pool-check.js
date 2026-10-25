/* Plain-Node check of AgentPool: one connection per agent, attach registry,
   idle reaping and LRU eviction that never touch the active agent. */
"use strict";
const path = require("path");
const os = require("os");
const esbuild = require("esbuild");

const out = path.join(os.tmpdir(), `pool-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "acp", "pool.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
});
const { AgentPool } = require(out);

let failures = 0;
let passed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}`); }
};

const created = [];
const fake = (agentId) => {
  const conn = {
    agentId,
    connected: false,
    initResponse: undefined,
    spec: undefined,
    stops: 0,
    start: async () => { conn.connected = true; conn.initResponse = {}; return {}; },
    stop: async () => { conn.stops++; conn.connected = false; },
    request: async () => ({}),
    notify: async () => {},
  };
  created.push(conn);
  return conn;
};
const meta = (agentId, sessionId, extra = {}) =>
  ({ agentId, sessionId, cwd: "x", busy: false, createdAt: 0, ...extra });

(async () => {
  {
    const pool = new AgentPool(fake, { idleMs: 1000, maxLive: 3 });
    ok(pool.connection(undefined).connected === false, "no agent: disconnected stub");
    ok(pool.connection("A") === pool.connection("A"), "one connection per agent");
    pool.setActive("A");
    await pool.start("A", {});
    pool.markAttached("A", "s1");
    ok(pool.attached("A", "s1") === undefined, "attached before meta: no cached meta yet");
    pool.remember(meta("A", "s1", { availableCommands: [{ name: "plan" }] }));
    ok(pool.attached("A", "s1")?.sessionId === "s1", "attached session returns its meta");
    ok(pool.lastCommands("A")?.[0]?.name === "plan", "commands cached per agent");
    pool.remember(meta("A", "s-other"));
    ok(pool.attached("A", "s-other") === undefined, "remember does not attach unknown sessions");

    pool.connection("A").connected = false;
    ok(pool.attached("A", "s1") === undefined, "dead process: nothing attached");
    await pool.start("A", {});
    ok(pool.attached("A", "s1") === undefined, "restart clears the old process's sessions");

    pool.markAttached("A", "s2");
    pool.remember(meta("A", "s2"));
    pool.forgetSessions("A");
    ok(pool.attached("A", "s2") === undefined, "forgetSessions drops the registry");
    pool.dispose();
  }

  {
    const pool = new AgentPool(fake, { idleMs: 1000, maxLive: 2 });
    pool.setActive("A");
    await pool.start("A", {});
    pool.setActive("B");
    await pool.start("B", {});
    ok(pool.liveAgents().join() === "A,B", "two agents live");
    pool.setActive("C");
    await pool.start("C", {});
    ok(!pool.connection("A").connected, "over the cap: least recently used inactive agent stopped");
    ok(pool.connection("B").connected && pool.connection("C").connected, "recent agents kept");

    const now = Date.now();
    pool.reap(now + 500);
    ok(pool.connection("B").connected, "reap: not idle long enough yet");
    pool.reap(now + 5000);
    ok(!pool.connection("B").connected, "reap: idle inactive agent stopped");
    ok(pool.connection("C").connected, "reap: active agent never stopped");
    pool.dispose();
    ok(created.every((c) => !c.connected),
      "dispose stops every process");
  }

  if (failures) {
    console.log(`${failures} pool checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} pool checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
