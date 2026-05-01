# Security

## Threat Model

Agent Workbench is a local web app that can:

- read local repositories,
- write files,
- spawn terminals,
- run git,
- attach agent CLIs,
- create branches,
- push code,
- open PRs.

That makes it a local code-execution surface. Defaults must be conservative.

## Defaults

- Bind to `127.0.0.1` by default.
- Require a local token in HTTP and WebSocket requests.
- Check request origin.
- Print the tokenized URL at startup.
- Keep storage local.
- Use isolated worktrees for agent work.

## Remote SSH Usage

Users can bind to all interfaces:

```bash
npm run serve -- --host 0.0.0.0 --port 3030
```

This is useful over SSH, but the token must remain private. Prefer SSH port forwarding where possible.

## Browser Permissions

Voice input depends on browser microphone permissions. Some browsers block microphone access on plain HTTP remote IPs. Use localhost forwarding or HTTPS when voice input is required.

Clipboard screenshot upload depends on browser clipboard support and user gesture permissions.

## Worktree Isolation

Isolated worktrees protect the original repository from direct agent writes until the user applies or delivers changes.

This is not a sandbox. A CLI process may still access other local paths unless the backend or runtime enforces restrictions.

## Git Safety

Delivery actions affect the original repository active branch.

Potentially risky operations:

- apply to repo,
- sync to latest,
- branch switch,
- remove branch,
- add,
- commit,
- push,
- draft PR.

UI tooltips and confirmation dialogs should make direction explicit.

## Secret Handling

Do not store tokens in project repositories.

Event logs may contain:

- prompts,
- file paths,
- shell output,
- diffs,
- accidental secrets.

Future work should add redaction and retention controls.

## Public Exposure

Do not expose Workbench directly to the public internet.

Current version has no:

- multi-user account system,
- role-based access control,
- hosted SaaS security boundary.
