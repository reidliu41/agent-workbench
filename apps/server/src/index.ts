import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { EventBus, GitClient, WorkbenchOrchestrator, createLocalToken, createWorkbenchStore, extractToken } from "@agent-workbench/core";
import { ClaudeTerminalBackend, CodexTerminalBackend, GeminiAcpBackend, GeminiBackend, GenericPtyBackend, QwenTerminalBackend } from "@agent-workbench/adapters";
import type {
  ClientMessage,
  AddProjectChangesRequest,
  ApplySessionRequest,
  CommitProjectRequest,
  CreateBranchRequest,
  CreateProjectRequest,
  CreatePullRequestRequest,
  CreateSessionDirectoryRequest,
  CreateSessionBranchRequest,
  CreateSessionSnapshotRequest,
  CreateSessionRequest,
  CreateTaskRequest,
  DeleteProjectResponse,
  DeliveryTargetResponse,
  DirectoryBrowserResponse,
  GeminiProjectSession,
  ImportGeminiSessionRequest,
  ImportNativeCliSessionRequest,
  NativeCliBackendId,
  NativeCliProjectSession,
  RenameSessionRequest,
  RespondApprovalRequest,
  RuntimeConfigResponse,
  SessionFileContentResponse,
  SessionSnapshotPatchResponse,
  SessionTreeEntry,
  SendSessionMessageRequest,
  ServerMessage,
  SetSessionModeRequest,
  SlashCommandInfo,
  SystemDoctorResponse,
  Task,
  ProjectBranchListResponse,
  UpdateProjectRequest,
  UpdateSessionBranchRequest,
  UpdateSessionSnapshotRequest,
  UpdateSessionFileRequest,
  UploadSessionImageRequest,
  UploadSessionImageResponse,
} from "@agent-workbench/protocol";

export interface ServerOptions {
  host?: string;
  port?: number;
  token?: string;
  storePath?: string;
  worktreeRoot?: string;
  logger?: boolean;
}

export interface StartedServer {
  app: FastifyInstance;
  host: string;
  port: number;
  token: string;
  url: string;
  urls: {
    local: string[];
    network: string[];
    all: string[];
  };
}

