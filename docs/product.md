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
ship the session branch with add/commit/push/draft PR
```

## Primary Users

- Developers using Gemini CLI, Codex CLI, Claude Code, or Qwen Code for coding tasks.
- Developers who run multiple tasks in parallel.
- Developers working over SSH who want a browser-based control surface.
- Developers who want each agent task isolated in its own branch/worktree until it is reviewed.
- Developers who want native CLI behavior but better session, diff, and delivery management.

## Main Value

### Multi-Agent And Multi-Session Control

The core problem is not "how to chat with one model." The core problem is operating many agent tasks safely:

- multiple projects,
- multiple sessions per project,
- isolated worktrees,
- independent native Gemini, Codex, Claude, and Qwen sessions,
- ready/running/review/needs-action/detached/failed state,
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
- native Qwen Code terminal attach,
- native Gemini, Codex, Claude, and Qwen session import/resume,
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

### Session-To-Branch Model

The default product model is:

```text
one implementation session -> one real branch -> one isolated worktree -> usually one PR
```

This keeps review, delivery, and rollback understandable:

- each session has a clear scope,
- each session diff maps to one owned branch,
- add/commit/push/draft PR actions stay simple,
- multiple agents can work in parallel without sharing an uncommitted working tree.

For large features, the recommended flow is:

1. Create a planning session.
2. Ask the agent to split the work into smaller PR-sized tasks.
3. Create one implementation session for each planned branch.
4. Review and ship each branch independently.

Future versions may support applying selected files from one session into multiple target branches as an advanced recovery workflow, but that is not the primary design. The primary design remains one implementation session per branch.

### Create Session

The user selects:

- project,
- session branch,
- session name,
- agent backend,
- mode.

The session branch is a real git branch checked out in one isolated Workbench worktree. A new implementation session should normally use a new branch name. Existing branches can be selected when the user intentionally wants to continue that branch in a new Workbench session.

### Import Native CLI Session

The Sessions menu can import existing native CLI sessions:

- Gemini CLI sessions from Gemini's local project session store,
- Codex CLI sessions from Codex rollout metadata,
- Claude Code sessions from Claude project JSONL history,
- Qwen Code sessions can be imported through a project-path bridge that copies the selected Qwen JSONL history into the isolated Workbench worktree and rewrites its stored `cwd`.

Imported sessions are linked to Workbench sessions and reopen with each CLI's native resume command.

### Run Agent

The session can use:

- Gemini ACP structured backend,
- attached native Gemini terminal,
- attached native Codex terminal,
- attached native Claude Code terminal,
- attached native Qwen Code terminal,
- raw terminal fallback for manual work.

The right-side Agent Terminal preserves the native CLI experience. The Split button projects a read-only, color-preserving terminal transcript into the center workspace while keeping input in the terminal panel.

The projection is intentionally not another input surface. It is a review surface:

- terminal colors and basic cell styling are preserved,
- CLI prompt/footer/status areas are filtered out,
- the center workspace can be zoomed independently from the real terminal,
- Gemini, Codex, Claude Code, and Qwen Code can keep their native command loops.

### Review Changes

The Changes tab shows:

- project file tree,
- changed files,
- selected file content,
- inline diff summary,
- raw file editor,
- save file,
- apply,
- session branch,
- delivery,
- snapshots,
- terminal projection.

### Delivery

Delivery is the primary shipping flow and operates on the isolated session worktree branch.

Actions:

- Add: choose changed files and stage selected files.
- Commit: commit staged files with a message.
- Push: push the session branch.
- Draft PR: automatically add, commit, push, then create a draft PR.

If `gh pr create` fails, Workbench falls back quietly to a GitHub compare URL. Git failures still surface as errors.

### Apply Patch

Apply Patch is an advanced fallback for moving reviewed isolated changes into another branch. It is not the default daily workflow; the recommended path is one session branch and Delivery.

## Product Boundaries

Current version includes:

- local web app,
- local token auth,
- Gemini, Codex, Claude, and Qwen native terminal workflows,
- git/worktree based isolation,
- review/diff/snapshot/delivery workflow.

Current version does not include:

- team accounts,
- cloud hosting,
- public tunnels,
- desktop packaging,
- full structured Codex/Claude/OpenCode event adapters.
