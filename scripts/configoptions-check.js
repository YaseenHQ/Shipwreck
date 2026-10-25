// Plain-Node check of config-option conversion/update/classification
// (bundled via esbuild). Covers toConfigOptionInfos, SessionModel
// config_option_update full-set semantics, and getComposerConfig.
const path = require("path");
const os = require("os");
const assert = require("assert");
const esbuild = require("esbuild");

const sm = path.join(os.tmpdir(), `cfg-sm-${Date.now()}.cjs`);
const co = path.join(os.tmpdir(), `cfg-co-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "sessionModel.ts")],
  bundle: true, platform: "node", format: "cjs", outfile: sm,
});
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "webview", "configOptions.ts")],
  bundle: true, platform: "node", format: "cjs", outfile: co,
});
const { SessionModel, toConfigOptionInfos } = require(sm);
const { getComposerConfig } = require(co);

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok: ${name}`); };

const sel = (id, category, opts, currentValue, extra = {}) => ({
  id, name: id, category, type: "select", currentValue, options: opts, ...extra,
});
const bool = (id, category, currentValue, extra = {}) => ({
  id, name: id, category, type: "boolean", currentValue, ...extra,
});
const opt = (value, name) => ({ value, name });

const meta = (configOptions) => ({
  sessionId: "s1", agentId: "a1", cwd: "/x", configOptions, busy: false, createdAt: 0,
});
const cfgUpdate = (configOptions) => ({
  sessionId: "s1",
  update: { sessionUpdate: "config_option_update", configOptions },
});

// --- full-set update semantics ---
t("config_option_update replaces list: labels, choices, order, removals", () => {
  const m = new SessionModel();
  const mt = meta(toConfigOptionInfos([
    sel("model", "model", [opt("a", "A"), opt("b", "B")], "a"),
    sel("old", "model_config", [opt("x", "X")], "x"),
  ]));
  m.applyUpdate(cfgUpdate([
    { id: "thought", name: "Reasoning", category: "thought_level", type: "select",
      currentValue: "hi", options: [opt("lo", "Low"), opt("hi", "High")] },
    { id: "model", name: "Model renamed", category: "model", type: "select",
      currentValue: "b", options: [opt("b", "B"), opt("c", "C")] },
  ]), mt);
  assert.strictEqual(mt.configOptions.length, 2);
  assert.strictEqual(mt.configOptions[0].id, "thought"); // new order kept
  assert.strictEqual(mt.configOptions[1].name, "Model renamed"); // label updated
  assert.deepStrictEqual(mt.configOptions[1].options.map((o) => o.value), ["b", "c"]); // choices replaced
  assert.strictEqual(mt.configOptions[1].currentValue, "b");
});

t("config_option_update with empty list clears options", () => {
  const m = new SessionModel();
  const mt = meta(toConfigOptionInfos([bool("b1", null, true)]));
  m.applyUpdate(cfgUpdate([]), mt);
  assert.deepStrictEqual(mt.configOptions, []);
});

t("boolean currentValue stays typed boolean", () => {
  const m = new SessionModel();
  const mt = meta([]);
  m.applyUpdate(cfgUpdate([
    { id: "b", name: "B", type: "boolean", currentValue: true },
  ]), mt);
  assert.strictEqual(mt.configOptions[0].type, "boolean");
  assert.strictEqual(mt.configOptions[0].currentValue, true);
});

t("unknown runtime type omitted by list conversion", () => {
  const out = toConfigOptionInfos([
    { id: "u", name: "U", type: "mystery", currentValue: 1 },
    bool("b", null, false),
    sel("s", "model", [opt("a", "A")], "a"),
  ]);
  assert.deepStrictEqual(out.map((o) => o.id), ["b", "s"]);
});

t("same-label groups stay distinct via groupId", () => {
  const [o] = toConfigOptionInfos([
    { id: "m", name: "Model", category: "model", type: "select", currentValue: "x",
      options: [
        { group: "g1", name: "Popular", options: [opt("x", "X")] },
        { group: "g2", name: "Popular", options: [opt("y", "Y")] },
      ] },
  ]);
  assert.strictEqual(o.options.length, 2);
  assert.strictEqual(o.options[0].groupId, "g1");
  assert.strictEqual(o.options[1].groupId, "g2");
  assert.strictEqual(o.options[0].group, "Popular");
  assert.strictEqual(o.options[1].group, "Popular");
});

