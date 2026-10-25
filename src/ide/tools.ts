import * as vscode from "vscode";
import * as path from "path";

/** One IDE tool exposed to agents over MCP. */
export interface IdeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

const MAX_LINES = 300;
const MAX_TEXT = 20_000;

class ToolError extends Error {}

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v == null || v === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
}

function int(args: Record<string, unknown>, key: string, required = false): number | undefined {
  const v = args[key];
  if (v == null) {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new ToolError(`"${key}" must be a positive integer`);
  }
  return n;
}

export function resolvePath(p: string): vscode.Uri {
  if (p.startsWith("file://")) return vscode.Uri.parse(p);
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new ToolError(`Relative path "${p}" needs an open workspace folder`);
  return vscode.Uri.file(path.join(root, p));
}

function rel(uri: vscode.Uri): string {
  return uri.scheme === "file" ? vscode.workspace.asRelativePath(uri, false) : uri.toString();
}

function cap(lines: string[], what: string): string {
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more ${what} omitted`].join("\n");
}

const SEVERITY = ["error", "warning", "info", "hint"];

/** 1-based line + the symbol's first occurrence on it → a position inside the symbol. */
async function symbolPosition(
  args: Record<string, unknown>,
): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
  const uri = resolvePath(str(args, "path", true)!);
  const line = int(args, "line", true)!;
  const symbol = str(args, "symbol", true)!;
  const doc = await vscode.workspace.openTextDocument(uri);
  if (line > doc.lineCount) throw new ToolError(`Line ${line} is past the end (${doc.lineCount} lines)`);
  const text = doc.lineAt(line - 1).text;
  const re = new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  const m = re.exec(text) ?? (text.includes(symbol) ? { index: text.indexOf(symbol) } : null);
  if (!m) throw new ToolError(`"${symbol}" is not on line ${line}: ${text.trim()}`);
  return { doc, pos: new vscode.Position(line - 1, m.index + Math.floor(symbol.length / 2)) };
}

async function lineText(uri: vscode.Uri, line: number): Promise<string> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    return line < doc.lineCount ? doc.lineAt(line).text.trim() : "";
  } catch {
    return "";
  }
}

async function formatLocations(locs: (vscode.Location | vscode.LocationLink)[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of locs.slice(0, MAX_LINES)) {
    const uri = "targetUri" in l ? l.targetUri : l.uri;
    const range = "targetUri" in l ? (l.targetSelectionRange ?? l.targetRange) : l.range;
    const snippet = out.length < 50 ? await lineText(uri, range.start.line) : "";
    out.push(`${rel(uri)}:${range.start.line + 1}:${range.start.character + 1}${snippet ? `  ${snippet}` : ""}`);
  }
  if (locs.length > MAX_LINES) out.push(`… ${locs.length - MAX_LINES} more omitted`);
  return out;
}

function symbolKind(k: vscode.SymbolKind): string {
  return (vscode.SymbolKind as unknown as Record<number, string>)[k]?.toLowerCase() ?? String(k);
}

function hoverText(h: vscode.Hover): string {
  return h.contents
    .map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))
    .filter(Boolean)
    .join("\n\n");
}

const symbolArgs = {
  type: "object",
  properties: {
    path: { type: "string", description: "File path, absolute or relative to the workspace root" },
    line: { type: "integer", description: "1-based line where the symbol appears" },
    symbol: { type: "string", description: "The identifier on that line" },
  },
  required: ["path", "line", "symbol"],
};

export const IDE_TOOLS: IdeTool[] = [
  {
    name: "get_diagnostics",
    description:
      "Errors and warnings the editor's language servers currently report (type errors, lint). " +
      "Faster than running a build. Omit path for the whole workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Limit to one file (absolute or workspace-relative)" },
        severity: {
          type: "string",
          enum: ["error", "warning", "all"],
          description: "Lowest severity to include (default: warning)",
        },
      },
    },
    async run(args) {
      const p = str(args, "path");
      const sev = str(args, "severity") ?? "warning";
      const max = sev === "error" ? 0 : sev === "warning" ? 1 : 3;
      const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = p
        ? [[resolvePath(p), vscode.languages.getDiagnostics(resolvePath(p))]]
        : vscode.languages.getDiagnostics();
      const lines: string[] = [];
      for (const [uri, diags] of entries) {
        for (const d of diags) {
          if (d.severity > max) continue;
          const code = typeof d.code === "object" ? d.code.value : d.code;
          const src = [d.source, code].filter((x) => x != null && x !== "").join(" ");
          lines.push(
            `${rel(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity]}${src ? ` [${src}]` : ""} ${d.message.replace(/\s*\n\s*/g, " ")}`,
          );
        }
      }
      return lines.length ? cap(lines, "diagnostics") : p ? `No problems in ${p}.` : "No problems in the workspace.";
    },
  },
  {
    name: "get_open_editors",
    description: "Files open in the editor, with which one is active and which have unsaved changes.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const lines: string[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input;
          const uri =
            input instanceof vscode.TabInputText
              ? input.uri
              : input instanceof vscode.TabInputTextDiff
                ? input.modified
                : undefined;
          if (!uri) continue;
          const flags = [
            tab.isActive && group.isActive ? "active" : "",
            tab.isDirty ? "unsaved" : "",
            input instanceof vscode.TabInputTextDiff ? "diff" : "",
          ].filter(Boolean);
          lines.push(`${rel(uri)}${flags.length ? ` (${flags.join(", ")})` : ""}`);
        }
      }
      return lines.length ? cap(lines, "editors") : "No files are open.";
    },
  },
  {
    name: "get_selection",
    description: "The active editor's file, cursor position and selected text.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return "No active editor.";
      const s = ed.selection;
      const where = `${rel(ed.document.uri)} (${ed.document.languageId})`;
      if (s.isEmpty) {
        const line = ed.document.lineAt(s.active.line).text;
        return `${where}\nCursor at ${s.active.line + 1}:${s.active.character + 1}, nothing selected.\nLine: ${line}`;
      }
      let text = ed.document.getText(s);
      if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n… selection truncated`;
      return `${where}\nSelected ${s.start.line + 1}:${s.start.character + 1}-${s.end.line + 1}:${s.end.character + 1}:\n${text}`;
    },
  },
  {
    name: "get_workspace_folders",
    description: "Root folders open in the editor.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const folders = vscode.workspace.workspaceFolders ?? [];
      return folders.length ? folders.map((f) => `${f.name}: ${f.uri.fsPath}`).join("\n") : "No folder is open.";
    },
  },
  {
    name: "open_file",
    description: "Show a file to the user in the editor, optionally highlighting a line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, absolute or relative to the workspace root" },
        line: { type: "integer", description: "1-based first line to reveal" },
        endLine: { type: "integer", description: "1-based last line to select" },
      },
      required: ["path"],
    },
    async run(args) {
      const uri = resolvePath(str(args, "path", true)!);
      const line = int(args, "line");
      const end = int(args, "endLine") ?? line;
      const doc = await vscode.workspace.openTextDocument(uri);
      const ed = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      if (line) {
        const a = new vscode.Position(Math.min(line, doc.lineCount) - 1, 0);
        const bLine = Math.min(end ?? line, doc.lineCount) - 1;
        const b = new vscode.Position(bLine, doc.lineAt(bLine).text.length);
        ed.selection = new vscode.Selection(a, end && end !== line ? b : a);
        ed.revealRange(new vscode.Range(a, b), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      return `Opened ${rel(uri)}${line ? ` at line ${line}` : ""}.`;
    },
  },
  {
    name: "find_definition",
    description: "Where a symbol is defined, using the editor's language server.",
    inputSchema: symbolArgs,
    async run(args) {
      const { doc, pos } = await symbolPosition(args);
      const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        doc.uri,
        pos,
      );
      return locs?.length ? (await formatLocations(locs)).join("\n") : "No definition found.";
    },
  },
  {
    name: "find_references",
    description: "Every reference to a symbol across the workspace, using the editor's language server.",
    inputSchema: symbolArgs,
    async run(args) {
      const { doc, pos } = await symbolPosition(args);
      const locs = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        doc.uri,
        pos,
      );
      return locs?.length ? (await formatLocations(locs)).join("\n") : "No references found.";
    },
  },
  {
    name: "get_hover",
    description: "Type signature and docs for a symbol, as the editor shows on hover.",
    inputSchema: symbolArgs,
    async run(args) {
      const { doc, pos } = await symbolPosition(args);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        pos,
      );
      const text = (hovers ?? []).map(hoverText).filter(Boolean).join("\n\n---\n\n");
      return text ? text.slice(0, MAX_TEXT) : "No hover information.";
    },
  },
  {
    name: "search_symbols",
    description: "Find classes, functions and other symbols by name across the workspace.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Symbol name or part of it" } },
      required: ["query"],
    },
    async run(args) {
      const q = str(args, "query", true)!;
      const syms = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        q,
      );
      if (!syms?.length) return `No symbols match "${q}".`;
      return cap(
        syms.map(
          (s) =>
            `${symbolKind(s.kind)} ${s.containerName ? `${s.containerName}.` : ""}${s.name}  ${rel(s.location.uri)}:${s.location.range.start.line + 1}`,
        ),
        "symbols",
      );
    },
  },
  {
    name: "get_document_symbols",
    description: "Outline of a file: its classes, functions, methods and their line ranges.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "File path, absolute or relative to the workspace root" } },
      required: ["path"],
    },
    async run(args) {
      const uri = resolvePath(str(args, "path", true)!);
      await vscode.workspace.openTextDocument(uri);
      const syms = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      );
      if (!syms?.length) return "No symbols found (the file may have no language support).";
      const lines: string[] = [];
      const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], depth: number) => {
        for (const s of list) {
          const range = "range" in s ? s.range : s.location.range;
          lines.push(`${"  ".repeat(depth)}${symbolKind(s.kind)} ${s.name}  ${range.start.line + 1}-${range.end.line + 1}`);
          if ("children" in s && s.children?.length) walk(s.children, depth + 1);
        }
      };
      walk(syms, 0);
      return cap(lines, "symbols");
    },
  },
];

export async function runTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const tool = IDE_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  try {
    return { text: await tool.run(args ?? {}), isError: false };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
