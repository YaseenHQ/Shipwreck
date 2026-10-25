import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

/** Agent start and session open timings, shown in the "Shipwreck" output channel.
 *  Labels and durations only, never prompt or transcript content. */
export function logTiming(line: string): void {
  channel ??= vscode.window.createOutputChannel("Shipwreck");
  channel.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${line}`);
}

export class Stopwatch {
  private readonly t0 = Date.now();
  private last = this.t0;

  constructor(private readonly label: string) {}

  lap(stage: string): void {
    const now = Date.now();
    logTiming(`${this.label}: ${stage} +${now - this.last}ms (total ${now - this.t0}ms)`);
    this.last = now;
  }
}

export function disposeTiming(): void {
  channel?.dispose();
  channel = undefined;
}
