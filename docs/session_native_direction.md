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

## Native Gemini Sessions

For Gemini CLI, Workbench should preserve native behavior:

- native Gemini session IDs,
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
apply
deliver
```

## Terminal Is Part Of The Session

The terminal is not just an escape hatch. It preserves native CLI behavior.

For Gemini, the attached terminal lets the user keep using the CLI naturally while Workbench tracks changes and delivery.
