import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentBackend } from "@agent-workbench/core";
import type { BackendStatus } from "@agent-workbench/protocol";

export class GenericPtyBackend implements AgentBackend {
  readonly id = "generic-pty";
  readonly name = "Generic CLI Fallback";
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  async detect(): Promise<BackendStatus> {
    return {
      id: this.id,
      name: this.name,
      kind: "generic-pty",
      available: true,
      details: "Fallback process backend is available. It is not the v0.1 release path.",
      capabilities: ["terminal", "cancel", "worktree"],
      profile: genericPtyProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    const command = process.env.AGENT_WORKBENCH_FALLBACK_COMMAND ?? "bash";
    const child = spawn(command, [], {
      cwd: input.worktreePath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.processes.set(input.task.id, child);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      void input.emit({
        type: "shell.output",
        taskId: input.task.id,
        stream: "stdout",
        data,
        timestamp: new Date().toISOString(),
      });
    });
    child.stderr.on("data", (data) => {
      void input.emit({
        type: "shell.output",
        taskId: input.task.id,
        stream: "stderr",
        data,
        timestamp: new Date().toISOString(),
      });
    });

    child.stdin.write(`${input.task.prompt}\n`);
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
  }

  async stopTask(taskId: string): Promise<void> {
    const child = this.processes.get(taskId);
    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(taskId);
    }
  }
}

function genericPtyProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Raw terminal fallback. It preserves CLI access, but Workbench cannot understand the agent protocol or manage rich tool events yet.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "partial",
        source: "terminal",
        description: "Workbench can write the initial prompt into a spawned terminal process.",
        limitation: "No structured conversation state is tracked.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "unsupported",
        source: "terminal",
        description: "The current fallback process is task-scoped, not a browser-accessible persistent terminal.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "partial",
        source: "terminal",
        description: "A real CLI can receive slash commands as raw terminal input.",
        limitation: "Workbench cannot inspect or autocomplete backend-specific commands in this mode yet.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "partial",
        source: "terminal",
        description: "Terminal output is streamed as text.",
        limitation: "No structured tool/action timeline or approval protocol is available.",
      },
      {
        id: "skills",
        label: "Skills",
        support: "partial",
        source: "terminal",
        description: "Backend-native skill systems can work if the launched CLI supports them.",
        limitation: "Workbench cannot enumerate, route, or audit those skills yet.",
      },
      {
        id: "memory",
        label: "Memory",
        support: "partial",
        source: "terminal",
        description: "Backend-native memory commands may work through raw terminal input.",
      },
      {
        id: "modes",
        label: "Modes",
        support: "unsupported",
        source: "workbench",
        description: "Workbench does not have structured mode control for raw terminal processes.",
      },
      {
        id: "models",
        label: "Models",
        support: "unsupported",
        source: "workbench",
        description: "Workbench does not have structured model control for raw terminal processes.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "unsupported",
        source: "workbench",
        description: "Raw terminal approvals remain inside the CLI process.",
      },
      {
        id: "terminal_fallback",
        label: "Terminal fallback",
        support: "supported",
        source: "terminal",
        description: "This backend exists to preserve CLI-only capabilities while structured adapters catch up.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "The terminal process runs inside the session worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "partial",
        source: "workbench",
        description: "Workbench can diff the worktree after the process exits.",
        limitation: "Live tool-level change attribution is not available.",
      },
    ],
    commands: [
      {
        name: "Raw terminal input",
        source: "terminal",
        support: "partial",
        description: "Send text into the spawned CLI process.",
        limitation: "Interactive browser terminal controls are not implemented yet.",
      },
    ],
    skills: [
      {
        name: "Backend-native CLI skills",
        source: "terminal",
        support: "partial",
        description: "Skills may work inside the CLI if the launched command supports them.",
        limitation: "Workbench cannot list or manage them yet.",
      },
    ],
    recommendedUse: [
      "Keeping access to CLI-only slash commands or skill systems.",
      "Testing closed-source agent CLIs before a structured adapter exists.",
    ],
    limitations: [
      "No structured approvals.",
      "No structured command discovery.",
      "No Workbench-native skill registry yet.",
      "Current fallback is task-scoped rather than a full web terminal session.",
    ],
  };
}
