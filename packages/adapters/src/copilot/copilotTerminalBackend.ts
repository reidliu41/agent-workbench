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

export class CopilotTerminalBackend implements AgentBackend {
  readonly id = "copilot";
  readonly name = "GitHub Copilot CLI";

  constructor(private readonly command = process.env.COPILOT_CLI_COMMAND ?? "copilot") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "copilot",
      available: result.exitCode === 0,
      command: this.command,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "GitHub Copilot CLI command detected. Workbench uses native terminal mode." : output || "GitHub Copilot CLI command not found.",
      capabilities: ["terminal", "resume", "cancel", "worktree"],
      profile: copilotTerminalProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    await emitCopilotTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async startSession(input: Parameters<NonNullable<AgentBackend["startSession"]>>[0]): Promise<void> {
    await emitCopilotTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async sendMessage(input: Parameters<NonNullable<AgentBackend["sendMessage"]>>[0]): Promise<void> {
    await input.emit({
      type: "session.action",
      action: "terminal",
      status: "completed",
      taskId: input.task.id,
      title: "Use the native Copilot terminal.",
      details: "GitHub Copilot CLI is attached through the right-side native terminal so slash commands, approvals, MCP, rollback, and resume behavior stay inside Copilot.",
      data: {
        kind: "terminal",
      },
      timestamp: new Date().toISOString(),
    });
  }
}

async function emitCopilotTerminalNotice(taskId: string, emit: (event: AgentEvent) => Promise<void>, sessionId?: string): Promise<void> {
  await emit({
    type: "session.action",
    action: "terminal",
    status: "started",
    taskId,
    title: "GitHub Copilot CLI terminal session ready.",
    details: sessionId
      ? `Attach the right-side terminal to start Copilot with session id ${sessionId}. Future attaches use copilot --resume.`
      : "Attach the right-side terminal to start Copilot in this isolated worktree.",
    data: {
      kind: "terminal",
      command: "copilot",
      agentSessionId: sessionId,
    },
    timestamp: new Date().toISOString(),
  });
}

function copilotTerminalProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Native GitHub Copilot CLI backend. It preserves Copilot's terminal experience while Workbench manages isolated worktrees, review, snapshots, and delivery.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "supported",
        source: "terminal",
        description: "The embedded terminal runs GitHub Copilot CLI directly.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "supported",
        source: "terminal",
        description: "Workbench starts Copilot with a stable session UUID and later reattaches with copilot --resume.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "supported",
        source: "terminal",
        description: "Copilot slash commands stay native inside the terminal.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "supported",
        source: "terminal",
        description: "Copilot executes commands through its own CLI permission flow.",
      },
      {
        id: "skills",
        label: "Skills",
        support: "supported",
        source: "terminal",
        description: "Copilot custom agents, MCP, plugins, and instructions remain available through the native CLI.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "partial",
        source: "terminal",
        description: "Approvals remain in Copilot CLI.",
        limitation: "Workbench does not yet mirror Copilot approvals into its approval panel.",
      },
      {
        id: "checkpoints",
        label: "Checkpoints",
        support: "supported",
        source: "terminal",
        description: "Copilot's native checkpoint and rollback commands remain available inside the terminal.",
      },
      {
        id: "terminal_fallback",
        label: "Native terminal",
        support: "supported",
        source: "terminal",
        description: "The right-side terminal is the primary Copilot interface for this first integration step.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Copilot runs inside the session isolated worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench reviews changes made by Copilot in the isolated worktree.",
      },
    ],
    commands: [
      {
        name: "copilot --resume=<id>",
        source: "terminal",
        support: "supported",
        description: "Starts or reopens the linked native Copilot session.",
      },
      {
        name: "copilot --continue",
        source: "terminal",
        support: "supported",
        description: "Reopens the most recent Copilot session inside the native CLI.",
      },
      {
        name: "copilot -p <prompt>",
        source: "backend-native",
        support: "planned",
        description: "One-shot programmatic Copilot execution is planned after the native terminal path is stable.",
      },
      {
        name: "copilot --acp",
        source: "acp",
        support: "planned",
        description: "Structured Copilot ACP integration is a later phase.",
      },
    ],
    skills: [
      {
        name: "Copilot native extensions",
        source: "terminal",
        support: "supported",
        description: "Copilot manages its own MCP servers, plugins, custom agents, and instructions inside the terminal session.",
      },
    ],
    recommendedUse: [
      "Running Copilot next to Gemini, Codex, Claude, and Qwen sessions across the same projects.",
      "Using Copilot's native CLI while keeping Workbench diff, snapshot, apply, and delivery controls.",
    ],
    limitations: [
      "Workbench does not yet parse Copilot ACP structured events.",
      "Copilot approvals remain inside the terminal.",
      "Importing existing Copilot sessions from Copilot's local history is not wired yet.",
      "GitHub Copilot CLI must be installed and authenticated separately.",
    ],
  };
}
