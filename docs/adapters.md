# Backend Adapters

## Current Adapter Priority

Gemini CLI remains the first structured backend, but Workbench now also supports native terminal backends for Codex CLI, Claude Code, Qwen Code, and GitHub Copilot CLI.

Current adapter paths:

1. Brainstorm Mix through Workbench-controlled read-only CLI calls.
2. Gemini ACP through `gemini --acp`.
3. Native Gemini terminal attach.
4. Native Codex CLI terminal attach.
5. Native Claude Code terminal attach.
6. Native Qwen Code terminal attach.
7. Native GitHub Copilot CLI terminal attach.
8. One-shot Gemini fallback for simple/headless use.
9. Generic PTY fallback for manual or future agent experiments.

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

## Brainstorm Mix

Brainstorm Mix is not a terminal adapter. It is a Workbench orchestration mode.

Workbench owns:

- per-round participant selection,
- `@agent` targeting,
- project context assembly,
- shared transcript storage,
- sequential round execution,
- live participant state,
- summary events.

Participants own:

- model execution,
- auth,
- local CLI availability,
- their own reasoning style.

The first implementation uses each CLI's non-interactive or planning mode where available:

- Gemini: `gemini --prompt ... --approval-mode plan --output-format text`
- Codex: `codex exec --cd <project> --sandbox read-only ...`
- Claude: `claude --print --permission-mode plan ...`
- Qwen: `qwen --prompt ... --approval-mode plan --output-format text`
- Copilot: `copilot --prompt ... --mode plan`

Participant selection is not fixed at session creation. The UI lets the user choose participants before every round, and `@codex`, `@gemini`, `@claude`, `@qwen`, or `@copilot` narrows that round to the mentioned selected agents.

Brainstorm Mix is intentionally read-only. It does not create worktree branches, attach terminals, apply patches, run delivery, or open PRs.

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

## Native Qwen Code Terminal

Qwen Code runs as a native terminal backend inside the isolated session worktree.

Workbench creates a stable Qwen session id when the Workbench session is created:

```bash
qwen --session-id <id>
```

Later attaches use:

```bash
qwen --resume <id>
```

This keeps Qwen Code slash commands, memory commands, approvals, and model controls inside Qwen Code while Workbench provides dashboard, review, snapshots, apply patch fallback, and delivery.

Existing Qwen Code sessions can be imported from Qwen's project JSONL history. Because Qwen validates sessions against the current project path, Workbench bridges the selected session into the isolated session worktree and rewrites the stored `cwd` fields to that worktree before using `qwen --resume <id>`.

Qwen support follows the same native-session rule as the other CLIs: Qwen owns the interactive CLI behavior, while Workbench owns the project/session dashboard, worktree isolation, review, snapshots, and delivery.

## Native GitHub Copilot CLI Terminal

GitHub Copilot CLI runs as a native terminal backend inside the isolated session worktree.

Workbench creates a stable Copilot session id when the Workbench session is created. The first attach uses:

```bash
copilot --resume=<id>
```

Later attaches use:

```bash
copilot --resume=<id>
```

Copilot does not allow `--name` together with `--resume`, so Workbench keeps the human session title in Workbench metadata. This keeps Copilot slash commands, permissions, MCP, custom agents, plugins, and rollback behavior inside GitHub Copilot CLI while Workbench provides dashboard, review, snapshots, apply patch fallback, and delivery.

Existing Copilot session import is not wired yet. The first integration path is Workbench-managed Copilot sessions with fixed session IDs. A later adapter can add Copilot ACP support through `copilot --acp`.

## Split Terminal Projection

Native terminal adapters can use the Split control in the Agent Terminal.

Split keeps input in the right-side terminal and projects a read-only transcript into the center workspace. The projection reads xterm buffer cells instead of plain text, so it can preserve foreground/background colors and basic styling. It filters live input prompts, footer/status lines, and Workbench terminal banners so the center view focuses on agent output. Projection zoom is local to the browser.

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
