import * as acp from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { ClientDelegate } from "../connection";
import type { TerminalManager } from "../terminalManager";
import { SessionTurns } from "./turns";
import { ProjectedUpdate, ShipwreckUpdate, ToolMirror, configOptions, project, toolCallUpdate } from "./project";

export class InsertedPromptFailed extends acp.RequestError {}

interface SessionState {
  turns: SessionTurns;
  tools: ToolMirror;
  modeOptionId?: string;
}

type AnyRequest = (method: string, params: unknown, options?: acp.SendRequestOptions) => Promise<any>;

let adapters = 0;

export class V2Adapter {
  private conn!: v2.ClientConnection;
  private readonly sessions = new Map<string, SessionState>();
  private readonly prefix = `v2-${++adapters}-`;
  private prompts = 0;
  private permissions = 0;

  constructor(
    private readonly delegate: ClientDelegate,
    private readonly terminals: TerminalManager,
    private readonly live: () => boolean,
  ) {}

  get signal(): AbortSignal {
    return this.conn.signal;
  }

  get closed(): Promise<void> {
    return this.conn.closed;
  }

  close(): void {
    this.conn.close();
  }

  /** The SDK v2 client rejects every request until it has sent its own
   *  initialize, so that initialize is answered here with the agent's earlier
   *  response and never reaches the wire. */
  async attach(
    stream: acp.Stream,
    request: v2.InitializeRequest,
    response: Record<string, unknown>,
  ): Promise<void> {
    let inbound!: ReadableStreamDefaultController<v2.AnyWireMessage>;
    const readable = new ReadableStream<v2.AnyWireMessage>({
      start: (c) => {
        inbound = c;
      },
    });
    const writer = stream.writable.getWriter();
    const writable = new WritableStream<v2.AnyWireMessage>({
      write: (m) => {
        const msg = m as { method?: string; id?: v2.JsonRpcId };
        if (msg.method === "initialize" && msg.id !== undefined) {
          inbound.enqueue({ jsonrpc: "2.0", id: msg.id, result: response } as v2.AnyWireMessage);
          return;
        }
        return writer.write(m as acp.AnyMessage);
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    });
    this.conn = v2
      .client({ name: "shipwreck" })
      .onRequest(v2.methods.client.session.requestPermission, (ctx) =>
        this.live()
          ? this.requestPermission(ctx.params)
          : Promise.resolve<v2.RequestPermissionResponse>({ outcome: { outcome: "cancelled" } }),
      )
      .onRequest(v2.methods.client.elicitation.create, (ctx) =>
        this.live()
          ? (this.delegate.createElicitation(
              ctx.params as unknown as acp.CreateElicitationRequest,
            ) as unknown as Promise<v2.CreateElicitationResponse>)
          : Promise.resolve<v2.CreateElicitationResponse>({ action: "cancel" } as v2.CreateElicitationResponse),
      )
      .onNotification(v2.methods.client.session.update, (ctx) => {
        if (this.live()) this.onUpdate(ctx.params);
      })
      .onNotification(v2.methods.client.elicitation.complete, (ctx) => {
        if (this.live()) {
          this.delegate.onElicitationComplete(ctx.params as unknown as acp.CompleteElicitationNotification);
        }
      })
      .connect({ readable, writable });
    void this.conn.closed
      .catch(() => undefined)
      .then(() => this.failAll(new Error("Agent process closed the connection")));
    await this.conn.agent.request(v2.methods.agent.initialize, request);
    void stream.readable
      .pipeTo(
        new WritableStream({
          write: (m) => inbound.enqueue(m as v2.AnyWireMessage),
          close: () => inbound.close(),
        }),
      )
      .catch((err) => inbound.error(err));
  }

  async request(method: string, params: any, options?: acp.SendRequestOptions): Promise<unknown> {
    const agent = this.conn.agent as unknown as { request: AnyRequest };
    const send: AnyRequest = (m, p, o) => agent.request(m, p, o);
    switch (method) {
      case acp.methods.agent.session.new: {
        const res = await send(method, { ...params, mcpServers: toV2Mcp(params.mcpServers) }, options);
        this.noteOptions(res.sessionId, res.configOptions);
        return { ...res, configOptions: configOptions(res.configOptions) };
      }
      case acp.methods.agent.session.load:
      case acp.methods.agent.session.resume: {
        const res = await send(
          v2.methods.agent.session.resume,
          {
            ...params,
            mcpServers: toV2Mcp(params.mcpServers),
            ...(method === acp.methods.agent.session.load ? { replayFrom: { type: "start" } } : {}),
          },
          options,
        );
        this.noteOptions(params.sessionId, res?.configOptions);
        return { ...res, configOptions: configOptions(res?.configOptions) };
      }
      case acp.methods.agent.session.setMode: {
        const configId = this.sessions.get(params.sessionId)?.modeOptionId;
        if (!configId) throw new acp.RequestError(-32601, "The agent offers no mode option");
        await this.request(
          acp.methods.agent.session.setConfigOption,
          { sessionId: params.sessionId, configId, value: params.modeId },
          options,
        );
        return {};
      }
      case acp.methods.agent.session.setConfigOption: {
        const res = await send(method, params.type === "boolean" ? params : { ...params, type: "id" }, options);
        this.noteOptions(params.sessionId, res.configOptions);
        return { ...res, configOptions: configOptions(res.configOptions) };
      }
      case acp.methods.agent.authenticate:
        return (await send(v2.methods.agent.auth.login, { methodId: params.methodId }, options)) ?? {};
      case acp.methods.agent.session.prompt:
        return this.prompt(params as acp.PromptRequest, agent);
      case acp.methods.agent.session.delete:
      case acp.methods.agent.session.close: {
        const res = await send(method, params, options);
        this.sessions.delete(params.sessionId);
        return res ?? {};
      }
      default:
        return send(method, params, options);
    }
  }

  notify(method: string, params: unknown): Promise<void> {
    return (this.conn.agent as unknown as { notify(m: string, p: unknown): Promise<void> }).notify(
      method,
      params,
    );
  }

  private prompt(params: acp.PromptRequest, agent: { request: AnyRequest }): Promise<acp.PromptResponse> {
    const { turns } = this.state(params.sessionId);
    const id = ++this.prompts;
    return new Promise<acp.PromptResponse>((resolve, reject) => {
      turns.sent(id, (s) => {
        if (s.kind === "failed") reject(s.error);
        else if (s.stop.stopReason === "error") {
          const e = s.stop.error;
          reject(new InsertedPromptFailed(e?.code ?? -32603, e?.message ?? "The agent reported an error", e?.data));
        } else resolve({ stopReason: s.stop.stopReason as acp.StopReason });
      });
      agent.request(v2.methods.agent.session.prompt, params).then(
        (res: v2.PromptResponse) => turns.acked(id, res.messageId),
        (err: unknown) => {
          turns.dropped(id);
          reject(err);
        },
      );
    });
  }

  private onUpdate(n: v2.UpdateSessionNotification): void {
    const { sessionId, update } = n;
    const s = this.state(sessionId);
    switch ((update as { sessionUpdate: string }).sessionUpdate) {
      case "state_update": {
        const stop = s.turns.unclaimedStop(update as v2.StateUpdate);
        if (stop) this.emit(sessionId, { sessionUpdate: "_shipwreck_unclaimed_turn_end", ...stop });
        return;
      }
      case "terminal_update": {
        const t = update as v2.TerminalUpdate;
        this.terminals.updateAgentTerminal(this.terminalId(t.terminalId), sessionId, {
          output: t.output,
          exitStatus: t.exitStatus,
        });
        return;
      }
      case "terminal_output_chunk": {
        const t = update as v2.TerminalOutputChunk;
        this.terminals.appendAgentTerminal(this.terminalId(t.terminalId), sessionId, t.data);
        return;
      }
      case "user_message":
      case "user_message_chunk":
        s.turns.userMessage((update as { messageId: string }).messageId);
        break;
      case "config_option_update":
        this.noteOptions(sessionId, (update as v2.ConfigOptionUpdate).configOptions);
        break;
    }
    for (const u of project(update as ProjectedUpdate, s.tools, this.terminalId)) this.emit(sessionId, u);
  }

  private async requestPermission(p: v2.RequestPermissionRequest): Promise<v2.RequestPermissionResponse> {
    const s = this.state(p.sessionId);
    const subject = p.subject as ({ type: string } & Record<string, unknown>) | null | undefined;
    let toolCall: acp.ToolCallUpdate;
    let command: string | undefined;
    if (subject?.type === "tool_call") {
      const update = toolCallUpdate(s.tools.apply(subject.toolCall as v2.ToolCallUpdate), this.terminalId);
      this.emit(p.sessionId, update);
      const { sessionUpdate: _kind, ...tool } = update as acp.ToolCallUpdate & { sessionUpdate: string };
      toolCall = { ...tool, title: p.title };
    } else if (subject?.type === "command") {
      const c = subject as unknown as v2.CommandPermissionSubject;
      command = c.command;
      toolCall = {
        toolCallId: c.toolCallId ?? `permission-${++this.permissions}`,
        title: p.title,
        kind: "execute",
        rawInput: { command: c.command, cwd: c.cwd },
      };
    } else {
      toolCall = { toolCallId: `permission-${++this.permissions}`, title: p.title };
    }
    const res = await this.delegate.requestPermission({
      sessionId: p.sessionId,
      toolCall,
      options: p.options as acp.PermissionOption[],
      description: p.description ?? undefined,
      command,
    });
    return res as v2.RequestPermissionResponse;
  }

  private readonly terminalId = (id: string): string => this.prefix + id;

  private emit(sessionId: string, update: acp.SessionUpdate | ShipwreckUpdate): void {
    this.delegate.onSessionUpdate({ sessionId, update } as acp.SessionNotification);
  }

  private state(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { turns: new SessionTurns(), tools: new ToolMirror() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private noteOptions(sessionId: string, options: v2.SessionConfigOption[] | undefined): void {
    if (!sessionId || !options) return;
    const mode = options.find((o) => o.category === "mode");
    if (mode) this.state(sessionId).modeOptionId = mode.configId;
  }

  private failAll(error: unknown): void {
    for (const s of this.sessions.values()) s.turns.failAll(error);
  }
}

/** v2 has no SSE transport. */
function toV2Mcp(servers: readonly acp.McpServer[] | undefined): v2.McpServer[] | undefined {
  if (!servers) return undefined;
  return servers.flatMap((s) => {
    const type = (s as { type?: string }).type;
    if (type === "sse") return [];
    return [(type ? s : { type: "stdio", ...s }) as v2.McpServer];
  });
}
