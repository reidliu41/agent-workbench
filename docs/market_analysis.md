# Market Analysis

## Direction

Coding-agent tools are moving from single chat sessions toward agent workbenches:

- many tasks,
- background sessions,
- branch and PR workflows,
- reviewable diffs,
- native terminal/IDE/web surfaces,
- human supervision.

Agent Workbench fits this direction as a local-first operator surface.

## What Existing Tools Do Well

### Native CLIs

Gemini CLI, Claude Code, Codex-style CLIs, and similar tools are strong at native terminal workflows.

They already provide:

- prompt loops,
- slash commands,
- tool execution,
- terminal UX,
- model integration.

### IDEs

IDEs are strong at:

- code editing,
- file navigation,
- inline diff,
- language services.

### Cloud Agents

Cloud PR agents are strong at:

- background work,
- branch creation,
- PR-centered review,
- CI integration.

## Gap

The gap is local multi-agent operations:

- Which local sessions are running?
- Which repo and branch are they using?
- What changed?
- Which changes overlap?
- Which sessions are ready to review?
- Can I inspect the native terminal?
- Can I edit and ship safely?

Agent Workbench targets this gap.

## Differentiation

Agent Workbench is not trying to out-chat native agents.

It differentiates by combining:

- local-first operation,
- multi-project/session dashboard,
- native Gemini CLI attach,
- isolated worktrees,
- visual review,
- snapshots,
- one-click delivery.

## Current Best First Backend

Gemini CLI remains the best first backend because:

- it is terminal-native,
- it has a real CLI session model,
- it exposes ACP,
- it supports native command workflows,
- it is easy for developers to install and test locally.

## Product Bet

The long-term product is not "a web version of one CLI." The long-term product is:

```text
a local operating surface for many coding-agent sessions
```

Gemini CLI is the first backend that makes this practical.
