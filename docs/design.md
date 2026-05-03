# Design

## Product Thesis

Agent Workbench is a session-native workbench for operating coding agents.

It preserves native agent behavior where that matters, especially Gemini CLI, Codex CLI, Claude Code, Qwen Code, and GitHub Copilot CLI, and adds the missing operator layer:

- multi-project visibility,
- multi-session coordination,
- isolated worktrees,
- reviewable changes,
- snapshots,
- delivery actions,
- dashboard-level progress.

## Design Principles

### Local First

All projects, events, sessions, diffs, snapshots, and terminals are local by default.

### Web UI, Local Gateway

The browser renders the UI. The local Node gateway owns filesystem access, git, PTY, agent CLI integration, and storage.

### Session Native

A Workbench session should bind to the real backend session when possible. For Gemini, Codex, Claude, Qwen, and Copilot, that means native session IDs and native terminal attach/resume.

### Worktree Isolation

Agent work happens in isolated worktrees. Each implementation session owns one real branch checked out in one isolated worktree.

### Review First

The main daily value is not raw protocol logs. The main daily value is reviewing and shaping code changes.

### Debug Secondary

Raw events, tool payloads, and backend traces belong in Diagnostics. They are important for development, not the default operator surface.

### Delivery Is One Click By Default

The user can manually add, commit, and push. But Draft PR should be a product-level action that performs the whole delivery chain when possible.

## Layout

### Left Sidebar

- app identity,
- settings,
- projects,
- Session Overview entry,
- sessions,
- session search,
- session actions.

### Center Workspace

Session tabs:

- Changes,
- Events,
- Snapshots,
- Diagnostics,
- Terminal.

The center workspace owns review, editing, snapshots, delivery, diagnostics, and the optional read-only terminal projection.

Terminal projection is intentionally read-only. It mirrors the useful transcript from the native terminal, preserves terminal styling where possible, filters live prompt/footer/status chrome, and supports independent zoom.

### Right Panel

The right panel keeps the native Agent Terminal visible for the selected session.

It is intentionally separate from the independent project shell. Agent Terminal is for the native coding CLI; project shell is for manual work inside the same session worktree.

## Core Interactions

### Delivery

Tooltip:

```text
Stage, commit, push, and create a draft PR from this session branch.
```

### Apply Patch

Tooltip:

```text
Apply reviewed changes from the isolated session worktree into another branch. This is an advanced fallback, not the default shipping path.
```

### Session Branch

Tooltip:

```text
This session owns one real branch checked out in one isolated worktree.
```

### Draft PR

Tooltip:

```text
Create a draft PR from the session branch. Workbench automatically stages, commits, pushes, then creates the draft PR.
```

## Branch Model

One implementation session maps to one user-visible git branch and one isolated worktree.

User-facing session branch management is intentionally small:

- rename branch,
- show base branch,
- show worktree path.

Delivery uses the session branch.

## Snapshot Model

Snapshots are user-visible restore points. They can include:

- label,
- description,
- timestamp,
- patch content,
- rollback target.

Snapshots are intended for risky review/edit cycles.

## Events Model

Events are still stored because audit and debugging matter. The UI, however, should show operator-level events by default:

- user messages,
- final agent replies,
- approvals,
- key read/edit/shell actions,
- apply patch/snapshot/delivery actions,
- failures.

Verbose tool payloads stay behind Diagnostics.
