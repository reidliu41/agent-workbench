# Agent Workbench

Agent Workbench is a local-first web workspace for managing coding-agent work across multiple projects and multiple sessions.

It focuses on one practical workflow: run several agent tasks in parallel, keep them isolated, review the code changes clearly, then apply or deliver the work when it is ready.

![Agent Workbench dashboard](agent-workbench.png)

## 🚀 Main Features

- 🚀 Multi-project management for local git repositories.
- 🔥 Multi-agent and multi-session workflow, with each session isolated from the others.
- 📊 Session Overview dashboard for current progress, status, blockers, changed files, and review state.
- 🤖 Gemini CLI support as the first backend, including native terminal attach.
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
4. Attach Gemini CLI from the terminal panel, or use the Gemini ACP backend.
5. Let the agent work in its isolated session worktree.
6. Review changed files in Changes.
7. Use Apply to repo to move isolated changes into the original repo active branch.
8. Use Sync to latest to update the isolated session from the original repo active branch.
9. Use Delivery to add, commit, push, and create a draft PR.

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

## Documentation

Detailed design and architecture notes are in [docs](docs/).