export async function createWorkbenchServer(options: ServerOptions = {}): Promise<StartedServer> {
  const host = options.host ?? process.env.AGENT_WORKBENCH_HOST ?? "127.0.0.1";
  const port = options.port ?? numberFromEnv("AGENT_WORKBENCH_PORT", 3030);
  const token = options.token ?? process.env.AGENT_WORKBENCH_TOKEN ?? createLocalToken();
  const storePath = options.storePath ?? process.env.AGENT_WORKBENCH_STORE_PATH;
  const worktreeRoot = options.worktreeRoot ?? process.env.AGENT_WORKBENCH_WORKTREE_ROOT ?? join(homedir(), ".agent-workbench", "worktrees");
  const eventBus = new EventBus();
  const store = createWorkbenchStore(storePath);
  const orchestrator = new WorkbenchOrchestrator({
    store,
    git: new GitClient(),
    eventBus,
    backends: [new GeminiAcpBackend(), new GeminiBackend(), new CodexTerminalBackend(), new ClaudeTerminalBackend(), new QwenTerminalBackend(), new GenericPtyBackend()],
    worktreeRoot,
  });
  await orchestrator.init();
  const terminals = new TerminalManager(orchestrator);

  const app = Fastify({ logger: options.logger ?? process.env.AGENT_WORKBENCH_LOGGER === "1" });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeApiError(error);
    reply.code(normalized.statusCode).send(normalized);
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/api/health")) {
      return;
    }
    if (request.url.startsWith("/ws")) {
      return;
    }
    if (!request.url.startsWith("/api/")) {
      return;
    }
    await requireToken(request, reply, token);
  });

  app.get("/api/health", async () => ({
    ok: true,
    version: "0.1.0",
    storagePath: store.path,
  }));

  app.get("/api/storage/status", async () => store.health());

  app.get("/api/slash-commands", async (): Promise<SlashCommandInfo[]> => orchestrator.listNativeSlashCommands());

  app.get("/api/runtime/config", async (): Promise<RuntimeConfigResponse> => ({
    backendCommands: [
      {
        command: process.env.GEMINI_CLI_COMMAND ?? "gemini",
        envVar: "GEMINI_CLI_COMMAND",
        id: "gemini-acp",
        label: "Gemini CLI ACP",
      },
      {
        command: process.env.GEMINI_CLI_COMMAND ?? "gemini",
        envVar: "GEMINI_CLI_COMMAND",
        id: "gemini",
        label: "Gemini CLI one-shot",
      },
      {
        command: process.env.CODEX_CLI_COMMAND ?? "codex",
        envVar: "CODEX_CLI_COMMAND",
        id: "codex",
        label: "Codex CLI terminal",
      },
      {
        command: process.env.CLAUDE_CODE_COMMAND ?? "claude",
        envVar: "CLAUDE_CODE_COMMAND",
        id: "claude",
        label: "Claude Code terminal",
      },
      {
        command: process.env.QWEN_CODE_COMMAND ?? "qwen",
        envVar: "QWEN_CODE_COMMAND",
        id: "qwen",
        label: "Qwen Code terminal",
      },
      {
        command: process.env.AGENT_WORKBENCH_FALLBACK_COMMAND ?? "bash",
        envVar: "AGENT_WORKBENCH_FALLBACK_COMMAND",
        id: "generic-pty",
        label: "Generic CLI fallback",
      },
    ],
    host,
    port,
    security: {
      allInterfaces: host === "0.0.0.0",
      tokenSource: process.env.AGENT_WORKBENCH_TOKEN ? "environment" : "generated",
    },
    storage: {
      path: store.path,
      type: "json",
    },
    terminal: {
      command: process.env.AGENT_WORKBENCH_TERMINAL_COMMAND?.trim() || "gemini",
    },
    worktrees: {
      root: worktreeRoot,
    },
  }));

  app.get("/api/system/doctor", async (): Promise<SystemDoctorResponse> => {
    const [node, git, gemini, codex, claude, qwen, storage] = await Promise.all([
      checkCommand("node", ["-v"]),
      checkCommand("git", ["--version"]),
      checkCommand(process.env.GEMINI_CLI_COMMAND ?? "gemini", ["--version"]),
      checkCommand(process.env.CODEX_CLI_COMMAND ?? "codex", ["--version"]),
      checkCommand(process.env.CLAUDE_CODE_COMMAND ?? "claude", ["--version"]),
      checkCommand(process.env.QWEN_CODE_COMMAND ?? "qwen", ["--version"]),
      store.health(),
    ]);
    const usesJsonStore = extname(storage.path).toLowerCase() === ".json";
    return {
      checks: [node, git, gemini, codex, claude, qwen],
      host,
      port,
      storage: {
        backupExists: storage.backupExists,
        exists: storage.exists,
        lastRecovery: storage.lastRecovery,
        path: storage.path,
      },
      warnings: [
        host === "0.0.0.0" ? "Server is listening on all interfaces. Keep the token private and prefer SSH port forwarding." : undefined,
        usesJsonStore && !storage.backupExists ? "JSON storage backup has not been created yet." : undefined,
        gemini.ok ? undefined : "Gemini CLI is not available; structured Gemini ACP sessions will not work until it is installed and authenticated.",
        codex.ok ? undefined : "Codex CLI is not available; Codex terminal sessions will not work until it is installed and authenticated.",
        claude.ok ? undefined : "Claude Code is not available; Claude terminal sessions will not work until it is installed and authenticated.",
        qwen.ok ? undefined : "Qwen Code is not available; Qwen terminal sessions will not work until it is installed and authenticated.",
      ].filter((warning): warning is string => Boolean(warning)),
    };
  });

  app.get("/", async (request, reply) => {
    const indexPath = await findWebAsset("index.html");
    if (indexPath) {
      return reply.type("text/html").send(await readFile(indexPath, "utf8"));
    }

    const webHost = process.env.AGENT_WORKBENCH_WEB_PUBLIC_HOST ?? request.hostname.split(":")[0] ?? "127.0.0.1";
    const webPort = numberFromEnv("AGENT_WORKBENCH_WEB_PORT", 5173);
    const devUi = `http://${webHost}:${webPort}/?token=${encodeURIComponent(token)}`;
    return reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Agent Workbench</title>
    <style>
      body { background: #111315; color: #e7e2d7; font-family: system-ui, sans-serif; margin: 40px; }
      a { color: #d7ff7a; }
      code { background: #191d1f; border: 1px solid #2a3031; border-radius: 6px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <h1>Agent Workbench API is running</h1>
    <p>In development, open the Web UI at <a href="${devUi}">${devUi}</a>.</p>
    <p>Health endpoint: <code>/api/health</code></p>
  </body>
</html>`);
  });

  app.get("/assets/*", async (request, reply) => {
    const params = request.params as { "*": string };
    const assetPath = await findWebAsset(join("assets", params["*"]));
    if (!assetPath) {
      return reply.code(404).send({ error: "Asset not found." });
    }
    return reply.type(contentType(assetPath)).send(createReadStream(assetPath));
  });

  app.get("/api/filesystem/directories", async (request): Promise<DirectoryBrowserResponse> => {
    const query = request.query as { path?: string };
    return browseDirectories(query.path);
  });

  app.get("/api/projects", async () => orchestrator.listProjects());

  app.get("/api/projects/:id/branches", async (request): Promise<ProjectBranchListResponse> => {
    const params = request.params as { id: string };
    return orchestrator.listProjectBranches(params.id);
  });

  app.post("/api/projects", async (request) => {
    const body = request.body as Partial<CreateProjectRequest>;
    if (!body.path || typeof body.path !== "string") {
      throw new Error("Missing required field: path");
    }
    return orchestrator.addProject(body.path);
  });

  app.patch("/api/projects/:id", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<UpdateProjectRequest>;
    if (!body.name || typeof body.name !== "string") {
      throw new Error("Missing required field: name");
    }
    return orchestrator.renameProject(params.id, body.name);
  });

  app.delete("/api/projects/:id", async (request): Promise<DeleteProjectResponse> => {
    const params = request.params as { id: string };
    const taskIds = (await orchestrator.listTasks()).filter((task) => task.projectId === params.id).map((task) => task.id);
    const result = await orchestrator.deleteProject(params.id);
    for (const taskId of taskIds) {
      setImmediate(() => terminals.stop(taskId));
    }
    return { ok: true, ...result };
  });

  app.get("/api/projects/:id/gemini-sessions", async (request): Promise<GeminiProjectSession[]> => {
    const params = request.params as { id: string };
    return orchestrator.listProjectGeminiSessions(params.id);
  });

  app.get("/api/projects/:id/native-sessions", async (request): Promise<NativeCliProjectSession[]> => {
    const params = request.params as { id: string };
    const query = request.query as { backendId?: NativeCliBackendId };
    return orchestrator.listProjectNativeSessions(params.id, query.backendId);
  });

  app.post("/api/projects/:id/gemini-sessions/import", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<ImportGeminiSessionRequest>;
    if (!body.sessionId || typeof body.sessionId !== "string") {
      throw new Error("Missing required field: sessionId");
    }
    return orchestrator.importGeminiSession(params.id, body.sessionId, body.modeId);
  });

  app.post("/api/projects/:id/native-sessions/import", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<ImportNativeCliSessionRequest>;
    if (!body.backendId || typeof body.backendId !== "string") {
      throw new Error("Missing required field: backendId");
    }
    if (!body.sessionId || typeof body.sessionId !== "string") {
      throw new Error("Missing required field: sessionId");
    }
    return orchestrator.importNativeCliSession(params.id, body.backendId, body.sessionId, body.modeId);
  });

  app.get("/api/tasks", async () => orchestrator.listTasks());

  app.get("/api/sessions", async () => orchestrator.listTasks());

  app.get("/api/sessions/overview", async () => orchestrator.listSessionOverviews());

  app.post("/api/sessions", async (request) => {
    const body = request.body as Partial<CreateSessionRequest>;
    if (!body.projectId || typeof body.projectId !== "string") {
      throw new Error("Missing required field: projectId");
    }
    return orchestrator.createSession({
      projectId: body.projectId,
      title: body.title,
      backendId: body.backendId,
      baseBranch: body.baseBranch,
      workingBranch: body.workingBranch,
      modeId: body.modeId,
      agentSessionId: body.agentSessionId,
    });
  });

  app.patch("/api/sessions/:id", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as Partial<RenameSessionRequest>;
    if (!body.title || typeof body.title !== "string") {
      throw new Error("Missing required field: title");
    }
    return orchestrator.renameSession(params.id, body.title);
  });

  app.post("/api/sessions/:id/messages", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as Partial<SendSessionMessageRequest>;
    if (!body.prompt || typeof body.prompt !== "string") {
      throw new Error("Missing required field: prompt");
    }
    return orchestrator.sendSessionMessage(params.id, body.prompt);
  });

  app.post("/api/sessions/:id/mode", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as Partial<SetSessionModeRequest>;
    if (!body.modeId || typeof body.modeId !== "string") {
      throw new Error("Missing required field: modeId");
    }
    return orchestrator.setSessionMode(params.id, body.modeId);
  });

  app.post("/api/sessions/:id/resume", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.resumeSession(params.id);
  });

  app.post("/api/sessions/:id/queue/clear", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.clearSessionQueue(params.id);
  });

  app.get("/api/sessions/:id/apply-target", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.applyTarget(params.id);
  });

  app.post("/api/sessions/:id/apply", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as ApplySessionRequest;
    return orchestrator.applySession(params.id, body);
  });

  app.post("/api/sessions/:id/apply-force", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.applySessionUnsafe(params.id);
  });

  app.get("/api/sessions/:id/diagnostics", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.sessionDiagnostics(params.id);
  });

  app.get("/api/sessions/:id/files", async (request) => {
    const params = request.params as { id: string };
    const query = request.query as { path?: string };
    if (!query.path || typeof query.path !== "string") {
      throw new Error("Missing required field: path");
    }
    return orchestrator.readSessionFile(params.id, query.path);
  });

  app.get("/api/sessions/:id/files/raw", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { path?: string };
    if (!query.path || typeof query.path !== "string") {
      throw new Error("Missing required field: path");
    }
    const file = await orchestrator.sessionFileReadInfo(params.id, query.path);
    reply.header("cache-control", "no-store");
    return reply.type(file.mimeType).send(createReadStream(file.absolutePath));
  });

  app.get("/api/sessions/:id/tree", async (request): Promise<SessionTreeEntry[]> => {
    const params = request.params as { id: string };
    return orchestrator.listSessionTree(params.id);
  });

  app.put("/api/sessions/:id/files", async (request): Promise<SessionFileContentResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<UpdateSessionFileRequest>;
    if (!body.path || typeof body.path !== "string") {
      throw new Error("Missing required field: path");
    }
    if (typeof body.content !== "string") {
      throw new Error("Missing required field: content");
    }
    return orchestrator.updateSessionFile(params.id, {
      content: body.content,
      path: body.path,
    });
  });

  app.post("/api/sessions/:id/directories", async (request): Promise<SessionTreeEntry> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CreateSessionDirectoryRequest>;
    if (!body.path || typeof body.path !== "string") {
      throw new Error("Missing required field: path");
    }
    return orchestrator.createSessionDirectory(params.id, {
      path: body.path,
    });
  });

  app.post("/api/sessions/:id/uploads/images", { bodyLimit: 18 * 1024 * 1024 }, async (request): Promise<UploadSessionImageResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<UploadSessionImageRequest>;
    if (!body.mimeType || typeof body.mimeType !== "string") {
      throw new Error("Missing required field: mimeType");
    }
    if (!body.contentBase64 || typeof body.contentBase64 !== "string") {
      throw new Error("Missing required field: contentBase64");
    }
    return orchestrator.uploadSessionImage(params.id, {
      contentBase64: body.contentBase64,
      fileName: typeof body.fileName === "string" ? body.fileName : undefined,
      mimeType: body.mimeType,
    });
  });

  app.post("/api/sessions/:id/report", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.exportSessionReport(params.id);
  });

  app.get("/api/sessions/:id/snapshots", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.listSessionSnapshots(params.id);
  });

  app.get("/api/sessions/:id/snapshots/:snapshotId/patch", async (request): Promise<SessionSnapshotPatchResponse> => {
    const params = request.params as { id: string; snapshotId: string };
    return orchestrator.readSessionSnapshotPatch(params.id, params.snapshotId);
  });

  app.post("/api/sessions/:id/snapshots", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as CreateSessionSnapshotRequest;
    return orchestrator.createSessionSnapshot(
      params.id,
      "manual",
      body.label?.trim() || "Manual snapshot",
      body.description?.trim() || undefined,
    );
  });

  app.patch("/api/sessions/:id/snapshots/:snapshotId", async (request) => {
    const params = request.params as { id: string; snapshotId: string };
    const body = (request.body ?? {}) as UpdateSessionSnapshotRequest;
    return orchestrator.updateSessionSnapshot(params.id, params.snapshotId, body);
  });

  app.delete("/api/sessions/:id/snapshots/:snapshotId", async (request) => {
    const params = request.params as { id: string; snapshotId: string };
    await orchestrator.deleteSessionSnapshot(params.id, params.snapshotId);
    return { ok: true };
  });

  app.post("/api/sessions/:id/rollback", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { snapshotId?: string };
    return orchestrator.rollbackSession(params.id, body.snapshotId);
  });

  app.post("/api/sessions/:id/export-patch", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.exportPatch(params.id);
  });

  app.get("/api/sessions/:id/delivery-target", async (request): Promise<DeliveryTargetResponse> => {
    const params = request.params as { id: string };
    return orchestrator.deliveryTarget(params.id);
  });

  app.post("/api/sessions/:id/delivery/add", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<AddProjectChangesRequest>;
    const files = Array.isArray(body.files) ? body.files.filter((file): file is string => typeof file === "string") : [];
    return orchestrator.addOriginalRepositoryChanges(params.id, { files });
  });

  app.post("/api/sessions/:id/delivery/commit", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CommitProjectRequest>;
    if (!body.message || typeof body.message !== "string") {
      throw new Error("Missing required field: message");
    }
    return orchestrator.commitOriginalRepositoryChanges(params.id, { message: body.message });
  });

  app.post("/api/sessions/:id/sync-latest", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.syncSessionToLatest(params.id);
  });

  app.get("/api/sessions/:id/branches", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.listSessionBranches(params.id);
  });

  app.post("/api/sessions/:id/branches", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CreateSessionBranchRequest>;
    return orchestrator.createManagedBranch(params.id, {
      name: body.name,
    });
  });

  app.patch("/api/sessions/:id/branches/:branchId", async (request) => {
    const params = request.params as { id: string; branchId: string };
    const body = (request.body ?? {}) as Partial<UpdateSessionBranchRequest>;
    return orchestrator.updateManagedBranch(params.id, params.branchId, {
      applySelected: body.applySelected,
      name: body.name,
    });
  });

  app.delete("/api/sessions/:id/branches/:branchId", async (request) => {
    const params = request.params as { id: string; branchId: string };
    return orchestrator.removeManagedBranch(params.id, params.branchId);
  });

  app.post("/api/sessions/:id/branch", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CreateBranchRequest>;
    return orchestrator.createSessionBranch(params.id, {
      commitMessage: body.commitMessage,
    });
  });

  app.post("/api/sessions/:id/push", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CreateBranchRequest>;
    return orchestrator.pushSessionBranch(params.id, {
      commitMessage: body.commitMessage,
      remote: body.remote,
    });
  });

  app.post("/api/sessions/:id/pr", async (request) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as Partial<CreatePullRequestRequest>;
    return orchestrator.createPullRequest(params.id, {
      body: body.body,
      commitMessage: body.commitMessage,
      draft: body.draft,
      remote: body.remote,
      title: body.title,
    });
  });

  app.post("/api/sessions/:id/cancel", async (request) => {
    const params = request.params as { id: string };
    const result = await orchestrator.stopTask(params.id);
    setImmediate(() => terminals.stop(params.id));
    return result;
  });

  app.post("/api/sessions/:id/discard", async (request) => {
    const params = request.params as { id: string };
    await orchestrator.deleteSession(params.id);
    setImmediate(() => terminals.stop(params.id));
    return { ok: true };
  });

  app.delete("/api/sessions/:id", async (request) => {
    const params = request.params as { id: string };
    await orchestrator.deleteSession(params.id);
    setImmediate(() => terminals.stop(params.id));
    return { ok: true };
  });

  app.post("/api/tasks", async (request) => {
    const body = request.body as Partial<CreateTaskRequest>;
    if (!body.projectId || typeof body.projectId !== "string") {
      throw new Error("Missing required field: projectId");
    }
    if (!body.prompt || typeof body.prompt !== "string") {
      throw new Error("Missing required field: prompt");
    }
    return orchestrator.createTask({
      projectId: body.projectId,
      title: body.title,
      prompt: body.prompt,
      backendId: body.backendId,
      baseBranch: body.baseBranch,
      modeId: body.modeId,
    });
  });

  app.post("/api/tasks/:id/stop", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.stopTask(params.id);
  });

  app.post("/api/approvals/:id/respond", async (request) => {
    const params = request.params as { id: string };
    const body = request.body as Partial<RespondApprovalRequest>;
    if (!body.taskId || typeof body.taskId !== "string") {
      throw new Error("Missing required field: taskId");
    }
    if (!body.decision) {
      throw new Error("Missing required field: decision");
    }
    await orchestrator.respondToApproval(body.taskId, params.id, body.decision);
    return { ok: true };
  });

  app.get("/api/tasks/:id/events", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.listEvents(params.id);
  });

  app.get("/api/tasks/:id/diff", async (request) => {
    const params = request.params as { id: string };
    return orchestrator.latestDiff(params.id);
  });

  app.get("/api/backends", async () => orchestrator.backendStatuses());

  app.get("/api/capabilities", async () => orchestrator.backendStatuses());

  app.get("/api/backends/gemini/status", async () => {
    const statuses = await orchestrator.backendStatuses();
    return statuses.find((status) => status.id === "gemini");
  });

  app.get("/api/backends/gemini-acp/status", async () => {
    const statuses = await orchestrator.backendStatuses();
    return statuses.find((status) => status.id === "gemini-acp");
  });

  app.get("/ws", { websocket: true }, (connection, request) => {
    const query = request.query as { token?: string };
    const provided = extractToken({
      authorization: request.headers.authorization,
      queryToken: query.token,
    });

    if (provided !== token) {
      connection.close(1008, "Unauthorized");
      return;
    }

    const unsubscribe = eventBus.onMessage((message: ServerMessage) => {
      connection.send(JSON.stringify(message));
    });

    connection.on("message", (raw: { toString(): string }) => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        if (message.type === "subscribe.task") {
          connection.send(JSON.stringify({ type: "subscribed", taskId: message.taskId }));
        }
        if (message.type === "approval.respond" && message.taskId && message.approvalId && message.decision) {
          void orchestrator.respondToApproval(message.taskId, message.approvalId, message.decision).catch((error: unknown) => {
            connection.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          });
        }
        if (message.type === "terminal.open" && message.taskId) {
          void terminals.open(message.taskId, connection, {
            command: message.command,
            cols: message.cols,
            rows: message.rows,
          }).catch((error: unknown) => {
            connection.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          });
        }
        if (message.type === "terminal.restart" && message.taskId) {
          void terminals.restart(message.taskId, connection, {
            command: message.command,
            cols: message.cols,
            rows: message.rows,
          }).catch((error: unknown) => {
            connection.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          });
        }
        if (message.type === "terminal.clear" && message.taskId) {
          terminals.clear(message.taskId);
        }
        if (message.type === "terminal.input" && message.taskId && typeof message.data === "string") {
          terminals.write(message.taskId, message.data);
        }
        if (message.type === "terminal.resize" && message.taskId) {
          terminals.resize(message.taskId, message.cols, message.rows);
        }
        if (message.type === "terminal.stop" && message.taskId) {
          terminals.stop(message.taskId);
        }
        if (message.type === "shell.open" && message.taskId) {
          void terminals.openProjectShell(message.taskId, connection, {
            cols: message.cols,
            rows: message.rows,
          }).catch((error: unknown) => {
            connection.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          });
        }
        if (message.type === "shell.restart" && message.taskId) {
          void terminals.restartProjectShell(message.taskId, connection, {
            cols: message.cols,
            rows: message.rows,
          }).catch((error: unknown) => {
            connection.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
          });
        }
        if (message.type === "shell.clear" && message.taskId) {
          terminals.clearProjectShell(message.taskId);
        }
        if (message.type === "shell.input" && message.taskId && typeof message.data === "string") {
          terminals.writeProjectShell(message.taskId, message.data);
        }
        if (message.type === "shell.resize" && message.taskId) {
          terminals.resizeProjectShell(message.taskId, message.cols, message.rows);
        }
        if (message.type === "shell.stop" && message.taskId) {
          terminals.stopProjectShell(message.taskId);
        }
      } catch {
        connection.send(JSON.stringify({ type: "error", error: "Invalid client message." }));
      }
    });

    connection.on("close", () => {
      terminals.detach(connection);
      unsubscribe();
    });
  });

  await app.listen({ host, port });
  const urls = createAccessUrls(host, port, token);

  return {
    app,
    host,
    port,
    token,
    url: urls.network[0] ?? urls.local[0] ?? `http://${formatUrlHost(host)}:${port}/?token=${encodeURIComponent(token)}`,
    urls,
  };
}

interface TerminalSocket {
  send(data: string): void;
}

interface WorkbenchApiError {
  code: string;
  error: string;
  hint?: string;
  message: string;
  statusCode: number;
}

function normalizeApiError(error: unknown): WorkbenchApiError {
  const source = error as { code?: unknown; message?: unknown; statusCode?: unknown };
  const rawMessage = typeof source.message === "string" && source.message.trim() ? source.message : "Unexpected server error.";
  const code = typeof source.code === "string" ? source.code : undefined;

  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
    return {
      code,
      error: "Bad Request",
      hint: "Send an empty object body `{}` or omit the JSON content-type for requests with no body.",
      message: "Request body is empty while Content-Type is application/json.",
      statusCode: 400,
    };
  }

  if (rawMessage.startsWith("Missing required field:")) {
    return apiError(400, "BAD_REQUEST", rawMessage, "Check the request payload and include the required field.");
  }
  if (rawMessage.includes("not found") || rawMessage.includes("Not found")) {
    return apiError(404, "NOT_FOUND", rawMessage, "Refresh the page and verify the project or session still exists.");
  }
  if (rawMessage.includes("already running")) {
    return apiError(409, "SESSION_BUSY", rawMessage, "Wait for the current turn to finish, or stop it before sending another message.");
  }
  if (rawMessage.includes("No session changes") || rawMessage.includes("No snapshot")) {
    return apiError(409, "NO_ACTIONABLE_CHANGES", rawMessage, "Continue the session until it creates changes, or choose another session.");
  }
  if (rawMessage.includes("local changes") || rawMessage.includes("conflict") || rawMessage.includes("Patch does not apply cleanly")) {
    return apiError(409, "APPLY_CONFLICT", rawMessage, "Review the Apply panel. Use export patch, create branch, or force apply only when you understand the overwrite risk.");
  }
  if (rawMessage.includes("Permission denied")) {
    return apiError(403, "PERMISSION_DENIED", rawMessage, "Check filesystem ownership and repository permissions for the worktree and original repository.");
  }
  if (rawMessage.includes("Failed to initialize checkpointing") && rawMessage.includes("initial-branch")) {
    return apiError(500, "BACKEND_CHECKPOINT_FAILED", simplifyServerError(rawMessage), "Upgrade Git or restart Workbench with Gemini checkpointing disabled.");
  }
  if (rawMessage.includes("gh") && (rawMessage.includes("not found") || rawMessage.includes("auth"))) {
    return apiError(424, "GITHUB_CLI_UNAVAILABLE", rawMessage, "Install and authenticate `gh`, or use branch/push output to create the PR manually.");
  }
  if (rawMessage.includes("origin") || rawMessage.includes("push branch")) {
    return apiError(409, "GIT_REMOTE_UNAVAILABLE", rawMessage, "Check the repository origin remote and push permissions.");
  }

  const explicitStatus = typeof source.statusCode === "number" && source.statusCode >= 400 ? source.statusCode : 500;
  return apiError(explicitStatus, code ?? "INTERNAL_ERROR", simplifyServerError(rawMessage), "Open diagnostics for the session and retry after checking the underlying command output.");
}

function apiError(statusCode: number, code: string, message: string, hint?: string): WorkbenchApiError {
  return {
    code,
    error: statusCode >= 500 ? "Internal Server Error" : statusCode >= 400 ? "Request Error" : "Error",
    hint,
    message,
    statusCode,
  };
}

function simplifyServerError(value: string): string {
  return value
    .replace(/\nusage: git init[\s\S]*$/m, "")
    .replace(/\n\s+/g, "\n")
    .trim();
}

interface TerminalHandle {
  buffer: string[];
  channel: "agent" | "project-shell";
  cols: number;
  command: string;
  cwd: string;
  diffRefresh?: NodeJS.Timeout;
  exited?: {
    exitCode: number;
  };
  obsolete?: boolean;
  recordedStart?: boolean;
  reportedCodexSessionId?: string;
  reportedClaudeSessionId?: string;
  reportedGeminiSessionId?: string;
  reportedQwenSessionId?: string;
  sessionLinkRefresh?: NodeJS.Timeout;
  process: pty.IPty;
  rows: number;
  subscribers: Set<TerminalSocket>;
  task: Task;
}

class TerminalManager {
  private readonly sessions = new Map<string, TerminalHandle>();

  constructor(private readonly orchestrator: WorkbenchOrchestrator) {}

  async open(taskId: string, socket: TerminalSocket, size: { command?: string; cols?: number; rows?: number } = {}): Promise<void> {
    const context = await this.orchestrator.sessionTerminalContext(taskId);
    const cols = clampTerminalSize(size.cols, 20, 240, 120);
    const rows = clampTerminalSize(size.rows, 8, 80, 32);
    const key = terminalKey(taskId, "agent");
    const existing = this.sessions.get(key);
    const command = normalizeTerminalCommand(size.command, context.task, context.worktreePath);
    const handle = existing && !existing.exited ? existing : this.start(key, "agent", taskId, context.task, context.worktreePath, cols, rows, command);
    handle.subscribers.add(socket);
    if (!handle.recordedStart) {
      handle.recordedStart = true;
      void this.orchestrator.recordTerminalStarted(taskId, handle.command, handle.cwd).catch(() => undefined);
    }
    this.sendStatus(socket, taskId, handle);
    for (const chunk of handle.buffer) {
      this.send(socket, { type: "terminal.output", taskId, data: chunk });
    }
  }

  async restart(taskId: string, socket: TerminalSocket, size: { command?: string; cols?: number; rows?: number } = {}): Promise<void> {
    const key = terminalKey(taskId, "agent");
    const existing = this.sessions.get(key);
    if (existing && !existing.exited) {
      existing.obsolete = true;
      existing.subscribers.delete(socket);
      if (existing.diffRefresh) {
        clearTimeout(existing.diffRefresh);
        existing.diffRefresh = undefined;
      }
      this.clearSessionLinkRefresh(existing);
      existing.process.kill();
    }
    this.sessions.delete(key);
    await this.open(taskId, socket, size);
  }

  clear(taskId: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "agent"));
    if (!handle) {
      return;
    }
    handle.buffer = [];
  }

  write(taskId: string, data: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "agent"));
    if (!handle || handle.exited) {
      return;
    }
    handle.process.write(data);
  }

  resize(taskId: string, cols?: number, rows?: number): void {
    const handle = this.sessions.get(terminalKey(taskId, "agent"));
    if (!handle || handle.exited) {
      return;
    }
    handle.cols = clampTerminalSize(cols, 20, 240, handle.cols);
    handle.rows = clampTerminalSize(rows, 8, 80, handle.rows);
    handle.process.resize(handle.cols, handle.rows);
    this.broadcastStatus(taskId, handle);
  }

  stop(taskId: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "agent"));
    if (!handle || handle.exited) {
      return;
    }
    handle.process.kill();
  }

  detach(socket: TerminalSocket): void {
    for (const handle of this.sessions.values()) {
      handle.subscribers.delete(socket);
    }
  }

  async openProjectShell(taskId: string, socket: TerminalSocket, size: { cols?: number; rows?: number } = {}): Promise<void> {
    const context = await this.orchestrator.sessionTerminalContext(taskId);
    const cols = clampTerminalSize(size.cols, 20, 240, 120);
    const rows = clampTerminalSize(size.rows, 8, 80, 32);
    const key = terminalKey(taskId, "project-shell");
    const existing = this.sessions.get(key);
    const shell = process.env.SHELL || "/bin/bash";
    const command = process.env.AGENT_WORKBENCH_PROJECT_SHELL_COMMAND?.trim() || `exec ${shellQuote(shell)} -l`;
    const handle = existing && !existing.exited ? existing : this.start(key, "project-shell", taskId, context.task, context.worktreePath, cols, rows, command);
    handle.subscribers.add(socket);
    this.sendStatus(socket, taskId, handle);
    for (const chunk of handle.buffer) {
      this.send(socket, { type: "shell.output", taskId, data: chunk });
    }
  }

  async restartProjectShell(taskId: string, socket: TerminalSocket, size: { cols?: number; rows?: number } = {}): Promise<void> {
    const key = terminalKey(taskId, "project-shell");
    const existing = this.sessions.get(key);
    if (existing && !existing.exited) {
      existing.obsolete = true;
      existing.subscribers.delete(socket);
      existing.process.kill();
    }
    this.sessions.delete(key);
    await this.openProjectShell(taskId, socket, size);
  }

  clearProjectShell(taskId: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "project-shell"));
    if (handle) {
      handle.buffer = [];
    }
  }

  writeProjectShell(taskId: string, data: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "project-shell"));
    if (!handle || handle.exited) {
      return;
    }
    handle.process.write(data);
  }

  resizeProjectShell(taskId: string, cols?: number, rows?: number): void {
    const handle = this.sessions.get(terminalKey(taskId, "project-shell"));
    if (!handle || handle.exited) {
      return;
    }
    handle.cols = clampTerminalSize(cols, 20, 240, handle.cols);
    handle.rows = clampTerminalSize(rows, 8, 80, handle.rows);
    handle.process.resize(handle.cols, handle.rows);
    this.broadcastStatus(taskId, handle);
  }

  stopProjectShell(taskId: string): void {
    const handle = this.sessions.get(terminalKey(taskId, "project-shell"));
    if (!handle || handle.exited) {
      return;
    }
    handle.process.kill();
  }

  private start(key: string, channel: "agent" | "project-shell", taskId: string, task: Task, cwd: string, cols: number, rows: number, command: string): TerminalHandle {
    const shell = process.env.SHELL || "/bin/bash";
    const guardedCommand = terminalWorktreeCommand(command, cwd, channel === "project-shell" ? "session worktree" : "isolated worktree");
    const env = { ...process.env };
    delete env.GEMINI_CLI_IDE_WORKSPACE_PATH;
    delete env.NO_COLOR;
    const processHandle = pty.spawn(shell, ["-lc", guardedCommand], {
      cols,
      cwd,
      env: {
        ...env,
        AGENT_WORKBENCH_SESSION_ID: task.id,
        AGENT_WORKBENCH_AGENT_SESSION_ID: task.agentSessionId ?? "",
        AGENT_WORKBENCH_DISPLAY_SESSION_ID: displaySessionId(task),
        AGENT_WORKBENCH_WORKTREE: cwd,
        AGENT_WORKBENCH_WORKTREE_REAL: cwd,
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        PWD: cwd,
        TERM: "xterm-256color",
      },
      name: "xterm-256color",
      rows,
    });
    const handle: TerminalHandle = {
      buffer: [`\r\n[Agent Workbench ${channel === "project-shell" ? "project shell" : "terminal"}]\r\ncommand: ${command}\r\ncwd: ${cwd}\r\n\r\n`],
      channel,
      cols,
      command,
      cwd,
      process: processHandle,
      rows,
      subscribers: new Set(),
      task,
    };
    this.sessions.set(key, handle);
    if (channel === "agent") {
      this.scheduleSessionLinkRefresh(taskId, handle);
    }

    processHandle.onData((data) => {
      appendTerminalBuffer(handle, data);
      if (channel === "agent") {
        this.captureNativeSessionFromTerminal(taskId, handle);
        this.scheduleDiffRefresh(taskId, handle);
      }
      this.broadcast(key, { type: channel === "project-shell" ? "shell.output" : "terminal.output", taskId, data });
    });
    processHandle.onExit(({ exitCode }) => {
      if (handle.obsolete) {
        return;
      }
      handle.exited = { exitCode };
      if (handle.diffRefresh) {
        clearTimeout(handle.diffRefresh);
        handle.diffRefresh = undefined;
      }
      this.clearSessionLinkRefresh(handle);
      const message = `\r\n[process exited with code ${exitCode}]\r\n`;
      appendTerminalBuffer(handle, message);
      if (channel === "agent") {
        this.captureNativeSessionFromTerminal(taskId, handle);
      }
      this.broadcast(key, { type: channel === "project-shell" ? "shell.output" : "terminal.output", taskId, data: message });
      this.broadcastStatus(taskId, handle);
      if (channel === "agent") {
        void this.orchestrator.recordTerminalExited(taskId, command, exitCode).catch(() => undefined);
        void this.orchestrator.refreshSessionDiff(taskId).catch(() => undefined);
      }
    });

    return handle;
  }

  private captureNativeSessionFromTerminal(taskId: string, handle: TerminalHandle): void {
    if (handle.task.backendId === "codex") {
      this.captureCodexSessionFromTerminal(taskId, handle);
      return;
    }
    if (handle.task.backendId === "claude") {
      this.captureClaudeSessionFromTerminal(taskId, handle);
      return;
    }
    if (handle.task.backendId === "qwen") {
      this.captureQwenSessionFromTerminal(taskId, handle);
      return;
    }
    this.captureGeminiSessionFromTerminal(taskId, handle);
  }

  private captureGeminiSessionFromTerminal(taskId: string, handle: TerminalHandle): void {
    const sessionId = extractGeminiResumeSessionId(handle.buffer.join(""));
    if (!sessionId || sessionId === handle.reportedGeminiSessionId) {
      return;
    }
    handle.reportedGeminiSessionId = sessionId;
    void this.orchestrator.recordTerminalGeminiSession(taskId, sessionId).catch(() => undefined);
  }

  private captureCodexSessionFromTerminal(taskId: string, handle: TerminalHandle): void {
    const sessionId = extractCodexResumeSessionId(handle.buffer.join(""));
    if (!sessionId || sessionId === handle.reportedCodexSessionId) {
      return;
    }
    handle.reportedCodexSessionId = sessionId;
    void this.orchestrator.recordTerminalCodexSession(taskId, sessionId).catch(() => undefined);
  }

  private captureClaudeSessionFromTerminal(taskId: string, handle: TerminalHandle): void {
    const sessionId = extractClaudeResumeSessionId(handle.buffer.join(""));
    if (!sessionId || sessionId === handle.reportedClaudeSessionId) {
      return;
    }
    handle.reportedClaudeSessionId = sessionId;
    void this.orchestrator.recordTerminalClaudeSession(taskId, sessionId).catch(() => undefined);
  }

  private captureQwenSessionFromTerminal(taskId: string, handle: TerminalHandle): void {
    const sessionId = extractQwenResumeSessionId(handle.buffer.join(""));
    if (!sessionId || sessionId === handle.reportedQwenSessionId) {
      return;
    }
    handle.reportedQwenSessionId = sessionId;
    void this.orchestrator.recordTerminalQwenSession(taskId, sessionId).catch(() => undefined);
  }

  private broadcast(key: string, message: ServerMessage): void {
    const handle = this.sessions.get(key);
    if (!handle) {
      return;
    }
    for (const socket of handle.subscribers) {
      this.send(socket, message);
    }
  }

  private broadcastStatus(taskId: string, handle: TerminalHandle): void {
    for (const socket of handle.subscribers) {
      this.sendStatus(socket, taskId, handle);
    }
  }

  private sendStatus(socket: TerminalSocket, taskId: string, handle: TerminalHandle): void {
    this.send(socket, {
      type: handle.channel === "project-shell" ? "shell.status" : "terminal.status",
      taskId,
      terminal: {
        cols: handle.cols,
        command: handle.command,
        cwd: handle.cwd,
        exitCode: handle.exited?.exitCode,
        rows: handle.rows,
        status: handle.exited ? "exited" : "running",
      },
    });
  }

  private send(socket: TerminalSocket, message: ServerMessage): void {
    socket.send(JSON.stringify(message));
  }

  private scheduleDiffRefresh(taskId: string, handle: TerminalHandle): void {
    if (handle.diffRefresh) {
      clearTimeout(handle.diffRefresh);
    }
    handle.diffRefresh = setTimeout(() => {
      handle.diffRefresh = undefined;
      void this.orchestrator.refreshSessionDiff(taskId).catch(() => undefined);
    }, 900);
  }

  private scheduleSessionLinkRefresh(taskId: string, handle: TerminalHandle): void {
    this.clearSessionLinkRefresh(handle);
    handle.sessionLinkRefresh = setInterval(() => {
      if (handle.exited || handle.obsolete) {
        this.clearSessionLinkRefresh(handle);
        return;
      }
      void this.orchestrator.recordTerminalNativeSessionCandidate(taskId).catch(() => undefined);
    }, 5000);
  }

  private clearSessionLinkRefresh(handle: TerminalHandle): void {
    if (handle.sessionLinkRefresh) {
      clearInterval(handle.sessionLinkRefresh);
      handle.sessionLinkRefresh = undefined;
    }
  }
}

