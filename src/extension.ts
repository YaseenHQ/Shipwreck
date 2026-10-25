import * as vscode from "vscode";
import { ChatController, ChatViewProvider, openChatPanel, AcpDiffContentProvider } from "./chatProvider";
import { RegistryService } from "./registry";
import { IconService } from "./icons";
import { Installer } from "./installer";
import { registerEditorIntegration } from "./editorIntegration";
import { AgentDescriptor } from "./types";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const registry = new RegistryService(context);
  const icons = new IconService(context.globalStorageUri.fsPath);
  const installer = new Installer(context, registry, icons);
  const controller = new ChatController(context, registry, installer);
  icons.onDidChange(() => controller.notifyAgentsChanged());
  controller.openPanelFallback = () => void openChatPanel(context, controller);

  const provider = new ChatViewProvider(context, controller);
  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider("shipwreck.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider("shipwreck.chatSecondary", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider("acp-diff", new AcpDiffContentProvider()),
    vscode.commands.registerCommand("shipwreck.openChat", () => controller.focusChat()),
    vscode.commands.registerCommand("shipwreck.openChatInEditor", () =>
      openChatPanel(context, controller),
    ),
    vscode.commands.registerCommand("shipwreck.newSession", () => {
      controller.closeView();
      return controller.newSession();
    }),
    vscode.commands.registerCommand("shipwreck.cancelTurn", () => controller.cancelTurn()),
    vscode.commands.registerCommand("shipwreck.authenticate", () => controller.authenticate()),
    vscode.commands.registerCommand("shipwreck.focusComposer", async () => {
      await controller.focusChat();
    }),
    vscode.commands.registerCommand("shipwreck.refreshRegistry", async () => {
      await registry.refresh();
      controller.notifyAgentsChanged();
      vscode.window.showInformationMessage("Agent registry refreshed.");
    }),
    vscode.commands.registerCommand("shipwreck.selectAgentById", (id: string) => controller.selectAgent(id)),
    vscode.commands.registerCommand("shipwreck.loadSessionById", (id: string) =>
      controller.loadSession(id),
    ),
    vscode.commands.registerCommand("shipwreck.selectAgent", async (arg?: AgentDescriptor | { agent: AgentDescriptor }) => {
      const direct = arg && "agent" in arg ? arg.agent : arg;
      if (direct?.id && direct.installed) {
        await controller.selectAgent(direct.id);
        return;
      }
      const picked = await pickAgent(installer.descriptors().filter((a) => a.installed));
      if (picked) await controller.selectAgent(picked.id);
    }),
    vscode.commands.registerCommand("shipwreck.installAgent", async (arg?: string | AgentDescriptor | { agent: AgentDescriptor }) => {
      const id: string | undefined =
        typeof arg === "string" ? arg : arg && "agent" in arg ? arg.agent.id : arg?.id;
      if (!id) {
        await vscode.commands.executeCommand("shipwreck.browseRegistry");
        return;
      }
      await installFlow(id, installer, controller);
    }),
    vscode.commands.registerCommand("shipwreck.uninstallAgent", async (arg?: string | AgentDescriptor | { agent: AgentDescriptor }) => {
      const id: string | undefined =
        typeof arg === "string" ? arg : arg && "agent" in arg ? arg.agent.id : arg?.id;
      if (!id) return;
      const rec = installer.record(id);
      const yes = await vscode.window.showWarningMessage(
        `Uninstall ${rec?.name ?? id}?${rec?.installDir ? " Its downloaded files will be removed." : ""}`,
        { modal: true },
        "Uninstall",
      );
      if (yes !== "Uninstall") return;
      await installer.uninstall(id);
      controller.notifyAgentsChanged();
      vscode.window.showInformationMessage(`${rec?.name ?? id} uninstalled.`);
    }),
    vscode.commands.registerCommand("shipwreck.browseRegistry", async () => {
      await controller.focusChat();
      controller.openCatalog();
    }),
    vscode.commands.registerCommand("shipwreck.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`),
    ),
    vscode.commands.registerCommand("shipwreck.closeAgents", () => controller.closeView()),
    vscode.commands.registerCommand("shipwreck.closeHistory", () => controller.closeView()),
    vscode.commands.registerCommand("shipwreck.showHistory", async () => {
      await controller.focusChat();
      controller.openHistory();
    }),
    vscode.commands.registerCommand("shipwreck.addCustomAgent", async () => {
      const name = await vscode.window.showInputBox({
        title: "Add custom agent (1/2)",
        prompt: "Display name",
        placeHolder: "my-agent",
        validateInput: (v) => (v.trim() ? undefined : "Name is required"),
      });
      if (!name) return;
      const command = await vscode.window.showInputBox({
        title: "Add custom agent (2/2)",
        prompt: "Command to launch the ACP agent (with optional arguments)",
        placeHolder: "e.g. /usr/local/bin/my-agent --serve or npx -y @scope/acp-agent",
        validateInput: (v) => (v.trim() ? undefined : "Command is required"),
      });
      if (!command) return;
      const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const [cmd, ...args] = parts.map((p) => p.replace(/^"|"$/g, ""));
      const cfg = vscode.workspace.getConfiguration("shipwreck");
      const existing = cfg.get<{ name: string; command: string; args?: string[] }[]>(
        "customAgents",
        [],
      );
      await cfg.update(
        "customAgents",
        [...existing.filter((a) => a.name !== name), { name, command: cmd, args }],
        vscode.ConfigurationTarget.Global,
      );
      controller.notifyAgentsChanged();
      vscode.window.showInformationMessage(`Custom agent "${name}" added.`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shipwreck.customAgents") || e.affectsConfiguration("shipwreck.showCost")) {
        controller.notifyAgentsChanged();
      }
      if (e.affectsConfiguration("shipwreck.registryUrl")) void registry.refresh();
      if (e.affectsConfiguration("shipwreck.mcpServers")) controller.mcpServersChanged();
    }),
  );

  registerEditorIntegration(context, controller);
  await Promise.all([registry.init(), icons.init(), controller.init()]);
  if (vscode.workspace.getConfiguration("shipwreck").get<boolean>("prewarm", true)) {
    controller.prewarm();
  }
}

async function pickAgent(
  agents: AgentDescriptor[],
  opts?: { showInstallButtons?: boolean },
): Promise<AgentDescriptor | undefined> {
  if (!agents.length) {
    vscode.window.showInformationMessage("No agents available yet — the registry may still be loading.");
    return undefined;
  }
  const items = agents.map((a) => ({
    label: `${a.installed ? "$(check) " : ""}${a.name}`,
    description: a.version ? `v${a.version} · ${a.installKind ?? ""}` : a.installKind,
    detail: a.description,
    agent: a,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Agents",
    placeHolder: "Select an agent",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.agent;
}

async function installFlow(
  agentId: string,
  installer: Installer,
  controller: ChatController,
): Promise<void> {
  const agent = installer.descriptors().find((a) => a.id === agentId);
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Installing ${agent?.name ?? agentId}…`,
        cancellable: false,
      },
      async (progress) => {
        await installer.install(agentId, progress);
      },
    );
    controller.notifyAgentsChanged();
    vscode.window.showInformationMessage(`${agent?.name ?? agentId} installed.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to install ${agent?.name ?? agentId}: ${msg}`);
    return;
  }
}
