const fs = require("fs");
const { Readable, Writable } = require("node:stream");
const v2 = require("@agentclientprotocol/sdk/experimental/v2");

const logFile = process.env.MOCK_V2_LOG;
const log = (method, params) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ method, params }) + "\n");
};
const stateFile = logFile && logFile + ".state.json";
const sessions = new Map(stateFile && fs.existsSync(stateFile)
  ? Object.entries(JSON.parse(fs.readFileSync(stateFile, "utf8"))) : []);
const save = () => {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(sessions), (k, v) => (k === "cancel" ? undefined : v)));
};
let n = sessions.size * 100;
const modeOption = (current) => ({
  configId: "mode", name: "Mode", type: "select", category: "mode", currentValue: current,
  options: [{ value: "ask", name: "Ask" }, { value: "code", name: "Code" }],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(client, sessionId, text, s) {
  const update = (u) => client.notify(v2.methods.client.session.update, { sessionId, update: u });
  const reply = async (t) => {
    const messageId = `a-${++n}`;
    await update({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: t } });
    s.history.push({ sessionUpdate: "agent_message", messageId, content: [{ type: "text", text: t }] });
  };
  await update({ sessionUpdate: "state_update", state: "running" });
  if (text === "tool") {
    const path = process.env.MOCK_V2_FILE || "/tmp/demo.txt";
    await update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", title: "Edit demo.txt",
      kind: "edit", status: "in_progress", locations: [{ path }] });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed",
      content: [{ type: "diff", changes: [{ operation: "modify", path }],
        patch: { format: "git_patch", text: "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n" } }] });
    await update({ sessionUpdate: "tool_call_content_chunk", toolCallId: "edit-1",
      content: { type: "content", content: { type: "text", text: "edited" } } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "run-1", title: "Run build",
      kind: "execute", status: "in_progress", content: [{ type: "terminal", terminalId: "term-1" }] });
    await update({ sessionUpdate: "terminal_update", terminalId: "term-1", command: "make", output: { data: "building\n" } });
    await update({ sessionUpdate: "terminal_output_chunk", terminalId: "term-1", data: "done\n" });
    await update({ sessionUpdate: "terminal_update", terminalId: "term-1", exitStatus: { exitCode: 0 } });
    await update({ sessionUpdate: "tool_call_update", toolCallId: "run-1", status: "completed", title: null });
    await update({ sessionUpdate: "_vendor_unknown", payload: 1 });
    await update({ sessionUpdate: "agent_message", messageId: "m-draft", content: [{ type: "text", text: "draft" }] });
    await update({ sessionUpdate: "agent_message", messageId: "m-draft", content: null });
    await reply("tool done");
  } else if (text === "permission") {
    await update({ sessionUpdate: "state_update", state: "requires_action" });
    const res = await client.request(v2.methods.client.session.requestPermission, {
      sessionId, title: "Run the test suite", description: "Runs npm test in the workspace.",
      subject: { type: "command", command: "npm test", cwd: process.cwd(), toolCallId: "perm-tool" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" }],
    });
    await update({ sessionUpdate: "state_update", state: "running" });
    await reply(`permission ${res.outcome.outcome === "selected" ? res.outcome.optionId : "cancelled"}`);
  } else if (text === "cancel") {
    await reply("working");
    await new Promise((resolve) => (s.cancel = resolve));
    await update({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
    return;
  } else if (text === "fail") {
    await update({ sessionUpdate: "state_update", state: "idle", stopReason: "error",
      error: { code: -32603, message: "session not found while running" } });
    return;
  } else {
    await reply(`v2 reply to ${text}`);
  }
  await update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  // A repeated idle snapshot is not a new completion.
  await update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
}

const agent = v2
  .agent({ name: "mock-v2" })
  .onRequest(v2.methods.agent.initialize, ({ params }) => {
    log("initialize", params);
    return {
      protocolVersion: 2,
      info: { name: "mock-v2", title: "Mock v2", version: "0.0.1" },
      capabilities: { session: { prompt: { embeddedContext: {} }, delete: {} } },
      authMethods: [{ type: "agent", methodId: "login", name: "Log in" }],
    };
  })
  .onRequest(v2.methods.agent.auth.login, ({ params }) => {
    log("auth/login", params);
  })
  .onRequest(v2.methods.agent.session.new, ({ params }) => {
    log("session/new", params);
    const sessionId = `s2-${++n}`;
    sessions.set(sessionId, { mode: "ask", history: [] });
    save();
    return { sessionId, configOptions: [modeOption("ask")] };
  })
  .onRequest(v2.methods.agent.session.list, () => ({
    sessions: [...sessions.keys()].map((sessionId) => ({ sessionId, cwd: process.cwd() })),
  }))
  .onRequest(v2.methods.agent.session.resume, async ({ params, client }) => {
    log("session/resume", params);
    const s = sessions.get(params.sessionId);
    if (!s) throw v2.RequestError.invalidParams(`Session ${params.sessionId} not found`);
    if (params.replayFrom?.type === "start") {
      for (const update of s.history) {
        await client.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update });
      }
    }
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId, update: { sessionUpdate: "state_update", state: "idle" },
    });
    return { configOptions: [modeOption(s.mode)] };
  })
  .onRequest(v2.methods.agent.session.setConfigOption, ({ params }) => {
    log("session/set_config_option", params);
    const s = sessions.get(params.sessionId);
    s.mode = params.value;
    save();
    return { configOptions: [modeOption(s.mode)] };
  })
  .onRequest(v2.methods.agent.session.close, ({ params }) => {
    log("session/close", params);
  })
  .onRequest(v2.methods.agent.session.delete, ({ params }) => {
    log("session/delete", params);
    sessions.delete(params.sessionId);
  })
  .onRequest(v2.methods.agent.session.prompt, async ({ params, client }) => {
    log("session/prompt", params);
    const s = sessions.get(params.sessionId);
    if (!s) throw v2.RequestError.invalidParams(`Session ${params.sessionId} not found`);
    const text = [...params.prompt].reverse().find((b) => b.type === "text")?.text ?? "";
    const messageId = `u-${++n}`;
    const userMessage = { sessionUpdate: "user_message", messageId, content: params.prompt };
    s.history.push(userMessage);
    save();
    if (text === "idle-before-ack") {
      await client.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update: userMessage });
      await runTurn(client, params.sessionId, text, s);
      return { messageId };
    }
    setTimeout(() => {
      client.notify(v2.methods.client.session.update, { sessionId: params.sessionId, update: userMessage })
        .then(() => sleep(20))
        .then(() => runTurn(client, params.sessionId, text, s))
        .catch((e) => console.error("mock-v2 turn failed", e));
    }, 0);
    return { messageId };
  })
  .onNotification(v2.methods.agent.session.cancel, ({ params }) => {
    log("session/cancel", params);
    sessions.get(params.sessionId)?.cancel?.();
  });

agent.connect(v2.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
