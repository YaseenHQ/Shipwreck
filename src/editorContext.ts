import * as vscode from "vscode";
import * as path from "path";
import type { Attachment, EditorContext, FileContext, HostMessage } from "./types";

interface GitRepository {
  state: {
    indexChanges: { uri: vscode.Uri; status: number }[];
    workingTreeChanges: { uri: vscode.Uri; status: number }[];
    untrackedChanges: { uri: vscode.Uri; status: number }[];
    onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

export function selectionAttachment(
  document: vscode.TextDocument, range: vscode.Range,
): Attachment & { range: { startLine: number; endLine: number }; text: string } {
  return {
    uri: document.uri.toString(),
    name: path.basename(document.uri.fsPath),
    kind: "selection",
    range: {
      startLine: range.start.line + 1,
      endLine: Math.max(range.start.line + 1, range.end.line + (range.end.character === 0 ? 0 : 1)),
    },
    text: document.getText(range),
  };
}

export async function enclosingSymbolAttachment(editor: vscode.TextEditor): Promise<Attachment | undefined> {
  if (editor.document.uri.scheme !== "file") return undefined;
  const position = editor.selection.active;
  const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    "vscode.executeDocumentSymbolProvider", editor.document.uri,
  );
  const ranges: vscode.Range[] = [];
  const visit = (items: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
    for (const symbol of items) {
      const range = "range" in symbol ? symbol.range : symbol.location.range;
      if ("location" in symbol && symbol.location.uri.toString() !== editor.document.uri.toString()) continue;
      if (range.contains(position)) ranges.push(range);
      if ("children" in symbol) visit(symbol.children);
    }
  };
  visit(symbols ?? []);
  ranges.sort((a, b) => editor.document.offsetAt(a.end) - editor.document.offsetAt(a.start)
    - (editor.document.offsetAt(b.end) - editor.document.offsetAt(b.start)));
  return ranges[0] ? selectionAttachment(editor.document, ranges[0]) : undefined;
}

export class EditorContextTracker implements vscode.Disposable {
  private context?: EditorContext;
  private enabled = true;
  private revision = 0;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private git?: GitApi;
  private readonly watched = new Map<object, Set<string>>();
  private readonly publishedFiles = new Map<string, string>();
  private publishedContext?: string;
  private readonly repositories = new Map<GitRepository, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly post: (message: HostMessage) => void) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(() => this.schedule()),
      vscode.languages.onDidChangeDiagnostics(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("shipwreck.context.activeFile")) {
          this.enabled = this.defaultEnabled();
          this.revision++;
          this.refresh();
        }
      }),
    );
    this.refresh();
    void this.connectGit();
  }

  private defaultEnabled(): boolean {
    return vscode.workspace.getConfiguration("shipwreck").get<boolean>("context.activeFile", true);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  }

  private async connectGit(): Promise<void> {
    try {
      const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
      const exports = extension?.isActive ? extension.exports : await extension?.activate();
      if (this.disposed || !exports) return;
      this.git = exports.getAPI(1);
      this.subscriptions.push(
        this.git.onDidOpenRepository(() => this.refresh()),
        this.git.onDidCloseRepository(() => this.refresh()),
      );
      this.refresh();
    } catch {
      // Git is optional and can be disabled.
    }
  }

  fileContext(uri: vscode.Uri): FileContext {
    const diagnostics: FileContext["diagnostics"] = { error: 0, warning: 0, items: [] };
    for (const d of vscode.languages.getDiagnostics(uri)) {
      if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
      const severity = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
      diagnostics[severity]++;
      if (diagnostics.items.length < 20) {
        const code = typeof d.code === "object" ? d.code.value : d.code;
        diagnostics.items.push({
          line: d.range.start.line + 1, severity,
          ...(code != null ? { code: String(code) } : {}),
          message: d.message.replace(/\s+/g, " ").slice(0, 300),
        });
      }
    }
    const changes = this.git?.repositories.flatMap((r) => [
      ...r.state.indexChanges, ...r.state.workingTreeChanges, ...r.state.untrackedChanges,
    ]) ?? [];
    const statuses = changes.filter((c) => c.uri.toString() === uri.toString()).map((c) => c.status);
    const git = statuses.includes(7) ? "U" : statuses.includes(1) ? "A"
      : statuses.length ? "M" : undefined;
    return { diagnostics, ...(git ? { git } : {}) };
  }

  enrich(attachment: Attachment): Attachment {
    if (attachment.kind === "folder" || attachment.kind === "image" || attachment.kind === "rejected"
      || !attachment.uri.startsWith("file:")) return attachment;
    const uri = vscode.Uri.parse(attachment.uri);
    if (uri.scheme !== "file") return attachment;
    return { ...attachment, fileContext: this.fileContext(uri) };
  }

  watch(source: object, uris: string[]): void {
    const files = new Set(uris.filter((uri) => uri.startsWith("file:")));
    if (files.size) this.watched.set(source, files);
    else this.watched.delete(source);
    this.refresh();
  }

  unwatch(source: object): void {
    this.watched.delete(source);
    this.refresh();
  }

  refresh(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    for (const [repo, subscription] of this.repositories) {
      if (!this.git?.repositories.includes(repo)) {
        subscription.dispose();
        this.repositories.delete(repo);
      }
    }
    for (const repo of this.git?.repositories ?? []) {
      if (!this.repositories.has(repo)) this.repositories.set(repo, repo.state.onDidChange(() => this.schedule()));
    }
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const previousUri = this.context?.uri;
    if (editor && uri?.scheme === "file") {
      const selection = !editor.selection.isEmpty ? selectionAttachment(editor.document, editor.selection) : undefined;
      this.context = {
        uri: uri.toString(), name: path.basename(uri.fsPath),
        ...(selection ? { selection: { range: selection.range, text: selection.text } } : {}),
        ...this.fileContext(uri),
      };
    } else this.context = undefined;
    if (previousUri !== this.context?.uri) {
      this.enabled = this.defaultEnabled();
      this.revision++;
    }
    this.publish();
    const watched = new Set([...this.watched.values()].flatMap((uris) => [...uris]));
    for (const uri of this.publishedFiles.keys()) if (!watched.has(uri)) this.publishedFiles.delete(uri);
    for (const uri of watched) {
      const context = this.fileContext(vscode.Uri.parse(uri));
      const serialized = JSON.stringify(context);
      if (this.publishedFiles.get(uri) === serialized) continue;
      this.publishedFiles.set(uri, serialized);
      this.post({ type: "fileContext", uri, context });
    }
  }

  publish(force = false): void {
    const message: HostMessage = { type: "editorContext", context: this.context, enabled: this.enabled };
    const serialized = JSON.stringify(message);
    if (!force && serialized === this.publishedContext) return;
    this.publishedContext = serialized;
    this.post(message);
  }

  setEnabled(uri: string, enabled: boolean): void {
    this.refresh();
    if (this.context?.uri !== uri) return;
    this.enabled = enabled;
    this.revision++;
    this.publish();
  }

  capture(): { attachment?: Attachment; accepted: () => void } {
    this.refresh();
    const revision = this.revision;
    const context = this.context;
    const attachment: Attachment | undefined = context && this.enabled ? {
      uri: context.uri, name: context.name, contextSource: "active-editor",
      kind: context.selection ? "selection" : "file",
      ...(context.selection ? { range: context.selection.range, text: context.selection.text } : {}),
      fileContext: { diagnostics: context.diagnostics, git: context.git },
    } : undefined;
    return { attachment, accepted: () => {
      if (this.revision !== revision) return;
      this.enabled = this.defaultEnabled();
      this.revision++;
      this.publish();
    } };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.subscriptions.forEach((s) => s.dispose());
    this.repositories.forEach((s) => s.dispose());
  }
}
