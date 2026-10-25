import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import { spawnSync } from "child_process";
import { RegistryAgent, RegistryService, platformKey } from "./registry";
import { IconService } from "./icons";
import { AgentDescriptor, CustomAgentConfig, InstalledAgentRecord } from "./types";

const INSTALLED_KEY = "shipwreck.installedAgents";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  description?: string;
}

export function commandExists(cmd: string): boolean {
  const tool = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(tool, [cmd], { shell: false, stdio: "ignore" });
  return r.status === 0;
}

/** npm package runner executable for the current platform. */
export function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function uvxCommand(): string {
  return process.platform === "win32" ? "uvx.exe" : "uvx";
}

export class Installer {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: RegistryService,
    private readonly icons?: IconService,
  ) {}

  /* ---------- installed records ---------- */

  installed(): InstalledAgentRecord[] {
    return this.context.globalState.get<InstalledAgentRecord[]>(INSTALLED_KEY, []);
  }

  record(id: string): InstalledAgentRecord | undefined {
    return this.installed().find((r) => r.id === id);
  }

  private async save(records: InstalledAgentRecord[]): Promise<void> {
    await this.context.globalState.update(INSTALLED_KEY, records);
    this.onDidChangeEmitter.fire();
  }

  /* ---------- descriptors ---------- */

  customAgents(): CustomAgentConfig[] {
    return vscode.workspace
      .getConfiguration("shipwreck")
      .get<CustomAgentConfig[]>("customAgents", []);
  }

  descriptors(): AgentDescriptor[] {
    const installed = this.installed();
    const out: AgentDescriptor[] = [];

    for (const custom of this.customAgents()) {
      const id = `custom:${custom.name}`;
      this.icons?.ensure(id, custom.icon);
      out.push({
        id,
        name: custom.name,
        description: custom.command,
        icon: custom.icon,
        ...this.icons?.get(id),
        source: "custom",
        installed: true,
        installKind: "custom",
      });
    }

    for (const agent of this.registry.agents()) {
      const rec = installed.find((r) => r.id === agent.id);
      this.icons?.ensure(agent.id, agent.icon);
      out.push({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        version: agent.version,
        icon: agent.icon,
        ...this.icons?.get(agent.id),
        source: "registry",
        installed: !!rec,
        installKind: this.registry.distFor(agent)?.kind,
        requires: this.registry.requires(agent),
      });
    }

    // Registry-installed agents that disappeared from the registry.
    for (const rec of installed) {
      if (!out.some((a) => a.id === rec.id)) {
        out.push({
          id: rec.id,
          name: rec.name,
          version: rec.version,
          source: "registry",
          installed: true,
          installKind: rec.kind,
        });
      }
    }
    return out;
  }

  /* ---------- install / uninstall ---------- */

  async install(
    agentOrId: RegistryAgent | string,
    progress?: vscode.Progress<{ message?: string }>,
  ): Promise<InstalledAgentRecord> {
    const agent =
      typeof agentOrId === "string" ? this.registry.agent(agentOrId) : agentOrId;
    if (!agent) throw new Error(`Unknown agent: ${String(agentOrId)}`);

    const dist = this.registry.distFor(agent);
    if (!dist) {
      throw new Error(
        `${agent.name} has no distribution for ${platformKey()} in the registry.`,
      );
    }

    let record: InstalledAgentRecord;
    if (dist.kind === "binary") {
      const dir = vscode.Uri.joinPath(
        this.context.globalStorageUri,
        "agents",
        `${agent.id}-${agent.version ?? "latest"}`,
      ).fsPath;
      progress?.report({ message: `Downloading ${agent.name}…` });
      await this.downloadAndExtract(agent, dist.dist, dir, progress);
      record = {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        kind: "binary",
        installDir: dir,
        command: "",
        args: [],
        installedAt: Date.now(),
      };
      const spec = await this.binaryLaunch(record, dist.dist);
      record.command = spec.command;
      record.args = spec.args;
      record.env = spec.env;
    } else if (dist.kind === "npx") {
      if (!commandExists("npx") && !commandExists("node")) {
        throw new Error(`${agent.name} is distributed via npm but Node.js/npm was not found on PATH.`);
      }
      record = {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        kind: "npx",
        command: npxCommand(),
        args: ["-y", dist.package, ...(dist.args ?? [])],
        env: dist.env,
        installedAt: Date.now(),
      };
    } else {
      if (!commandExists("uvx") && !commandExists("uv")) {
        throw new Error(`${agent.name} is distributed via uv but uv/uvx was not found on PATH.`);
      }
      record = {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        kind: "uvx",
        command: uvxCommand(),
        args: [dist.package, ...(dist.args ?? [])],
        env: dist.env,
        installedAt: Date.now(),
      };
    }

    await this.save([...this.installed().filter((r) => r.id !== agent.id), record]);
    return record;
  }

  async uninstall(id: string): Promise<void> {
    if (id.startsWith("custom:")) {
      const config = vscode.workspace.getConfiguration("shipwreck");
      const name = id.slice("custom:".length);
      const values = config.inspect<CustomAgentConfig[]>("customAgents");
      for (const [target, agents] of [
        [vscode.ConfigurationTarget.WorkspaceFolder, values?.workspaceFolderValue],
        [vscode.ConfigurationTarget.Workspace, values?.workspaceValue],
        [vscode.ConfigurationTarget.Global, values?.globalValue],
      ] as const) {
        if (!agents?.some((a) => a.name === name)) continue;
        await config.update("customAgents", agents.filter((a) => a.name !== name), target);
      }
      this.onDidChangeEmitter.fire();
      return;
    }
    const rec = this.record(id);
    if (rec?.installDir) {
      await fs.rm(rec.installDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await this.save(this.installed().filter((r) => r.id !== id));
  }

  /* ---------- launch resolution ---------- */

  /** Resolve a launch spec for an installed agent or `custom:` descriptor. */
  async launchSpec(agentId: string): Promise<LaunchSpec> {
    if (agentId.startsWith("custom:")) {
      const name = agentId.slice("custom:".length);
      const custom = this.customAgents().find((c) => c.name === name);
      if (!custom) throw new Error(`Custom agent "${name}" is not configured.`);
      return {
        command: custom.command,
        args: custom.args ?? [],
        env: custom.env,
        description: custom.name,
      };
    }

    const rec = this.record(agentId);
    if (!rec) throw new Error(`Agent "${agentId}" is not installed.`);

    if (rec.kind === "binary") {
      const agent = this.registry.agent(agentId);
      const dist = agent ? this.registry.distFor(agent) : undefined;
      if (dist?.kind === "binary") return this.binaryLaunch(rec, dist.dist);
      // Registry entry vanished: reuse the stored resolved command.
      return { command: rec.command, args: rec.args, env: rec.env, description: rec.name };
    }
    return { command: rec.command, args: rec.args, env: rec.env, description: rec.name };
  }

  private async binaryLaunch(
    rec: InstalledAgentRecord,
    dist: { cmd: string; args?: string[]; env?: Record<string, string> },
  ): Promise<LaunchSpec> {
    let cmdPath = path.resolve(rec.installDir!, dist.cmd);
    // Some archives wrap everything in a single top-level directory.
    if (!(await exists(cmdPath))) {
      const children = await fs.readdir(rec.installDir!, { withFileTypes: true });
      const dirs = children.filter((c) => c.isDirectory());
      if (dirs.length === 1) {
        const nested = path.resolve(rec.installDir!, dirs[0].name, dist.cmd);
        if (await exists(nested)) cmdPath = nested;
      }
    }
    return {
      command: cmdPath,
      args: dist.args ?? [],
      env: dist.env,
      description: rec.name,
    };
  }

  /* ---------- binary download + extract ---------- */

  private async downloadAndExtract(
    agent: RegistryAgent,
    dist: { archive: string; sha256?: string },
    destDir: string,
    progress?: vscode.Progress<{ message?: string }>,
  ): Promise<void> {
    const archivePath = path.join(destDir, path.basename(new URL(dist.archive).pathname));
    await fs.mkdir(destDir, { recursive: true });

    await download(dist.archive, archivePath);

    if (dist.sha256) {
      progress?.report({ message: "Verifying checksum…" });
      const hash = crypto.createHash("sha256");
      hash.update(await fs.readFile(archivePath));
      const digest = hash.digest("hex");
      if (digest.toLowerCase() !== dist.sha256.toLowerCase()) {
        await fs.rm(archivePath, { force: true });
        throw new Error(
          `Checksum mismatch for ${agent.name}: expected ${dist.sha256}, got ${digest}.`,
        );
      }
    }

    progress?.report({ message: "Extracting…" });
    await extractArchive(archivePath, destDir);
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }
}

/** Minimal download helper with redirect support (keeps the dep tree small). */
function download(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https:") ? https.get : http.get;
    const req = get(url, { headers: { "user-agent": "vscode-acp-client" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("Too many redirects"));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const file = require("fs").createWriteStream(dest) as import("fs").WriteStream;
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

/**
 * Extract a .zip / .tar.gz / .tgz archive. Uses the system tar (bsdtar on
 * Windows 10+, which also extracts zip) and falls back to PowerShell for zip.
 */
async function extractArchive(archive: string, destDir: string): Promise<void> {
  const isZip = archive.toLowerCase().endsWith(".zip");
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  const args = isZip
    ? ["-xf", archive, "-C", destDir]
    : ["-xzf", archive, "-C", destDir];
  const r = spawnSync(tar, args, { stdio: "pipe" });
  if (r.status === 0) return;

  if (isZip && process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
      ],
      { stdio: "pipe" },
    );
    if (ps.status === 0) return;
  }
  throw new Error(
    `Failed to extract ${archive}: ${r.stderr?.toString() || r.error?.message || "unknown error"}`,
  );
}
