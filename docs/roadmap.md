# Roadmap

## v0.1: Native CLI Workbench

Goal: make native coding CLIs usable from a local web workbench with strong review and delivery.

Included:

- multi-project UI,
- multi-session UI,
- isolated worktrees,
- Session Overview dashboard,
- Gemini ACP backend,
- native Gemini terminal attach,
- native Codex terminal attach,
- native Claude Code terminal attach,
- native Qwen Code terminal attach,
- Changes review/edit workspace,
- snapshots,
- one session -> one branch -> one isolated worktree,
- delivery add/commit/push/draft PR,
- voice input,
- screenshot upload,
- enhanced terminal split projection with color-preserving transcript, footer filtering, and zoom controls.

## v0.2: Reliability And Polish

Focus:

- stronger branch/delivery tests,
- reinforce the one implementation session -> one branch/worktree model,
- planning-session workflow for splitting large work into smaller branch/session tasks,
- clearer compare summaries,
- better terminal lifecycle cleanup,
- stronger native CLI projection profiles,
- better session recovery,
- improved UI density,
- improved error remediation,
- HTTPS/local certificate option for browser permissions.

## v0.3: More Agent Backends And Policies

Candidate backends:

- OpenCode,
- custom CLI profiles.

Goal: expand the Workbench workflow across more agents without losing review and safety.

## v0.4: Team-Grade Local Workflow

Focus:

- optional PR-slice recovery workflow for applying selected files from one session to multiple branches,
- stronger audit exports,
- project profiles,
- environment profiles,
- policy presets,
- richer diagnostics,
- PR/CI status integration.

## v1.0: Stable Local Agent Workbench

Expected:

- Gemini, Codex, Claude, and Qwen native terminal workflows stable for daily use,
- at least one additional backend path beyond those three,
- reliable session dashboard,
- reliable review/edit/delivery,
- clear documentation,
- repeatable setup,
- safe local defaults.
