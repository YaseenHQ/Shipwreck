import * as cp from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

/** Untracked files larger than this are left out of snapshots. */
const MAX_UNTRACKED_FILE = 5 * 1024 * 1024;
/** More new files than this in one folder is build output or dependencies, not edits. */
const MAX_UNTRACKED_FILES = 10_000;
/** A store over this size starts again from empty. */
const MAX_STORE_BYTES = 1024 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** Never worth snapshotting in a folder that is not a Git repository. */
const SHADOW_EXCLUDES = [
  ".git/", "node_modules/", ".venv/", "venv/", "__pycache__/", ".tox/", "target/", "dist/", "build/",
  "out/", ".next/", ".nuxt/", ".gradle/", ".idea/", ".vs/", "bin/", "obj/", "*.log", ".DS_Store",
];

/**
 * Where snapshots of one folder live. Inside a Git repository the user's
 * config, attributes and ignore rules apply, but the index and new objects
 * are the extension's own, so the repository's index, refs and history are
 * never touched. Outside one, a private repository tracks the folder.
 */
export interface GitStore {
  gitDir: string;
  workTree: string;
  indexFile: string;
  objectDir: string;
  alternates: string[];
}

export interface Snapshot {
  store: GitStore;
  tree: string;
}

export interface SnapshotChange {
  /** Absolute path in the work tree. */
  path: string;
  rel: string;
  status: "A" | "M" | "D" | "T";
  add: number;
  del: number;
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const keyOf = (p: string) => {
  const n = path.normalize(p);
  return caseInsensitive ? n.toLowerCase() : n;
};

export class GitError extends Error {}

export class Snapshotter {
  private readonly stores = new Map<string, Promise<GitStore | undefined>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly baseDir: string,
    private readonly gitPath: () => Promise<string | undefined>,
  ) {}

  private async git(
    store: Pick<GitStore, "gitDir" | "workTree"> & Partial<GitStore>,
    args: string[],
    input?: Buffer,
  ): Promise<Buffer> {
    const bin = await this.gitPath();
    if (!bin) throw new GitError("Git is not available");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: store.gitDir,
      GIT_WORK_TREE: store.workTree,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const k of ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete env[k];
    if (store.indexFile) env.GIT_INDEX_FILE = store.indexFile;
    if (store.objectDir) env.GIT_OBJECT_DIRECTORY = store.objectDir;
    if (store.alternates?.length) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = store.alternates.join(path.delimiter);
    const full = ["-c", "core.quotepath=false", "-c", "gc.auto=0", "-c", "core.fsmonitor=false", "-c", "core.safecrlf=false", ...args];
    return run(bin, full, store.workTree, env, input);
  }

  /** Runs store operations one at a time: they share one index file. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  /** The store for a folder, created on first use; undefined when Git is missing. */
  store(root: string): Promise<GitStore | undefined> {
    const k = keyOf(root);
    let s = this.stores.get(k);
    if (!s) {
      s = this.openStore(root).catch((err) => {
        console.warn("[acp] change snapshots unavailable for", root, err instanceof Error ? err.message : err);
        this.stores.delete(k);
        return undefined;
      });
      this.stores.set(k, s);
    }
    return s;
  }

