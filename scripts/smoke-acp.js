// Smoke test: spawn `devin acp` (or argv[2]) and run an ACP handshake +
// session/new using the real SDK, the same way the extension does.
const { spawn } = require("child_process");
const { Readable, Writable } = require("stream");
const acp = require("@agentclientprotocol/sdk");

const cmd = process.argv[2] || "devin";
const args = process.argv[2] ? process.argv.slice(3) : ["acp"];

async function main() {
  const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
  proc.on("exit", (c, s) => console.log(`[exit ${c} ${s ?? ""}]`));

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout);
  const stream = acp.ndJsonStream(input, output);

  const conn = acp
    .client({ name: "smoke" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const u = ctx.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        process.stdout.write(u.content.text);
      } else if (u.sessionUpdate !== "agent_message_chunk") {
        console.log(`\n[update] ${u.sessionUpdate}`, JSON.stringify(u).slice(0, 200));
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      console.log(`\n[permission] ${ctx.params.toolCall?.title}`);
      const opt = ctx.params.options.find((o) => o.kind === "allow_once") ?? ctx.params.options[0];
      console.log(`  -> auto: ${opt?.name}`);
      return { outcome: { outcome: "selected", optionId: opt.optionId } };
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const fs = require("fs/promises");
      return { content: await fs.readFile(ctx.params.path, "utf8") };
    })
    .connect(stream);

  const init = await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      elicitation: { form: {}, url: {} },
      session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
      subagents: {},
      plan: {},
    },
    clientInfo: { name: "smoke", version: "0" },
  });
  console.log("INIT:", JSON.stringify(init, null, 1).slice(0, 1500));

  try {
    const sess = await conn.agent.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: process.env.SMOKE_MCP ? JSON.parse(process.env.SMOKE_MCP) : [],
    });
    console.log("SESSION:", sess.sessionId);
    const res = await conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: sess.sessionId,
      prompt: [{ type: "text", text: process.env.SMOKE_PROMPT || "Reply with exactly the word: pong" }],
    });
    console.log("\nSTOP:", res.stopReason);
  } catch (e) {
    console.log("\nERR:", e.code ?? "", e.message ?? e);
    if (e.code === -32000) console.log("(auth required — expected if not signed in)");
  }

  conn.close();
  proc.kill();
  process.exit(0);
}

const t = setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 90000);
t.unref?.();
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
