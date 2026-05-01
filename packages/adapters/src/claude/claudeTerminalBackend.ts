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

export class ClaudeTerminalBackend implements AgentBackend {
  readonly id = "claude";
  readonly name = "Claude Code";

  constructor(private readonly command = process.env.CLAUDE_CODE_COMMAND ?? "claude") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "claude",
      available: result.exitCode === 0,
      command: this.command,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "Claude Code command detected. Workbench uses native terminal mode." : output || "Claude Code command not found.",
      capabilities: ["terminal", "resume", "cancel", "worktree"],
      profile: claudeTerminalProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    await emitClaudeTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async startSession(input: Parameters<NonNullable<AgentBackend["startSession"]>>[0]): Promise<void> {
    await emitClaudeTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async sendMessage(input: Parameters<NonNullable<AgentBackend["sendMessage"]>>[0]): Promise<void> {
    await input.emit({
      type: "session.action",
      action: "terminal",
      status: "completed",
      taskId: input.task.id,
      title: "Use the native Claude Code terminal.",
      details: "Claude Code is attached through the right-side native terminal so slash commands, plugins, skills, permissions, and resume behavior stay inside Claude Code.",
      data: {
        kind: "terminal",
      },
      timestamp: new Date().toISOString(),
    });
  }
}

async function emitClaudeTerminalNotice(taskId: string, emit: (event: AgentEvent) => Promise<void>, sessionId?: string): Promise<void> {
  await emit({
    type: "session.action",
    action: "terminal",
    status: "started",
    taskId,
    title: "Claude Code terminal session ready.",
    details: sessionId
      ? `Attach the right-side terminal to start Claude Code with fixed session id ${sessionId}. Future attaches use claude --resume.`
      : "Attach the right-side terminal to start Claude Code in this isolated worktree.",
    data: {
      kind: "terminal",
      command: "claude",
      agentSessionId: sessionId,
    },
    timestamp: new Date().toISOString(),
  });
}

function claudeTerminalProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Native Claude Code backend. It preserves Claude Code's full terminal experience while Workbench manages isolated worktrees, review, snapshots, and delivery.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "supported",
        source: "terminal",
        description: "The embedded terminal runs Claude Code directly.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "supported",
        source: "terminal",
        description: "Workbench creates a stable Claude session id up front and reattaches with claude --resume.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "supported",
        source: "terminal",
        description: "Claude Code slash commands stay native inside the terminal.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "supported",
        source: "terminal",
        description: "Claude Code executes commands through its own permission flow.",
      },
      {
        id: "skills",
        label: "Skills and plugins",
        support: "supported",
        source: "terminal",
        description: "Claude Code skills, plugins, hooks, and agents work through the CLI.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "partial",
        source: "terminal",
        description: "Approvals remain in Claude Code.",
        limitation: "Workbench does not yet mirror Claude Code permissions into its approval panel.",
      },
      {
        id: "terminal_fallback",
        label: "Native terminal",
        support: "supported",
        source: "terminal",
        description: "The right-side terminal is the primary Claude Code interface.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Claude Code runs inside the session isolated worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench reviews changes made by Claude Code in the isolated worktree.",
      },
    ],
    commands: [
      {
        name: "claude --session-id <id>",
        source: "terminal",
        support: "supported",
        description: "Starts Claude Code using Workbench's fixed native session id.",
      },
      {
        name: "claude --resume <id>",
        source: "terminal",
        support: "supported",
        description: "Reopens the linked native Claude Code session.",
      },
    ],
    skills: [
      {
        name: "Claude Code skills and plugins",
        source: "terminal",
        support: "supported",
        description: "Claude Code manages its own skills, plugins, hooks, and agents inside the terminal session.",
      },
    ],
    recommendedUse: [
      "Running Claude Code, Codex, and Gemini sessions side by side across the same projects.",
      "Using Claude Code's native CLI while keeping Workbench diff, snapshot, apply, and delivery controls.",
    ],
    limitations: [
      "Workbench does not yet parse Claude Code structured transcript events into first-class Workbench events.",
      "Claude Code approvals remain inside the terminal.",
      "Claude Code must be installed and authenticated separately.",
    ],
  };
}
