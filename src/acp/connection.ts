import * as vscode from "vscode";
import { ChildProcess } from "child_process";
import { Readable, Writable } from "stream";
import * as acp from "@agentclientprotocol/sdk";
import { spawnProcess, killProcessTree } from "./process";
import { TerminalManager } from "./terminalManager";
import { readTextFile, writeTextFile } from "./clientFs";
import { LaunchSpec } from "../installer";
import { negotiate } from "./v2/negotiate";
import { hybridInitParams, normalizeInit, v2InitParams } from "./v2/init";
import { V2Adapter } from "./v2/adapter";

export type PermissionRequest = acp.RequestPermissionRequest & {
  description?: string;
  command?: string;
};

/** UI-facing callbacks the chat controller implements. */
export interface ClientDelegate {
  onSessionUpdate(notification: acp.SessionNotification): void;
  requestPermission(
    params: PermissionRequest,
    ctx?: acp.ClientRequestContext<acp.RequestPermissionRequest>,
  ): Promise<acp.RequestPermissionResponse>;
  createElicitation(
    params: acp.CreateElicitationRequest,
    ctx?: acp.ClientRequestContext<acp.CreateElicitationRequest>,
  ): Promise<acp.CreateElicitationResponse>;
  onElicitationComplete(params: acp.CompleteElicitationNotification): void;
  onConnectionClosed(reason: string): void;
  onStderr?(text: string): void;
  /** Runs before the client writes a file for the agent (e.g. to snapshot it). */
  beforeWriteFile?(sessionId: string, path: string): Promise<void>;
}

interface Wire {
  readonly version: 1 | 2;
  request(method: string, params: unknown, options?: acp.SendRequestOptions): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  readonly closed: Promise<void>;
  readonly signal: AbortSignal;
  close(): unknown;
}

type InitMode = "v1" | "negotiate";

const v2Enabled = (): boolean =>
  vscode.workspace.getConfiguration("shipwreck").get<boolean>("acpV2", false);

export class AgentConnection implements vscode.Disposable {
  private proc: ChildProcess | undefined;
  private wire: Wire | undefined;
  private stderrBuf = "";
  initResponse: acp.InitializeResponse | undefined;
  spec: LaunchSpec | undefined;

  get connected(): boolean {
    // Connected means initialized: during start() the stream exists before the
    // initialize response, and callers must not observe "connected" there.
    return !!this.wire && !this.wire.signal.aborted && !!this.initResponse;
  }

  get closed(): Promise<void> | undefined {
    return this.wire?.closed;
  }

  get protocolVersion(): 1 | 2 | undefined {
    return this.initResponse ? this.wire?.version : undefined;
  }

  constructor(
    private readonly delegate: ClientDelegate,
    private readonly terminals: TerminalManager,
  ) {}

  private epoch = 0;

  /** Retire the current generation: detach identities first so the old
   *  process's close/exit/error callbacks observe a stale generation. */
  private retire(): void {
    const wire = this.wire;
    const proc = this.proc;
    this.wire = undefined;
    this.proc = undefined;
    this.initResponse = undefined;
    this.spec = undefined;
    if (wire) {
      try {
        // close() is async in the SDK; a retired connection's rejection
        // must never surface as an unhandled rejection.
        void Promise.resolve(wire.close() as unknown).catch(() => undefined);
      } catch {
        /* noop */
      }
    }
    if (proc) killProcessTree(proc);
  }

  start(spec: LaunchSpec, cwd?: string): Promise<acp.InitializeResponse> {
    return this.startWith(spec, cwd, v2Enabled() ? "negotiate" : "v1");
  }