function normalizeTerminalCommand(command?: string, task?: Task, worktreePath?: string): string {
  const requested = command?.trim() || process.env.AGENT_WORKBENCH_TERMINAL_COMMAND?.trim() || defaultTerminalCommand(task);
  if (task?.backendId === "codex") {
    const sessionId = nativeCodexCliSessionId(task);
    const cd = worktreePath ? ` --cd ${shellQuote(worktreePath)}` : "";
    return sessionId ? `codex resume${cd} ${sessionId}` : `codex${cd}`;
  }
  if (task?.backendId === "claude") {
    const sessionId = nativeClaudeCliSessionId(task);
    if (sessionId) {
      return task.agentSessionResumeMode === "resume" ? `claude --resume ${sessionId}` : `claude --session-id ${sessionId} --name ${shellQuote(task.title)}`;
    }
    return "claude";
  }
  if (task?.backendId === "qwen") {
    const sessionId = nativeQwenCliSessionId(task);
    if (sessionId) {
      return task.agentSessionResumeMode === "resume" ? `qwen --resume ${sessionId}` : `qwen --session-id ${sessionId}`;
    }
    return "qwen";
  }
  if (!task || (task.backendId !== "gemini" && task.backendId !== "gemini-acp")) {
    return requested;
  }
  const sessionId = nativeGeminiCliSessionId(task);
  return sessionId ? `gemini --resume ${sessionId}` : "gemini";
}

