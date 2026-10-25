import type * as acp from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";

type V1InitializeRequest = acp.InitializeRequest;

/** v1 agents read clientInfo and clientCapabilities and fall back to version 1;
 *  v2 agents read info and capabilities and may select version 2. */
export function hybridInitParams(v1: V1InitializeRequest): Record<string, unknown> {
  const info = v1.clientInfo ?? { name: "shipwreck", version: "0.0.0" };
  return {
    ...v1,
    protocolVersion: 2,
    info,
    capabilities: v2ClientCapabilities(),
  };
}

export function v2InitParams(v1: V1InitializeRequest): v2.InitializeRequest {
  return {
    protocolVersion: 2,
    info: v1.clientInfo ?? { name: "shipwreck", version: "0.0.0" },
    capabilities: v2ClientCapabilities(),
  };
}

function v2ClientCapabilities(): v2.ClientCapabilities {
  return { auth: { terminal: {} }, elicitation: { form: {}, url: {} } };
}

/** v2 session capabilities imply session/list, session/resume and session/close. */
export function normalizeInit(r: v2.InitializeResponse): acp.InitializeResponse {
  const session = r.capabilities?.session;
  const prompt = session?.prompt;
  const agentCapabilities: acp.AgentCapabilities = session
    ? {
        loadSession: true,
        promptCapabilities: {
          image: !!prompt?.image,
          audio: !!prompt?.audio,
          embeddedContext: !!prompt?.embeddedContext,
        },
        mcpCapabilities: { http: !!session.mcp?.http, sse: false },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
          ...(session.delete ? { delete: {} } : {}),
          ...(session.additionalDirectories ? { additionalDirectories: {} } : {}),
        },
      }
    : {};
  return {
    protocolVersion: r.protocolVersion as acp.ProtocolVersion,
    agentInfo: r.info,
    agentCapabilities,
    authMethods: (r.authMethods ?? []).map(normalizeAuthMethod),
  };
}

function normalizeAuthMethod(m: v2.AuthMethod): acp.AuthMethod {
  const { methodId, env, ...rest } = m as {
    methodId: string;
    env?: { name: string; value: string }[];
  } & Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest, id: methodId };
  if (Array.isArray(env)) out.env = Object.fromEntries(env.map((e) => [e.name, e.value]));
  return out as unknown as acp.AuthMethod;
}