  private async startWith(
    spec: LaunchSpec,
    cwd: string | undefined,
    mode: InitMode,
  ): Promise<acp.InitializeResponse> {
    // Synchronous retire: no await between detaching the old generation and
    // claiming the new epoch, so overlapping starts can't interleave.
    this.retire();
    const epoch = ++this.epoch;
    this.stderrBuf = "";

    const proc = spawnProcess(spec.command, spec.args, {
      cwd,
      env: spec.env as NodeJS.ProcessEnv | undefined,
    });
    this.proc = proc;
    let notified = false;
    const closedOnce = (reason: string) => {
      if (notified || this.epoch !== epoch || this.proc !== proc) return;
      notified = true;
      this.delegate.onConnectionClosed(reason);
    };

    proc.stderr?.on("data", (d: Buffer) => {
      if (this.epoch !== epoch || this.proc !== proc) return;
      const text = d.toString("utf8");
      this.stderrBuf = (this.stderrBuf + text).slice(-64 * 1024);
      this.delegate.onStderr?.(text);
    });

    proc.on("error", (err) => {
      closedOnce(`Failed to start agent: ${err.message}`);
    });

    const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    // Every inbound request/notification is gated on this generation still
    // being live — a retired connection must not create terminals, write
    // files, or ask for permissions, even mid-handler after awaits.
    let wireRef: Wire | undefined;
    const live = (): boolean => this.epoch === epoch && this.wire === wireRef;
    const publish = (wire: Wire) => {
      wireRef = wire;
      this.wire = wire;
      wire.closed
        .then(() => {
          closedOnce("Agent process closed the connection");
        })
        .catch(() => undefined);
    };

    proc.on("exit", (code, signal) => {
      closedOnce(
        `Agent process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
      );
    });

    const deadlineCtl = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineCtl.abort(), 30_000);
    const deadline = deadlineCtl.signal;
    const timeout = new Promise<never>((_, reject) => {
      deadline.addEventListener(
        "abort",
        () => reject(new Error("Agent did not respond to initialize within 30s")),
        { once: true },
      );
    });
    timeout.catch(() => undefined);
    const params = v1InitParams();
    let init: acp.InitializeResponse;
    try {
      if (mode === "v1") {
        const conn = this.connectV1(stream, live);
        publish(v1Wire(conn));
        init = await Promise.race<acp.InitializeResponse>([
          conn.agent.request(acp.methods.agent.initialize, params, { cancellationSignal: deadline }),
          timeout,
        ]);
      } else {
        const n = await Promise.race([negotiate(stream, hybridInitParams(params), deadline), timeout]);
        if (this.epoch !== epoch) throw new Error("superseded by a newer agent start");
        if (n.kind === "rejected") {
          this.retire();
          clearTimeout(deadlineTimer);
          return this.startWith(spec, cwd, "v1");
        } else if (n.response.protocolVersion === 2) {
          const adapter = new V2Adapter(this.delegate, this.terminals, live);
          const wire = v2Wire(adapter);
          wireRef = wire;
          this.wire = wire;
          await Promise.race([adapter.attach(n.stream, v2InitParams(params), n.response), timeout]);
          publish(wire);
          init = normalizeInit(n.response as never);
        } else {
          publish(v1Wire(this.connectV1(n.stream, live)));
          init = n.response as unknown as acp.InitializeResponse;
        }
      }
    } catch (err) {
      // Stop only this generation; a newer start may already be in flight.
      if (this.epoch !== epoch) throw new Error("superseded by a newer agent start");
      this.retire();
      throw err;
    } finally {
      clearTimeout(deadlineTimer);
    }
    // Only the current generation may publish.
    if (this.epoch !== epoch) throw new Error("superseded by a newer agent start");
    const supported = mode === "negotiate" ? [1, 2] : [acp.PROTOCOL_VERSION];
    if (!supported.includes(init.protocolVersion)) {
      this.retire();
      throw new Error(
        `The agent speaks ACP version ${init.protocolVersion}; this extension supports version ${supported.join(" and ")}.`,
      );
    }
    this.initResponse = init;
    this.spec = spec;
    return init;
  }

  private connectV1(stream: acp.Stream, live: () => boolean): acp.ClientConnection {
    const delegate = this.delegate;
    const terminals = this.terminals;
    const retired = (): Promise<never> =>
      Promise.reject(new Error("agent connection superseded"));
    return acp
      .client({ name: "acp-client-vscode" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        live()
          ? delegate.requestPermission(ctx.params, ctx)
          : Promise.resolve<acp.RequestPermissionResponse>({
              outcome: { outcome: "cancelled" },
            }),
      )
      .onRequest(acp.methods.client.elicitation.create, (ctx) =>
        live()
          ? delegate.createElicitation(ctx.params, ctx)
          : Promise.resolve<acp.CreateElicitationResponse>({ action: "cancel" }),
      )
      // Reads and writes go through open editor buffers, so agents see
      // unsaved edits and their writes land on the editor's undo stack.
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        if (!live()) return retired();
        const { path, line, limit } = ctx.params;
        const content = await readTextFile(path, line, limit);
        if (!live()) return retired();
        return { content };
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        if (!live()) return retired();
        const { sessionId, path, content } = ctx.params;
        await delegate.beforeWriteFile?.(sessionId, path);
        if (!live()) return retired();
        await writeTextFile(path, content);
        return {};
      })
      .onRequest(acp.methods.client.terminal.create, async (ctx) => {
        if (!live()) return retired();
        return terminals.create(ctx.params);
      })
      .onRequest(acp.methods.client.terminal.output, async (ctx) => {
        if (!live()) return retired();
        return terminals.output(ctx.params.terminalId);
      })
      .onRequest(acp.methods.client.terminal.waitForExit, async (ctx) => {
        if (!live()) return retired();
        const status = await terminals.waitForExit(ctx.params.terminalId);
        if (!live()) return retired();
        return { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
      })
      .onRequest(acp.methods.client.terminal.kill, async (ctx) => {
        if (!live()) return retired();
        terminals.kill(ctx.params.terminalId);
        return {};
      })
      .onRequest(acp.methods.client.terminal.release, async (ctx) => {
        if (!live()) return retired();
        terminals.release(ctx.params.terminalId);
        return {};
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (!live()) return;
        delegate.onSessionUpdate(ctx.params);
      })
      .onNotification(acp.methods.client.elicitation.complete, (ctx) => {
        if (!live()) return;
        delegate.onElicitationComplete(ctx.params);
      })
      .connect(stream);
  }

  /** Typed agent request. Throws when the connection is down. */
  request<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
    options?: acp.SendRequestOptions,
  ): Promise<acp.AgentRequestResponsesByMethod[Method]> {
    if (!this.wire) return Promise.reject(new Error("Not connected to an agent"));
    return this.wire.request(method, params, options) as Promise<
      acp.AgentRequestResponsesByMethod[Method]
    >;
  }

  notify<Method extends acp.AgentNotificationMethod>(
    method: Method,
    params: acp.AgentNotificationParamsByMethod[Method],
  ): Promise<void> {
    if (!this.wire) return Promise.resolve();
    return this.wire.notify(method, params);
  }

  async stop(): Promise<void> {
    // Bump the epoch first, then retire: callbacks from the old generation
    // find no identities to match and are ignored (no restart on stop).
    this.epoch++;
    this.retire();
  }

  recentStderr(): string {
    return this.stderrBuf.trim();
  }

  dispose(): void {
    void this.stop();
  }
}

function v1InitParams(): acp.InitializeRequest {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      elicitation: { form: {}, url: {} },
      session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
      subagents: {},
      plan: {},
    },
    clientInfo: {
      name: "shipwreck",
      title: "Shipwreck",
      version:
        vscode.extensions.getExtension("yaseen.shipwreck")?.packageJSON?.version ?? "0.0.0",
    },
  };
}

function v1Wire(conn: acp.ClientConnection): Wire {
  return {
    version: 1,
    request: (method, params, options) =>
      conn.agent.request(method as acp.AgentRequestMethod, params as never, options),
    notify: (method, params) => conn.agent.notify(method as acp.AgentNotificationMethod, params as never),
    closed: conn.closed,
    signal: conn.signal,
    close: () => conn.close(),
  };
}

function v2Wire(adapter: V2Adapter): Wire {
  return {
    version: 2,
    request: (method, params, options) => adapter.request(method, params, options),
    notify: (method, params) => adapter.notify(method, params),
    get closed() {
      return adapter.closed;
    },
    get signal() {
      return adapter.signal;
    },
    close: () => adapter.close(),
  };
}
