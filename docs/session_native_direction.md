# Native Session Direction

## Decision

Agent Workbench should be session-native.

That means the user's real unit of work is the durable session, not a one-shot prompt and not a raw event stream.

## Why

Developer agent work is becoming:

- parallel,
- branch-based,
- session-based,
- review-heavy,
- PR-oriented.

The product should help operators manage that complexity.

## Native CLI Sessions

For Gemini CLI, Codex CLI, Claude Code, and Qwen Code, Workbench should preserve native behavior:

- native session IDs,
- native terminal attach,
- native slash commands,
- native auth/settings,
- native resume where supported.

Workbench should add:

- project/session dashboard,
- isolated worktrees,
- review,
- snapshots,
- delivery.

## Debug Is Secondary

Raw tool events and protocol details are still important, but they are not the daily workflow.

Default UI should show:

- user intent,
- agent outcome,
- key actions,
- changed files,
- delivery state.

Diagnostics should show raw details.

## Review Is Primary

The center of the product is the review loop:

```text
agent works
developer reviews
developer edits if needed
snapshot
deliver
```

## Terminal Is Part Of The Session

The terminal is not just an escape hatch. It preserves native CLI behavior.

For Gemini, Codex, Claude, and Qwen, the attached terminal lets the user keep using the CLI naturally while Workbench tracks changes and delivery.

The terminal can be split so the main workspace shows a read-only transcript projection while input remains in the native terminal panel.

Split projection is for review, not input. It preserves terminal colors where possible, filters CLI input/footer/status chrome, and provides browser-local zoom controls so long agent output is easier to read.
