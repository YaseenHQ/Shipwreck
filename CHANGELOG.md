# Changelog

## 0.1.1

First public release.

- Chat with any Agent Client Protocol (ACP) agent in one VS Code panel all your ACP stuff - Claude, Codex, OpenCode, Droid, and the rest of the ACP registry.
- Agent catalog with one-click install from the ACP registry for `npx`, `uvx`, and binary agents, with checksum verification for binaries. Custom local agents go in `shipwreck.customAgents`. ill make this later on with better GUI on a lter update in future, but ACP registry has most of what i use at the momentt.
- One model menu for agent, model, and reasoning effort. Search finds models across every installed agent, favorites sit at the top, and `Ctrl+1` to `Ctrl+9` pick a model while the menu is open.
- Tool calls, terminal output, plans, and permission requests stream into the chat as cards. Edits open in the VS Code diff editor.
- A Changes card after each turn lists every file the agent changed, with Review and Undo. Git snapshots back it, and it also works in folders that are not Git repositories. The Edits bar collects unreviewed changes across turns.
- The message box shows the file you're on, or its selected lines, and sends it with your message. File chips show problem counts and Git status. **Shipwreck: Add Symbol to Chat** and `Alt+K` attach code from the editor.
- Paste or drop images and files into the message box.
- Threads with history, plus import of sessions the agent started outside VS Code.
- Switch agents in the middle of a thread. The new agent gets the conversation so far.
- Agents start when VS Code does, so the first message doesn't wait for a launch. check prewarm thingy
- A `vscode` MCP server gives agents diagnostics, open editors, selection, definitions, references, hover, and symbols.
- Optional support for the draft ACP v2 protocol through `shipwreck.acpV2`, off by default. Agents that only speak v1 keep using v1.
