import * as vscode from "vscode";
import * as path from "path";
import { ChatController } from "./chatProvider";
import { Attachment } from "./types";
import { enclosingSymbolAttachment, selectionAttachment } from "./editorContext";

/** Secondary-sidebar containers landed in 1.106; older hosts get the activity bar. */
export function supportsSecondarySidebar(): boolean {
  const m = /^(\d+)\.(\d+)/.exec(vscode.version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 106);
}

function fileAttachment(uri: vscode.Uri, isDir = false): Attachment {
  return {
    uri: uri.toString(),
    name: path.basename(uri.fsPath) || uri.fsPath,
    kind: isDir ? "folder" : "file",
  };
}

function editorSelectionAttachment(editor: vscode.TextEditor): Attachment | undefined {
  if (editor.document.uri.scheme !== "file" || editor.selection.isEmpty) return undefined;
  return selectionAttachment(editor.document, editor.selection);
}

async function urisToAttachments(uris: vscode.Uri[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const uri of uris) {
    const stat = await vscode.workspace.fs.stat(uri).then(
      (s) => s,
      () => undefined,
    );
    if (!stat) continue;
    out.push(fileAttachment(uri, stat.type === vscode.FileType.Directory));
  }
  return out;
}

/** editor/explorer/terminal/scm "add to chat" commands. */
export function registerAddToChatCommands(
  controller: ChatController,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("shipwreck.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") return;
      await controller.addAttachments([
        editorSelectionAttachment(editor) ?? fileAttachment(editor.document.uri),
      ]);
    }),
    vscode.commands.registerCommand("shipwreck.addSymbolToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      try {
        const attachment = await enclosingSymbolAttachment(editor);
        if (attachment) await controller.addAttachments([attachment]);
        else void vscode.window.showInformationMessage("No enclosing symbol at the cursor.");
      } catch {
        void vscode.window.showWarningMessage("Couldn't read symbols from this editor.");
      }
    }),
    vscode.commands.registerCommand(
      "shipwreck.addFileToChat",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        await controller.addAttachments(await urisToAttachments([target]));
      },
    ),
    vscode.commands.registerCommand(
      "shipwreck.addToChat",
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const targets = uris?.length ? uris : uri ? [uri] : [];
        await controller.addAttachments(await urisToAttachments(targets));
      },
    ),
    vscode.commands.registerCommand("shipwreck.addTerminalSelectionToChat", async () => {
      let prev = "";
      let text = "";
      try {
        prev = await vscode.env.clipboard.readText();
      } catch {
        /* no clipboard */
      }
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      try {
        text = await vscode.env.clipboard.readText();
      } catch {
        /* no clipboard */
      }
      try {
        await vscode.env.clipboard.writeText(prev);
      } catch {
        /* restore best-effort */
      }
      if (!text) return;
      await controller.addAttachments([
        { uri: "terminal:///selection", name: "Terminal selection", kind: "terminal", text },
      ]);
    }),
  ];
}

/* ================= code actions ================= */

interface CodeActionArgs {
  uri: vscode.Uri;
  range: vscode.Range;
  diagnostics: vscode.Diagnostic[];
  intent: "fix" | "explain";
}

class AcpCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly controller: ChatController) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const diags = context.diagnostics.filter(
      (d) => d.severity <= vscode.DiagnosticSeverity.Warning,
    );
    if (!diags.length) return [];
    const agent = this.controller.agentDisplayName();
    const args = (intent: "fix" | "explain"): CodeActionArgs => ({
      uri: document.uri,
      range,
      diagnostics: diags,
      intent,
    });
    const mk = (title: string, intent: "fix" | "explain") => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.command = { title, command: "shipwreck.runCodeAction", arguments: [args(intent)] };
      return a;
    };
    return [mk(`Fix with ${agent}`, "fix"), mk(`Explain with ${agent}`, "explain")];
  }
}

const SEVERITY_LABEL: Record<number, string> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint",
};

function diagnosticPrompt(args: CodeActionArgs): { text: string; att: Attachment } {
  const d = args.diagnostics[0];
  const sev = SEVERITY_LABEL[d.severity] ?? "diagnostic";
  const src = d.source ? ` (${d.source})` : "";
  const verb = args.intent === "fix" ? "Fix" : "Explain";
  const text = `${verb} this ${sev}${src}:\n\n${d.message}`;
  return {
    text,
    att: {
      uri: args.uri.toString(),
      name: path.basename(args.uri.fsPath),
      kind: "diagnostic",
      range: { startLine: args.range.start.line + 1, endLine: args.range.end.line + 1 },
    },
  };
}

/* ================= TODO CodeLens ================= */

class TodoCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly controller: ChatController) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration("shipwreck").get<boolean>("codeLens.todo", true)) {
      return [];
    }
    const agent = this.controller.agentDisplayName();
    const re = /\b(TODO|FIXME)\b/g;
    const out: vscode.CodeLens[] = [];
    const text = document.getText();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < 200) {
      const pos = document.positionAt(m.index);
      const line = doc_line(document, pos.line);
      out.push(
        new vscode.CodeLens(new vscode.Range(pos, pos), {
          title: `$(wand) Implement with ${agent}`,
          command: "shipwreck.implementTodo",
          arguments: [document.uri, pos.line, line],
        }),
      );
    }
    return out;
  }
}

function doc_line(doc: vscode.TextDocument, line: number): string {
  return doc.lineAt(line).text.trim();
}

/* ================= status bar ================= */

export function createStatusBar(controller: ChatController): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  const update = () => {
    const name = controller.agentDisplayName();
    if (controller.needsApproval) {
      item.text = `$(bell-dot) ${name} needs approval`;
      item.command = "shipwreck.focusComposer";
      item.show();
    } else if (controller.busyNow) {
      item.text = `$(loading~spin) ${name}`;
      item.command = "shipwreck.focusComposer";
      item.show();
    } else {
      item.hide();
    }
  };
  const sub = controller.onDidUpdate(update);
  update();
  return vscode.Disposable.from(item, sub);
}

/* ================= registration ================= */

export function registerEditorIntegration(
  context: vscode.ExtensionContext,
  controller: ChatController,
): void {
  const noSecondary = !supportsSecondarySidebar();
  controller.chatViewId = noSecondary ? "shipwreck.chat" : "shipwreck.chatSecondary";
  void vscode.commands.executeCommand("setContext", "shipwreck.noSecondarySidebar", noSecondary);

  const todoLens = new TodoCodeLensProvider(controller);
  context.subscriptions.push(
    ...registerAddToChatCommands(controller),
    createStatusBar(controller),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new AcpCodeActionProvider(controller),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, todoLens),
    vscode.commands.registerCommand(
      "shipwreck.runCodeAction",
      async (args: CodeActionArgs) => {
        const { text, att } = diagnosticPrompt(args);
        await controller.focusChat();
        await controller.sendPrompt(text, [att]);
      },
    ),
    vscode.commands.registerCommand(
      "shipwreck.implementTodo",
      async (uri: vscode.Uri, line: number, comment: string) => {
        await controller.focusChat();
        await controller.sendPrompt(`Implement this TODO: ${comment}`, [
          {
            uri: uri.toString(),
            name: path.basename(uri.fsPath),
            kind: "selection",
            range: { startLine: line + 1, endLine: line + 1 },
          },
        ]);
      },
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shipwreck.codeLens.todo")) todoLens.refresh();
    }),
  );
}
