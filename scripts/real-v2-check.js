/* Manual check, not run by npm test. Needs a Claude login.
   Usage: node scripts/real-v2-check.js [path-to-claude-agent-acp/dist/index.js] */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const esbuild = require("esbuild");

const adapter = process.argv[2] || process.env.CLAUDE_ACP_ENTRY ||
  path.join(os.tmpdir(), "acp-v2-research", "node_modules", "@agentclientprotocol",
    "claude-agent-acp", "dist", "index.js");
if (!fs.existsSync(adapter)) {
  console.log(`FAIL: adapter not found at ${adapter}`);
  process.exit(1);
}

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "realv2-"));
process.env.ACP_SHIM_WS = tmp;
globalThis.__acpShimConfig = { acpV2: true, ideTools: false };
const out = path.join(os.tmpdir(), `realv2-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(root, "src", "chatProvider.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
  alias: { vscode: path.join(__dirname, "vscode-shim.js") },
});
const { ChatController } = require(out);

let failures = 0;
const ok = (cond, name) => {
  console.log(`${cond ? "ok" : "FAIL"}: ${name}`);
  if (!cond) failures++;
};
const textOf = (e) => (e.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");

const context = {
  globalState: {
    _m: new Map(),
    get(k, d) { return this._m.has(k) ? this._m.get(k) : d; },
    async update(k, v) { this._m.set(k, v); },
  },
  globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), "realv2-ctx-")) },
  subscriptions: [],
};
const installer = {
  descriptors: () => [{ id: "claude", name: "Claude", installed: true }],
  launchSpec: async () => ({
    command: process.execPath, args: [adapter], env: { ...process.env }, description: "claude-agent-acp",
  }),
};
const c = new ChatController(context, {}, installer);
c.didAutoConnect = true;
c.chatVisible = true;
c.bind({ postMessage: async () => true, onDidReceiveMessage: () => {} });

const deadline = setTimeout(() => {
  console.log("FAIL: timed out after 180s");
  process.exit(1);
}, 180_000);

(async () => {
  await c.init();
  await c.selectAgent("claude");
  const conn = c.pool.connection("claude");
  const init = conn.initResponse;
  console.log(`agent: ${init?.agentInfo?.name} ${init?.agentInfo?.version ?? ""}`.trim());
  console.log(`connection: ${c.connectionStatus}`);
  const expected = process.env.CLAUDE_AGENT_ACP_PROTOCOL === "v1" ? 1 : 2;
  ok(conn.protocolVersion === expected, `negotiated ACP version ${conn.protocolVersion}`);
  ok(c.connectionStatus === "connected" && !!c.session?.sessionId, "session created");
  console.log(`config options: ${(c.session?.configOptions ?? []).map((o) => `${o.id}(${o.category ?? "-"})`).join(", ")}`);

  const t0 = Date.now();
  await c.sendPrompt("Reply with the word pong.", [], "real-1");
  const reply = c.model.entries.filter((e) => e.kind === "agent").map(textOf).join("\n").trim();
  console.log(`reply after ${Date.now() - t0}ms: ${JSON.stringify(reply)}`);
  ok(/pong/i.test(reply), "reply landed in the transcript");
  ok(!c.session.busy, "turn ended");
  const errors = c.model.entries.filter((e) => e.kind === "notice" && e.severity === "error");
  ok(errors.length === 0, `no error notices (${errors.map((e) => e.title).join("; ")})`);
  console.log(`entries: ${c.model.entries.map((e) => e.kind).join(", ")}`);
  for (const e of c.model.entries) {
    if (e.kind === "notice") console.log(`notice (${e.severity}): ${e.title}`);
  }

  clearTimeout(deadline);
  await c.dispose();
  await c.threadStore.flush();
  console.log(failures ? `${failures} real v2 checks failed` : "real v2 check passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
