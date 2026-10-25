import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { randomUUID } from "crypto";
import { spawnProcess, killProcessTree } from "./process";
import type { TerminalSnapshot } from "../types";

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024; // 1 MiB retained output cap
const INLINE_OUTPUT_LIMIT = 32 * 1024;
const SNAPSHOT_LIMIT = 50;
const OUTPUT_INTERVAL_MS = 150;

function utf8Tail(buffer: Buffer, limit: number): Buffer {
  let start = Math.max(0, buffer.length - limit);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}

export interface TerminalExit {
  exitCode?: number | null;
  signal?: string | null;
}

interface TerminalRecord {
  id: string;
  sessionId: string;
  child: ChildProcess;
  terminal: vscode.Terminal;
  pty: AgentPty;
  chunks: Buffer[];
  bytes: number;
  byteLimit: number;
  truncated: boolean;
  exit?: TerminalExit;
  exitWaiters: ((s: TerminalExit) => void)[];
  released: boolean;
  output: string;
  outputTruncated: boolean;
  outputTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Pseudoterminal that mirrors a spawned child process into a real VS Code
 * terminal so users can watch agent commands run, while output is captured
 * for `terminal/output`.
 */
class AgentPty implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  readonly onDidWrite = this.writeEmitter.event;
  readonly onDidClose = this.closeEmitter.event;
  private backlog: string[] = [];
  private opened = false;
  private onInput?: (data: string) => void;
  private onClose?: () => void;

  constructor(hooks: { onInput?: (data: string) => void; onClose?: () => void }) {
    this.onInput = hooks.onInput;
    this.onClose = hooks.onClose;
  }

  open(): void {
    this.opened = true;
    for (const chunk of this.backlog) this.writeEmitter.fire(chunk);
    this.backlog = [];
  }

  close(): void {
    this.onClose?.();
  }

  handleInput(data: string): void {
    this.onInput?.(data);
  }

  emit(data: string): void {
    // Terminals expect CRLF for newlines.
    const rendered = data.replace(/(?<!\r)\n/g, "\r\n");
    if (this.opened) this.writeEmitter.fire(rendered);
    else this.backlog.push(rendered);
  }

  closeTerminal(code: number | void): void {
    this.closeEmitter.fire(code);
  }
}

interface AgentTerminal {
  id: string;
  sessionId: string;
  output: string;
  truncated: boolean;
  exit?: TerminalExit;
  outputTimer?: ReturnType<typeof setTimeout>;
}

export class TerminalManager implements vscode.Disposable {
  private terminals = new Map<string, TerminalRecord>();
  private retained = new Map<string, TerminalSnapshot>();
  private agentTerminals = new Map<string, AgentTerminal>();
  private disposed = false;

  constructor(private readonly onOutput?: (snapshot: TerminalSnapshot, sessionId: string) => void) {}

  create(params: {
    sessionId: string;
    command: string;
    args?: string[];
    env?: { name: string; value: string }[];
    cwd?: string | null;
    outputByteLimit?: number | null;
  }): { terminalId: string } {
    const id = `acp-term-${randomUUID()}`;
    const env: Record<string, string> = {};
    for (const e of params.env ?? []) env[e.name] = e.value;

    let child: ChildProcess;
    const record: TerminalRecord = {
      id,
      sessionId: params.sessionId,
      child: undefined as unknown as ChildProcess,
      terminal: undefined as unknown as vscode.Terminal,
      pty: undefined as unknown as AgentPty,
      chunks: [],
      bytes: 0,
      byteLimit: Math.max(0, params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT),
      truncated: false,
      exitWaiters: [],
      released: false,
      output: "",
      outputTruncated: false,
    };

    const pty = new AgentPty({
      onInput: (data) => {
        try {
          child.stdin?.write(data);
        } catch {
          /* stdin closed */
        }
      },
      onClose: () => killProcessTree(child),
    });
    record.pty = pty;

    child = spawnProcess(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env,
    });
    record.child = child;

