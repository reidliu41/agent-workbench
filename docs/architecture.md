# Architecture

## Overview

Agent Workbench is a local web application.

```text
Browser UI
  React + Vite
  |
  | HTTP + WebSocket
  |
Local Node Gateway
  Fastify
  |
  +-- Workbench Orchestrator
  +-- Agent adapters
  +-- PTY terminals
  +-- Git client
  +-- Storage
  +-- Event bus
  |
Local machine
  git repositories
  isolated worktrees
  Gemini CLI / Codex CLI / Claude Code / Qwen Code
```

The browser never directly reads local files or spawns local processes. All privileged actions go through the local gateway.

## Monorepo

```text
agent-workbench/
  apps/
    cli/
    server/
    web/
  packages/
    adapters/
    core/
    protocol/
  docs/
  scripts/
```

## apps/cli

Responsibilities:

- parse CLI arguments,
- start the local server,
- print tokenized URLs,
- run doctor checks.

Important commands:

```bash
npm run serve -- --host 127.0.0.1 --port 3030
npm run doctor
```

## apps/server

Fastify gateway.

Responsibilities:

- token auth,
- origin checks,
- HTTP APIs,
- WebSocket event streams,
- project directory browsing,
- session terminal sockets,
- project shell sockets,
- static web asset serving.

## apps/web

React UI.

Responsibilities:

- project and session management,
- Session Overview dashboard,
- Changes workspace,
- snapshot UI,
- Delivery UI,
- Diagnostics UI,
- native agent terminal attach,
- voice input,
- clipboard image upload.

## packages/protocol

Shared TypeScript types for frontend and backend:

- Project,
- Task,
- AgentEvent,
- DiffSnapshot,
- SessionSnapshot,
- Delivery responses,
- Branch responses,
- API request/response types.

The UI depends on protocol types. It must not depend on Gemini internals.

## packages/core

Core orchestration:

- create projects,
- create sessions,
- create isolated worktrees,
- manage tasks,
- normalize events,
- collect diffs,
- apply patch fallback,
- manage snapshots,
- manage delivery,
- run git commands.

## packages/adapters

Agent backend adapters:

- Gemini ACP backend,
- one-shot Gemini fallback,
- native Gemini terminal,
- native Codex terminal,
- native Claude Code terminal,
- native Qwen Code terminal,
- generic PTY backend.

The adapter boundary is intentionally capability-based so future agents can be added without rewriting the UI.

## Worktree Flow

1. User creates a session.
2. User chooses a session branch.
3. Workbench creates or reuses that real branch.
4. Workbench checks the branch out in a dedicated isolated session worktree.
5. Agent works in the isolated worktree.
6. User reviews changes.
7. User delivers the session branch through add/commit/push/draft PR.

## Delivery Flow

Delivery operates on the isolated session worktree branch:

```text
session worktree branch
  |
  +-- add selected files
  +-- commit
  +-- push
  +-- draft PR
```

Draft PR can run the whole chain automatically.

## Terminal Flow

There are two different terminal concepts:

- Agent Terminal: native Gemini, Codex, Claude, or Qwen CLI session attached to the selected Workbench session.
- Project shell: manual shell in the selected session worktree for tests, git inspection, and operator fixes.

They are intentionally separate.

The Agent Terminal can also be split: input stays in the right terminal panel, while a read-only transcript projection appears in the center workspace.

The projection is rendered from xterm buffer cells rather than plain text. This lets Workbench preserve terminal colors and basic styling while filtering prompt/footer/status chrome. Projection zoom is independent from the real terminal.
