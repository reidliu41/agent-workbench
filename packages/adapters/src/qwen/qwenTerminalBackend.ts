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

export class QwenTerminalBackend implements AgentBackend {
  readonly id = "qwen";
  readonly name = "Qwen Code";

  constructor(private readonly command = process.env.QWEN_CODE_COMMAND ?? "qwen") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "qwen",
      available: result.exitCode === 0,
      command: this.command,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "Qwen Code command detected. Workbench uses native terminal mode." : output || "Qwen Code command not found.",
      capabilities: ["terminal", "resume", "cancel", "worktree"],
      profile: qwenTerminalProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    await emitQwenTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async startSession(input: Parameters<NonNullable<AgentBackend["startSession"]>>[0]): Promise<void> {
    await emitQwenTerminalNotice(input.task.id, input.emit, input.task.agentSessionId);
  }

  async sendMessage(input: Parameters<NonNullable<AgentBackend["sendMessage"]>>[0]): Promise<void> {
    await input.emit({
      type: "session.action",
      action: "terminal",
      status: "completed",
      taskId: input.task.id,
      title: "Use the native Qwen Code terminal.",
      details: "Qwen Code is attached through the right-side native terminal so slash commands, approvals, memory, and resume behavior stay inside Qwen Code.",
      data: {
        kind: "terminal",
      },
      timestamp: new Date().toISOString(),
    });
  }
}

async function emitQwenTerminalNotice(taskId: string, emit: (event: AgentEvent) => Promise<void>, sessionId?: string): Promise<void> {
  await emit({
    type: "session.action",
    action: "terminal",
    status: "started",
    taskId,
    title: "Qwen Code terminal session ready.",
    details: sessionId
      ? `Attach the right-side terminal to start Qwen Code with fixed session id ${sessionId}. Future attaches use qwen --resume after Qwen writes session history.`
      : "Attach the right-side terminal to start Qwen Code in this isolated worktree.",
    data: {
      kind: "terminal",
      command: "qwen",
      agentSessionId: sessionId,
    },
    timestamp: new Date().toISOString(),
  });
}

function qwenTerminalProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Native Qwen Code backend. It preserves Qwen Code's Gemini-compatible terminal experience while Workbench manages isolated worktrees, review, snapshots, and delivery.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "supported",
        source: "terminal",
        description: "The embedded terminal runs Qwen Code directly.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "supported",
        source: "terminal",
        description: "Workbench creates a stable Qwen session id up front and reattaches with qwen --resume after Qwen writes resumable session history.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "supported",
        source: "terminal",
        description: "Qwen Code slash commands stay native inside the terminal.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "supported",
        source: "terminal",
        description: "Qwen Code executes commands through its own CLI approval and sandbox flow.",
      },
      {
        id: "memory",
        label: "Memory",
        support: "supported",
        source: "terminal",
        description: "Qwen Code memory commands remain available through the native CLI.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "partial",
        source: "terminal",
        description: "Approvals remain in Qwen Code.",
        limitation: "Workbench does not yet mirror Qwen approvals into its approval panel.",
      },
      {
        id: "terminal_fallback",
        label: "Native terminal",
        support: "supported",
        source: "terminal",
        description: "The right-side terminal is the primary Qwen Code interface.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Qwen Code runs inside the session isolated worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench reviews changes made by Qwen Code in the isolated worktree.",
      },
    ],
    commands: [
      {
        name: "qwen --session-id <id>",
        source: "terminal",
        support: "supported",
        description: "Starts Qwen Code using Workbench's fixed native session id.",
      },
      {
        name: "qwen --resume <id>",
        source: "terminal",
        support: "supported",
        description: "Reopens the linked native Qwen Code session.",
      },
    ],
    skills: [
      {
        name: "Qwen Code native tools",
        source: "terminal",
        support: "supported",
        description: "Qwen Code manages its own native commands, memory, and tool behavior inside the terminal session.",
      },
    ],
    recommendedUse: [
      "Running Qwen Code next to Gemini, Codex, and Claude sessions across the same projects.",
      "Using Qwen Code's native CLI while keeping Workbench diff, snapshot, apply, and delivery controls.",
    ],
    limitations: [
      "Workbench does not yet parse Qwen ACP structured events into first-class Workbench events.",
      "Qwen approvals remain inside the terminal.",
      "Importing existing Qwen sessions from the original repo store is not enabled yet because Qwen sessions are project-path scoped.",
      "Qwen Code must be installed and authenticated separately.",
    ],
  };
}
