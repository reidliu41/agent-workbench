import { spawn } from "node:child_process";
import type { AgentBackend } from "@agent-workbench/core";
import type { AgentEvent, BackendStatus } from "@agent-workbench/protocol";

async function commandResult(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

export class CodexTerminalBackend implements AgentBackend {
  readonly id = "codex";
  readonly name = "Codex CLI";

  constructor(private readonly command = process.env.CODEX_CLI_COMMAND ?? "codex") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "codex",
      available: result.exitCode === 0,
      command: this.command,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "Codex CLI command detected. Workbench uses native terminal mode." : output || "Codex CLI command not found.",
      capabilities: ["terminal", "resume", "cancel", "worktree"],
      profile: codexTerminalProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    await emitCodexTerminalNotice(input.task.id, input.emit);
  }

  async startSession(input: Parameters<NonNullable<AgentBackend["startSession"]>>[0]): Promise<void> {
    await emitCodexTerminalNotice(input.task.id, input.emit);
  }

  async sendMessage(input: Parameters<NonNullable<AgentBackend["sendMessage"]>>[0]): Promise<void> {
    await input.emit({
      type: "session.action",
      action: "terminal",
      status: "completed",
      taskId: input.task.id,
      title: "Use the native Codex terminal.",
      details: "Codex is attached through the right-side native terminal so its slash commands, approvals, and resume behavior stay inside Codex CLI.",
      data: {
        kind: "terminal",
      },
      timestamp: new Date().toISOString(),
    });
  }
}

async function emitCodexTerminalNotice(taskId: string, emit: (event: AgentEvent) => Promise<void>): Promise<void> {
  await emit({
    type: "session.action",
    action: "terminal",
    status: "started",
    taskId,
    title: "Codex terminal session ready.",
    details: "Attach the right-side terminal to start Codex in this isolated worktree. Workbench will link the Codex resume id automatically after Codex writes its session metadata.",
    data: {
      kind: "terminal",
      command: "codex",
    },
    timestamp: new Date().toISOString(),
  });
}

function codexTerminalProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Native Codex CLI backend. It preserves Codex's full terminal experience while Workbench manages isolated worktrees, review, snapshots, and delivery.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "supported",
        source: "terminal",
        description: "The embedded terminal runs Codex CLI directly.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "partial",
        source: "terminal",
        description: "Workbench records the native Codex session id and reattaches with codex resume.",
        limitation: "Structured thread control will require Codex app-server integration.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "supported",
        source: "terminal",
        description: "Codex slash commands stay native inside the terminal.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "supported",
        source: "terminal",
        description: "Codex executes commands through its own CLI approval and sandbox flow.",
      },
      {
        id: "skills",
        label: "Skills",
        support: "supported",
        source: "terminal",
        description: "Codex-native skills and plugins work through the CLI.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "partial",
        source: "terminal",
        description: "Approvals remain in Codex CLI.",
        limitation: "Workbench does not yet mirror Codex approvals into its approval panel.",
      },
      {
        id: "terminal_fallback",
        label: "Native terminal",
        support: "supported",
        source: "terminal",
        description: "The right-side terminal is the primary Codex interface.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Codex runs inside the session isolated worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench reviews changes made by Codex in the isolated worktree.",
      },
    ],
    commands: [
      {
        name: "codex",
        source: "terminal",
        support: "supported",
        description: "Starts a native Codex CLI session in the isolated worktree.",
      },
      {
        name: "codex resume <id>",
        source: "terminal",
        support: "supported",
        description: "Reopens the linked native Codex session.",
      },
    ],
    skills: [
      {
        name: "Codex native skills",
        source: "terminal",
        support: "supported",
        description: "Codex manages its own skills and plugins inside the terminal session.",
      },
    ],
    recommendedUse: [
      "Running Codex and Gemini sessions side by side across the same projects.",
      "Using Codex's native CLI while keeping Workbench diff, snapshot, apply, and delivery controls.",
    ],
    limitations: [
      "Workbench does not yet parse Codex app-server structured events.",
      "Codex approvals remain inside the terminal.",
      "Codex must be installed and authenticated separately.",
    ],
  };
}
