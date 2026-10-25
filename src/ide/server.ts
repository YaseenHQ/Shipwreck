import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type * as acp from "@agentclientprotocol/sdk";
import { IDE_TOOLS, runTool } from "./tools";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const IDE_SERVER_NAME = "vscode";

type Rpc = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/**
 * MCP server giving agents editor context (diagnostics, open editors,
 * selection, language-server navigation). Agents launch a tiny stdio bridge
 * that connects back here over a local socket, so every agent that supports
 * stdio MCP servers can use it.
 */
export class IdeToolsServer implements vscode.Disposable {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly token = crypto.randomBytes(16).toString("hex");
  private readonly pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\acp-ide-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
      : path.join(os.tmpdir(), `acp-ide-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);

  constructor(
    private readonly bridgePath: string,
    private readonly version: string,
  ) {}

  /** The ACP stdio server entry; starts listening on first use. */
  mcpServer(): acp.McpServer {
    this.listen();
    return {
      name: IDE_SERVER_NAME,
      command: process.execPath,
      args: [this.bridgePath],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "ACP_IDE_PIPE", value: this.pipe },
        { name: "ACP_IDE_TOKEN", value: this.token },
      ],
    };
  }

  private listen(): void {
    if (this.server) return;
    const server = net.createServer((sock) => this.accept(sock));
    server.on("error", (e) => console.error("[acp] IDE tools server failed", e));
    server.listen(this.pipe, () => {
      if (process.platform !== "win32") fs.chmod(this.pipe, 0o600, () => undefined);
    });
    // Only live bridge sockets should keep the process alive.
    server.unref();
    this.server = server;
  }

  private accept(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.unref();
    sock.setEncoding("utf8");
    let authed = false;
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!authed) {
          if (line !== this.token) {
            sock.destroy();
            return;
          }
          authed = true;
          continue;
        }
        if (line.trim()) void this.handle(sock, line);
      }
    });
    sock.on("close", () => this.sockets.delete(sock));
    sock.on("error", () => sock.destroy());
  }

  private async handle(sock: net.Socket, line: string): Promise<void> {
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      this.send(sock, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    // Notifications (initialized, cancelled) need no reply.
    if (msg.id === undefined || msg.id === null) return;
    try {
      const result = await this.dispatch(msg.method ?? "", msg.params ?? {});
      this.send(sock, { jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      this.send(sock, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: err.code ?? -32603, message: err.message ?? String(e) },
      });
    }
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = String(params.protocolVersion ?? "");
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "acp-client-vscode-ide", version: this.version },
          instructions:
            "Live editor context from the user's VS Code window: diagnostics from language servers, " +
            "open editors and selection, and language-aware navigation (definitions, references, symbols).",
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: IDE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      case "tools/call": {
        const { text, isError } = await runTool(
          String(params.name ?? ""),
          (params.arguments as Record<string, unknown>) ?? {},
        );
        return { content: [{ type: "text", text }], isError };
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  private send(sock: net.Socket, msg: unknown): void {
    if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
  }

  dispose(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
  }
}
