import { ChildProcess, spawn } from "child_process";

/**
 * Quote a single argument for cmd.exe. Follows MSVC CommandLineToArgvW rules
 * (backslashes escape backslashes before quotes; quotes are doubled-escaped).
 */
function quoteCmdArg(arg: string): string {
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)("|$)/g, (_m, bs: string, end: string) => bs + bs + (end ? '\\"' : ''))}"`;
}

function needsCmdShim(command: string): boolean {
  if (process.platform !== "win32") return false;
  if (/\.(cmd|bat)$/i.test(command)) return true;
  // Bare tool names that resolve to .cmd shims on PATH (npm-installed runners).
  if (!/[\\/]/.test(command) && !/\.(exe|com)$/i.test(command)) return true;
  return false;
}

/**
 * Spawn a process robustly across platforms. On Windows, `.cmd`/`.bat` files
 * and PATH-resolved shim names (e.g. `npx`) are wrapped in cmd.exe.
 */
export function spawnProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const env = { ...process.env, ...options.env };

  if (needsCmdShim(command)) {
    const cmdline = `${quoteCmdArg(command)} ${args.map(quoteCmdArg).join(" ")}`.trim();
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdline}"`], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** Kill a process and (on Windows) its whole tree. */
export function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
