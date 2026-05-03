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
- Codex terminal attach,
- Claude Code terminal attach,
- Qwen Code terminal attach,
- isolated worktrees,
- Changes review workspace,
- editable file content,
- snapshots,
- one session -> one branch -> one isolated worktree,
- apply patch fallback,
- session branch controls,
- delivery add/commit/push/draft PR,
- voice input,
- clipboard screenshot upload,
- enhanced terminal split projection with color-preserving transcript, footer filtering, and zoom controls,
- diagnostics.

## Current Priority

Make the current native-CLI workflow reliable and understandable.

Immediate areas:

1. polish one-session/one-branch semantics,
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
- import native Gemini, Codex, and Claude sessions,
- import existing Qwen Code sessions through the project-path bridge,
- overview state,
- stuck/blocked visibility,
- independent terminal attach.
- split terminal projection for Gemini, Codex, Claude Code, and Qwen Code.

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
- apply patch confirmation,
- snapshots,
- rollback,
- session branch warnings.

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
