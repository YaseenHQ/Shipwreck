# Shipwreck

Shipwreck runs any [Agent Client Protocol](https://agentclientprotocol.com) (ACP) coding agent in one VS Code chat panel. Claude Code, ChatGPT Codex, OpenCode, Factory Droid, and other agents in the [ACP registry](https://agentclientprotocol.com/registry) all use the same chat, the same diffs etc.

It works in VS Code, VSCodium, and should ideally work on other editors built on VS Code 1.85 or later. (if you're facing problems raise an issue, supporting PRs are nice too btw and does help me save a lot of time - but i do like to personally check as much as i can - atleast for most VSCode forks i have installed)

## Install

Download `shipwreck-<version>.vsix` from the project's GitHub Releases page, or build it yourself (see [Development](#development)), then install it:

```bash
code --install-extension shipwreck-<version>.vsix
```

## Quick start

1. Open the Shipwreck chat view. It sits in the secondary side bar, or in the activity bar on editors without one.
2. Click the **Agents** button in the view's title bar to open the agent catalog.
3. Click **Install** on an agent. Shipwreck downloads it from the ACP registry. If the agent asks you to sign in, follow its prompt.
4. Type a message and press Enter. The agent's tool calls, file reads, terminal commands, and edits stream into the chat as cards.
5. When the turn ends, the **Changes** card lists every file the agent changed. Click **Review** to see the diffs, or **Undo** to put the files back the way they were before the turn.

To add the current editor selection to the chat, press `Alt+K`. To focus the chat input, press `Ctrl+Alt+L` (`Cmd+Alt+L` on macOS).

## Features

- **Agent catalog.** Browse the ACP registry and install agents in one click. Shipwreck handles `npx`, `uvx`, and binary distributions, and verifies binary checksums. You can also launch any local ACP agent through `shipwreck.customAgents`.
- **One model menu for every agent.** Pick the agent, model, and reasoning effort from one menu under the message box. Search finds models across all installed agents, favorites sit at the top, and `Ctrl+1` to `Ctrl+9` pick a model while the menu is open. Session modes and other agent options sit next to it.
- **Paste images and files.** Paste or drop images and files into the message box. Images go to agents that accept them, and a file the agent can't take shows why on its chip.
- **Native diffs.** Edits open in the VS Code diff editor.
- **Edits bar.** Files the agent changed and you haven't reviewed sit in a bar above the message box, with Review, Undo, and Keep for each file or all of them.
- **Changes card with Review and Undo.** Shipwreck snapshots the workspace with Git at the start and end of each turn. The card lists every changed file, including files changed by terminal commands, and can undo the whole turn. Snapshots live in the extension's storage, never in your repository, so folders that are not Git repositories work too.
- **Threads.** Each conversation is a thread with history. Threads can also list the connected agent's own sessions, so you can import a session you started outside VS Code.
- **Agent handoff.** Switch agents in the middle of a thread. Shipwreck passes the conversation so far to the new agent as context, unless you turn that off.
- **Prewarmed agents.** Shipwreck keeps a pool of agent processes and starts the last-used agent when VS Code starts, so the first message does not wait for the agent to launch.
- **IDE tools over MCP.** Agents get an MCP server named `vscode` with editor tools: diagnostics, open editors, selection, go to definition, references, hover, and symbols.
- **Context from anywhere in the editor.** Add files, folders, selections, terminal output, and source control entries to the chat from their context menus, or mention a file with `@`.
- **Active editor context.** The message box includes the active file or selection by default. Toggle its chip to exclude it for one message. File chips show problem counts and Git status. Use **Shipwreck: Add Symbol to Chat** to attach the enclosing symbol, or `Alt+K` for a selection.
- **The rest of the ACP client side.** Permission requests, form and URL elicitations (for browser sign-in flows), agent terminals, slash commands, and agent plans.

## Settings

Open them from the chat view's `...` menu, then **Settings**.

**Agents**

| Setting | Default | Description |
| --- | --- | --- |
| `shipwreck.defaultAgent` | `""` | Agent to start with before you pick one, by registry ID or custom agent name. |
| `shipwreck.prewarm` | `true` | Start your last agent when VS Code starts. |
| `shipwreck.customAgents` | `[]` | Custom agents to launch, as `{ name, command, args, env }` objects. |
| `shipwreck.mcpServers` | `{}` | MCP servers to give every agent, keyed by name. |
| `shipwreck.ideTools` | `true` | Give agents the `vscode` MCP server with editor tools. Applies to new chats. |
| `shipwreck.registryUrl` | Official registry URL | Where the agent catalog comes from. |
| `shipwreck.acpV2` | `false` | Offer the draft ACP v2 protocol to agents that support it. Applies when an agent next starts. (Its off by default as recommed by ACP docs, but i use it personally and its pretty decent, give it a shot.)|

**Chat**

| Setting | Default | Description |
| --- | --- | --- |
| `shipwreck.context.activeFile` | `true` | Include the active file or selection by default. Toggle the chip to exclude it for one message. Only `file:` editors are included. Problem text is limited to 20 errors or warnings, with 300 characters per diagnostic. |
| `shipwreck.showCost` | `false` | Show the session's cost next to the context meter, when the agent reports it. |
| `shipwreck.newChatShortcut` | `false` | Use `Ctrl+N` (`Cmd+N`) for New Chat while the chat has focus. |
| `shipwreck.codeLens.todo` | `true` | Show "Implement with <agent>" above TODO and FIXME comments. |

**Threads**

| Setting | Default | Description |
| --- | --- | --- |
| `shipwreck.threads.carryContext` | `true` | When you switch agents in a thread, give the new agent a summary of the conversation so far. |
| `shipwreck.switchWhileRunning` | `keepRunning` | What happens to a running turn when you switch agents or threads: `keepRunning` or `ask`. |
| `shipwreck.threads.scope` | `workspace` | Which threads the Threads list shows first: `workspace` or `all`. |
| `shipwreck.threads.importFromAgents` | `true` | List the connected agent's own past sessions in Threads for import. |

**Permissions and changes**

| Setting | Default | Description |
| --- | --- | --- |
| `shipwreck.autoApprovePermissions` | `never` | Answer permission requests for you: `never`, `allowOnce`, or `always`. |
| `shipwreck.changeSnapshots` | `true` | Snapshot the workspace with Git at each turn so Changes can list and undo every change. |

## Compatibility

Shipwreck uses ACP v1 by default. Turn on `shipwreck.acpV2` to try draft ACP v2 version and it (agent) that supports v2 then uses it, if there's an agent that only speaks v1 it keeps using v1. v2 is still a draft, so an agent update can change how it behaves. Turn the setting off to go back to v1. i personally like using v2 tho, but v1 could be more stable as thats what i built it on for the most part, v2 supprot was added later on.

On v2, agents read and write files and run commands themselves instead of through VS Code. Changes then relies on Git snapshots to list and undo what the agent changed etc. i'll work on seeing what i can do to improve on this laterr on.

## Privacy

Shipwreck collects no telemetry. Agents run on your machine as child processes of VS Code. Your prompts and code go only to the agent you chose via ACP.

## Development

```bash
npm install
npm run build     # or: npm run watch
npm test          # extension checks against mock agents
npm run package   # builds shipwreck-<version>.vsix
```

Press `F5` (Run Extension) to open an Extension Development Host.

`scripts/smoke-acp.js` runs the ACP handshake against a local agent:

```bash
node scripts/smoke-acp.js devin acp
```

## Releasing

Pushing a tag `v<version>` runs `.github/workflows/release.yml`. It type-checks, runs `npm test`, builds `shipwreck-<version>.vsix`, and creates a GitHub release with that file and the version's `CHANGELOG.md` section as notes. It also publishes to the VS Code Marketplace when the `VSCE_PAT` secret is set, and to Open VSX when `OVSX_PAT` is set. The tag must match the `version` in `package.json`.

```bash
# bump "version" in package.json and package-lock.json, add a "## <version>" section to CHANGELOG.md, commit
git tag v0.1.1
git push origin main v0.1.1
```

Running the workflow by hand (Actions, Release, Run workflow) does the same checks and uploads the VSIX as a build artifact without releasing.
## License

Shipwreck is licensed under the GNU General Public License v3.0 or later, in `LICENSE`. Bundled third-party code and icons keep their own licenses, listed in `THIRD_PARTY_NOTICES.md`. Regenerate that file with `node scripts/gen-notices.js` after changing dependencies.

I'm planning on adding this to VScode marketpace and also OpenVSX thingy that vscodium and other vscode forks use, ill update the readme here with links to it once i do that lateron. for now , you can find releases on releases part of this repo. 
