# Design

## Product Thesis

Agent Workbench is a session-native workbench for operating coding agents.

It preserves native agent behavior where that matters, especially Gemini CLI, and adds the missing operator layer:

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

The browser renders the UI. The local Node gateway owns filesystem access, git, PTY, Gemini integration, and storage.

### Session Native

A Workbench session should bind to the real backend session when possible. For Gemini, that means native Gemini session IDs and native terminal attach.

### Worktree Isolation

Agent work happens in isolated worktrees. The original repository is changed only through explicit apply or delivery actions.

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
- Delivery,
- Diagnostics,
- Terminal.

The center workspace owns review, editing, snapshots, and delivery.

### Right Panel

The right panel keeps the native Gemini Terminal visible for the selected session.

It is intentionally separate from the independent project shell. Gemini Terminal is for the agent session; project shell is for manual repository work when needed.

## Core Interactions

### Apply To Repo

Tooltip:

```text
Apply changes from the Agent Workbench isolated worktree to the current active branch in the original repository.
```

### Sync To Latest

Tooltip:

```text
Sync the current active branch in the original repository into the Agent Workbench isolated worktree.
```

### Draft PR

Tooltip:

```text
Create a draft PR from the original repository's current active branch. Workbench automatically stages, commits, pushes, then creates the draft PR.
```

## Branch Model

Internal `agent-workbench/*` branches are implementation details for isolated worktrees.

User-facing branch management is about the original project repository:

- create branch,
- switch branch,
- rename branch,
- remove branch,
- show current active branch.

Delivery uses the original repository's active branch.

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
- apply/sync/snapshot/delivery actions,
- failures.

Verbose tool payloads stay behind Diagnostics.
