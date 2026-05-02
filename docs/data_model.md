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
- timestamps.

### Event

Append-only record of session activity:

- messages,
- actions,
- approvals,
- terminal state,
- diff updates,
- apply patch/snapshot/delivery actions,
- errors.

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