    const label = `${params.command} ${(params.args ?? []).join(" ")}`.trim();
    record.terminal = vscode.window.createTerminal({
      name: `Agent: ${label.length > 60 ? label.slice(0, 57) + "…" : label}`,
      pty,
      iconPath: new vscode.ThemeIcon("terminal"),
    });
    record.terminal.show(true);

    const display = (text: string) => {
      if (!text) return;
      if (!record.released) pty.emit(text);
      const buffer = Buffer.from(record.output + text, "utf8");
      record.outputTruncated ||= buffer.length > INLINE_OUTPUT_LIMIT;
      record.output = utf8Tail(buffer, INLINE_OUTPUT_LIMIT).toString("utf8");
      if (!record.outputTimer && !this.disposed) {
        record.outputTimer = setTimeout(() => this.publish(record), OUTPUT_INTERVAL_MS);
        record.outputTimer.unref?.();
      }
    };
    const capture = (buf: Buffer, decoder: StringDecoder) => {
      record.chunks.push(buf);
      record.bytes += buf.length;
      while (record.bytes > record.byteLimit && record.chunks.length > 1) {
        const drop = record.chunks.shift()!;
        record.bytes -= drop.length;
        record.truncated = true;
      }
      // If a single chunk exceeds the limit, truncate it at a char boundary.
      if (record.bytes > record.byteLimit && record.chunks.length === 1) {
        const kept = utf8Tail(record.chunks[0], record.byteLimit);
        record.chunks = [kept];
        record.bytes = kept.length;
        record.truncated = true;
      }
      display(decoder.write(buf));
    };

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (buf: Buffer) => capture(buf, stdoutDecoder));
    child.stderr?.on("data", (buf: Buffer) => capture(buf, stderrDecoder));
    child.on("error", (err) => {
      pty.emit(`\r\n[process error] ${err.message}`);
      this.settle(record, { exitCode: null, signal: null });
      this.publish(record);
    });
    child.on("close", (code, signal) => {
      display(stdoutDecoder.end());
      display(stderrDecoder.end());
      this.settle(record, { exitCode: code, signal });
      this.publish(record);
      pty.emit(`\r\n[process exited ${code ?? signal ?? "?"}]`);
      pty.closeTerminal(code ?? undefined);
    });

    this.terminals.set(id, record);
    this.publish(record);
    return { terminalId: id };
  }

  private snapshotOf(record: TerminalRecord): TerminalSnapshot {
    return {
      terminalId: record.id,
      output: record.output,
      truncated: record.outputTruncated,
      exitStatus: record.exit
        ? { exitCode: record.exit.exitCode ?? null, signal: record.exit.signal ?? null }
        : null,
      live: !record.released && !record.exit,
    };
  }

  snapshot(terminalId: string): TerminalSnapshot | undefined {
    const record = this.terminals.get(terminalId);
    if (record) return this.snapshotOf(record);
    const display = this.agentTerminals.get(terminalId);
    return display ? this.displaySnapshot(display) : this.retained.get(terminalId);
  }

  updateAgentTerminal(
    id: string,
    sessionId: string,
    patch: { output?: { data: string } | null; exitStatus?: TerminalExit | null },
  ): void {
    const record = this.display(id, sessionId);
    if (patch.output !== undefined) {
      record.output = "";
      record.truncated = false;
      this.appendTail(record, patch.output?.data ?? "");
    }
    if (patch.exitStatus !== undefined) record.exit = patch.exitStatus ?? undefined;
    this.publishDisplay(record);
  }

  appendAgentTerminal(id: string, sessionId: string, data: string): void {
    const record = this.display(id, sessionId);
    this.appendTail(record, data);
    if (!record.outputTimer && !this.disposed) {
      record.outputTimer = setTimeout(() => this.publishDisplay(record), OUTPUT_INTERVAL_MS);
      record.outputTimer.unref?.();
    }
  }

  private display(id: string, sessionId: string): AgentTerminal {
    let record = this.agentTerminals.get(id);
    if (!record) {
      record = { id, sessionId, output: "", truncated: false };
      this.agentTerminals.set(id, record);
      while (this.agentTerminals.size > SNAPSHOT_LIMIT) {
        const oldest = this.agentTerminals.values().next().value!;
        if (oldest.outputTimer) clearTimeout(oldest.outputTimer);
        this.agentTerminals.delete(oldest.id);
      }
    }
    return record;
  }

  private appendTail(record: AgentTerminal, data: string): void {
    const buffer = Buffer.from(record.output + data, "utf8");
    record.truncated ||= buffer.length > INLINE_OUTPUT_LIMIT;
    record.output = utf8Tail(buffer, INLINE_OUTPUT_LIMIT).toString("utf8");
  }

  private displaySnapshot(record: AgentTerminal): TerminalSnapshot {
    return {
      terminalId: record.id,
      output: record.output,
      truncated: record.truncated,
      exitStatus: record.exit
        ? { exitCode: record.exit.exitCode ?? null, signal: record.exit.signal ?? null }
        : null,
      live: !record.exit,
    };
  }

  private publishDisplay(record: AgentTerminal): void {
    if (record.outputTimer) clearTimeout(record.outputTimer);
    record.outputTimer = undefined;
    if (this.disposed) return;
    this.onOutput?.(this.displaySnapshot(record), record.sessionId);
  }

  private publish(record: TerminalRecord): void {
    if (record.outputTimer) clearTimeout(record.outputTimer);
    record.outputTimer = undefined;
    if (this.disposed) return;
    const snapshot = this.snapshotOf(record);
    if (record.released) {
      this.retained.set(record.id, snapshot);
      while (this.retained.size > SNAPSHOT_LIMIT) {
        this.retained.delete(this.retained.keys().next().value!);
      }
    }
    this.onOutput?.(snapshot, record.sessionId);
  }

  private settle(record: TerminalRecord, status: TerminalExit): void {
    if (record.exit) return;
    record.exit = status;
    for (const w of record.exitWaiters.splice(0)) w(status);
  }

  private get(id: string): TerminalRecord {
    const t = this.terminals.get(id);
    if (!t || t.released) throw new Error(`Terminal ${id} not found or released`);
    return t;
  }

  output(terminalId: string): { output: string; truncated: boolean; exitStatus?: TerminalExit | null } {
    const t = this.get(terminalId);
    const output = utf8Tail(Buffer.concat(t.chunks), t.byteLimit).toString("utf8");
    return { output, truncated: t.truncated, exitStatus: t.exit ?? null };
  }

  async waitForExit(terminalId: string): Promise<TerminalExit> {
    const t = this.get(terminalId);
    if (t.exit) return t.exit;
    return new Promise((resolve) => t.exitWaiters.push(resolve));
  }

  kill(terminalId: string): void {
    const t = this.get(terminalId);
    killProcessTree(t.child);
  }

  release(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t || t.released) return;
    t.released = true;
    if (!t.exit) killProcessTree(t.child);
    t.terminal.dispose();
    this.publish(t);
    t.chunks = [];
    this.terminals.delete(terminalId);
  }

  /** Show the VS Code terminal backing a tool-call terminal reference. */
  reveal(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    t?.terminal.show(true);
  }

  /** True when a terminal id is still live (for tool-call embedding). */
  has(terminalId: string): boolean {
    const t = this.terminals.get(terminalId);
    return !!t && !t.released;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of [...this.terminals.values()]) {
      if (t.outputTimer) clearTimeout(t.outputTimer);
      if (!t.exit) killProcessTree(t.child);
      t.terminal.dispose();
    }
    this.terminals.clear();
    this.retained.clear();
    for (const d of this.agentTerminals.values()) if (d.outputTimer) clearTimeout(d.outputTimer);
    this.agentTerminals.clear();
  }
}
