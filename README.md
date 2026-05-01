# Agent Workbench

Agent Workbench is a local-first web workspace for managing coding-agent work across multiple projects and multiple sessions.

It focuses on one practical workflow: run several agent tasks in parallel, keep them isolated, review the code changes clearly, then apply or deliver the work when it is ready.

![Agent Workbench dashboard](agent-workbench.png)

## 🚀 Main Features

- 🚀 Multi-project management for local git repositories.
- 🔥 Multi-agent and multi-session workflow, with each session isolated from the others.
- 📊 Session Overview dashboard for current progress, status, blockers, changed files, and review state.
- 🤖 Gemini CLI, Codex CLI, and Claude Code support through native terminal attach.
- 🔁 Native CLI resume binding: Workbench links Gemini, Codex, and Claude session IDs and reattaches with resume automatically.
- 🔎 Native session import for existing Gemini CLI, Codex CLI, and Claude Code sessions.
- 👀 Changes view for reviewing CLI/agent edits immediately after they happen.
- 🛠️ Apply to repo with target branch selection/creation, Sync to latest, snapshots, branch management, add/commit/push, and Draft PR delivery.
- 🎙️ Browser voice input for faster prompting when supported by browser permissions.
- 🖼️ Clipboard screenshot upload, inserting an image path into the CLI prompt.

## Install

Requirements:

- Node.js 20.19 or newer
- npm
- git
- Gemini CLI installed and authenticated for Gemini-backed sessions
- Codex CLI installed and authenticated for Codex-backed sessions
- Claude Code installed and authenticated for Claude-backed sessions

Install the published package:

```bash
npm install -g @agent-workbench/cli
```

Start Agent Workbench:

```bash
agent-workbench serve
```

Check local runtime dependencies:

```bash
agent-workbench doctor
```

The default bind address is `127.0.0.1:3030`. The server prints a tokenized URL. Keep the token private.

## Run From Source

Install dependencies:

```bash
npm install
```

Run from source:

```bash
npm run serve
```

Check source dependencies:

```bash
npm run doctor
```

## Basic Usage

1. Open the Workbench URL in a browser.
2. Add a local git project.
3. Create a new session.
4. Choose Gemini CLI, Gemini ACP, Codex CLI, or Claude Code for the session.
5. Attach the native terminal from the right panel.
6. Workbench starts the selected CLI inside the isolated session worktree.
7. Workbench records the native CLI session ID and uses resume on later attaches.
8. Let the agent work in its isolated session worktree.
9. Review changed files in Changes.
10. Use Apply to repo to choose or create the original repo target branch, then move isolated changes there.
11. Use Sync to latest to update the isolated session from the original repo active branch.
12. Use Delivery to add, commit, push, and create a draft PR.

You can also import existing native CLI sessions from the Sessions menu:

- Gemini CLI sessions from Gemini's local session store.
- Codex CLI sessions from Codex rollout metadata.
- Claude Code sessions from Claude project JSONL history.

Imported sessions become regular Workbench sessions and reopen through each CLI's resume command.

## CLI Backends

Gemini CLI:

- Native terminal attach starts `gemini`.
- After Gemini creates a native session ID, Workbench records it.
- Later attaches use `gemini --resume <id>`.
- Gemini ACP remains available for structured tool events where supported.

Codex CLI:

- Native terminal attach starts `codex --cd <session-worktree>`.
- After Codex writes its rollout metadata, Workbench records the Codex session ID.
- Later attaches use `codex resume --cd <session-worktree> <id>`.
- Codex slash commands, approvals, skills, and model controls stay native inside Codex CLI.

Claude Code:

- Native terminal attach starts `claude --session-id <id>` in the session worktree.
- Workbench creates the Claude session ID up front, so the AW session and Claude session are bound from the first attach.
- Later attaches use `claude --resume <id>`.
- Claude Code slash commands, plugins, skills, hooks, permissions, and model controls stay native inside Claude Code.

## Development

Run the development server:

```bash
npm run dev
```

Run checks:

```bash
npm run typecheck
npm run build
```

Additional smoke checks:

```bash
npm run smoke
```

## Built With

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) - Google's official Gemini command-line coding agent.
- [Codex CLI](https://github.com/openai/codex) - OpenAI's command-line coding agent.
- [Claude Code](https://github.com/anthropics/claude-code) - Anthropic's command-line coding agent.
- [React](https://react.dev/) - User interface library.
- [Vite](https://vite.dev/) - Fast frontend build tool and development server.
- [Fastify](https://fastify.dev/) - Local HTTP and WebSocket server.
- [xterm.js](https://xtermjs.org/) - Browser terminal rendering.
- [node-pty](https://github.com/microsoft/node-pty) - Pseudo-terminal integration for native CLI sessions.

## Acknowledgments

Agent Workbench is built around the idea that native coding CLIs should keep their terminal-first power while gaining a web dashboard for multi-session supervision, review, snapshots, and delivery.

Gemini CLI, Codex CLI, and Claude Code are the main native CLI workflows for the current release.

## Documentation

Detailed design and architecture notes are in [docs](docs/).
