// Plain-Node check of SessionModel streaming/entry ordering (bundled via esbuild).
const path = require("path");
const os = require("os");
const esbuild = require("esbuild");

const out = path.join(os.tmpdir(), `sessionmodel-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "sessionModel.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
});
const { SessionModel } = require(out);

let failures = 0;
function ok(cond, name) {
  if (cond) console.log(`ok: ${name}`);
  else { failures++; console.log(`FAIL: ${name}`); }
}

const meta = () => ({ sessionId: "s1", agentId: "a1", cwd: "/x" });
const notify = (sessionUpdate, extra = {}) => ({
  sessionId: "s1",
  update: { sessionUpdate, ...extra },
});
const text = (t) => ({ type: "text", text: t });
const kinds = (m) => m.entries.map((e) => e.kind);
const texts = (m) =>
  m.entries.map((e) => (e.parts ?? []).map((p) => p.text).join(""));

// 1. Two turns without messageIds → u,a,u,a with separate agent entries.
{
  const m = new SessionModel();
  m.addLocalUserMessage([text("hi")]);
  m.applyUpdate(notify("agent_message_chunk", { content: text("r1") }), meta());
  m.endTurn();
  m.addLocalUserMessage([text("next")]);
  m.applyUpdate(notify("agent_message_chunk", { content: text("r2") }), meta());
  m.endTurn();
  ok(kinds(m).join(",") === "user,agent,user,agent", "two turns: u,a,u,a order");
  ok(texts(m)[1] === "r1" && texts(m)[3] === "r2", "turn replies stay separate");
}

// 2. Prompt-response race: agent chunk arrives before sendPrompt's finally.
{
  const m = new SessionModel();
  m.addLocalUserMessage([text("hi")]);
  m.applyUpdate(notify("agent_message_chunk", { content: text("r1") }), meta());
  // Second prompt sent before endTurn ran (response still in flight).
  m.addLocalUserMessage([text("next")]);
  m.applyUpdate(notify("agent_message_chunk", { content: text("r2") }), meta());
  ok(kinds(m).join(",") === "user,agent,user,agent", "pre-endTurn send: no merge");
}

// 3. Chunks with the same messageId merge; different ones split.
{
  const m = new SessionModel();
  m.addLocalUserMessage([text("hi")]);
  m.applyUpdate(notify("agent_message_chunk", { content: text("a"), messageId: "m1" }), meta());
  m.applyUpdate(notify("agent_message_chunk", { content: text("b"), messageId: "m1" }), meta());
  m.applyUpdate(notify("agent_message_chunk", { content: text("c"), messageId: "m2" }), meta());
  ok(m.entries.length === 3, "same messageId merges, new splits");
  ok(texts(m)[1] === "ab" && texts(m)[2] === "c", "messageId text grouping");
}

// 4. Replay sequence (session/load): interleaved user/agent chunks, no ids.
{
  const m = new SessionModel();
  for (const [kind, t] of [
    ["user_message_chunk", "q1"],
    ["agent_message_chunk", "r1"],
    ["user_message_chunk", "q2"],
    ["agent_message_chunk", "r2"],
  ]) {
    m.applyUpdate(notify(kind, { content: text(t) }), meta());
  }
  ok(kinds(m).join(",") === "user,agent,user,agent", "replay: u,a,u,a order");
  ok(texts(m).join("|") === "q1|r1|q2|r2", "replay: text grouping");
}

// 5. Thought then message → separate entries.
{
  const m = new SessionModel();
  m.applyUpdate(notify("agent_thought_chunk", { content: text("hmm") }), meta());
  m.applyUpdate(notify("agent_message_chunk", { content: text("answer") }), meta());
  ok(kinds(m).join(",") === "thought,agent", "thought then message: separate");
}

// 6. Tool call interrupts the agent stream.
{
  const m = new SessionModel();
  m.applyUpdate(notify("agent_message_chunk", { content: text("before") }), meta());
  m.applyUpdate(
    notify("tool_call", { toolCallId: "tc1", title: "Read", status: "pending" }),
    meta(),
  );
  m.applyUpdate(notify("agent_message_chunk", { content: text("after") }), meta());
  ok(kinds(m).join(",") === "agent,tool,agent", "tool call splits agent stream");
}

// 7. Replay with echo suppression: local user entry + suppressed echo.
{
  const m = new SessionModel();
  m.addLocalUserMessage([text("hi")]);
  m.applyUpdate(notify("user_message_chunk", { content: text("hi") }), meta());
  ok(m.entries.length === 1, "suppressed user echo");
  m.endTurn();
  m.applyUpdate(notify("user_message_chunk", { content: text("echo ok") }), meta());
  ok(m.entries.length === 2, "echo unsuppressed after turn end");
}

// 8. Closed entries are reported as changed so the webview clears spinners.
{
  const m = new SessionModel();
  m.applyUpdate(notify("agent_message_chunk", { content: text("a") }), meta());
  const { changed } = m.applyUpdate(
    notify("tool_call", { toolCallId: "tc9", title: "T", status: "pending" }),
    meta(),
  );
  ok(
    changed.some((e) => e.kind === "agent" && e.streaming === false),
    "closed agent entry reported",
  );
}

{
  const m = new SessionModel();
  m.applyUpdate(notify("compaction_summary_chunk", { compactionId: "c1", content: text("First ") }), meta());
  m.applyUpdate(notify("compaction_summary_chunk", { compactionId: "c1", content: text("second") }), meta());
  ok(m.entries.length === 1 && m.entries[0].summary === "First second" &&
    m.entries[0].text === "Compacting context…" && m.entries[0].state === "in_progress",
    "compaction chunks create a marker and append without changing its status label");
  m.applyUpdate(notify("compaction_update", { compactionId: "c1", status: "completed" }), meta());
  ok(m.entries.length === 1 && m.entries[0].summary === "First second" &&
    m.entries[0].text === "Context compacted" && m.entries[0].state === "completed",
    "compaction completion preserves the accumulated summary");
}

console.log(failures ? `${failures} sessionmodel checks FAILED` : "all sessionmodel checks passed");
process.exit(failures ? 1 : 0);
