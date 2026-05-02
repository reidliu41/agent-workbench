# Technology Stack

## Main Stack

Agent Workbench is TypeScript-first.

```text
Node.js 20.19+
npm workspaces
Fastify
React
Vite
JSON local store
node-pty
xterm.js
```

## Why TypeScript

The product crosses web UI, local server, CLI process management, git operations, and shared protocol types.

TypeScript keeps frontend/backend types aligned and lowers contributor friction.

## Frontend

- React.
- Vite.
- xterm.js for terminal surfaces.
- CSS modules through the app stylesheet.
- Shared API types from `packages/protocol`.

Important UI priorities:

- dense developer-tool layout,
- clear active branch and session state,
- review-first Changes tab,
- visible terminal attach,
- concise dashboards,
- no marketing page.

## Server

- Fastify HTTP server.
- Fastify WebSocket.
- local token auth.
- static web asset serving.
- filesystem and project directory APIs.
- native agent and terminal socket management.

## Core

`packages/core` owns:

- orchestration,
- git operations,
- storage,
- event bus,
- sessions,
- snapshots,
- apply patch/delivery.

## Protocol

`packages/protocol` contains shared TypeScript request/response and event types.

## Adapters

`packages/adapters` contains backend integrations.

Current:

- Gemini ACP,
- Gemini one-shot,
- native Gemini terminal,
- native Codex terminal,
- native Claude Code terminal,
- generic PTY.

Future:

- OpenCode,
- other CLI agents.

## Development Commands

```bash
npm install
npm run dev
npm run serve -- --host 127.0.0.1 --port 3030
npm run doctor
npm run typecheck
npm run build
```
