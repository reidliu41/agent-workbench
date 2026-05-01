import { spawn, type ChildProcess } from "node:child_process";
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

export class GeminiBackend implements AgentBackend {
  readonly id = "gemini";
  readonly name = "Gemini CLI";
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly command = process.env.GEMINI_CLI_COMMAND ?? "gemini") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "gemini",
      available: result.exitCode === 0,
      command: this.command,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "Gemini CLI command detected. Workbench uses stream-json mode." : output || "Gemini CLI command not found.",
      capabilities: [
        "structured_stream",
        "tool_events",
        "diff_events",
        "cancel",
        "worktree",
      ],
      profile: geminiStreamProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    const status = await this.detect();
    if (!status.available) {
      throw new Error(status.details ?? "Gemini CLI command not found.");
    }

    const approvalMode = process.env.AGENT_WORKBENCH_GEMINI_APPROVAL_MODE ?? "plan";
    const args = [
      "--prompt",
      input.task.prompt,
      "--output-format",
      "stream-json",
      "--approval-mode",
      approvalMode,
    ];

    if (process.env.AGENT_WORKBENCH_GEMINI_MODEL) {
      args.unshift("--model", process.env.AGENT_WORKBENCH_GEMINI_MODEL);
    }

    await input.emit({
      type: "message.delta",
      taskId: input.task.id,
      timestamp: new Date().toISOString(),
      text: [
        `Starting Gemini CLI in ${input.worktreePath}.`,
        `Command: ${this.command} --prompt <task prompt> --output-format stream-json --approval-mode ${approvalMode}`,
        "Default approval mode is read-only `plan` until Workbench approval UI is implemented.",
      ].join("\n"),
    });

    await input.emit({
      type: "tool.started",
      taskId: input.task.id,
      toolCallId: `${input.task.id}:gemini-cli`,
      name: "gemini.cli",
      input: {
        command: this.command,
        args,
        cwd: input.worktreePath,
      },
      timestamp: new Date().toISOString(),
    });

    const child = spawn(this.command, args, {
      cwd: input.worktreePath,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(input.task.id, child);

    const pendingEmits: Promise<void>[] = [];
    const emit = (event: AgentEvent): void => {
      const pending = input.emit(event);
      pendingEmits.push(pending);
      void pending.finally(() => {
        const index = pendingEmits.indexOf(pending);
        if (index >= 0) {
          pendingEmits.splice(index, 1);
        }
      });
    };

    let stdoutBuffer = "";
    let resultError: string | undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          handleGeminiStreamLine(line, input.task.id, emit, (message) => {
            resultError = message;
          });
        }
      }
    });
    child.stderr.on("data", (data: string) => {
      emit({
        type: "shell.output",
        taskId: input.task.id,
        stream: "stderr",
        data,
        timestamp: new Date().toISOString(),
      });
    });

    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });
    } finally {
      this.processes.delete(input.task.id);
    }

    if (stdoutBuffer.trim()) {
      handleGeminiStreamLine(stdoutBuffer, input.task.id, emit, (message) => {
        resultError = message;
      });
    }

    await Promise.allSettled(pendingEmits);

    await input.emit({
      type: "tool.finished",
      taskId: input.task.id,
      toolCallId: `${input.task.id}:gemini-cli`,
      name: "gemini.cli",
      status: exitCode === 0 && !resultError ? "ok" : "error",
      output: {
        exitCode,
        error: resultError,
      },
      timestamp: new Date().toISOString(),
    });

    if (exitCode !== 0 || resultError) {
      throw new Error(resultError ?? `Gemini CLI exited with code ${exitCode}.`);
    }
  }

  async stopTask(taskId: string): Promise<void> {
    const child = this.processes.get(taskId);
    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(taskId);
    }
  }
}

function geminiStreamProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "One-shot Gemini CLI backend using stream-json output. Useful as a fallback, but it is not a full interactive CLI session.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "partial",
        source: "backend-native",
        description: "Runs a single Gemini prompt and streams structured output.",
        limitation: "No long-lived interactive process is kept after the task completes.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "unsupported",
        source: "backend-native",
        description: "This backend exits after each task.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "unsupported",
        source: "backend-native",
        description: "Stream-json mode does not expose Gemini TUI slash command discovery.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "partial",
        source: "backend-native",
        description: "Gemini may emit tool events in stream-json output.",
        limitation: "Approval handling is limited compared with ACP sessions.",
      },
      {
        id: "skills",
        label: "Skills",
        support: "unsupported",
        source: "workbench",
        description: "Workbench-native skills are not wired to this backend.",
      },
      {
        id: "memory",
        label: "Memory",
        support: "unsupported",
        source: "backend-native",
        description: "Memory commands require an interactive/ACP path.",
      },
      {
        id: "modes",
        label: "Modes",
        support: "partial",
        source: "backend-native",
        description: "Workbench sets a CLI approval mode for the one-shot command.",
      },
      {
        id: "models",
        label: "Models",
        support: "partial",
        source: "backend-native",
        description: "A model can be selected through AGENT_WORKBENCH_GEMINI_MODEL.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "unsupported",
        source: "workbench",
        description: "Interactive approval resolution is not implemented for this one-shot backend.",
      },
      {
        id: "terminal_fallback",
        label: "Terminal fallback",
        support: "unsupported",
        source: "terminal",
        description: "Use the Generic CLI Fallback backend for terminal behavior.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Each task runs in an isolated git worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench captures git diffs after the one-shot command exits.",
      },
    ],
    commands: [
      {
        name: "One-shot prompt",
        source: "backend-native",
        support: "supported",
        description: "Run Gemini CLI once with --prompt and --output-format stream-json.",
      },
    ],
    skills: [
      {
        name: "Workbench skills",
        source: "workbench",
        support: "planned",
        description: "Portable Workbench skills are planned, but not connected to one-shot Gemini yet.",
      },
    ],
    recommendedUse: [
      "Simple non-interactive tasks.",
      "Fallback when ACP is unavailable.",
    ],
    limitations: [
      "No persistent conversation.",
      "No slash command discovery.",
      "No interactive Gemini TUI parity.",
    ],
  };
}

type GeminiStreamEvent = {
  type?: string;
  timestamp?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: string;
  output?: unknown;
  error?: unknown;
  severity?: string;
  message?: string;
  session_id?: string;
  model?: string;
  stats?: unknown;
};

function handleGeminiStreamLine(
  line: string,
  taskId: string,
  emit: (event: AgentEvent) => void,
  setResultError: (message: string) => void,
): void {
  let event: GeminiStreamEvent;
  try {
    event = JSON.parse(line) as GeminiStreamEvent;
  } catch {
    emit({
      type: "shell.output",
      taskId,
      stream: "stdout",
      data: `${line}\n`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const timestamp = event.timestamp ?? new Date().toISOString();
  switch (event.type) {
    case "init":
      emit({
        type: "tool.started",
        taskId,
        toolCallId: `${taskId}:gemini-session`,
        name: "gemini.session",
        input: {
          sessionId: event.session_id,
          model: event.model,
        },
        timestamp,
      });
      break;
    case "message":
      if (event.role === "assistant" && event.content) {
        emit({
          type: "message.delta",
          taskId,
          text: event.content,
          timestamp,
        });
      }
      break;
    case "tool_use":
      emit({
        type: "tool.started",
        taskId,
        toolCallId: event.tool_id ?? `${taskId}:gemini-tool:${Date.now()}`,
        name: event.tool_name ?? "gemini.tool",
        input: event.parameters,
        timestamp,
      });
      break;
    case "tool_result":
      emit({
        type: "tool.finished",
        taskId,
        toolCallId: event.tool_id ?? `${taskId}:gemini-tool:${Date.now()}`,
        status: event.status === "error" ? "error" : "ok",
        output: event.output ?? event.error,
        timestamp,
      });
      break;
    case "error":
      if (event.severity === "error") {
        setResultError(event.message ?? "Gemini CLI reported an error.");
      }
      emit({
        type: "shell.output",
        taskId,
        stream: event.severity === "warning" ? "stdout" : "stderr",
        data: `[${event.severity ?? "error"}] ${event.message ?? "Gemini CLI event error."}\n`,
        timestamp,
      });
      break;
    case "result":
      if (event.status === "error") {
        setResultError(errorMessage(event.error) ?? "Gemini CLI returned an error result.");
      }
      emit({
        type: "tool.finished",
        taskId,
        toolCallId: `${taskId}:gemini-result`,
        name: "gemini.result",
        status: event.status === "error" ? "error" : "ok",
        output: event.stats ?? event.error,
        timestamp,
      });
      break;
    default:
      emit({
        type: "shell.output",
        taskId,
        stream: "stdout",
        data: `${line}\n`,
        timestamp,
      });
  }
}

function errorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}
