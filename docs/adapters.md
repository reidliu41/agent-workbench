# Backend Adapters

## Current Adapter Priority

Gemini CLI is the first supported backend.

Current adapter paths:

1. Gemini ACP through `gemini --acp`.
2. Native Gemini terminal attach.
3. One-shot Gemini fallback for simple/headless use.
4. Generic PTY fallback for manual or future agent experiments.

## Capability Model

Adapters should declare capabilities instead of forcing the UI to know every backend detail.

Important capabilities:

- persistent session,
- terminal attach,
- structured stream,
- tool events,
- approval events,
- diff awareness,
- resume,
- cancel,
- delivery support,
- screenshot/path input support.

## Gemini ACP

Gemini ACP is the preferred structured backend.

Workbench owns:

- session records,
- project/worktree isolation,
- event persistence,
- UI state,
- diff review,
- snapshots,
- delivery.

Gemini owns:

- model execution,
- auth,
- native settings,
- tools,
- CLI behavior,
- slash command behavior.

## Native Gemini Terminal

Native terminal attach is not a fallback-only feature. It is part of the product.

It preserves:

- Gemini slash commands,
- native CLI UI,
- MCP/tool behavior,
- interactive editing flow,
- session continuity.

Workbench adds review and delivery around that native session.

## One-Shot Gemini Backend

The one-shot backend is useful for diagnostics and simple tasks, but it is not enough for the main product because it lacks the durable interactive session experience.

## Generic PTY Backend

Generic PTY can launch arbitrary CLI agents, but Workbench cannot fully understand their semantics.

Use it for:

- experiments,
- manual fallback,
- adapter development,
- comparing native CLI behavior.

Do not treat it as equivalent to a structured backend.

## Future Backends

Planned candidates:

- Codex,
- Claude Code,
- OpenCode,
- OpenHands,
- custom CLI agents.

Future adapters should reuse the same Workbench surfaces:

- projects,
- sessions,
- dashboard,
- changes,
- snapshots,
- delivery,
- diagnostics.

## Rule

The agent backend may differ, but the operator workflow should stay consistent:

```text
run session -> review changes -> snapshot -> apply -> deliver
```
