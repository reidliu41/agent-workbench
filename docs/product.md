# Product

## Positioning

Agent Workbench is a local web workspace for supervising many coding-agent sessions across many projects.

The product is built around a practical developer workflow:

```text
start several agent sessions
watch progress from one dashboard
review what changed
edit when needed
snapshot before risk
apply to the active branch
ship with add/commit/push/draft PR
```

## Primary Users

- Developers using Gemini CLI for coding tasks.
- Developers who run multiple tasks in parallel.
- Developers working over SSH who want a browser-based control surface.
- Developers who want to review agent changes before they touch the original repository.
- Developers who want native CLI behavior but better session, diff, and delivery management.

## Main Value

### Multi-Agent And Multi-Session Control

The core problem is not "how to chat with one model." The core problem is operating many agent tasks safely:

- multiple projects,
- multiple sessions per project,
- isolated worktrees,
- independent native Gemini sessions,
- active/blocked/review-ready state,
- changed-file overlap awareness,
- session search and overview.

### Visual Dashboard

Session Overview gives a quick status view:

- total sessions,
- running sessions,
- sessions needing action,
- blocked sessions,
- changed files,
- session state summaries.

The goal is to let the operator choose what to review next without opening every terminal.

### Review-First Developer Workflow

For development work, the value is immediate review:

- CLI or agent edits appear in Changes.
- Changed files are visible in a file tree.
- Text files can be opened and edited.
- Diffs are shown inline with line numbers and added/removed highlighting.
- File edits can be saved back to the isolated session worktree.

### Gemini CLI First

The current backend focus is Gemini CLI:

- `gemini --acp` structured sessions,
- native Gemini terminal attach,
- Gemini session import/resume,
- Gemini auth/settings reuse,
- slash commands available through the native terminal.

Workbench does not try to reimplement every Gemini CLI feature in custom web controls. It keeps native terminal access available and adds review, dashboard, snapshots, and delivery around it.

### Voice And Screenshot Input

The browser interface supports faster prompt entry:

- voice input through browser speech APIs when the browser permits microphone access,
- clipboard image upload from screenshots,
- inserted image paths for agent prompts.

This is especially useful when reviewing UI bugs, screenshots, terminal output, or visual diffs.

## Current Workflow

### Create Session

The user selects:

- project,
- working branch,
- session name,
- agent backend,
- mode.

The working branch field can create a new branch or select an existing branch. Workbench switches the original repository to that branch before creating the isolated session.

### Run Agent

The session can use:

- Gemini ACP structured backend,
- attached native Gemini terminal,
- raw terminal fallback for manual work.

### Review Changes

The Changes tab shows:

- project file tree,
- changed files,
- selected file content,
- inline diff summary,
- raw file editor,
- save file,
- apply,
- branch manager,
- delivery,
- snapshots,
- sync to latest.

### Apply

Apply moves changes from the isolated worktree into the original repository's current active branch.

### Sync

Sync moves the original repository's current active branch into the isolated worktree.

### Delivery

Delivery targets the original repository's current active branch.

Actions:

- Add: choose changed files and stage selected files.
- Commit: commit staged files with a message.
- Push: push the active branch.
- Draft PR: automatically add, commit, push, then create a draft PR.

If `gh pr create` fails, Workbench falls back quietly to a GitHub compare URL. Git failures still surface as errors.

## Product Boundaries

Current version includes:

- local web app,
- local token auth,
- Gemini-first backend,
- git/worktree based isolation,
- review/diff/snapshot/delivery workflow.

Current version does not include:

- team accounts,
- cloud hosting,
- public tunnels,
- desktop packaging,
- full Codex/Claude/OpenCode adapters.
