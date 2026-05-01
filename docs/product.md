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

- Developers using Gemini CLI, Codex CLI, or Claude Code for coding tasks.
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
- independent native Gemini, Codex, and Claude sessions,
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

### Native CLI First

The current backend focus is native coding CLIs:

- `gemini --acp` structured sessions,
- native Gemini terminal attach,
- native Codex terminal attach,
- native Claude Code terminal attach,
- native Gemini, Codex, and Claude session import/resume,
- native auth/settings reuse,
- slash commands available through the native terminal.

Workbench does not try to reimplement every CLI feature in custom web controls. It keeps native terminal access available and adds review, dashboard, snapshots, and delivery around it.

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
- session name,
- agent backend,
- mode.

New sessions do not switch the original repository branch. Workbench creates an isolated session worktree from the current project state, and the final target branch is chosen later during Apply.

### Import Native CLI Session

The Sessions menu can import existing native CLI sessions:

- Gemini CLI sessions from Gemini's local project session store,
- Codex CLI sessions from Codex rollout metadata,
- Claude Code sessions from Claude project JSONL history.

Imported sessions are linked to Workbench sessions and reopen with each CLI's native resume command.

### Run Agent

The session can use:

- Gemini ACP structured backend,
- attached native Gemini terminal,
- attached native Codex terminal,
- attached native Claude Code terminal,
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

Apply moves changes from the isolated worktree into a selected original repository branch.

The Apply confirmation lets the user:

- choose an existing branch,
- type a new branch name,
- create and switch to that branch before applying.

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
- Gemini, Codex, and Claude native terminal workflows,
- git/worktree based isolation,
- review/diff/snapshot/delivery workflow.

Current version does not include:

- team accounts,
- cloud hosting,
- public tunnels,
- desktop packaging,
- full structured Codex/Claude/OpenCode event adapters.
