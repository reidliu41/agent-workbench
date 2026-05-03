# Data Model

## Storage

Default storage is a local JSON store:

```text
~/.agent-workbench/store.json
```

The JSON store keeps installation simple and avoids native database dependencies in the published npm package.

## Core Entities

### Project

A registered local git repository.

Fields:

- id,
- name,
- path,
- defaultBranch,
- createdAt,
- updatedAt.

### Task / Session

A durable agent session.

Fields include:

- id,
- projectId,
- backendId,
- title,
- status,
- agentSessionId,
- agentSessionKind,
- agentSessionOrigin,
- baseBranch,
- modeId,
- worktreePath,
- worktreeBranch,
- branches,
- brainstorm config for Brainstorm Mix sessions,
- timestamps.

Implementation sessions have a worktree branch. Brainstorm Mix sessions normally do not; they keep participant config and transcript location instead.

### Event

Append-only record of session activity:

- messages,
- actions,
- approvals,
- terminal state,
- diff updates,
- brainstorm round/participant responses,
- apply patch/snapshot/delivery actions,
- errors.

### Brainstorm Transcript

Brainstorm Mix stores a markdown transcript and JSONL round log outside the project repository:

```text
~/.agent-workbench/brainstorm/<session-id>/
```

This keeps planning discussion separate from git diffs and implementation worktrees.

The session stores available participants and the last selected participant set. Each brainstorm message can override participants for that round, which supports per-round selection and `@agent` targeting without changing the session definition.

### Diff Snapshot

Stored view of changed files and patch text for a session.

### Session Snapshot

Named restore point with:

- label,
- optional description,
- timestamp,
- patch path/content metadata.

### Delivery Entry

Derived from session action events:

- add,
- commit,
- push,
- draft PR,
- compare URL fallback,
- branch,
- commit sha,
- remote,
- status.

## Branch Semantics

Each implementation session owns one real branch checked out in one isolated Workbench worktree.

Delivery operates on the session worktree branch. Apply Patch is an advanced fallback for moving reviewed changes into another branch.

## File Uploads

Clipboard images are saved under Workbench-controlled upload storage and inserted into prompts as file references.

## Reliability

Storage should preserve enough state to recover after restart:

- projects,
- sessions,
- events,
- diffs,
- snapshots,
- delivery history.

Queued active process state is runtime state and should not unexpectedly continue after a deliberate stop/remove.
