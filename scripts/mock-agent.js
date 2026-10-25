/* Mock ACP agent for e2e checks: echoes block counts, logs prompts, replays
   stored sessions. Usage: node scripts/mock-agent.js --name EchoA */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Readable, Writable } = require("node:stream");
const acp = require("@agentclientprotocol/sdk");

const name = process.argv[process.argv.indexOf("--name") + 1] || "Mock";
const withConfig = process.argv.includes("--config-options");
const smokeTools = process.argv.includes("--smoke-tools");
const configOptions = () => [
  { id: "model", name: "Model", type: "select", category: "model", currentValue: "gpt-5.4",
    options: [
      { value: "gpt-5.4", name: "GPT-5.4" },
      { value: "gpt-5.3-codex", name: "GPT-5.3-Codex" },
      { value: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ] },
  { id: "effort", name: "Reasoning effort", type: "select", category: "thought_level", currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Extra high" },
    ] },
];
const dir = process.env.SHIPWRECK_MOCK_DIR || path.join(os.tmpdir(), "acp-mock");
const storeFile = path.join(dir, `${name}.json`);
const logFile = path.join(dir, `${name}.log`);
fs.mkdirSync(dir, { recursive: true });

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(storeFile, "utf8"));
  } catch {
    return { sessions: {} };
  }
};
const save = (s) => fs.writeFileSync(storeFile, JSON.stringify(s, null, 1));
const db = load();
const sessions = new Map(Object.entries(db.sessions));

const persist = () => save({ sessions: Object.fromEntries(sessions) });

const log = (sessionId, block) =>
  fs.appendFileSync(
    logFile,
    JSON.stringify({
      sessionId,
      type: block.type,
      text: block.text?.slice(0, 200) ?? undefined,
      uri: block.uri ?? undefined,
      name: block.name ?? undefined,
    }) + "\n",
  );

const newId = () =>
  "s-" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

const touch = (id, patch) => {
  const s = sessions.get(id);
  if (s) {
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    persist();
  }
};

const agent = acp
  .agent({ name: name.toLowerCase() })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      promptCapabilities: { embeddedContext: true },
    },
    agentInfo: { name, title: name, version: "0.0.1" },
  }))
  .onRequest("session/new", (ctx) => {
    if (process.env.SHIPWRECK_MOCK_FAIL_NEW && fs.existsSync(process.env.SHIPWRECK_MOCK_FAIL_NEW)) {
      throw new Error("Synthetic session/new failure");
    }
    const sessionId = newId();
    fs.appendFileSync(logFile, `${JSON.stringify({ method: "session/new", sessionId })}\n`);
    sessions.set(sessionId, {
      id: sessionId,
      title: null,
      cwd: ctx.params.cwd,
      updatedAt: new Date().toISOString(),
      messages: [],
      ...(withConfig ? { configOptions: configOptions() } : {}),
    });
    persist();
    return { sessionId, ...(withConfig ? { configOptions: sessions.get(sessionId).configOptions } : {}) };
  })
  .onRequest("session/list", () => ({
    sessions: [...sessions.values()].map((s) => ({
      sessionId: s.id,
      title: s.title,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
    })),
  }))
  .onRequest("session/load", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    if (!s) return {};
    for (const m of s.messages) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: s.id,
        update: {
          sessionUpdate:
            m.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          content: { type: "text", text: m.text },
        },
      });
    }
    return s.configOptions ? { configOptions: s.configOptions } : {};
  })
  .onRequest("session/resume", (ctx) => {
    fs.appendFileSync(logFile, `${JSON.stringify({ method: "session/resume", sessionId: ctx.params.sessionId })}\n`);
    const s = sessions.get(ctx.params.sessionId);
    return s?.configOptions ? { configOptions: s.configOptions } : {};
  })
  .onRequest("session/set_config_option", (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    const option = s?.configOptions?.find((o) => o.id === ctx.params.configId);
    if (!option?.options.some((o) => o.value === ctx.params.value)) {
      throw new Error("Unknown config choice");
    }
    option.currentValue = ctx.params.value;
    persist();
    return { configOptions: s.configOptions };
  })
  .onRequest("session/delete", (ctx) => {
    sessions.delete(ctx.params.sessionId);
    persist();
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    const s = sessions.get(ctx.params.sessionId);
    const blocks = ctx.params.prompt ?? [];
    for (const b of blocks) log(ctx.params.sessionId, b);
    const parts = blocks.map((b) => {
      if (b.type === "text") return `text(${b.text.length})`;
      if (b.type === "resource_link") return `resource_link(${b.name ?? b.uri})`;
      return b.type;
    });
    const lastText = [...blocks].reverse().find((b) => b.type === "text");
    // Prompts containing "slow" delay the reply so status-bar/busy states show.
    if (lastText && lastText.text.includes("slow")) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    let reply = `${name} received ${blocks.length} blocks: ${parts.join(", ")}` +
      (lastText ? ` — text("${lastText.text.slice(0, 60)}")` : "");
    if (smokeTools && lastText?.text === "Create hello.txt containing hi") {
      const filePath = path.join(s.cwd, "hello.txt");
      const toolCall = { toolCallId: "write-hello", title: "Write hello.txt", kind: "edit",
        status: "pending", locations: [{ path: filePath }] };
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: s.id, update: { sessionUpdate: "tool_call", ...toolCall },
      });
      const permission = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: s.id, toolCall,
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" }],
      });
      if (permission.outcome.outcome !== "selected" || permission.outcome.optionId !== "allow") {
        throw new Error("Smoke write permission was not approved");
      }
      await ctx.client.request(acp.methods.client.fs.writeTextFile, {
        sessionId: s.id, path: filePath, content: "hi",
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: s.id, update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId,
          status: "completed", content: [{ type: "diff", path: filePath, oldText: null, newText: "hi" }] },
      });
      reply = `${name} created hello.txt containing hi`;
    } else if (smokeTools && lastText?.text === "Recall the first request") {
      reply = blocks.some((b) => b.type === "text" && b.text.includes("Create hello.txt containing hi"))
        ? `${name} remembers hello.txt containing hi`
        : `${name} did not receive the earlier request`;
    }

    if (s) {
      // First prompt seeds the session title via session_info_update.
      if (!s.title && lastText) {
        s.title = lastText.text.slice(0, 40);
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: s.id,
          update: { sessionUpdate: "session_info_update", title: s.title },
        });
      }
      s.messages.push(
        { role: "user", text: lastText?.text ?? "" },
        { role: "agent", text: reply },
      );
      touch(s.id, {});
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .onRequest("authenticate", () => ({}));

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
agent.connect(acp.ndJsonStream(input, output));