  private async openStore(root: string): Promise<GitStore> {
    const bin = await this.gitPath();
    if (!bin) throw new GitError("Git is not available");
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[k];
    let repo: { top: string; gitDir: string; objects: string; index: string } | undefined;
    try {
      const out = (
        await run(bin, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-path", "objects", "--git-path", "index"], root, env)
      )
        .toString("utf8")
        .split(/\r?\n/);
      const [top, gitDir, objects, index] = out;
      if (top && gitDir && objects && index) {
        repo = {
          top: path.normalize(top),
          gitDir: path.normalize(gitDir),
          objects: path.resolve(root, objects),
          index: path.resolve(root, index),
        };
      }
    } catch {
      /* not inside a repository */
    }
    const workTree = repo?.top ?? path.normalize(root);
    const dir = path.join(this.baseDir, crypto.createHash("sha1").update(keyOf(workTree)).digest("hex").slice(0, 16));
    await fsp.mkdir(dir, { recursive: true });
    let store: GitStore;
    if (repo) {
      const objectDir = path.join(dir, "objects");
      const alternates = [repo.objects, ...(await readAlternates(repo.objects))];
      store = { gitDir: repo.gitDir, workTree, indexFile: path.join(dir, "index"), objectDir, alternates };
      if (await this.oversized(store)) await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(path.join(objectDir, "info"), { recursive: true });
      await fsp.mkdir(path.join(objectDir, "pack"), { recursive: true });
      // The repository's own index carries file stat data, so the first
      // snapshot only hashes files that differ from it.
      if (!fs.existsSync(store.indexFile)) await fsp.copyFile(repo.index, store.indexFile).catch(() => undefined);
    } else {
      const gitDir = path.join(dir, "git");
      store = { gitDir, workTree, indexFile: path.join(gitDir, "index"), objectDir: path.join(gitDir, "objects"), alternates: [] };
      if (fs.existsSync(gitDir) && (await this.oversized(store))) await fsp.rm(gitDir, { recursive: true, force: true });
      if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
        await run(bin, ["init", "--quiet", "--bare", gitDir], dir, env);
        const cfg = (k: string, v: string) => run(bin, ["--git-dir", gitDir, "config", k, v], dir, env);
        await cfg("core.bare", "false");
        await cfg("core.autocrlf", "false");
        await cfg("core.safecrlf", "false");
        await fsp.mkdir(path.join(gitDir, "info"), { recursive: true });
        await fsp.writeFile(path.join(gitDir, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`);
      }
    }
    return store;
  }

  private async oversized(store: GitStore): Promise<boolean> {
    try {
      const out = (await this.git({ ...store, alternates: [] }, ["count-objects", "-v"])).toString("utf8");
      const kb = (name: string) => Number(new RegExp(`^${name}: (\\d+)`, "m").exec(out)?.[1] ?? 0);
      return (kb("size") + kb("size-pack")) * 1024 > MAX_STORE_BYTES;
    } catch {
      return false;
    }
  }

  /** Records the folder's current files; undefined when it cannot be snapshotted. */
  async take(root: string): Promise<Snapshot | undefined> {
    if (!(await fsp.stat(root).then((s) => s.isDirectory(), () => false))) return undefined;
    const store = await this.store(root);
    if (!store) return undefined;
    return this.serial(keyOf(store.workTree), async () => {
      try {
        const untracked = await this.untracked(store);
        await this.git(store, ["add", "--update", "--ignore-errors", "--", "."]).catch((e) => {
          // --ignore-errors still exits 1 after adding what it could.
          if (!(e instanceof GitError) || !/error: |warning: /.test(e.message)) throw e;
        });
        if (untracked.length) {
          await this.git(
            store,
            ["add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
            Buffer.from(`${untracked.join("\0")}\0`, "utf8"),
          ).catch((e) => {
            if (!(e instanceof GitError) || !/error: |warning: /.test(e.message)) throw e;
          });
        }
        const tree = (await this.git(store, ["write-tree"])).toString("utf8").trim();
        return /^[0-9a-f]{40,64}$/.test(tree) ? { store, tree } : undefined;
      } catch (err) {
        console.warn("[acp] change snapshot failed for", store.workTree, err instanceof Error ? err.message : err);
        return undefined;
      }
    });
  }

  private async untracked(store: GitStore): Promise<string[]> {
    const out = (await this.git(store, ["ls-files", "--others", "--exclude-standard", "-z"])).toString("utf8");
    const files = out.split("\0").filter(Boolean);
    if (files.length > MAX_UNTRACKED_FILES) {
      console.warn(`[acp] change snapshot: ${files.length} new files in ${store.workTree}, not recording new files`);
      return [];
    }
    const keep: string[] = [];
    for (let i = 0; i < files.length; i += 64) {
      const batch = files.slice(i, i + 64);
      const sizes = await Promise.all(
        batch.map((f) => fsp.stat(path.join(store.workTree, f)).then((s) => s.size, () => Infinity)),
      );
      batch.forEach((f, j) => {
        if (sizes[j] <= MAX_UNTRACKED_FILE) keep.push(f);
      });
    }
    return keep;
  }

  /** Files that differ between two snapshots of the same folder. */
  async diff(a: Snapshot, b: Snapshot): Promise<SnapshotChange[]> {
    if (a.tree === b.tree) return [];
    const store = b.store;
    const [num, names] = await Promise.all([
      this.git(store, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", a.tree, b.tree]),
      this.git(store, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", a.tree, b.tree]),
    ]);
    const stats = new Map<string, { add: number; del: number }>();
    for (const rec of num.toString("utf8").split("\0").filter(Boolean)) {
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec);
      if (m) stats.set(m[3], { add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const parts = names.toString("utf8").split("\0");
    const out: SnapshotChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i].charAt(0) as SnapshotChange["status"];
      const rel = parts[i + 1];
      if (!rel || !"AMDT".includes(status)) continue;
      out.push({ path: path.join(store.workTree, rel), rel, status, ...(stats.get(rel) ?? { add: 0, del: 0 }) });
    }
    return out;
  }

  /** A file's bytes as of a snapshot, converted as a checkout would write them; null when absent. */
  async read(snap: Snapshot, rel: string): Promise<Buffer | null> {
    const spec = `${snap.tree}:${rel.replace(/\\/g, "/")}`;
    try {
      await this.git(snap.store, ["cat-file", "-e", spec]);
    } catch (e) {
      if (e instanceof GitError && /Git is not available/.test(e.message)) throw e;
      return null;
    }
    return this.git(snap.store, ["cat-file", "--filters", spec]);
  }
}

async function readAlternates(objects: string): Promise<string[]> {
  try {
    const text = await fsp.readFile(path.join(objects, "info", "alternates"), "utf8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => path.resolve(objects, l));
  } catch {
    return [];
  }
}

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(bin, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GitError(e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else {
        const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c" && args[i - 1] !== "--git-dir");
        reject(new GitError(`git ${sub} failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
