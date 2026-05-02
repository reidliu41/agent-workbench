# Backend Adapters

## Current Adapter Priority

Gemini CLI remains the first structured backend, but Workbench now also supports native terminal backends for Codex CLI and Claude Code.

Current adapter paths:

1. Gemini ACP through `gemini --acp`.
2. Native Gemini terminal attach.
3. Native Codex CLI terminal attach.
4. Native Claude Code terminal attach.
5. One-shot Gemini fallback for simple/headless use.
6. Generic PTY fallback for manual or future agent experiments.

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

Existing Gemini CLI sessions can be imported from Gemini's local project session store and linked to a Workbench session. Later attaches use `gemini --resume <id>`.

## Native Codex Terminal

Codex runs as a native terminal backend inside the isolated session worktree.

Workbench starts Codex with the session worktree path and later reattaches with `codex resume`.

Codex owns:

- slash commands,
- approvals,
- model controls,
- skills,
- terminal interaction.

Workbench owns:

- isolated worktrees,
- diff review,
- snapshots,
- apply patch fallback,
- session branch and delivery workflow.

Existing Codex sessions can be imported from Codex rollout metadata and linked to a Workbench session. Later attaches use `codex resume --cd <session-worktree> <id>`.

## Native Claude Code Terminal

Claude Code runs as a native terminal backend inside the isolated session worktree.

Workbench creates a stable Claude session ID before the first attach:

```bash
claude --session-id <id>
```

Later attaches reopen it with:

```bash
claude --resume <id>
```

This keeps Claude Code slash commands, plugins, skills, hooks, permissions, and model controls inside Claude Code while Workbench provides dashboard, review, snapshots, apply patch fallback, and delivery.

Existing Claude Code sessions can be imported from Claude project JSONL history and linked to a Workbench session. Later attaches use `claude --resume <id>`.

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
run session -> review changes -> snapshot -> deliver
```
