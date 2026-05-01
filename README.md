# Agent Workbench

Agent Workbench is a local-first web workspace for managing coding-agent work across multiple projects and multiple sessions.

It focuses on one practical workflow: run several agent tasks in parallel, keep them isolated, review the code changes clearly, then apply or deliver the work when it is ready.

![Agent Workbench dashboard](agent-workbench.png)

## 🚀 Main Features

- 🚀 Multi-project management for local git repositories.
- 🔥 Multi-agent and multi-session workflow, with each session isolated from the others.
- 📊 Session Overview dashboard for current progress, status, blockers, changed files, and review state.
- 🤖 Gemini CLI and Codex CLI support through native terminal attach.
- 🔁 Native CLI resume binding: Workbench links Gemini/Codex session IDs and reattaches with resume automatically.
- 👀 Changes view for reviewing CLI/agent edits immediately after they happen.
- 🛠️ Apply to repo, Sync to latest, snapshots, branch management, add/commit/push, and Draft PR delivery.
- 🎙️ Browser voice input for faster prompting when supported by browser permissions.
- 🖼️ Clipboard screenshot upload, inserting an image path into the CLI prompt.

## Install

Requirements:

- Node.js 20.19 or newer
- npm
- git
- Gemini CLI installed and authenticated for Gemini-backed sessions
- Codex CLI installed and authenticated for Codex-backed sessions

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
3. Create a new session and choose a working branch.
4. Choose Gemini CLI, Gemini ACP, or Codex CLI for the session.
5. Attach the native terminal from the right panel.
6. Workbench starts the selected CLI inside the isolated session worktree.
7. For Gemini and Codex, Workbench records the native session ID and uses resume on later attaches.
8. Let the agent work in its isolated session worktree.
9. Review changed files in Changes.
10. Use Apply to repo to move isolated changes into the original repo active branch.
11. Use Sync to latest to update the isolated session from the original repo active branch.
12. Use Delivery to add, commit, push, and create a draft PR.

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
- [React](https://react.dev/) - User interface library.
- [Vite](https://vite.dev/) - Fast frontend build tool and development server.
- [Fastify](https://fastify.dev/) - Local HTTP and WebSocket server.
- [xterm.js](https://xtermjs.org/) - Browser terminal rendering.
- [node-pty](https://github.com/microsoft/node-pty) - Pseudo-terminal integration for native CLI sessions.

## Acknowledgments

Agent Workbench is built around the idea that native coding CLIs should keep their terminal-first power while gaining a web dashboard for multi-session supervision, review, snapshots, and delivery.

Gemini CLI and Codex CLI are the main native CLI workflows for the current release.

## Documentation

Detailed design and architecture notes are in [docs](docs/).
