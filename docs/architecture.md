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
  +-- Gemini adapters
  +-- PTY terminals
  +-- Git client
  +-- Storage
  +-- Event bus
  |
Local machine
  git repositories
  isolated worktrees
  Gemini CLI
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
- Gemini terminal attach,
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
- apply changes,
- sync worktrees,
- manage snapshots,
- manage delivery,
- run git commands.

## packages/adapters

Agent backend adapters:

- Gemini ACP backend,
- one-shot Gemini fallback,
- generic PTY backend.

The adapter boundary is intentionally capability-based so future agents can be added without rewriting the UI.

## Worktree Flow

1. User creates a session.
2. User chooses a working branch.
3. Workbench creates or switches the original repository to that branch.
4. Workbench creates an internal `agent-workbench/*` isolated worktree.
5. Agent works in the isolated worktree.
6. User reviews changes.
7. User applies changes back to the original repository active branch.

## Delivery Flow

Delivery operates on the original repository active branch:

```text
original repo active branch
  |
  +-- add selected files
  +-- commit
  +-- push
  +-- draft PR
```

Draft PR can run the whole chain automatically.

## Terminal Flow

There are two different terminal concepts:

- Gemini Terminal: native agent CLI session attached to the selected Workbench session.
- Project shell: manual shell in the original project repository for operator fixes.

They are intentionally separate.
