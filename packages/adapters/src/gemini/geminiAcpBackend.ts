import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentBackend } from "@agent-workbench/core";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  BackendStatus,
} from "@agent-workbench/protocol";

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

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function acpStartTimeoutMs(): number {
  return numberFromEnv("AGENT_WORKBENCH_GEMINI_ACP_START_TIMEOUT_MS", 30_000);
}

function acpRpcTimeoutMs(): number {
  return numberFromEnv("AGENT_WORKBENCH_GEMINI_ACP_RPC_TIMEOUT_MS", 20_000);
}

function acpTurnTimeoutMs(): number {
  return numberFromEnv("AGENT_WORKBENCH_GEMINI_ACP_TURN_TIMEOUT_MS", 10 * 60_000);
}

async function withTimeout<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function geminiAcpEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (process.env.AGENT_WORKBENCH_GEMINI_CHECKPOINTING === "1") {
    return process.env;
  }

  const settingsPath = await writeGeminiAcpSystemSettings();

  return {
    ...process.env,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsPath,
  };
}

async function writeGeminiAcpSystemSettings(): Promise<string> {
  const settingsContent = `${JSON.stringify(
    {
      general: {
        checkpointing: {
          enabled: false,
        },
      },
    },
    null,
    2,
  )}\n`;
  const configuredPath = process.env.AGENT_WORKBENCH_GEMINI_SYSTEM_SETTINGS_PATH;
  const candidatePaths = [
    configuredPath,
    join(homedir(), ".agent-workbench", "gemini-acp-system-settings.json"),
    join(tmpdir(), "agent-workbench-gemini-acp-system-settings.json"),
  ].filter((path): path is string => Boolean(path));
  let lastError: unknown;

  for (const settingsPath of candidatePaths) {
    try {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, settingsContent, "utf8");
      return settingsPath;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Failed to write Gemini ACP system settings: ${formatUnknownError(lastError)}`);
}

interface GeminiAcpHandle {
  acpSessionId: string;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  emit: (event: AgentEvent) => Promise<void>;
  queue: Promise<void>;
  taskId: string;
}

interface PendingApproval {
  emit: (event: AgentEvent) => Promise<void>;
  options: acp.PermissionOption[];
  reject: (error: Error) => void;
  request: ApprovalRequest;
  resolve: (response: acp.RequestPermissionResponse) => void;
  taskId: string;
}

export class GeminiAcpBackend implements AgentBackend {
  readonly id = "gemini-acp";
  readonly name = "Gemini CLI ACP";
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly sessions = new Map<string, GeminiAcpHandle>();

  constructor(private readonly command = process.env.GEMINI_CLI_COMMAND ?? "gemini") {}

  async detect(): Promise<BackendStatus> {
    const result = await commandResult(this.command, ["--version"]);
    const output = `${result.stdout}${result.stderr}`.trim();

    return {
      id: this.id,
      name: this.name,
      kind: "gemini",
      available: result.exitCode === 0,
      command: `${this.command} --acp`,
      version: result.exitCode === 0 ? output : undefined,
      details: result.exitCode === 0 ? "Gemini CLI ACP command detected. Workbench can run persistent sessions." : output || "Gemini CLI command not found.",
      capabilities: [
        "structured_stream",
        "tool_events",
        "approval",
        "diff_events",
        "resume",
        "cancel",
        "worktree",
        "cost_usage",
      ],
      profile: geminiAcpProfile(),
    };
  }

  async startTask(input: Parameters<AgentBackend["startTask"]>[0]): Promise<void> {
    await this.startSession(input);
    try {
      if (input.task.prompt.trim()) {
        await this.sendMessage({
          ...input,
          prompt: input.task.prompt,
        });
      }
    } finally {
      await this.stopTask(input.task.id);
    }
  }

  async startSession(input: Parameters<NonNullable<AgentBackend["startSession"]>>[0]): ReturnType<NonNullable<AgentBackend["startSession"]>> {
    const status = await this.detect();
    if (!status.available) {
      throw new Error(status.details ?? "Gemini CLI command not found.");
    }

    await input.emit({
      type: "tool.started",
      taskId: input.task.id,
      toolCallId: `${input.task.id}:gemini-acp`,
      name: "gemini.acp",
      input: {
        command: this.command,
        args: ["--acp"],
        cwd: input.worktreePath,
      },
      timestamp: new Date().toISOString(),
    });

    const env = await geminiAcpEnvironment();
    const child = spawn(this.command, ["--acp"], {
      cwd: input.worktreePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      void input.emit({
        type: "shell.output",
        taskId: input.task.id,
        stream: "stderr",
        data,
        timestamp: new Date().toISOString(),
      });
    });

    const rpcInput = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const rpcOutput = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(rpcInput, rpcOutput);
    const client = new WorkbenchAcpClient(this, input.task.id, input.emit);
    const connection = new acp.ClientSideConnection(() => client, stream);

    try {
      const init = await withTimeout(
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: {
            name: "agent-workbench",
            title: "Agent Workbench",
            version: "0.1.0",
          },
          clientCapabilities: {},
        }),
        "Gemini ACP initialize",
        acpStartTimeoutMs(),
      );

      await this.authenticateFromEnvironment(connection, init);

      const supportsLoadSession = init.agentCapabilities?.loadSession === true;
      const supportsResumeSession = Boolean(init.agentCapabilities?.sessionCapabilities?.resume);
      const sessionRequest = {
        cwd: input.worktreePath,
        mcpServers: [],
      };
      let acpSessionId = input.agentSessionId;
      let resumeMode: "new" | "load" | "resume" = "new";
      let resumeError: string | undefined;
      let sessionState:
        | {
            modes?: unknown;
            models?: unknown;
          }
        | undefined;

      if (acpSessionId && supportsLoadSession) {
        try {
          sessionState = await withTimeout(
            connection.loadSession({
              ...sessionRequest,
              sessionId: acpSessionId,
            }),
            "Gemini ACP loadSession",
            acpStartTimeoutMs(),
          );
          resumeMode = "load";
        } catch (error) {
          resumeError = formatUnknownError(error);
          acpSessionId = undefined;
        }
      }

      if (acpSessionId && !sessionState && supportsResumeSession) {
        try {
          sessionState = await withTimeout(
            connection.unstable_resumeSession({
              ...sessionRequest,
              sessionId: acpSessionId,
            }),
            "Gemini ACP resumeSession",
            acpStartTimeoutMs(),
          );
          resumeMode = "resume";
        } catch (error) {
          resumeError = formatUnknownError(error);
          acpSessionId = undefined;
        }
      }

      if (!acpSessionId || !sessionState) {
        const session = await withTimeout(
          connection.newSession(sessionRequest),
          "Gemini ACP newSession",
          acpStartTimeoutMs(),
        );
        acpSessionId = session.sessionId;
        sessionState = session;
        resumeMode = "new";
      }
      if (!acpSessionId || !sessionState) {
        throw new Error("Gemini ACP did not return a session id.");
      }
      const activeSessionId = acpSessionId;
      const activeSessionState = sessionState;

      const handle: GeminiAcpHandle = {
        acpSessionId: activeSessionId,
        child,
        connection,
        emit: input.emit,
        queue: Promise.resolve(),
        taskId: input.task.id,
      };
      this.sessions.set(input.task.id, handle);

      child.on("close", (exitCode) => {
        this.sessions.delete(input.task.id);
        this.cancelApprovalsForTask(input.task.id, new Error(`Gemini ACP process exited with code ${exitCode ?? 1}.`));
      });

      const modeId = input.modeId ?? process.env.AGENT_WORKBENCH_GEMINI_ACP_MODE;
      if (modeId) {
        await withTimeout(
          connection.setSessionMode({
            sessionId: activeSessionId,
            modeId,
          }),
          "Gemini ACP setSessionMode",
          acpRpcTimeoutMs(),
        );
      }

      await input.emit({
        type: "tool.finished",
        taskId: input.task.id,
        toolCallId: `${input.task.id}:gemini-acp`,
        name: "gemini.acp",
        status: "ok",
        output: {
          agent: init.agentInfo,
          agentCapabilities: init.agentCapabilities,
          authMethods: init.authMethods?.map((method: acp.AuthMethod) => method.id),
          resumeError,
          resumeMode,
          sessionId: activeSessionId,
          modes: activeSessionState.modes,
          models: activeSessionState.models,
        },
        timestamp: new Date().toISOString(),
      });
      return {
        agentSessionId: activeSessionId,
        resumeMode,
      };
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  async sendMessage(input: Parameters<NonNullable<AgentBackend["sendMessage"]>>[0]): Promise<{ stopReason?: string }> {
    const handle = this.sessions.get(input.task.id);
    if (!handle) {
      throw new Error("Gemini ACP session is not attached. Start a new session after restarting the server.");
    }

    return this.enqueue(handle, async () => {
      try {
        const response = await withTimeout(
          handle.connection.prompt({
            sessionId: handle.acpSessionId,
            messageId: randomUUID(),
            prompt: [
              {
                type: "text",
                text: input.prompt,
              },
            ],
          }),
          "Gemini ACP prompt turn",
          acpTurnTimeoutMs(),
        );
        return { stopReason: response.stopReason };
      } catch (error) {
        this.sessions.delete(input.task.id);
        handle.child.kill("SIGTERM");
        this.cancelApprovalsForTask(input.task.id, new Error(formatUnknownError(error)));
        throw error;
      }
    });
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  async cancelSession(taskId: string): Promise<void> {
    const handle = this.sessions.get(taskId);
    if (handle) {
      await handle.connection.cancel({ sessionId: handle.acpSessionId }).catch(() => undefined);
    }
    this.cancelApprovalsForTask(taskId, new Error("Session was cancelled."));
  }

  async stopTask(taskId: string): Promise<void> {
    const handle = this.sessions.get(taskId);
    if (handle) {
      handle.child.kill("SIGTERM");
      this.sessions.delete(taskId);
    }
    this.cancelApprovalsForTask(taskId, new Error("Session was stopped."));
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) {
      return;
    }

    this.approvals.delete(approvalId);
    await pending.emit({
      type: "approval.resolved",
      taskId: pending.taskId,
      approvalId,
      decision,
      timestamp: new Date().toISOString(),
    });

    if (decision === "deny_and_stop") {
      await this.cancelSession(pending.taskId).catch(() => undefined);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    const option = selectPermissionOption(pending.options, decision);
    if (!option) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    pending.resolve({
      outcome: {
        outcome: "selected",
        optionId: option.optionId,
      },
    });
  }

  async setMode(taskId: string, modeId: string): Promise<void> {
    const handle = this.sessions.get(taskId);
    if (!handle) {
      return;
    }
    await this.enqueue(handle, async () => {
      await withTimeout(
        handle.connection.setSessionMode({
          sessionId: handle.acpSessionId,
          modeId,
        }),
        "Gemini ACP setSessionMode",
        acpRpcTimeoutMs(),
      );
    });
  }

  async createPermissionRequest(
    taskId: string,
    params: acp.RequestPermissionRequest,
    emit: (event: AgentEvent) => Promise<void>,
  ): Promise<acp.RequestPermissionResponse> {
    const approvalId = randomUUID();
    const request: ApprovalRequest = {
      id: approvalId,
      taskId,
      kind: approvalKind(params.toolCall.kind),
      risk: approvalRisk(params.toolCall.kind),
      title: params.toolCall.title ?? "Gemini tool approval",
      body: permissionBody(params),
      payload: {
        options: params.options,
        toolCall: params.toolCall,
      },
      createdAt: new Date().toISOString(),
    };

    await emit({
      type: "approval.requested",
      taskId,
      approvalId,
      request,
      timestamp: new Date().toISOString(),
    });

    return new Promise((resolve, reject) => {
      this.approvals.set(approvalId, {
        emit,
        options: params.options,
        reject,
        request,
        resolve,
        taskId,
      });
    });
  }

  private async authenticateFromEnvironment(
    connection: acp.ClientSideConnection,
    init: acp.InitializeResponse,
  ): Promise<void> {
    const authMethod = process.env.AGENT_WORKBENCH_GEMINI_AUTH_METHOD ?? (process.env.GEMINI_API_KEY ? "gemini-api-key" : undefined);
    if (!authMethod || !init.authMethods?.some((method) => method.id === authMethod)) {
      return;
    }

    await withTimeout(
      connection.authenticate({
        methodId: authMethod,
        _meta: process.env.GEMINI_API_KEY
          ? {
              "api-key": process.env.GEMINI_API_KEY,
            }
          : undefined,
      }),
      "Gemini ACP authenticate",
      acpRpcTimeoutMs(),
    );
  }

  private enqueue<T>(handle: GeminiAcpHandle, operation: () => Promise<T>): Promise<T> {
    const next = handle.queue.then(operation, operation);
    handle.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private cancelApprovalsForTask(taskId: string, error: Error): void {
    for (const [approvalId, pending] of this.approvals.entries()) {
      if (pending.taskId === taskId) {
        this.approvals.delete(approvalId);
        pending.reject(error);
      }
    }
  }
}

function geminiAcpProfile(): NonNullable<BackendStatus["profile"]> {
  return {
    summary: "Best current backend for Workbench sessions: persistent ACP process, structured tool events, approvals, diff capture, and partial slash command discovery.",
    features: [
      {
        id: "chat",
        label: "Chat turns",
        support: "supported",
        source: "acp",
        description: "Messages are sent through Gemini ACP prompt turns.",
      },
      {
        id: "persistent_session",
        label: "Persistent session",
        support: "partial",
        source: "acp",
        description: "Workbench keeps a live ACP process per session and stores the visible transcript.",
        limitation: "If Gemini ACP cannot restore a backend session after server restart, Workbench falls back to transcript memory.",
      },
      {
        id: "slash_commands",
        label: "Slash commands",
        support: "partial",
        source: "workbench",
        description: "Workbench handles core slash commands natively and forwards the rest to Gemini ACP.",
        limitation: "Full Gemini TUI command parity still requires more Workbench-native command implementations.",
      },
      {
        id: "command_execution",
        label: "Command execution",
        support: "partial",
        source: "acp",
        description: "Gemini can request shell/file/network tools and Workbench can show approvals.",
        limitation: "Gemini TUI-only commands still need Workbench-native panels or terminal fallback.",
      },
      {
        id: "skills",
        label: "Skills",
        support: "partial",
        source: "workbench",
        description: "Workbench can list visible SKILL.md files without attaching Gemini ACP.",
        limitation: "Skill execution/routing is not yet a full Workbench-native registry.",
      },
      {
        id: "memory",
        label: "Memory",
        support: "supported",
        source: "workbench",
        description: "Workbench handles /memory show/list/refresh/add natively, without waiting for Gemini ACP reconnect.",
        limitation: "/memory add writes to ~/.gemini/GEMINI.md, matching Gemini CLI global memory behavior.",
      },
      {
        id: "modes",
        label: "Modes",
        support: "supported",
        source: "acp",
        description: "Default, Plan, Auto Edit, and YOLO modes can be selected for sessions.",
      },
      {
        id: "models",
        label: "Models",
        support: "partial",
        source: "acp",
        description: "Gemini reports model metadata through ACP session updates.",
        limitation: "Workbench does not yet provide a full model selector wired to ACP model changes.",
      },
      {
        id: "approvals",
        label: "Approvals",
        support: "supported",
        source: "acp",
        description: "Gemini permission requests are surfaced in the timeline with allow/deny actions.",
      },
      {
        id: "checkpoints",
        label: "Checkpoints",
        support: "unsupported",
        source: "backend-native",
        description: "Gemini checkpointing is disabled by Workbench by default.",
        limitation: "Workbench uses isolated worktrees and diff/apply flow; Gemini checkpointing can fail on older Git versions.",
      },
      {
        id: "terminal_fallback",
        label: "Terminal fallback",
        support: "planned",
        source: "terminal",
        description: "A real terminal bridge is the planned escape hatch for TUI-only Gemini features.",
      },
      {
        id: "worktree_isolation",
        label: "Worktree isolation",
        support: "supported",
        source: "workbench",
        description: "Each session runs in its own git worktree.",
      },
      {
        id: "diff_review",
        label: "Diff review",
        support: "supported",
        source: "workbench",
        description: "Workbench captures git diffs for review, export, apply, branch, push, and PR actions.",
      },
    ],
    commands: [
      {
        name: "Workbench-native slash commands",
        source: "workbench",
        support: "supported",
        description: "Core commands run in Workbench without attaching a Gemini ACP process.",
        examples: ["/memory show", "/memory list", "/memory add remember this", "/skills list", "/extensions list", "/help", "/about"],
      },
      {
        name: "ACP available commands",
        source: "acp",
        support: "partial",
        description: "Commands reported by Gemini ACP are shown per active session and can be inserted from the composer palette.",
        examples: ["/memory list", "/memory show", "/help", "/about"],
        limitation: "Non-native commands still go through Gemini prompt turns because ACP has no stable separate command-execution method.",
      },
      {
        name: "Workbench session actions",
        source: "workbench",
        support: "supported",
        description: "Apply, export patch, create branch, push branch, draft PR, reconnect, and remove session are Workbench commands.",
      },
    ],
    skills: [
      {
        name: "Gemini project instructions",
        source: "backend-native",
        support: "partial",
        description: "Gemini can read its native project context such as GEMINI.md inside the isolated worktree.",
        limitation: "Workbench does not yet index, edit, or route these as portable skills.",
      },
      {
        name: "Workbench skills",
        source: "workbench",
        support: "planned",
        description: "Portable Workbench skills should map instructions, context files, and allowed tools across backends.",
      },
    ],
    recommendedUse: [
      "Long-running coding sessions that need reviewable diffs.",
      "Tasks where approvals and isolated worktrees matter.",
      "Gemini CLI parity work where ACP exposes enough structure.",
    ],
    limitations: [
      "Not full Gemini TUI parity yet.",
      "Only core slash commands are Workbench-native today; less common Gemini TUI commands still need native implementations or ACP forwarding.",
      "Workbench-native skill management can list skills but does not yet execute or route them as a full registry.",
      "Gemini checkpointing is disabled by default to avoid Git compatibility failures.",
    ],
  };
}

class WorkbenchAcpClient implements acp.Client {
  constructor(
    private readonly backend: GeminiAcpBackend,
    private readonly taskId: string,
    private readonly emit: (event: AgentEvent) => Promise<void>,
  ) {}

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    return this.backend.createPermissionRequest(this.taskId, params, this.emit);
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;
    const timestamp = new Date().toISOString();

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        await this.emit({
          type: "message.delta",
          taskId: this.taskId,
          text: contentBlockText(update.content),
          timestamp,
        });
        break;
      case "agent_thought_chunk":
        await this.emit({
          type: "shell.output",
          taskId: this.taskId,
          stream: "stdout",
          data: `[thought] ${contentBlockText(update.content)}\n`,
          timestamp,
        });
        break;
      case "user_message_chunk":
        break;
      case "tool_call":
        await this.emitToolStarted(update.toolCallId, update.title, {
          content: update.content,
          kind: update.kind,
          locations: update.locations,
          rawInput: update.rawInput,
          status: update.status,
        });
        if (update.status === "completed" || update.status === "failed") {
          await this.emitToolFinished(update.toolCallId, update.title, update.status, update.rawOutput ?? update.content);
        }
        break;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") {
          await this.emitToolFinished(update.toolCallId, update.title ?? undefined, update.status, update.rawOutput ?? update.content);
        } else {
          await this.emitToolStarted(update.toolCallId, update.title ?? `tool:${update.toolCallId}`, {
            content: update.content,
            kind: update.kind,
            locations: update.locations,
            rawInput: update.rawInput,
            status: update.status,
          });
        }
        break;
      case "plan":
        await this.emit({
          type: "message.delta",
          taskId: this.taskId,
          text: formatPlan(update),
          timestamp,
        });
        break;
      case "available_commands_update":
        await this.emitToolFinished("gemini.commands", "gemini.commands", "completed", update.availableCommands);
        break;
      case "current_mode_update":
        await this.emitToolFinished("gemini.mode", "gemini.mode", "completed", { currentModeId: update.currentModeId });
        break;
      case "config_option_update":
        await this.emitToolFinished("gemini.config", "gemini.config", "completed", update.configOptions);
        break;
      case "session_info_update":
        await this.emitToolFinished("gemini.session_info", "gemini.session_info", "completed", {
          title: update.title,
          updatedAt: update.updatedAt,
        });
        break;
      case "usage_update":
        await this.emitToolFinished("gemini.usage", "gemini.usage", "completed", {
          used: update.used,
          size: update.size,
          cost: update.cost,
        });
        break;
    }
  }

  private async emitToolStarted(toolCallId: string, name: string, input?: unknown): Promise<void> {
    await this.emit({
      type: "tool.started",
      taskId: this.taskId,
      toolCallId,
      name,
      input,
      timestamp: new Date().toISOString(),
    });
  }

  private async emitToolFinished(
    toolCallId: string,
    name: string | undefined,
    status: acp.ToolCallStatus,
    output?: unknown,
  ): Promise<void> {
    await this.emit({
      type: "tool.finished",
      taskId: this.taskId,
      toolCallId,
      name,
      status: status === "failed" ? "error" : "ok",
      output,
      timestamp: new Date().toISOString(),
    });
  }
}

function selectPermissionOption(options: acp.PermissionOption[], decision: ApprovalDecision): acp.PermissionOption | undefined {
  switch (decision) {
    case "allow_once":
      return options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always");
    case "allow_for_task":
      return options.find((option) => option.kind === "allow_always") ?? options.find((option) => option.kind === "allow_once");
    case "deny":
      return options.find((option) => option.kind === "reject_once") ?? options.find((option) => option.kind === "reject_always");
    case "deny_and_stop":
      return undefined;
  }
}

function contentBlockText(content: acp.ContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "image":
      return `[image:${content.mimeType}]`;
    case "audio":
      return `[audio:${content.mimeType}]`;
    case "resource_link":
      return `[resource:${content.name}]`;
    case "resource":
      return "[resource]";
  }
}

function formatPlan(plan: acp.Plan): string {
  const lines = plan.entries.map((entry) => `- [${entry.status}] ${entry.content}`);
  return `\nPlan\n${lines.join("\n")}\n`;
}

function permissionBody(params: acp.RequestPermissionRequest): string {
  const options = params.options.map((option) => `${option.name} (${option.kind})`).join(", ");
  const content = params.toolCall.content?.map((item) => {
    if (item.type === "content") {
      return contentBlockText(item.content);
    }
    if (item.type === "diff") {
      return `diff:${item.path}`;
    }
    return `terminal:${item.terminalId}`;
  }).join("\n");
  return [content, `Options: ${options}`].filter(Boolean).join("\n\n");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function approvalKind(kind?: acp.ToolKind | null): ApprovalKind {
  switch (kind) {
    case "execute":
      return "shell_command";
    case "edit":
      return "file_write";
    case "delete":
      return "file_delete";
    case "fetch":
      return "network_access";
    default:
      return "external_app";
  }
}

function approvalRisk(kind?: acp.ToolKind | null): ApprovalRequest["risk"] {
  switch (kind) {
    case "execute":
    case "delete":
      return "high";
    case "edit":
    case "move":
      return "medium";
    default:
      return "low";
  }
}
