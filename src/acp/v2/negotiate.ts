import * as acp from "@agentclientprotocol/sdk";

const INIT_ID = "shipwreck-init";

export type Negotiated =
  | { kind: "selected"; response: { protocolVersion: unknown } & Record<string, unknown>; stream: acp.Stream }
  | { kind: "rejected"; error: acp.RequestError };

export async function negotiate(
  stream: acp.Stream,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Negotiated> {
  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();
  const buffered: acp.AnyMessage[] = [];
  let reply: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("initialize aborted"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    await Promise.race([
      writer.write({ jsonrpc: "2.0", id: INIT_ID, method: "initialize", params } as acp.AnyMessage),
      aborted,
    ]);
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) throw new Error("Agent process closed the connection");
      const m = next.value as { id?: unknown; method?: unknown };
      if (m.id === INIT_ID && m.method === undefined) {
        reply = next.value as typeof reply;
        break;
      }
      buffered.push(next.value);
    }
  } finally {
    writer.releaseLock();
  }
  const readable = new ReadableStream<acp.AnyMessage>({
    start(controller) {
      for (const m of buffered) controller.enqueue(m);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  const handed = { readable, writable: stream.writable };
  if (reply.error) {
    return {
      kind: "rejected",
      error: new acp.RequestError(reply.error.code, reply.error.message, reply.error.data),
    };
  }
  return {
    kind: "selected",
    response: (reply.result ?? {}) as { protocolVersion: unknown } & Record<string, unknown>,
    stream: handed,
  };
}
