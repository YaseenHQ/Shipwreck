// Dumps what an agent offers on session/new (modes, config options, models)
// without sending a prompt. Usage: node scripts/dump-session.js <cmd> [args...]
const { spawn } = require("child_process");
const { Readable, Writable } = require("stream");
const acp = require("@agentclientprotocol/sdk");

const [cmd, ...args] = process.argv.slice(2);
(async () => {
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  proc.stderr.on("data", () => {});
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const updates = [];
  const conn = acp
    .client({ name: "dump" })
    .onNotification(acp.methods.client.session.update, (ctx) => updates.push(ctx.params.update))
    .connect(stream);
  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      session: { configOptions: { boolean: {} } },
    },
    clientInfo: { name: "dump", version: "0" },
  });
  console.log("INIT", JSON.stringify({ agentInfo: init.agentInfo, caps: init.agentCapabilities, auth: (init.authMethods || []).map((m) => m.id) }));
  try {
    const s = await conn.agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    await new Promise((r) => setTimeout(r, 1500));
    console.log("MODES", JSON.stringify(s.modes, null, 1));
    console.log("MODELS", JSON.stringify(s.models && { current: s.models.currentModelId, n: s.models.availableModels?.length }, null, 1));
    console.log("CONFIG", JSON.stringify(s.configOptions, null, 1));
    console.log("UPDATES", JSON.stringify(updates.map((u) => u.sessionUpdate)));
    const cmds = updates.find((u) => u.sessionUpdate === "available_commands_update");
    if (cmds) console.log("COMMANDS", cmds.availableCommands.map((c) => c.name).join(" "));
  } catch (e) {
    console.log("ERR", e.code, e.message);
  }
  proc.kill();
  process.exit(0);
})().catch((e) => { console.log("FATAL", e.message); process.exit(1); });
setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 240000).unref();