function defaultTerminalCommand(task?: Task): string {
  if (task?.backendId === "codex") {
    return "codex";
  }
  if (task?.backendId === "claude") {
    return "claude";
  }
  if (task?.backendId === "qwen") {
    return "qwen";
  }
  return "gemini";
}

function terminalKey(taskId: string, channel: "agent" | "project-shell"): string {
  return channel === "agent" ? taskId : `${taskId}:project-shell`;
}

function terminalWorktreeCommand(command: string, cwd: string, label = "isolated worktree"): string {
  const quotedCwd = shellQuote(cwd);
  return [
    `expected_cwd="$(cd ${quotedCwd} && pwd -P)"`,
    `cd ${quotedCwd}`,
    `if [ "$(pwd -P)" != "$expected_cwd" ]; then echo "[Agent Workbench terminal] refused to start outside expected directory"; pwd -P; exit 70; fi`,
    `echo "[Agent Workbench terminal] ${label}: $(pwd -P)"`,
    command,
  ].join("; ");
}

function displaySessionId(task: Task): string {
  return nativeGeminiCliSessionId(task) ?? nativeCodexCliSessionId(task) ?? nativeClaudeCliSessionId(task) ?? nativeQwenCliSessionId(task) ?? task.id;
}

function nativeGeminiCliSessionId(task: Task): string | undefined {
  return task.agentSessionId &&
    (task.backendId === "gemini" || task.backendId === "gemini-acp") &&
    (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported"))
    ? task.agentSessionId
    : undefined;
}

function nativeCodexCliSessionId(task: Task): string | undefined {
  return task.agentSessionId &&
    task.backendId === "codex" &&
    (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported"))
    ? task.agentSessionId
    : undefined;
}

function nativeClaudeCliSessionId(task: Task): string | undefined {
  return task.agentSessionId &&
    task.backendId === "claude" &&
    (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported"))
    ? task.agentSessionId
    : undefined;
}

function nativeQwenCliSessionId(task: Task): string | undefined {
  return task.agentSessionId &&
    task.backendId === "qwen" &&
    (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported"))
    ? task.agentSessionId
    : undefined;
}

function isGeminiTerminalCommand(command: string): boolean {
  return command === "gemini" || /^gemini\s+--resume(?:=|\s+)/.test(command);
}

function isCodexTerminalCommand(command: string): boolean {
  return command === "codex" || /^codex\s+(resume|--cd|--no-alt-screen)(?:\s|$)/.test(command);
}

function isClaudeTerminalCommand(command: string): boolean {
  return command === "claude" || /^claude\s+(--resume|--session-id|-r)(?:=|\s|$)/.test(command);
}

function isQwenTerminalCommand(command: string): boolean {
  return command === "qwen" || /^qwen\s+(--resume|--session-id|-r)(?:=|\s|$)/.test(command);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function checkCommand(name: string, args: string[]): Promise<{ name: string; ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ name, ok: false, output: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ name, ok: exitCode === 0, output: output.trim() });
    });
  });
}

