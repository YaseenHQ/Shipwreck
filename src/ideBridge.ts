/* Stdio MCP bridge the agent launches: relays its stdin/stdout to the
   extension's IDE tools server over a local socket. Runs as plain Node. */
import * as net from "net";

const pipe = process.env.ACP_IDE_PIPE;
const token = process.env.ACP_IDE_TOKEN;
if (!pipe || !token) {
  process.stderr.write("ACP IDE bridge: missing ACP_IDE_PIPE/ACP_IDE_TOKEN\n");
  process.exit(1);
}

const sock = net.connect(pipe, () => {
  sock.write(`${token}\n`);
  process.stdin.pipe(sock);
});
sock.pipe(process.stdout);
sock.on("error", (e) => {
  process.stderr.write(`ACP IDE bridge: ${e.message}\n`);
  process.exit(1);
});
sock.on("close", () => process.exit(0));
process.stdin.on("end", () => sock.end());
