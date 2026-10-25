// Plain-Node check of buildHandoff/buildTranscript (bundled via esbuild).
const path = require("path");
const os = require("os");
const esbuild = require("esbuild");

const out = path.join(os.tmpdir(), `handoff-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "threads", "handoff.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
});
const { buildHandoff, buildTranscript } = require(out);

const agentName = (id) => ({ a1: "Echo A", a2: "Echo B", a3: "Devin" }[id] ?? id);
const user = (text) => ({
  id: Math.random().toString(36),
  kind: "user",
  ts: 1,
  parts: [{ type: "text", text }],
});
const agent = (text, agentId = "a1") => ({
  id: Math.random().toString(36),
  kind: "agent",
  ts: 1,
  parts: [{ type: "text", text }],
  agentId,
});

let pass = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  pass++;
  console.log("ok:", msg);
};

// 1. first user message always kept, chronological order, omission count
const base = [
  user("FIRST: plan a cache"),
  agent("answer one"),
  user("middle question"),
  agent("answer two"),
  user("last request"),
];
const r = buildHandoff(base, {
  budgetBytes: 64_000,
  agentName,
  currentAgentId: "a2",
});
ok(r && r.text.includes("FIRST: plan a cache"), "first user message kept");
ok(
  r.text.indexOf("FIRST") < r.text.indexOf("answer one") &&
    r.text.indexOf("answer one") < r.text.indexOf("last request"),
  "chronological order",
);
ok(r.included === 5 && r.omitted === 0, "all items included under budget");
ok(r.agents.length === 1 && r.agents[0] === "a1", "agent list");

// 2. tiny budget → omission marker with correct count
const r2 = buildHandoff(base, {
  budgetBytes: 80,
  agentName,
  currentAgentId: "a2",
});
ok(r2.text.includes("omitted — the full transcript is attached"), "omission marker present");
ok(
  /… \d+ earlier items omitted/.test(r2.text) &&
    r2.text.includes(`${r2.omitted} earlier`),
  `marker count matches omitted (${r2.omitted})`,
);
ok(r2.included + r2.omitted === 5, "included + omitted = total items");

// 3. budget respected (output <= budget + header + marker overhead)
const big = [];
for (let i = 0; i < 50; i++) {
  big.push(user(`question ${i} ${"x".repeat(200)}`));
  big.push(agent(`answer ${i} ${"y".repeat(200)}`));
}
const r3 = buildHandoff(big, { budgetBytes: 2000, agentName, currentAgentId: "a2" });
const header = r3.text.indexOf("###");
ok(header > 0, "has context header");
ok(
  new TextEncoder().encode(r3.text.slice(header)).length < 2000 + 400,
  "body within budget (+marker slop)",
);
ok(r3.omitted > 0, "budget forced omissions");

// 4. single oversize item truncated
const huge = [user("start"), agent("z".repeat(10000))];
const r4 = buildHandoff(huge, { budgetBytes: 1000, agentName, currentAgentId: "a2" });
ok(r4.text.includes("[truncated — see transcript]"), "oversize item truncated");
ok(!r4.text.includes("z".repeat(2000)), "truncation actually cut content");

// 5. skipped kinds
const mixed = [
  user("hi"),
  { id: "1", kind: "thought", ts: 1, parts: [{ type: "text", text: "SECRET THOUGHT" }] },
  { id: "2", kind: "marker", ts: 1, text: "MARKER" },
  {
    id: "3",
    kind: "handoff",
    ts: 1,
    toAgentId: "a2",
    fromAgents: ["a1"],
    included: 1,
    omitted: 0,
    text: "PRIOR HANDOFF",
  },
  {
    id: "4",
    kind: "permission",
    ts: 1,
    requestKey: "k",
    toolCall: { toolCallId: "t", title: "PERM" },
    options: [],
    state: "pending",
  },
  agent("real answer"),
];
const r5 = buildHandoff(mixed, { budgetBytes: 64_000, agentName, currentAgentId: "a2" });
ok(!r5.text.includes("SECRET THOUGHT"), "thoughts skipped");
ok(!r5.text.includes("MARKER"), "markers skipped");
ok(!r5.text.includes("PRIOR HANDOFF"), "handoffs skipped");
ok(!r5.text.includes("PERM"), "permissions skipped");

// 6. tool/edit/plan formats
const tools = [
  user("do it"),
  {
    id: "t1",
    kind: "tool",
    ts: 1,
    agentId: "a1",
    tool: {
      toolCallId: "c1",
      kind: "edit",
      title: "Update file",
      status: "completed",
      locations: [{ path: "D:\\acp client\\src\\registry.ts" }],
      content: [
        { type: "diff", path: "x", oldText: "a\nb\nc", newText: "a\nB\nc" },
      ],
    },
  },
  {
    id: "p1",
    kind: "plan",
    ts: 1,
    agentId: "a1",
    entries: [
      { content: "step one", status: "completed" },
      { content: "step two", status: "pending" },
    ],
  },
];
const r6 = buildHandoff(tools, { budgetBytes: 64_000, agentName, currentAgentId: "a2" });
ok(/- edit Update file src\/registry\.ts \(\+1 −1\) → completed/.test(r6.text), "tool/edit line format");
ok(r6.text.includes("- [completed] step one"), "plan item format");
ok(r6.text.includes("- [pending] step two"), "plan pending item");

// 7. empty / ineligible → null
ok(
  buildHandoff([{ id: "1", kind: "marker", ts: 1, text: "x" }], {
    budgetBytes: 100,
    agentName,
    currentAgentId: "a2",
  }) === null,
  "no eligible items → null",
);

// 8. transcript has every eligible item, no budget
const tr = buildTranscript(base, agentName);
ok(tr.includes("FIRST") && tr.includes("last request"), "transcript complete");
ok(tr.includes("### Echo A"), "transcript agent headers");

console.log(`all ${pass} handoff checks passed`);