function clampTerminalSize(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function appendTerminalBuffer(handle: TerminalHandle, data: string): void {
  handle.buffer.push(data);
  let size = handle.buffer.reduce((total, chunk) => total + chunk.length, 0);
  while (size > 200_000 && handle.buffer.length > 1) {
    size -= handle.buffer.shift()?.length ?? 0;
  }
}

function extractGeminiResumeSessionId(raw: string): string | undefined {
  const text = stripTerminalControl(raw);
  const resumeMatch = text.match(/gemini\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1];
  }
  return undefined;
}

function extractCodexResumeSessionId(raw: string): string | undefined {
  const text = stripTerminalControl(raw);
  const resumeMatch = text.match(/codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1];
  }
  return undefined;
}

function extractClaudeResumeSessionId(raw: string): string | undefined {
  const text = stripTerminalControl(raw);
  const resumeMatch = text.match(/claude\s+(?:--resume|-r|--session-id)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1];
  }
  return undefined;
}

function extractQwenResumeSessionId(raw: string): string | undefined {
  const text = stripTerminalControl(raw);
  const resumeMatch = text.match(/qwen\s+(?:--resume|-r)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1];
  }
  return undefined;
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

async function requireToken(request: FastifyRequest, reply: FastifyReply, expected: string): Promise<void> {
  const query = request.query as { token?: string };
  const provided = extractToken({
    authorization: request.headers.authorization,
    queryToken: query.token,
  });

  const origin = request.headers.origin;
  if (origin && !isAllowedOrigin(origin, request.headers.host)) {
    await reply.code(403).send({ error: "Forbidden origin." });
    return;
  }

  if (provided !== expected) {
    await reply.code(401).send({ error: "Unauthorized." });
  }
}

