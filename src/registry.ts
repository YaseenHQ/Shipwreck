import * as vscode from "vscode";
import { AgentDescriptor, DistributionKind } from "./types";

export const DEFAULT_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

export interface RegistryBinaryDist {
  archive: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  sha256?: string;
}

export interface RegistryDistribution {
  npx?: { package: string; args?: string[]; env?: Record<string, string> };
  uvx?: { package: string; args?: string[]; env?: Record<string, string> };
  binary?: Record<string, RegistryBinaryDist>;
}

export interface RegistryAgent {
  id: string;
  name: string;
  version?: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution?: RegistryDistribution;
}

interface RegistryDocument {
  version: string;
  agents: RegistryAgent[];
}

/** Current platform key as used by the registry's binary distribution map. */
export function platformKey(): string {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
}

export class RegistryService {
  private doc: RegistryDocument | undefined;
  private readonly cacheFile: vscode.Uri;
  private readonly iconDir: vscode.Uri;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.cacheFile = vscode.Uri.joinPath(context.globalStorageUri, "registry-cache.json");
    this.iconDir = vscode.Uri.joinPath(context.globalStorageUri, "icons");
  }

  private get url(): string {
    return (
      vscode.workspace.getConfiguration("shipwreck").get<string>("registryUrl") ||
      DEFAULT_REGISTRY_URL
    );
  }

  /** Load from disk cache, then refresh from network in the background. */
  async init(): Promise<void> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.cacheFile);
      this.doc = JSON.parse(Buffer.from(raw).toString("utf8"));
      this.onDidChangeEmitter.fire();
    } catch {
      /* no cache yet */
    }
    void this.refresh().catch(() => undefined);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(this.url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Registry request failed: HTTP ${res.status}`);
      const doc = (await res.json()) as RegistryDocument;
      if (!doc || !Array.isArray(doc.agents)) throw new Error("Invalid registry document");
      this.doc = doc;
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      await vscode.workspace.fs.writeFile(this.cacheFile, Buffer.from(JSON.stringify(doc), "utf8"));
      this.onDidChangeEmitter.fire();
    } catch (err) {
      if (!this.doc) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      // Keep serving stale cache; surface a soft warning only.
      console.warn("[acp] registry refresh failed, using cache", err);
    }
  }

  agents(): RegistryAgent[] {
    return this.doc?.agents ?? [];
  }

  agent(id: string): RegistryAgent | undefined {
    return this.doc?.agents.find((a) => a.id === id);
  }

  /** Pick the best distribution descriptor for this platform. */
  distFor(agent: RegistryAgent):
    | { kind: "npx"; package: string; args?: string[]; env?: Record<string, string> }
    | { kind: "uvx"; package: string; args?: string[]; env?: Record<string, string> }
    | { kind: "binary"; dist: RegistryBinaryDist }
    | undefined {
    const d = agent.distribution;
    if (!d) return undefined;
    if (d.binary) {
      const bin = d.binary[platformKey()];
      if (bin) return { kind: "binary", dist: bin };
    }
    if (d.npx) return { kind: "npx", ...d.npx };
    if (d.uvx) return { kind: "uvx", ...d.uvx };
    return undefined;
  }

  requires(agent: RegistryAgent): "node" | "uv" | null {
    const d = this.distFor(agent);
    if (!d) return null;
    if (d.kind === "npx") return "node";
    if (d.kind === "uvx") return "uv";
    return null;
  }

  /** Download (once) the agent's SVG icon into the icon cache, for tree view use. */
  async iconPath(agent: RegistryAgent): Promise<string | undefined> {
    if (!agent.icon) return undefined;
    const file = vscode.Uri.joinPath(this.iconDir, `${agent.id}.svg`);
    try {
      await vscode.workspace.fs.stat(file);
      return file.fsPath;
    } catch {
      try {
        const res = await fetch(agent.icon);
        if (!res.ok) return undefined;
        const buf = Buffer.from(await res.arrayBuffer());
        await vscode.workspace.fs.createDirectory(this.iconDir);
        await vscode.workspace.fs.writeFile(file, buf);
        return file.fsPath;
      } catch {
        return undefined;
      }
    }
  }
}
