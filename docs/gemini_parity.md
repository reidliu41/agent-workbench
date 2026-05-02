# Gemini CLI Support

## Goal

Gemini CLI is the first complete backend for Agent Workbench.

The goal is not to replace the terminal. The goal is to keep Gemini CLI useful while adding a web dashboard, multi-session management, review, snapshots, and delivery.

## Supported Today

- Gemini ACP backend through `gemini --acp`.
- Native Gemini terminal attach.
- Gemini session creation from Workbench.
- Gemini session import/resume from existing project sessions.
- Linked native Gemini session IDs.
- Gemini auth/settings reuse through the installed CLI.
- WebSocket terminal input/output.
- Voice input when browser permissions allow it.
- Clipboard screenshot upload and inserted image path prompts.
- Worktree isolation per session.
- Review and diff around Gemini edits.

## Native Terminal Coverage

Slash commands and native Gemini CLI UX are primarily preserved through terminal attach.

Workbench should not reimplement every Gemini slash command if the real terminal already supports it.

## Workbench-Native Coverage

Workbench provides native controls for:

- session management,
- project management,
- branch selection,
- diff review,
- file editing,
- snapshots,
- apply patch fallback,
- delivery,
- diagnostics.

## Known Gaps

- Not every Gemini CLI slash command has a separate web-native command.
- Full Gemini settings UI is not complete.
- ACP behavior depends on Gemini CLI's exposed protocol support.
- Terminal resume is tied to Gemini's native session behavior.
- Browser voice input requires a secure context or browser permission support.

## Product Rule

If Gemini CLI already does something well, Workbench should attach to it or surface it, not clone it poorly.

If Workbench adds value, it should be in:

- multi-session operation,
- review,
- safety,
- delivery,
- dashboard visibility.