if (isStandaloneServerEntry()) {
  void startStandaloneServer();
}

function isStandaloneServerEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  const modulePath = fileURLToPath(import.meta.url);
  if (resolve(entry) !== resolve(modulePath)) {
    return false;
  }
  return modulePath.replaceAll("\\", "/").endsWith("/apps/server/src/index.ts");
}

async function startStandaloneServer(): Promise<void> {
  const started = await createWorkbenchServer();
  if (started.host === "0.0.0.0") {
    console.warn("Warning: Agent Workbench is listening on all interfaces. Keep the token private and prefer SSH port forwarding when possible.");
  }
  console.log(`Agent Workbench running at: ${started.url}`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function findWebAsset(relativePath: string): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "apps/web/dist", relativePath),
    resolve(here, "../../apps/web/dist", relativePath),
    resolve(here, "../../../apps/web/dist", relativePath),
    resolve(here, "../../../../apps/web/dist", relativePath),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

async function browseDirectories(inputPath?: string): Promise<DirectoryBrowserResponse> {
  const directoryPath = resolve(inputPath?.trim() || homedir());
  let dirents;
  try {
    dirents = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open directory ${directoryPath}: ${message}`);
  }

  const entries = await Promise.all(
    dirents
      .filter((dirent) => dirent.isDirectory())
      .map(async (dirent) => {
        const path = join(directoryPath, dirent.name);
        return {
          gitRepository: await isGitRepositoryDirectory(path),
          hidden: dirent.name.startsWith("."),
          name: dirent.name,
          path,
        };
      }),
  );

  entries.sort((left, right) => {
    if (left.gitRepository !== right.gitRepository) {
      return left.gitRepository ? -1 : 1;
    }
    if (left.hidden !== right.hidden) {
      return left.hidden ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });

  const parentPath = dirname(directoryPath);
  return {
    entries,
    gitRepository: await isGitRepositoryDirectory(directoryPath),
    parentPath: parentPath === directoryPath ? undefined : parentPath,
    path: directoryPath,
  };
}

async function isGitRepositoryDirectory(path: string): Promise<boolean> {
  try {
    await access(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css";
    case ".js":
      return "text/javascript";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function isAllowedOrigin(origin: string, requestHost?: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (requestHost && parsed.host === requestHost) {
      return true;
    }
    const hostname = parsed.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return true;
    }
    if (hostname === process.env.AGENT_WORKBENCH_HOST || hostname === process.env.AGENT_WORKBENCH_WEB_PUBLIC_HOST) {
      return true;
    }
    return process.env.AGENT_WORKBENCH_ALLOW_REMOTE_ORIGIN === "1";
  } catch {
    return false;
  }
}

function createAccessUrls(host: string, port: number, token: string): StartedServer["urls"] {
  const localHosts: string[] = [];
  const networkHosts: string[] = [];

  if (isAllInterfaces(host)) {
    localHosts.push("127.0.0.1");
    networkHosts.push(...nonInternalIPv4Addresses());
  } else if (isLoopbackHost(host)) {
    localHosts.push(host);
  } else {
    networkHosts.push(host);
  }

  const local = unique(localHosts).map((urlHost) => createUrl(urlHost, port, token));
  const network = unique(networkHosts).map((urlHost) => createUrl(urlHost, port, token));
  return {
    local,
    network,
    all: unique([...network, ...local]),
  };
}

function nonInternalIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function createUrl(host: string, port: number, token: string): string {
  return `http://${formatUrlHost(host)}:${port}/?token=${encodeURIComponent(token)}`;
}

function formatUrlHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

function isAllInterfaces(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