// --- composer classification ---
t("unknown category is never primaryModel", () => {
  const c = getComposerConfig([sel("weird", "_custom", [opt("a", "A")], "a")], false);
  assert.strictEqual(c.primaryModel, undefined);
  assert.strictEqual(c.primaryMode, undefined);
  assert.strictEqual(c.primaryPills.length, 0);
});

t("first duplicate category wins; duplicates retained in list", () => {
  const opts = [
    sel("m1", "model", [opt("a", "A")], "a"),
    sel("m2", "model", [opt("b", "B")], "b"),
  ];
  const c = getComposerConfig(opts, false);
  assert.strictEqual(c.primaryModel.id, "m1");
  assert.strictEqual(opts.length, 2); // nothing dropped
});

t("model_config select and boolean both retained", () => {
  const c = getComposerConfig([
    sel("m", "model", [opt("a", "A")], "a"),
    sel("temp", "model_config", [opt("1", "1")], "1"),
    bool("cache", "model_config", true),
  ], false);
  assert.deepStrictEqual(c.modelParameters.map((o) => o.id), ["temp", "cache"]);
});

t("config mode preferred over legacy modes", () => {
  const c = getComposerConfig([sel("mode", "mode", [opt("x", "X")], "x")], true);
  assert.strictEqual(c.primaryMode.id, "mode");
  assert.strictEqual(c.useLegacyModes, false);
});

t("empty config list permits legacy modes", () => {
  assert.strictEqual(getComposerConfig([], true).useLegacyModes, true);
  assert.strictEqual(getComposerConfig([], false).useLegacyModes, false);
});

t("primary pills follow original agent array order", () => {
  const c = getComposerConfig([
    sel("t", "thought_level", [opt("h", "High")], "h"),
    sel("m", "model", [opt("a", "A")], "a"),
    sel("mo", "mode", [opt("x", "X")], "x"),
  ], false);
  assert.deepStrictEqual(c.primaryPills.map((o) => o.id), ["t", "m", "mo"]);
});

t("agent update replacing reasoning options is reflected (follows model)", () => {
  const m = new SessionModel();
  const mt = meta(toConfigOptionInfos([
    sel("model", "model", [opt("a", "A")], "a"),
    sel("thought", "thought_level", [opt("l", "Low"), opt("h", "High")], "l"),
  ]));
  // Agent swaps in a new model + reasoning set (as one full update).
  m.applyUpdate(cfgUpdate([
    { id: "model", name: "Model", category: "model", type: "select",
      currentValue: "b", options: [opt("a", "A"), opt("b", "B")] },
    { id: "thought", name: "Reasoning", category: "thought_level", type: "select",
      currentValue: "max", options: [opt("m", "Med"), opt("max", "Max")] },
  ]), mt);
  const thought = mt.configOptions.find((o) => o.id === "thought");
  assert.deepStrictEqual(thought.options.map((o) => o.value), ["m", "max"]);
  assert.strictEqual(thought.currentValue, "max");
});

t("collaboration_mode with a plan choice becomes the plan toggle, not a trait", () => {
  const collab = sel("collaboration_mode", "collaboration_mode",
    [opt("default", "Default"), opt("plan", "Plan")], "plan");
  const c = getComposerConfig([
    sel("mode", "mode", [opt("agent", "Auto review")], "agent"),
    collab,
    sel("effort", "thought_level", [opt("low", "Low")], "low"),
  ], true);
  assert.deepStrictEqual(
    { id: c.planToggle?.option.id, planValue: c.planToggle?.planValue, offValue: c.planToggle?.offValue, on: c.planToggle?.on },
    { id: "collaboration_mode", planValue: "plan", offValue: "default", on: true },
  );
  assert.deepStrictEqual(c.traits.map((o) => o.id), []);
});

t("collaboration_mode without a plan choice stays a trait", () => {
  const c = getComposerConfig([
    sel("collaboration_mode", "collaboration_mode", [opt("a", "Pair"), opt("b", "Solo")], "a"),
  ], false);
  assert.strictEqual(c.planToggle, undefined);
  assert.deepStrictEqual(c.traits.map((o) => o.id), ["collaboration_mode"]);
});

console.log(`all ${n} configoptions checks passed`);
