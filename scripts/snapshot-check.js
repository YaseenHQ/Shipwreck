/* Real-git check of Snapshotter: repository mode never touches the user's
   index, refs or object store; non-repository folders use a private store;
   diff reports created, modified and deleted files; read returns exact bytes. */
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const cp = require("child_process");
const esbuild = require("esbuild");

const out = path.join(os.tmpdir(), `snap-${Date.now()}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "snapshots.ts")],
  bundle: true, platform: "node", format: "cjs", outfile: out,
});
const { Snapshotter } = require(out);

let passed = 0;
let failures = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok: ${name}`); }
  else { failures++; console.log(`FAIL: ${name}`); }
};
const git = (cwd, ...args) => cp.execFileSync("git", args, { cwd, encoding: "utf8" });
const sha = (f) => crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex");
const countFiles = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  }
  return n;
};
const byRel = (changes) => Object.fromEntries(changes.map((c) => [c.rel, c.status]));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snap-check-"));
const store = path.join(tmp, "store");
const snaps = new Snapshotter(store, async () => "git");

(async () => {
  {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "core.autocrlf", "false");
    const crlf = Buffer.from("one\r\ntwo\r\n");
    fs.writeFileSync(path.join(repo, "a.txt"), crlf);
    fs.writeFileSync(path.join(repo, "b.txt"), "bee\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "init");
    fs.writeFileSync(path.join(repo, "staged.txt"), "staged by the user\n");
    git(repo, "add", "staged.txt");

    const indexBefore = sha(path.join(repo, ".git", "index"));
    const headBefore = git(repo, "rev-parse", "HEAD");
    const objectsBefore = countFiles(path.join(repo, ".git", "objects"));
    const statusBefore = git(repo, "status", "--porcelain");

    const before = await snaps.take(repo);
    ok(!!before, "repo: start snapshot taken");

    fs.writeFileSync(path.join(repo, "a.txt"), "changed\r\n");
    fs.rmSync(path.join(repo, "b.txt"));
    fs.writeFileSync(path.join(repo, "ü new file.txt"), "new\n");
    const bin = crypto.randomBytes(2048);
    fs.writeFileSync(path.join(repo, "blob.bin"), bin);
    fs.mkdirSync(path.join(repo, "ignored"));
    fs.writeFileSync(path.join(repo, "ignored", "x.txt"), "ignored\n");

    const after = await snaps.take(repo);
    const changes = await snaps.diff(before, after);
    ok(JSON.stringify(byRel(changes)) === JSON.stringify({ "a.txt": "M", "b.txt": "D", "blob.bin": "A", "ü new file.txt": "A" }),
      `repo: diff lists modified, deleted and created files only (${JSON.stringify(byRel(changes))})`);
    ok(changes.every((c) => path.isAbsolute(c.path) && c.path.startsWith(fs.realpathSync(repo).slice(0, 2))),
      "repo: change paths are absolute");
    const a0 = await snaps.read(before, "a.txt");
    ok(a0 && a0.equals(crlf), "repo: start bytes of a.txt kept exactly, CRLF included");
    ok((await snaps.read(before, "ü new file.txt")) === null, "repo: created file has no start content");
    const b0 = await snaps.read(before, "b.txt");
    ok(b0 && b0.toString() === "bee\n", "repo: deleted file readable from the start snapshot");
    const blob = await snaps.read(after, "blob.bin");
    ok(blob && blob.equals(bin), "repo: binary file read back byte for byte");
    const st = await snaps.read(before, "staged.txt");
    ok(st && st.toString() === "staged by the user\n", "repo: user's staged-only file is in the snapshot");

    ok(sha(path.join(repo, ".git", "index")) === indexBefore, "repo: user's index untouched");
    ok(git(repo, "rev-parse", "HEAD") === headBefore, "repo: HEAD untouched");
    ok(git(repo, "for-each-ref").trim().split("\n").length === 1, "repo: no refs added");
    ok(countFiles(path.join(repo, ".git", "objects")) === objectsBefore, "repo: no objects written to the repository");
    ok(git(repo, "status", "--porcelain").includes("A  staged.txt") && statusBefore.includes("A  staged.txt"),
      "repo: staged change still staged");

    const again = await snaps.take(repo);
    ok(again.tree === after.tree, "repo: unchanged folder gives the same tree");
    ok((await snaps.diff(after, again)).length === 0, "repo: no changes between identical snapshots");
  }

  {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(path.join(plain, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(plain, "main.py"), "print(1)\n");
    fs.writeFileSync(path.join(plain, "node_modules", "dep", "i.js"), "x\n");
    const before = await snaps.take(plain);
    ok(!!before, "plain folder: snapshot taken without a repository");
    ok(!fs.existsSync(path.join(plain, ".git")), "plain folder: no .git created in the user's folder");
    fs.writeFileSync(path.join(plain, "main.py"), "print(2)\n");
    fs.writeFileSync(path.join(plain, "node_modules", "dep", "i.js"), "y\n");
    fs.writeFileSync(path.join(plain, "new.py"), "pass\n");
    const after = await snaps.take(plain);
    const changes = await snaps.diff(before, after);
    ok(JSON.stringify(byRel(changes)) === JSON.stringify({ "main.py": "M", "new.py": "A" }),
      `plain folder: dependency folders excluded (${JSON.stringify(byRel(changes))})`);
    const m0 = await snaps.read(before, "main.py");
    ok(m0 && m0.toString() === "print(1)\n", "plain folder: start content readable");
  }

  {
    const repo = path.join(tmp, "autocrlf");
    fs.mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "config", "core.autocrlf", "true");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "w.txt"), "a\r\nb\r\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "init");
    fs.writeFileSync(path.join(repo, "u.txt"), "x\r\ny\r\n");
    const snap = await snaps.take(repo);
    const w = await snaps.read(snap, "w.txt");
    const u = await snaps.read(snap, "u.txt");
    ok(w && w.equals(Buffer.from("a\r\nb\r\n")), "autocrlf repo: tracked file restores with CRLF");
    ok(u && u.equals(Buffer.from("x\r\ny\r\n")), "autocrlf repo: untracked file restores with CRLF");
  }

  {
    const missing = await snaps.take(path.join(tmp, "does-not-exist"));
    ok(missing === undefined, "missing folder: no snapshot, no error");
    const noGit = new Snapshotter(path.join(tmp, "store2"), async () => undefined);
    ok((await noGit.take(path.join(tmp, "plain"))) === undefined, "git unavailable: no snapshot, no error");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) {
    console.log(`${failures} snapshot checks failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`all ${passed} snapshot checks passed`);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
