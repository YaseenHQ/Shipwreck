// Plain-Node check of ThreadStore (no vscode dependency):
// create → append → debounced save → reload index → rename/titleIsUser →
// pin/archive → delete.
const fs = require("fs");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-threads-"));
const out = path.join(dir, "store.cjs");
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "threads", "store.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: out,
});
const { ThreadStore } = require(out);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
};

const entry = (id, kind, text) => ({
  id,
  kind,
  ts: Date.now(),
  parts: [{ type: "text", text }],
});

(async () => {
  const store = new ThreadStore(dir);

  await store.load();
  assert(store.list().length === 0, "fresh dir loads empty index");

  // create + append entries (debounced write)
  store.put(
    {
      id: "t-1",
      title: "Fix the thing",
      workspace: "/repo",
      createdAt: 1,
      updatedAt: 2,
      agents: ["a1"],
      backing: [{ agentId: "a1", sessionId: "s1", coveredEntries: 0, lastUsedAt: 2 }],
    },
    [entry("e1", "user", "hello")],
  );
  assert(!fs.existsSync(path.join(dir, "index.json")), "index write is debounced");
  await sleep(700);
  assert(fs.existsSync(path.join(dir, "index.json")), "index written after debounce");
  assert(
    fs.existsSync(path.join(dir, "threads", "t-1.json")),
    "entries written after debounce",
  );

  // append more entries, flush immediately (turn end)
  const e2 = [entry("e1", "user", "hello"), entry("e2", "agent", "working on it")];
  store.setEntries("t-1", e2);
  await store.flush();

  // reload in a fresh store
  const store2 = new ThreadStore(dir);
  await store2.load();
  assert(store2.list().length === 1, "index reloads one thread");
  const reloaded = await store2.entriesOf("t-1");
  assert(reloaded.length === 2, "entries reload");

  // agent-provided title overwrites a default title
  store2.updateMeta("t-1", { title: "Agent title" });
  await store2.flush();
  let store3 = new ThreadStore(dir);
  await store3.load();
  assert(store3.get("t-1").title === "Agent title", "agent title applied");

  // user rename sets titleIsUser; agent title must not overwrite
  store3.updateMeta("t-1", { title: "My rename", titleIsUser: true });
  const meta = store3.get("t-1");
  assert(meta.titleIsUser, "titleIsUser set by rename");
  const wouldOverwrite = meta.titleIsUser ? meta.title : "Agent title 2";
  store3.updateMeta("t-1", { title: wouldOverwrite });
  await store3.flush();
  const store4 = new ThreadStore(dir);
  await store4.load();
  assert(store4.get("t-1").title === "My rename", "user rename survives agent title");

  // pin / archive
  store4.updateMeta("t-1", { pinned: true });
  assert(store4.get("t-1").pinned === true, "pin");
  store4.updateMeta("t-1", { pinned: false, archived: true });
  assert(store4.get("t-1").archived === true, "archive");
  await store4.flush();

  // atomicity: no leftover .tmp files
  const leftovers = fs
    .readdirSync(dir)
    .filter((f) => f.includes(".tmp"))
    .concat(
      fs.readdirSync(path.join(dir, "threads")).filter((f) => f.includes(".tmp")),
    );
  assert(leftovers.length === 0, "no temp files left behind");

  // delete removes meta + entries file
  await store4.delete("t-1");
  assert(store4.list().length === 0, "delete removes from index");
  assert(!fs.existsSync(path.join(dir, "threads", "t-1.json")), "delete removes file");

  // --- serialized flush: overlapping put/flush never corrupt the index ---
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "acp-threads-b-"));
  const sB = new ThreadStore(dirB);
  sB.put({ id: "b1", title: "one", createdAt: 1, updatedAt: 1, agents: [], backing: [] },
    [entry("e1", "user", "a")]);
  const f1 = sB.flush();
  sB.put({ id: "b2", title: "two", createdAt: 1, updatedAt: 1, agents: [], backing: [] },
    [entry("e2", "user", "b")]);
  const f2 = sB.flush();
  sB.updateMeta("b1", { title: "one-renamed" });
  const f3 = sB.flush();
  await Promise.all([f1, f2, f3]);
  const sB2 = new ThreadStore(dirB);
  await sB2.load();
  assert(sB2.list().length === 2, "concurrent flushes: both threads persisted");
  assert(sB2.get("b1").title === "one-renamed", "concurrent flushes: last write wins");
  assert((await sB2.entriesOf("b2")).length === 1, "concurrent flushes: entries persisted");

  // --- flush failure re-marks dirty and retries; scheduled flush rejects are handled ---
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "acp-threads-c-"));
  const sC = new ThreadStore(dirC);
  let unhandled = 0;
  process.on("unhandledRejection", () => unhandled++);
  fs.mkdirSync(path.join(dirC, "index.json")); // sabotage the index write
  sC.put({ id: "c1", title: "x", createdAt: 1, updatedAt: 1, agents: [], backing: [] },
    [entry("e1", "user", "x")]);
  let rejected = false;
  await sC.flush().then(() => "ok", () => { rejected = true; });
  assert(rejected, "sabotaged flush rejects");
  await sleep(700); // scheduled flush also fails — must not crash unhandled
  fs.rmdirSync(path.join(dirC, "index.json"));
  await sC.flush(); // dirty state was retained — retry succeeds
  const sC2 = new ThreadStore(dirC);
  await sC2.load();
  assert(sC2.list().length === 1, "failed flush: data retried and persisted");
  assert(unhandled === 0, `no unhandled flush rejections (${unhandled})`);

  // --- a mutation landing DURING a write stays dirty and is persisted ---
  const dirD = fs.mkdtempSync(path.join(os.tmpdir(), "acp-threads-d-"));
  const sD = new ThreadStore(dirD);
  sD.put({ id: "d1", title: "v1", createdAt: 1, updatedAt: 1, agents: [], backing: [] },
    [entry("e1", "user", "v1")]);
  // Hold the first rename (the index write) open, mutate mid-write, release.
  const fsp = require("fs").promises;
  const origRename = fsp.rename;
  let gate = null, held = 0;
  fsp.rename = (...a) => {
    held++;
    if (held === 1) return new Promise((r) => { gate = () => r(origRename(...a)); });
    return origRename(...a);
  };
  try {
    const first = sD.flush();
    await sleep(50); // first flush is now parked inside the index rename
    assert(held >= 1, "mid-write test: a write is in flight");
    sD.setEntries("d1", [entry("e1", "user", "v1"), entry("e2", "agent", "v2")]);
    sD.updateMeta("d1", { title: "v2" });
    gate();
    await first;
    await sD.flush(); // drain whatever was re-marked dirty mid-write
  } finally {
    fsp.rename = origRename;
  }
  const sD2 = new ThreadStore(dirD);
  await sD2.load();
  assert(sD2.get("d1").title === "v2", "mid-write meta update persisted");
  const dEntries = await sD2.entriesOf("d1");
  assert(dEntries.length === 2 && dEntries[1].parts[0].text === "v2",
    "mid-write entries update persisted");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
  fs.rmSync(dirC, { recursive: true, force: true });
  fs.rmSync(dirD, { recursive: true, force: true });
  console.log("all threadstore checks passed");
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
