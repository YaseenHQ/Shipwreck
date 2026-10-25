/* Minimal vscode API surface for bundling host code into plain-Node checks.
   Only what the bundled modules reference — no real VS Code. */
"use strict";
const path = require("path");

class Disposable {
  constructor(fn) { this.fn = fn; }
  dispose() { this.fn && this.fn(); }
}
class EventEmitter {
  constructor() { this.listeners = new Set(); }
  get event() {
    return (fn) => {
      this.listeners.add(fn);
      return new Disposable(() => this.listeners.delete(fn));
    };
  }
  fire(x) { for (const f of this.listeners) f(x); }
}

class WorkspaceEdit {
  constructor() { this.ops = []; }
  replace(uri, range, text) { this.ops.push({ kind: "replace", uri, range, text }); }
  deleteFile(uri, options) { this.ops.push({ kind: "delete", uri, options }); }
}
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
const SymbolKind = {};
["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor",
  "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array",
  "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter"]
  .forEach((n, i) => { SymbolKind[n] = i; SymbolKind[i] = n; });

const toUri = (p) => ({
  fsPath: p,
  scheme: "file",
  toString: () => "file:///" + String(p).replace(/\\/g, "/"),
  with: (x) => toUri(x && x.path !== undefined ? x.path : p),
});

// Tests that spawn real child processes need a cwd that exists.
const workspaceFolders = [
  { uri: toUri(process.env.ACP_SHIM_WS || "D:\\ws-test"), name: "ws-test", index: 0 },
];

module.exports = {
  Disposable,
  EventEmitter,
  Uri: {
    file: toUri,
    parse: (s) => /^file:\/\//i.test(s)
      ? toUri(require("url").fileURLToPath(s.replace(/#.*$/, "")))
      : { fsPath: s, scheme: "file", toString: () => s, with: () => ({ fsPath: s, scheme: "file", toString: () => s }) },
    joinPath: (u, ...parts) => toUri(path.join(u.fsPath, ...parts)),
  },
  workspace: {
    workspaceFolders,
    textDocuments: [],
    getConfiguration: () => ({
      // Tests override settings through globalThis.__acpShimConfig.
      get: (k, d) => {
        const o = globalThis.__acpShimConfig;
        return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d;
      },
      update: async (...a) => globalThis.__acpShimUpdate?.(...a),
      inspect: (key) => globalThis.__acpShimConfig &&
        Object.prototype.hasOwnProperty.call(globalThis.__acpShimConfig, key)
          ? { globalValue: globalThis.__acpShimConfig[key] } : undefined,
    }),
    // Tests that need real files set globalThis.__acpShimFs.
    fs: Object.fromEntries(Object.entries({
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
      createDirectory: async () => undefined,
      stat: async () => ({ type: 2, ctime: 0, mtime: 0, size: 0 }),
      readDirectory: async () => [],
      delete: async () => undefined,
    }).map(([k, stub]) => [k, (...a) => (globalThis.__acpShimFs?.[k] ?? stub)(...a)])),
    findFiles: async () => [],
    openTextDocument: async () => ({ getText: () => "", uri: toUri("x") }),
    asRelativePath: (p) => String(p),
    onDidChangeWorkspaceFolders: () => new Disposable(() => {}),
    onDidChangeTextDocument: () => new Disposable(() => {}),
    onDidChangeConfiguration: () => new Disposable(() => {}),
    createFileSystemWatcher: () => ({
      onDidCreate: () => new Disposable(() => {}),
      onDidChange: () => new Disposable(() => {}),
      onDidDelete: () => new Disposable(() => {}),
      dispose: () => {},
    }),
    applyEdit: async () => true,
  },
  window: {
    showErrorMessage: async (...a) => globalThis.__acpShimError?.(...a),
    showWarningMessage: async (...a) => globalThis.__acpShimWarning?.(...a),
    showInformationMessage: async (...a) => globalThis.__acpShimInfo?.(...a),
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => ({ selection: undefined }),
    createWebviewPanel: () => ({ webview: { postMessage: async () => true }, dispose: () => {} }),
    createTerminal: () => ({ show: () => {}, sendText: () => {}, dispose: () => {} }),
    createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    registerWebviewViewProvider: () => new Disposable(() => {}),
    registerFileDecorationProvider: () => new Disposable(() => {}),
    onDidChangeActiveTextEditor: () => new Disposable(() => {}),
    onDidChangeTextEditorSelection: () => new Disposable(() => {}),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [] },
  },
  commands: {
    executeCommand: async (...a) => globalThis.__acpShimCommand?.(...a),
    registerCommand: () => new Disposable(() => {}),
  },
  languages: {
    registerCodeActionsProvider: () => new Disposable(() => {}),
    registerCodeLensProvider: () => new Disposable(() => {}),
    onDidChangeDiagnostics: () => new Disposable(() => {}),
    getDiagnostics: () => [],
  },
  env: {
    openExternal: async () => true,
    appName: "test-host",
    uriScheme: "vscode",
    clipboard: { readText: async () => "", writeText: async () => {} },
  },
  extensions: { getExtension: () => undefined },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  TextEditorRevealType: { InCenter: 1, Default: 0, InCenterIfOutsideViewport: 2 },
  WorkspaceEdit,
  TabInputText,
  TabInputTextDiff,
  SymbolKind,
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class ThemeIcon { constructor(id) { this.id = id; } },
  Position: class Position { constructor(line, ch) { this.line = line; this.character = ch; } },
  Range: class Range {
    constructor(sl, sc, el, ec) {
      if (typeof sl === "object") { this.start = sl; this.end = sc; }
      else { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
    }
  },
  Selection: class Selection {
    constructor(a, b, c, d) { this.anchor = a; this.active = b; }
  },
  Pseudoterminal: class Pseudoterminal {},
  Terminal: class Terminal {},
  CodeActionKind: { QuickFix: "quickfix" },
  CodeAction: class CodeAction {},
  CodeLens: class CodeLens {},
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
};
