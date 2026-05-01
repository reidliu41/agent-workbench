# Implementation Plan

## Current Baseline

Implemented core:

- local web server,
- React UI,
- project management,
- session management,
- Session Overview,
- Gemini ACP backend,
- Gemini terminal attach,
- isolated worktrees,
- Changes review workspace,
- editable file content,
- snapshots,
- apply to repo,
- sync to latest,
- branch manager,
- delivery add/commit/push/draft PR,
- voice input,
- clipboard screenshot upload,
- diagnostics.

## Current Priority

Make the current Gemini-first workflow reliable and understandable.

Immediate areas:

1. polish session creation and branch semantics,
2. improve branch compare summaries for Delivery,
3. harden Draft PR with better base/head detection,
4. improve UI feedback and tooltips,
5. keep docs aligned with actual behavior,
6. expand smoke tests for branch and delivery workflows.

## Product Completion Checklist

### Multi-Session Operations

- create sessions,
- search sessions,
- remove sessions,
- import Gemini sessions,
- overview state,
- stuck/blocked visibility,
- independent terminal attach.

### Review

- changed file tree,
- inline diff,
- editable file content,
- save file,
- reload file,
- binary file handling,
- dirty state protection.

### Safety

- isolated worktree,
- apply confirmation,
- sync confirmation,
- snapshots,
- rollback,
- branch manager warnings.

### Delivery

- selective Add,
- Commit,
- Push,
- one-click Draft PR,
- quiet compare URL fallback,
- delivery history.

### Input Acceleration

- voice input,
- screenshot paste/upload,
- prompt path insertion.

## Test Expectations

Before merging product changes:

```bash
npm run typecheck
npm run build
```

When touching server/runtime behavior:

```bash
npm run doctor
npm run smoke
```

## Future Hardening

- richer integration tests around git branch states,
- browser-level UI tests for the branch picker and delivery dialog,
- structured PR compare summary,
- better terminal lifecycle cleanup,
- HTTPS/local certificate option for browser microphone support.
