import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type {
  AgentContextStatus,
  AgentEvent,
  AddProjectChangesRequest,
  ApplySessionRequest,
  ApplySessionResponse,
  ApplyTargetResponse,
  ApplyPreflight,
  ApprovalDecision,
  BackendStatus,
  CommitProjectRequest,
  CreateBranchRequest,
  CreateBranchResponse,
  CreatePullRequestRequest,
  CreatePullRequestResponse,
  CreateSessionDirectoryRequest,
  CreateSessionBranchRequest,
  CreateSessionRequest,
  CreateTaskRequest,
  DeliveryTargetResponse,
  DiffSummary,
  DiffSnapshot,
  ExportSessionReportResponse,
  ExportPatchResponse,
  GeminiProjectSession,
  NativeCliBackendId,
  NativeCliProjectSession,
  Project,
  ProjectBranchListResponse,
  ProjectDeliveryResponse,
  PushBranchResponse,
  RollbackSessionResponse,
  SessionAction,
  SessionBranch,
  SessionBranchListResponse,
  SessionDiagnostics,
  SessionDeliverySummary,
  SessionFileContentResponse,
  SessionFileOverlap,
  SessionHealth,
  SessionOverview,
  SessionRisk,
  SessionSnapshot,
  SessionState,
  SessionSnapshotPatchResponse,
  SyncSessionToLatestResponse,
  SessionTreeEntry,
  SlashCommandInfo,
  Task,
  UpdateSessionBranchRequest,
  UpdateSessionSnapshotRequest,
  UpdateSessionFileRequest,
  UploadSessionImageRequest,
  UploadSessionImageResponse,
} from "@agent-workbench/protocol";
import { EventBus } from "../events/eventBus.js";
import { GitClient } from "../git/gitClient.js";
import {
  findClaudeProjectSession,
  findLatestClaudeProjectSession,
  listClaudeProjectSessions,
} from "../integrations/claudeSessions.js";
import {
  findLatestCodexProjectSession,
  listCodexProjectSessions,
} from "../integrations/codexSessions.js";
import {
  bridgeGeminiSessionToWorktree,
  listGeminiProjectSessionCandidates,
  listGeminiProjectSessions,
} from "../integrations/geminiSessions.js";
import {
  bridgeQwenSessionToWorktree,
  listQwenProjectSessions,
} from "../integrations/qwenSessions.js";
import type { WorkbenchStore } from "../storage/localStore.js";

export interface AgentBackend {
  id: string;
  name: string;
  detect(): Promise<BackendStatus>;
  startTask(input: {
    task: Task;
    project: Project;
    worktreePath: string;
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<void>;
  startSession?(input: {
    agentSessionId?: string;
    task: Task;
    project: Project;
    worktreePath: string;
    modeId?: string;
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<
    | {
        agentSessionId?: string;
        resumeMode?: "new" | "load" | "resume";
      }
    | void
  >;
  sendMessage?(input: {
    task: Task;
    project: Project;
    worktreePath: string;
    prompt: string;
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<{ stopReason?: string } | void>;
  hasSession?(taskId: string): boolean;
  cancelSession?(taskId: string): Promise<void>;
  resolveApproval?(approvalId: string, decision: ApprovalDecision): Promise<void>;
  setMode?(taskId: string, modeId: string): Promise<void>;
  stopTask?(taskId: string): Promise<void>;
}

export interface WorkbenchOptions {
  store: WorkbenchStore;
  git: GitClient;
  eventBus: EventBus;
  backends: AgentBackend[];
  worktreeRoot?: string;
}

interface QueuedTurn {
  prompt: string;
  queuedAt: string;
}

export class WorkbenchOrchestrator {
  private readonly activeTurns = new Map<string, string>();
  private readonly activeTerminals = new Map<string, { command: string; cwd: string; startedAt: string }>();
  private readonly backends = new Map<string, AgentBackend>();
  private readonly queuedTurns = new Map<string, QueuedTurn[]>();
  private readonly sessionStartups = new Map<string, Promise<void>>();
  private readonly worktreeRoot: string;

  constructor(private readonly options: WorkbenchOptions) {
    for (const backend of options.backends) {
      this.backends.set(backend.id, backend);
    }
    this.worktreeRoot = options.worktreeRoot ?? join(homedir(), ".agent-workbench", "worktrees");
  }

  async init(): Promise<void> {
    await this.options.store.init();
    await this.repairQwenResumeStates();
    await this.recoverStaleSessions();
  }

  async listProjects(): Promise<Project[]> {
    return this.options.store.listProjects();
  }

  async listProjectBranches(projectId: string): Promise<ProjectBranchListResponse> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    const branches = await this.options.git.listBranches(project.path);
    return {
      branches: branches
        .filter((branch) => !branch.name.startsWith("agent-workbench/"))
        .map((branch) => ({
          active: branch.active,
          checkedOutHere: branch.checkedOutHere,
          checkedOutPath: branch.checkedOutPath,
          name: branch.name,
          updatedAt: branch.updatedAt,
        })),
      currentBranch: branches.find((branch) => branch.active)?.name,
    };
  }

  async addProject(path: string): Promise<Project> {
    const repo = await this.options.git.requireRepo(path);
    const now = new Date().toISOString();
    const existing = (await this.options.store.listProjects()).find((project) => project.path === repo.root);
    const project: Project = {
      id: existing?.id ?? randomUUID(),
      name: repo.name,
      path: repo.root,
      defaultBranch: repo.defaultBranch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.options.store.upsertProject(project);
  }

  async renameProject(projectId: string, name: string): Promise<Project> {
    const title = name.trim();
    if (!title) {
      throw new Error("Project name cannot be empty.");
    }
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    return this.options.store.upsertProject({
      ...project,
      name: title,
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteProject(projectId: string): Promise<{ projectId: string; removedSessions: number }> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    const tasks = (await this.options.store.listTasks()).filter((task) => task.projectId === projectId);
    for (const task of tasks) {
      await this.deleteSession(task.id);
    }
    await this.options.store.deleteProject(projectId);
    return {
      projectId,
      removedSessions: tasks.length,
    };
  }

  async listTasks(): Promise<Task[]> {
    return this.options.store.listTasks();
  }

  private async repairQwenResumeStates(): Promise<void> {
    const tasks = await this.options.store.listTasks();
    for (const task of tasks) {
      if (
        !isQwenBackendId(task.backendId) ||
        task.agentSessionResumeMode !== "resume" ||
        !task.agentSessionId ||
        !task.worktreePath
      ) {
        continue;
      }
      if (await qwenSessionFileExists(task.worktreePath, task.agentSessionId)) {
        continue;
      }
      await this.updateTask({
        ...task,
        agentContextStatus: task.agentContextStatus ?? "live",
        agentSessionResumeMode: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  private async recoverStaleSessions(): Promise<void> {
    const tasks = await this.options.store.listTasks();
    for (const task of tasks) {
      if (!isRestartRecoverableStatus(task.status)) {
        continue;
      }

      const backend = this.backends.get(task.backendId);
      if (backend?.hasSession?.(task.id)) {
        continue;
      }

      const now = new Date().toISOString();
      let diff: DiffSnapshot | undefined;
      if (task.worktreePath) {
        try {
          diff = await this.captureDiff(task);
        } catch {
          diff = await this.options.store.latestDiff(task.id);
        }
      }

      const hasChanges = Boolean(diff && diff.summary.filesChanged > 0);
      const status = hasChanges ? "review_ready" : "failed";
      await this.updateTask({
        ...task,
        agentContextStatus: "transcript_fallback",
        completedAt: now,
        status,
        updatedAt: now,
      });
      await this.emitAction(
        task.id,
        "recover",
        "completed",
        "Recovered session after server restart.",
        hasChanges
          ? "Workbench restarted while this session was active. The agent process is gone, but worktree changes were preserved for review."
          : "Workbench restarted while this session was active. The agent process is gone and no worktree changes were detected.",
        {
          filesChanged: diff?.summary.filesChanged ?? 0,
          previousStatus: task.status,
          recoveredAt: now,
          worktreePath: task.worktreePath,
        },
      );
    }
  }

  async listSessionOverviews(): Promise<SessionOverview[]> {
    const [projects, tasks] = await Promise.all([this.options.store.listProjects(), this.options.store.listTasks()]);
    const now = Date.now();
    const overviews = await Promise.all(
      tasks.map(async (task) => {
        const [events, diff, snapshots] = await Promise.all([
          this.options.store.listEvents(task.id),
          this.options.store.latestDiff(task.id),
          this.options.store.listSnapshots(task.id),
        ]);
        const project = projects.find((item) => item.id === task.projectId);
        const lastEvent = events.at(-1);
        const lastEventAt = lastEvent?.timestamp ?? task.updatedAt;
        const waitingApprovals = countWaitingApprovals(events);
        const runtimeMs = task.startedAt ? Math.max(0, now - Date.parse(task.startedAt)) : 0;
        const lastEventMs = Date.parse(lastEventAt);
        const idleMs = Number.isFinite(lastEventMs) ? Math.max(0, now - lastEventMs) : 0;
        const activeTurn = this.activeTurns.has(task.id);
        const queuedTurns = this.queuedTurns.get(task.id)?.length ?? 0;
        const conflictFiles = latestApplyConflictFiles(events);
        const applied = task.status === "applied";
        const branchReady = task.status === "branch_ready";
        const prReady = task.status === "pr_ready";
        const terminal = this.liveTerminalSummary(task.id, summarizeTerminal(events));
        const orphanedRunning = isOrphanedRunningTask(task, {
          activeTurn,
          idleMs,
          startupActive: this.sessionStartups.has(task.id),
          terminal,
        });
        const stuck = task.status === "running" && (idleMs > 5 * 60 * 1000 || orphanedRunning);
        const latestDelivery = summarizeLatestDelivery(events);
        const filesChanged = diff?.summary.filesChanged ?? 0;
        const stage = overviewStage(task, waitingApprovals, stuck, conflictFiles, terminal, {
          activeTurn,
          filesChanged,
          latestDelivery,
          queuedTurns,
          snapshots: snapshots.length,
        });
        const state = overviewState(task, {
          activeTurn,
          conflictFiles,
          filesChanged,
          latestDelivery,
          queuedTurns,
          snapshots: snapshots.length,
          stuck,
          terminal,
          waitingApprovals,
        });
        const health = overviewHealth(task, stage, waitingApprovals, conflictFiles, stuck, state);
        const risk = overviewRisk(task, {
          conflictFiles,
          filesChanged,
          insertions: diff?.summary.insertions ?? 0,
          stuck,
          terminal,
          waitingApprovals,
        });

        const nextAction = overviewNextAction(task, stage, waitingApprovals, conflictFiles, diff?.summary.filesChanged ?? 0, terminal);
        return {
          agentName: this.backends.get(task.backendId)?.name ?? task.backendId,
          applied,
          activeTurn,
          branchReady,
          conflictFiles,
          currentStep: summarizeCurrentStep(events, task),
          filesChanged,
          health,
          healthReason: overviewHealthReason(health, task, waitingApprovals, conflictFiles, stuck, orphanedRunning),
          idleMs,
          insertions: diff?.summary.insertions ?? 0,
          lastAgentMessage: summarizeLastAgentMessage(events),
          lastError: summarizeLastError(events),
          lastEventAt,
          latestDelivery,
          nextAction: queuedTurns > 0 ? `${nextAction} · ${queuedTurns} queued` : nextAction,
          overlapFiles: [],
          prReady,
          projectName: project?.name ?? task.projectId,
          projectPath: project?.path ?? "",
          queuedTurns,
          risk: risk.level,
          riskReasons: risk.reasons,
          runtimeMs,
          snapshotCount: snapshots.length,
          stage,
          state,
          stateReason: overviewStateReason(state, task, {
            activeTurn,
            conflictFiles,
            filesChanged,
            latestDelivery,
            queuedTurns,
            snapshots: snapshots.length,
            stuck,
            terminal,
            waitingApprovals,
          }),
          stuck,
          task,
          terminal,
          touchedFiles: diff?.summary.files.map((file) => file.path) ?? [],
          waitingApprovals,
        };
      }),
    );
    return addFileOverlapRisk(overviews)
      .sort((left, right) => Date.parse(right.lastEventAt ?? right.task.updatedAt) - Date.parse(left.lastEventAt ?? left.task.updatedAt));
  }

  async createTask(input: CreateTaskRequest): Promise<Task> {
    const projects = await this.options.store.listProjects();
    const project = projects.find((item) => item.id === input.projectId);
    if (!project) {
      throw new Error("Project not found.");
    }

    const backendId = input.backendId ?? "gemini";
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new Error(`Backend not found: ${backendId}`);
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const worktreeBranch = `agent-workbench/${id}`;
    const worktreePath = join(this.worktreeRoot, project.name, id);

    const baseBranch = input.baseBranch ?? (await this.options.git.currentBranch(project.path).catch(() => project.defaultBranch));
    await this.options.git.createWorktree(project.path, worktreePath, worktreeBranch, baseBranch ?? project.defaultBranch);

    let task: Task = {
      id,
      projectId: project.id,
      backendId,
      title: input.title?.trim() || input.prompt.slice(0, 80) || "Untitled task",
      prompt: input.prompt,
      status: "starting",
      baseBranch: input.baseBranch ?? project.defaultBranch,
      modeId: input.modeId,
      worktreePath,
      worktreeBranch,
      branches: createInitialSessionBranches(worktreeBranch, now),
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };

    task = await this.options.store.upsertTask(task);
    this.options.eventBus.publishTask(task);

    void this.runBackend(backend, task, project, worktreePath);
    return task;
  }

  async createSession(input: CreateSessionRequest): Promise<Task> {
    const projects = await this.options.store.listProjects();
    const project = projects.find((item) => item.id === input.projectId);
    if (!project) {
      throw new Error("Project not found.");
    }

    const backendId = input.backendId ?? "gemini-acp";
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new Error(`Backend not found: ${backendId}`);
    }
    if (!backend.startSession || !backend.sendMessage) {
      throw new Error(`Backend does not support persistent sessions: ${backendId}`);
    }

    if (input.agentSessionId) {
      const existing = (await this.options.store.listTasks()).find(
        (task) =>
          task.projectId === project.id &&
          task.backendId === backendId &&
          task.agentSessionId === input.agentSessionId,
      );
      if (existing) {
        return existing;
      }
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    const worktreePath = join(this.worktreeRoot, project.name, id);
    const workingBranch = normalizeBranchName(input.workingBranch) || defaultSessionBranchName(id);
    if (await this.options.git.branchExists(project.path, workingBranch)) {
      throw new Error(`Branch already exists: ${workingBranch}. Choose a new session branch name.`);
    }
    const baseBranch = input.baseBranch || (await this.newWorkingBranchStartPoint(project.path, project.defaultBranch));

    await this.options.git.createWorktree(project.path, worktreePath, workingBranch, baseBranch);

    if (input.agentSessionId && isGeminiBackendId(backendId)) {
      await bridgeGeminiSessionToWorktree(project.path, worktreePath, input.agentSessionId);
    }
    if (input.agentSessionId && isQwenBackendId(backendId)) {
      await bridgeQwenSessionToWorktree(project.path, worktreePath, input.agentSessionId);
    }

    const nativeAgentSessionId = usesPreallocatedNativeSessionId(backendId) ? (input.agentSessionId ?? randomUUID()) : input.agentSessionId;

    let task: Task = {
      id,
      projectId: project.id,
      backendId,
      title: input.title?.trim() || "New session",
      prompt: "",
      status: "starting",
      agentSessionId: nativeAgentSessionId,
      agentSessionKind: nativeAgentSessionId && isNativeCliBackendId(backendId) ? "native-cli" : undefined,
      agentSessionOrigin: isNativeCliBackendId(backendId) ? (input.agentSessionId ? "imported" : "new") : undefined,
      agentSessionResumeMode: input.agentSessionId && isNativeCliBackendId(backendId) ? "resume" : undefined,
      baseBranch,
      modeId: input.modeId,
      worktreePath,
      worktreeBranch: workingBranch,
      branches: createInitialSessionBranches(workingBranch, now),
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };

    task = await this.options.store.upsertTask(task);
    this.options.eventBus.publishTask(task);

    const running = await this.updateTask({ ...task, status: "running", updatedAt: new Date().toISOString() });
    await this.emit({ type: "task.started", taskId: running.id, timestamp: new Date().toISOString() });

    this.attachSession(backend, running, project, worktreePath, input.modeId);
    return running;
  }

  async listProjectGeminiSessions(projectId: string): Promise<GeminiProjectSession[]> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    return listGeminiProjectSessions(project.path);
  }

  async importGeminiSession(projectId: string, sessionId: string, modeId?: string): Promise<Task> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    const sessions = await listGeminiProjectSessions(project.path);
    const nativeSession = sessions.find((session) => session.id === sessionId);
    if (!nativeSession) {
      throw new Error(`Gemini session not found: ${sessionId}`);
    }
    return this.createSession({
      agentSessionId: nativeSession.id,
      backendId: "gemini-acp",
      modeId,
      projectId,
      title: nativeSession.displayName || nativeSession.firstUserMessage || "Imported Gemini session",
    });
  }

  async listProjectNativeSessions(projectId: string, backendId?: NativeCliBackendId): Promise<NativeCliProjectSession[]> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    const backendIds: NativeCliBackendId[] = backendId ? [backendId] : ["gemini-acp", "codex", "claude", "qwen", "copilot"];
    const groups = await Promise.all(
      backendIds.map(async (id) => {
        if (id === "gemini-acp") {
          return (await listGeminiProjectSessions(project.path)).map((session): NativeCliProjectSession => ({
            backendId: "gemini-acp",
            backendName: "Gemini CLI",
            displayName: session.displayName,
            fileName: session.fileName,
            firstUserMessage: session.firstUserMessage,
            id: session.id,
            lastUpdated: session.lastUpdated,
            messageCount: session.messageCount,
            startTime: session.startTime,
            summary: session.summary,
          }));
        }
        if (id === "codex") {
          return (await listCodexProjectSessions(project.path, true)).map((session): NativeCliProjectSession => ({
            backendId: "codex",
            backendName: "OpenAI Codex",
            displayName: session.displayName,
            fileName: session.fileName,
            firstUserMessage: session.firstUserMessage,
            id: session.id,
            lastUpdated: session.lastUpdated,
            messageCount: session.messageCount,
            startTime: session.startTime,
          }));
        }
        if (id === "qwen") {
          return (await listQwenProjectSessions(project.path)).map((session): NativeCliProjectSession => ({
            backendId: "qwen",
            backendName: "Qwen Code",
            displayName: session.displayName,
            fileName: session.fileName,
            firstUserMessage: session.firstUserMessage,
            id: session.id,
            lastUpdated: session.lastUpdated,
            messageCount: session.messageCount,
            startTime: session.startTime,
            summary: session.summary,
          }));
        }
        if (id === "copilot") {
          return [];
        }
        return (await listClaudeProjectSessions(project.path)).map((session): NativeCliProjectSession => ({
          backendId: "claude",
          backendName: "Claude Code",
          displayName: session.firstUserMessage || session.id,
          fileName: session.fileName,
          firstUserMessage: session.firstUserMessage,
          id: session.id,
          lastUpdated: session.lastUpdated,
          messageCount: session.messageCount,
          startTime: session.startTime,
          summary: session.version,
        }));
      }),
    );
    return groups.flat().sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
  }

  async importNativeCliSession(projectId: string, backendId: NativeCliBackendId, sessionId: string, modeId?: string): Promise<Task> {
    const project = (await this.options.store.listProjects()).find((item) => item.id === projectId);
    if (!project) {
      throw new Error("Project not found.");
    }
    const sessions = await this.listProjectNativeSessions(projectId, backendId);
    const nativeSession = sessions.find((session) => session.id === sessionId);
    if (!nativeSession) {
      throw new Error(`${nativeCliBackendName(backendId)} session not found: ${sessionId}`);
    }
    return this.createSession({
      agentSessionId: nativeSession.id,
      backendId,
      modeId,
      projectId,
      title: nativeSession.displayName || nativeSession.firstUserMessage || `Imported ${nativeSession.backendName} session`,
    });
  }

  async sendSessionMessage(taskId: string, prompt: string): Promise<Task> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new Error("Missing required field: prompt");
    }

    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    if (!task.worktreePath) {
      throw new Error("Task has no worktree.");
    }

    const projects = await this.options.store.listProjects();
    const project = projects.find((item) => item.id === task.projectId);
    if (!project) {
      throw new Error("Project not found.");
    }

    const backend = this.backends.get(task.backendId);
    if (!backend?.sendMessage) {
      throw new Error(`Backend does not support persistent sessions: ${task.backendId}`);
    }
    const sessionBackend = backend as AgentBackend & { sendMessage: NonNullable<AgentBackend["sendMessage"]> };

    if (this.activeTurns.has(task.id)) {
      const queuedAt = new Date().toISOString();
      const queue = this.queuedTurns.get(task.id) ?? [];
      queue.push({ prompt: trimmed, queuedAt });
      this.queuedTurns.set(task.id, queue);
      const updated = await this.updateTask({
        ...task,
        completedAt: undefined,
        prompt: trimmed,
        status: "running",
        updatedAt: queuedAt,
      });
      await this.emit({ type: "user.message", taskId, text: trimmed, timestamp: queuedAt });
      await this.emitAction(
        task.id,
        "enqueue",
        "completed",
        "Queued message for this session.",
        `${queue.length} pending message${queue.length === 1 ? "" : "s"} will run after the current turn.`,
        {
          pending: queue.length,
          queuedAt,
        },
      );
      return updated;
    }

    return this.startPromptTurn(sessionBackend, task, project, task.worktreePath, trimmed, true);
  }

  private async startPromptTurn(
    backend: AgentBackend & { sendMessage: NonNullable<AgentBackend["sendMessage"]> },
    task: Task,
    project: Project,
    worktreePath: string,
    prompt: string,
    emitUserMessage: boolean,
  ): Promise<Task> {
    const turnId = randomUUID();
    this.activeTurns.set(task.id, turnId);

    const running = await this.updateTask({
      ...task,
      completedAt: undefined,
      prompt,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    if (emitUserMessage) {
      await this.emit({ type: "user.message", taskId: task.id, text: prompt, timestamp: new Date().toISOString() });
    }

    try {
      if (await this.handleNativeSlashCommand(running, project, worktreePath, prompt, turnId)) {
        this.clearActiveTurn(task.id, turnId);
        void this.startNextQueuedTurn(task.id).catch(() => undefined);
        return running;
      }
      if (await this.handleUnsupportedSlashCommand(running, prompt, turnId)) {
        this.clearActiveTurn(task.id, turnId);
        void this.startNextQueuedTurn(task.id).catch(() => undefined);
        return running;
      }
    } catch (error) {
      if (this.isActiveTurn(running.id, turnId)) {
        await this.updateTask({
          ...running,
          status: "failed",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await this.emit({
          type: "turn.finished",
          taskId: running.id,
          status: "failed",
          error: formatUnknownError(error),
          timestamp: new Date().toISOString(),
        });
      }
      this.clearActiveTurn(task.id, turnId);
      void this.startNextQueuedTurn(task.id).catch(() => undefined);
      return running;
    }

    void this.processSessionMessage(backend, running, project, worktreePath, prompt, turnId).catch(() => undefined);
    return running;
  }

  private async processSessionMessage(
    backend: AgentBackend & { sendMessage: NonNullable<AgentBackend["sendMessage"]> },
    running: Task,
    project: Project,
    worktreePath: string,
    prompt: string,
    turnId: string,
  ): Promise<void> {
    try {
      const attachMode = await this.ensureSessionAttached(backend, running, project, worktreePath);
      if (!this.isActiveTurn(running.id, turnId)) {
        return;
      }
      const promptWithMemory = await this.promptWithSessionMemoryIfNeeded(running, prompt, attachMode);
      const result = await backend.sendMessage({
        task: running,
        project,
        worktreePath,
        prompt: promptWithMemory,
        emit: (event) => this.emit(event),
      });

      if (!this.isActiveTurn(running.id, turnId)) {
        return;
      }
      await this.captureDiff(running);
      if (!this.isActiveTurn(running.id, turnId)) {
        return;
      }
      await this.updateTask({
        ...running,
        status: "review_ready",
        updatedAt: new Date().toISOString(),
      });
      await this.emit({
        type: "turn.finished",
        taskId: running.id,
        status: "completed",
        stopReason: result?.stopReason,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (!this.isActiveTurn(running.id, turnId)) {
        return;
      }
      const message = formatUnknownError(error);
      await this.updateTask({
        ...running,
        status: "failed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.emit({
        type: "turn.finished",
        taskId: running.id,
        status: "failed",
        error: message,
        timestamp: new Date().toISOString(),
      });
    } finally {
      const shouldStartNext = this.isActiveTurn(running.id, turnId);
      this.clearActiveTurn(running.id, turnId);
      if (shouldStartNext) {
        void this.startNextQueuedTurn(running.id).catch(() => undefined);
      }
    }
  }

  private async startNextQueuedTurn(taskId: string): Promise<void> {
    if (this.activeTurns.has(taskId)) {
      return;
    }
    const queue = this.queuedTurns.get(taskId) ?? [];
    const next = queue.shift();
    if (!next) {
      this.queuedTurns.delete(taskId);
      return;
    }
    if (queue.length === 0) {
      this.queuedTurns.delete(taskId);
    }

    const task = await this.options.store.getTask(taskId);
    if (!task || !task.worktreePath || task.status === "cancelled" || task.status === "applied") {
      return;
    }
    const projects = await this.options.store.listProjects();
    const project = projects.find((item) => item.id === task.projectId);
    const backend = this.backends.get(task.backendId);
    if (!project || !backend?.sendMessage) {
      await this.emit({
        type: "turn.finished",
        taskId,
        status: "failed",
        error: "Queued message could not start because the project or backend is no longer available.",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    await this.emitAction(taskId, "enqueue", "started", "Running queued message.", next.prompt.slice(0, 180), {
      queuedAt: next.queuedAt,
      remaining: queue?.length ?? 0,
    });
    await this.startPromptTurn(
      backend as AgentBackend & { sendMessage: NonNullable<AgentBackend["sendMessage"]> },
      task,
      project,
      task.worktreePath,
      next.prompt,
      false,
    );
  }

  async listEvents(taskId: string): Promise<AgentEvent[]> {
    return this.options.store.listEvents(taskId);
  }

  async latestDiff(taskId: string): Promise<DiffSnapshot | undefined> {
    return this.options.store.latestDiff(taskId);
  }

  async backendStatuses(): Promise<BackendStatus[]> {
    return Promise.all([...this.backends.values()].map((backend) => backend.detect()));
  }

  listNativeSlashCommands(): SlashCommandInfo[] {
    return nativeSlashCommandInfo();
  }

  async stopTask(taskId: string): Promise<Task> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    const backend = this.backends.get(task.backendId);
    const clearedQueuedTurns = this.clearQueuedTurns(taskId);
    this.activeTurns.delete(taskId);
    await backend?.cancelSession?.(taskId);
    await backend?.stopTask?.(taskId);
    const current = await this.options.store.getTask(taskId);
    const updated = await this.updateTask({ ...(current ?? task), status: "cancelled", completedAt: new Date().toISOString() });
    if (clearedQueuedTurns > 0) {
      await this.emitAction(taskId, "clear_queue", "completed", "Cleared queued messages.", `${clearedQueuedTurns} queued message${clearedQueuedTurns === 1 ? "" : "s"} removed because the session was stopped.`, {
        cleared: clearedQueuedTurns,
        reason: "cancel",
      });
    }
    await this.emit({ type: "task.finished", taskId, status: "cancelled", timestamp: new Date().toISOString() });
    return updated;
  }

  async clearSessionQueue(taskId: string): Promise<{ cleared: number; queuedTurns: number; task: Task }> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    const cleared = this.clearQueuedTurns(taskId);
    await this.emitAction(
      taskId,
      "clear_queue",
      "completed",
      cleared > 0 ? "Cleared queued messages." : "No queued messages to clear.",
      cleared > 0 ? `${cleared} queued message${cleared === 1 ? "" : "s"} removed.` : undefined,
      {
        cleared,
        reason: "manual",
      },
    );
    return {
      cleared,
      queuedTurns: this.queuedTurns.get(taskId)?.length ?? 0,
      task,
    };
  }

  async deleteSession(taskId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }

    const backend = this.backends.get(task.backendId);
    this.clearQueuedTurns(taskId);
    this.activeTurns.delete(taskId);
    await backend?.cancelSession?.(taskId).catch(() => undefined);
    await backend?.stopTask?.(taskId).catch(() => undefined);

    if (task.worktreePath) {
      const project = (await this.options.store.listProjects()).find((item) => item.id === task.projectId);
      if (project) {
        await this.options.git.removeWorktree(project.path, task.worktreePath).catch(() => undefined);
      }
    }

    await this.options.store.deleteTask(taskId);
  }

  async resumeSession(taskId: string): Promise<Task> {
    const { backend, project, task, worktreePath } = await this.requireSession(taskId);
    if (!backend.startSession || !backend.sendMessage) {
      throw new Error(`Backend does not support persistent sessions: ${task.backendId}`);
    }

    const running = await this.updateTask({ ...task, status: "running", updatedAt: new Date().toISOString() });
    void this.ensureSessionAttached(backend, running, project, worktreePath).catch(() => undefined);
    return running;
  }

  async setSessionMode(taskId: string, modeId: string): Promise<Task> {
    const trimmed = modeId.trim();
    if (!trimmed) {
      throw new Error("Missing required field: modeId");
    }
    const { backend, task } = await this.requireSession(taskId);
    await backend.setMode?.(taskId, trimmed);
    const updated = await this.updateTask({ ...task, modeId: trimmed, updatedAt: new Date().toISOString() });
    await this.emitAction(task.id, "set_mode", "completed", `Mode changed to ${trimmed}.`);
    return updated;
  }

  async renameSession(taskId: string, title: string): Promise<Task> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session title cannot be empty.");
    }
    if (trimmed.length > 160) {
      throw new Error("Session title must be 160 characters or fewer.");
    }
    const updated = await this.updateTask({ ...task, title: trimmed, updatedAt: new Date().toISOString() });
    await this.emitAction(task.id, "set_mode", "completed", `Renamed session to ${trimmed}.`, undefined, {
      previousTitle: task.title,
      title: trimmed,
    });
    return updated;
  }

  async updateSessionNotes(taskId: string, notes: string): Promise<Task> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    if (notes.length > 20000) {
      throw new Error("Session notes must be 20000 characters or fewer.");
    }
    return this.updateTask({ ...task, notes, updatedAt: new Date().toISOString() });
  }

  async listSessionBranches(taskId: string): Promise<SessionBranchListResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const updated = await this.updateTask({
      ...normalizeTaskBranches(task),
      branches: await this.sessionBranchesFromGit(task, worktreePath),
      updatedAt: new Date().toISOString(),
    });
    return {
      branches: updated.branches ?? [],
      task: updated,
    };
  }

  async createManagedBranch(taskId: string, input: CreateSessionBranchRequest = {}): Promise<SessionBranchListResponse> {
    const { project, task } = await this.requireSession(taskId);
    const normalized = normalizeTaskBranches(task);
    const branches = await this.originalRepoBranchesFromGit(normalized, project.path);
    const name = normalizeBranchName(input.name) || nextSessionBranchName(normalized, branches);
    ensureUniqueBranchName(branches, name);
    if (await this.options.git.branchExists(project.path, name)) {
      throw new Error(`Branch already exists: ${name}`);
    }

    await this.options.git.createBranch(project.path, name);
    await this.options.git.switchBranch(project.path, name);
    const now = new Date().toISOString();
    const updated = await this.updateTask({
      ...normalized,
      branches: await this.originalRepoBranchesFromGit({ ...normalized, updatedAt: now }, project.path),
      updatedAt: now,
    });
    await this.emitAction(task.id, "create_branch", "completed", `Original repository branch created and checked out: ${name}.`, undefined, { branch: name });
    return {
      branches: updated.branches ?? [],
      task: updated,
    };
  }

  async updateManagedBranch(taskId: string, branchId: string, input: UpdateSessionBranchRequest): Promise<SessionBranchListResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const normalized = normalizeTaskBranches(task);
    const branches = await this.sessionBranchesFromGit(normalized, worktreePath);
    const branch = branches.find((item) => item.id === branchId || item.name === branchId);
    if (!branch) {
      throw new Error("Branch target not found.");
    }

    const now = new Date().toISOString();
    let nextName = branch.name;
    if (input.name !== undefined) {
      nextName = normalizeBranchName(input.name);
      if (!nextName) {
        throw new Error("Branch name cannot be empty.");
      }
      if (nextName !== branch.name) {
        ensureUniqueBranchName(branches.filter((item) => item.name !== branch.name), nextName);
        await this.options.git.renameBranch(worktreePath, branch.name, nextName);
      }
    }

    if (input.applySelected === true) {
      await this.options.git.switchBranch(worktreePath, nextName);
    }

    const updated = await this.updateTask({
      ...normalized,
      worktreeBranch: nextName,
      branches: await this.sessionBranchesFromGit({ ...normalized, worktreeBranch: nextName, updatedAt: now }, worktreePath),
      updatedAt: now,
    });
    return {
      branches: updated.branches ?? [],
      task: updated,
    };
  }

  async removeManagedBranch(taskId: string, branchId: string): Promise<SessionBranchListResponse> {
    const { project, task } = await this.requireSession(taskId);
    const normalized = normalizeTaskBranches(task);
    const branches = await this.originalRepoBranchesFromGit(normalized, project.path);
    const branch = branches.find((item) => item.id === branchId || item.name === branchId);
    if (!branch) {
      throw new Error("Branch target not found.");
    }

    if (branch.checkedOutHere) {
      throw new Error(`Cannot remove branch ${branch.name} because it is the active branch in the original repository. Switch to another branch first, then remove it.`);
    }
    if (branch.checkedOutPath) {
      throw new Error(`Cannot remove branch ${branch.name} because it is checked out at ${branch.checkedOutPath}. Switch that worktree/repository to another branch, or remove the Agent Workbench session that owns it, then retry.`);
    }

    if (await this.options.git.branchExists(project.path, branch.name)) {
      await this.options.git.deleteBranch(project.path, branch.name);
    }
    const now = new Date().toISOString();
    const updated = await this.updateTask({
      ...normalized,
      branches: await this.originalRepoBranchesFromGit(normalized, project.path),
      updatedAt: now,
    });
    await this.emitAction(task.id, "create_branch", "completed", `Original repository branch removed: ${branch.name}.`, undefined, { branch: branch.name });
    return {
      branches: updated.branches ?? [],
      task: updated,
    };
  }

  private async originalRepoBranchesFromGit(task: Task, projectPath: string): Promise<SessionBranch[]> {
    const now = new Date().toISOString();
    const branches = await this.options.git.listBranches(projectPath);
    return branches
      .filter((branch) => branch.checkedOutHere || !branch.name.startsWith("agent-workbench/"))
      .map((branch) => ({
        checkedOutHere: branch.checkedOutHere,
        checkedOutPath: branch.checkedOutPath,
        id: branch.name,
        name: branch.name,
        role: "extra",
        applySelected: branch.active,
        createdAt: branch.updatedAt ?? task.createdAt ?? now,
        updatedAt: branch.updatedAt ?? task.updatedAt ?? now,
      }));
  }

  private async sessionBranchesFromGit(task: Task, worktreePath: string): Promise<SessionBranch[]> {
    const now = new Date().toISOString();
    const branches = await this.options.git.listBranches(worktreePath);
    return branches.map((branch) => ({
      checkedOutHere: branch.checkedOutHere,
      checkedOutPath: branch.checkedOutPath,
      id: branch.name,
      name: branch.name,
      role: branch.name === task.worktreeBranch ? "primary" : "extra",
      applySelected: branch.active,
      createdAt: branch.updatedAt ?? task.createdAt ?? now,
      updatedAt: branch.updatedAt ?? task.updatedAt ?? now,
    }));
  }

  async syncSessionToLatest(taskId: string): Promise<SyncSessionToLatestResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    const normalized = normalizeTaskBranches(task);
    await this.emitAction(task.id, "sync_latest", "started", "Syncing isolated worktree to current original repository HEAD.");

    try {
      const dirty = await this.options.git.statusPorcelain(worktreePath);
      if (dirty.trim()) {
        throw new Error(`Session worktree has local changes. Save a snapshot, export a patch, commit, or discard changes before syncing.\n\n${dirty.trim()}`);
      }

      const [originalBranch, originalHead] = await Promise.all([
        this.options.git.currentBranch(project.path).catch(() => undefined),
        this.options.git.currentCommit(project.path),
      ]);
      const reset = await this.options.git.run(["reset", "--hard", originalHead], worktreePath);
      if (reset.exitCode !== 0) {
        throw new Error(reset.stderr.trim() || `Failed to reset session branch to ${originalHead}.`);
      }
      const clean = await this.options.git.run(["clean", "-fd"], worktreePath);
      if (clean.exitCode !== 0) {
        throw new Error(clean.stderr.trim() || "Failed to clean session worktree.");
      }

      const now = new Date().toISOString();
      const updated = await this.updateTask({
        ...normalized,
        baseBranch: originalBranch || normalized.baseBranch,
        updatedAt: now,
        branches: await this.originalRepoBranchesFromGit({ ...normalized, updatedAt: now }, project.path),
      });
      await this.captureDiff(updated);
      await this.emitAction(
        task.id,
        "sync_latest",
        "completed",
        `Isolated worktree synced from ${originalBranch ? `${originalBranch}@` : ""}${originalHead.slice(0, 12)}.`,
        undefined,
        { branch: originalBranch, head: originalHead, originalBranch },
      );
      return {
        branch: originalBranch || normalized.worktreeBranch || task.id,
        head: originalHead,
        originalBranch,
        task: updated,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "sync_latest", "failed", "Failed to sync isolated worktree from original repository.", message);
      throw error;
    }
  }

  async applyTarget(taskId: string): Promise<ApplyTargetResponse> {
    const { project, worktreePath } = await this.requireSession(taskId);
    const [branches, originalBranch, originalHead] = await Promise.all([
      this.options.git.listBranches(project.path),
      this.options.git.currentBranch(project.path).catch(() => undefined),
      this.options.git.currentCommit(project.path),
    ]);

    return {
      branches: branches
        .filter((branch) => !branch.name.startsWith("agent-workbench/"))
        .map((branch) => ({
          active: branch.active,
          checkedOutHere: branch.checkedOutHere,
          checkedOutPath: branch.checkedOutPath,
          name: branch.name,
          updatedAt: branch.updatedAt,
        })),
      originalBranch,
      originalHead,
      projectPath: project.path,
      worktreePath,
    };
  }

  async applySession(taskId: string, input: ApplySessionRequest = {}): Promise<ApplySessionResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    const patchText = await this.sessionPatch(task, worktreePath);
    const summary = summarizeDiff(patchText);
    if (task.status === "applied") {
      if (!patchText.trim()) {
        return {
          alreadyApplied: true,
          task,
          projectPath: project.path,
          summary,
        };
      }
    }

    await this.emitAction(task.id, "apply", "started", "Applying session changes to original repository.");

    try {
      await this.selectApplyTargetBranch(project.path, input);
      await this.assertApplyTarget(project.path, input);
      if (!patchText.trim()) {
        throw new Error("No session changes to apply.");
      }

      const [originalStatus, overlapFiles] = await Promise.all([
        this.options.git.statusPorcelain(project.path),
        this.sessionFileOverlaps(task, summary),
      ]);
      const preflight = await this.applyPreflightForSession(project.path, worktreePath, task, summary, originalStatus, overlapFiles);
      if (!preflight.canApply) {
        const updated = await this.updateTask({ ...task, status: "failed", updatedAt: new Date().toISOString() });
        await this.emitAction(task.id, "apply", "failed", `Apply blocked: ${applyBlockSummary(preflight)}.`, applyConflictMessage(preflight), preflight);
        return {
          preflight,
          projectPath: project.path,
          summary,
          task: updated,
        };
      }

      await this.options.git.checkApplyPatch(project.path, patchText);
      await this.createSessionPatchSnapshot(task, project, patchText, "before_apply", "Before apply");
      await this.options.git.applyPatch(project.path, patchText);
      const targetBranch = await this.options.git.currentBranch(project.path).catch(() => undefined);
      const baseline = await this.options.git.commitAll(worktreePath, `Agent Workbench apply baseline: ${task.title}`);
      const updated = await this.updateTask({ ...task, baseBranch: baseline.commitSha, status: "applied", updatedAt: new Date().toISOString() });
      await this.captureDiff(updated);
      await this.emitAction(task.id, "apply", "completed", "Applied isolated session changes to original repository.", project.path, {
        projectPath: project.path,
        targetBranch,
        summary,
      });
      return {
        task: updated,
        projectPath: project.path,
        summary,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "apply", "failed", "Failed to apply changes.", message);
      throw error;
    }
  }

  private async selectApplyTargetBranch(projectPath: string, input: ApplySessionRequest): Promise<void> {
    const targetBranch = normalizeBranchName(input.targetBranch);
    if (!targetBranch) {
      return;
    }
    const currentBranch = await this.options.git.currentBranch(projectPath).catch(() => undefined);
    if (currentBranch === targetBranch) {
      return;
    }
    const exists = await this.options.git.branchExists(projectPath, targetBranch);
    if (!exists) {
      await this.options.git.createBranch(projectPath, targetBranch);
    }
    await this.options.git.switchBranch(projectPath, targetBranch);
  }

  private async assertApplyTarget(projectPath: string, input: ApplySessionRequest): Promise<void> {
    if (!input.expectedOriginalBranch && !input.expectedOriginalHead) {
      return;
    }

    const [currentBranch, currentHead] = await Promise.all([
      this.options.git.currentBranch(projectPath).catch(() => undefined),
      this.options.git.currentCommit(projectPath),
    ]);
    const selectedTargetBranch = normalizeBranchName(input.targetBranch);
    const intentionallyChangedTarget = selectedTargetBranch && selectedTargetBranch !== input.expectedOriginalBranch;
    if (!intentionallyChangedTarget && input.expectedOriginalBranch !== undefined && input.expectedOriginalBranch !== currentBranch) {
      throw new Error(`Original repository branch changed from ${input.expectedOriginalBranch || "detached HEAD"} to ${currentBranch || "detached HEAD"}. Reopen Apply and confirm the current target branch.`);
    }
    if (!intentionallyChangedTarget && input.expectedOriginalHead !== undefined && input.expectedOriginalHead !== currentHead) {
      throw new Error(`Original repository HEAD changed from ${input.expectedOriginalHead.slice(0, 12)} to ${currentHead.slice(0, 12)}. Reopen Apply and confirm the current target commit.`);
    }
  }

  private async applyPreflightForSession(
    projectPath: string,
    worktreePath: string,
    task: Task,
    summary: ApplyPreflight["summary"],
    originalStatus: string,
    overlapFiles: SessionFileOverlap[],
  ): Promise<ApplyPreflight> {
    const preflight = applyPreflight(projectPath, summary, originalStatus, overlapFiles);
    if (task.status !== "applied" || preflight.conflictFiles.length === 0) {
      return preflight;
    }

    const conflictFiles: ApplyPreflight["conflictFiles"] = [];
    for (const file of preflight.conflictFiles) {
      if (!(await this.originalMatchesSessionHead(projectPath, worktreePath, file.path))) {
        conflictFiles.push(file);
      }
    }
    return {
      ...preflight,
      canApply: conflictFiles.length === 0 && preflight.overlapFiles.length === 0,
      conflictFiles,
    };
  }

  private async originalMatchesSessionHead(projectPath: string, worktreePath: string, path: string): Promise<boolean> {
    const absolutePath = resolve(projectPath, path);
    const root = resolve(projectPath);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
      return false;
    }
    const [originalContent, sessionHeadContent] = await Promise.all([
      readFile(absolutePath, "utf8").catch(() => undefined),
      this.options.git.fileAtRef(worktreePath, "HEAD", path),
    ]);
    return originalContent !== undefined && sessionHeadContent !== undefined && originalContent === sessionHeadContent;
  }

  async exportPatch(taskId: string): Promise<ExportPatchResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    await this.emitAction(task.id, "export_patch", "started", "Exporting session patch.");

    try {
      const patchText = await this.sessionPatch(task, worktreePath);
      const summary = summarizeDiff(patchText);
      if (!patchText.trim()) {
        throw new Error("No session changes to export.");
      }

      const patchPath = await this.writePatchFile(project, task, patchText);

      await this.emitAction(task.id, "export_patch", "completed", "Patch exported.", patchPath, {
        patchPath,
        summary,
      });
      return {
        diffText: patchText,
        patchPath,
        summary,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "export_patch", "failed", "Failed to export patch.", message);
      throw error;
    }
  }

  async deliveryTarget(taskId: string): Promise<DeliveryTargetResponse> {
    const { worktreePath } = await this.requireSession(taskId);
    const [currentBranch, currentHead, files, remotes, status] = await Promise.all([
      this.options.git.currentBranch(worktreePath).catch(() => undefined),
      this.options.git.currentCommit(worktreePath),
      this.options.git.statusFiles(worktreePath),
      this.options.git.listRemotes(worktreePath).catch(() => []),
      this.options.git.statusPorcelain(worktreePath),
    ]);
    return {
      currentBranch,
      currentHead,
      files,
      projectPath: worktreePath,
      remotes,
      status,
    };
  }

  async addOriginalRepositoryChanges(taskId: string, input?: AddProjectChangesRequest): Promise<ProjectDeliveryResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const files = [...new Set((input?.files ?? []).map((file) => file.trim()).filter(Boolean))];
    await this.emitAction(
      task.id,
      "repo_add",
      "started",
      files.length > 0 ? `Staging ${files.length} selected session file${files.length === 1 ? "" : "s"}.` : "Staging session branch changes.",
      undefined,
      files.length > 0 ? { files } : undefined,
    );
    try {
      if (files.length > 0) {
        await this.options.git.addPaths(worktreePath, files);
      } else {
        await this.options.git.addAll(worktreePath);
      }
      const [branch, nextFiles, status] = await Promise.all([
        this.options.git.currentBranch(worktreePath).catch(() => undefined),
        this.options.git.statusFiles(worktreePath),
        this.options.git.statusPorcelain(worktreePath),
      ]);
      await this.emitAction(task.id, "repo_add", "completed", "Session branch changes staged.", status, {
        branch,
        files,
        projectPath: worktreePath,
        status,
      });
      return {
        branch,
        files: nextFiles,
        projectPath: worktreePath,
        status,
        task,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "repo_add", "failed", "Failed to stage session branch changes.", message);
      throw error;
    }
  }

  async commitOriginalRepositoryChanges(taskId: string, input: CommitProjectRequest): Promise<ProjectDeliveryResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const message = input.message.trim();
    if (!message) {
      throw new Error("Commit message cannot be empty.");
    }
    await this.emitAction(task.id, "repo_commit", "started", `Committing session branch changes on ${worktreePath}.`);
    try {
      const branch = await this.options.git.currentBranch(worktreePath).catch(() => undefined);
      const commit = await this.options.git.commitStaged(worktreePath, message);
      const updated = await this.updateTask({ ...task, updatedAt: new Date().toISOString() });
      const status = await this.options.git.statusPorcelain(worktreePath);
      await this.emitAction(task.id, "repo_commit", "completed", `Committed session branch changes${branch ? ` on ${branch}` : ""}.`, commit.commitSha, {
        branch,
        commitSha: commit.commitSha,
        projectPath: worktreePath,
        status,
      });
      return {
        branch,
        commitSha: commit.commitSha,
        projectPath: worktreePath,
        status,
        task: updated,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "repo_commit", "failed", "Failed to commit session branch changes.", message);
      throw error;
    }
  }

  async createSessionBranch(taskId: string, input: CreateBranchRequest = {}): Promise<CreateBranchResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const branch = selectedSessionBranch(task).name || task.worktreeBranch || (await this.options.git.currentBranch(worktreePath));
    await this.emitAction(task.id, "create_branch", "started", `Preparing branch ${branch}.`);

    try {
      const patchText = await this.sessionPatch(task, worktreePath);
      const summary = summarizeDiff(patchText);
      const commit = await this.options.git.commitAll(worktreePath, input.commitMessage?.trim() || `Agent Workbench: ${task.title}`);
      const updated = await this.updateTask({ ...task, status: "branch_ready", updatedAt: new Date().toISOString() });
      await this.captureDiff(updated);
      await this.emitAction(
        task.id,
        "create_branch",
        "completed",
        commit.committed ? `Committed changes on ${branch}.` : `Branch ${branch} is already clean.`,
        commit.commitSha,
        {
          branch,
          commitSha: commit.commitSha,
          committed: commit.committed,
          summary,
        },
      );
      return {
        branch,
        commitSha: commit.commitSha,
        summary,
        task: updated,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "create_branch", "failed", "Failed to prepare branch.", message);
      throw error;
    }
  }

  async pushSessionBranch(taskId: string, input: CreateBranchRequest = {}): Promise<PushBranchResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const branch = await this.options.git.currentBranch(worktreePath);
    const remote = input.remote?.trim() || "origin";
    await this.emitAction(task.id, "push_branch", "started", `Pushing ${branch} to ${remote}.`);

    try {
      const summary = summarizeDiff(await this.options.git.diff(worktreePath));
      const commitSha = await this.options.git.currentCommit(worktreePath);
      await this.options.git.pushBranch(worktreePath, branch, remote);
      const updated = await this.updateTask({ ...task, status: "branch_ready", updatedAt: new Date().toISOString() });
      await this.emitAction(task.id, "push_branch", "completed", `Pushed ${branch} to ${remote}.`, commitSha, {
        branch,
        commitSha,
        remote,
        summary,
      });
      return {
        branch,
        commitSha,
        remote,
        summary,
        task: updated,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "push_branch", "failed", "Failed to push branch.", message);
      throw error;
    }
  }

  async createPullRequest(taskId: string, input: CreatePullRequestRequest = {}): Promise<CreatePullRequestResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    const branch = await this.options.git.currentBranch(worktreePath);
    const remote = input.remote?.trim() || "origin";
    await this.emitAction(task.id, "create_pr", "started", `Creating draft PR for ${branch}.`);

    try {
      const status = await this.options.git.statusPorcelain(worktreePath);
      const deliveryPatchText = await this.sessionPatch(task, worktreePath);
      const patchPath = deliveryPatchText.trim() ? await this.writePatchFile(project, task, deliveryPatchText) : undefined;
      let commitSha = await this.options.git.currentCommit(worktreePath);
      if (status.trim()) {
        const commitMessage = input.commitMessage?.trim() || defaultDeliveryCommitMessage(task);
        await this.emitAction(task.id, "repo_add", "started", `Staging session branch changes before Draft PR.`, status, {
          branch,
          projectPath: worktreePath,
          status,
        });
        await this.options.git.addAll(worktreePath);
        await this.emitAction(task.id, "repo_commit", "started", `Committing session branch changes before Draft PR.`, commitMessage, {
          branch,
          projectPath: worktreePath,
        });
        const commit = await this.options.git.commitStaged(worktreePath, commitMessage);
        commitSha = commit.commitSha;
        const postCommitStatus = await this.options.git.statusPorcelain(worktreePath);
        await this.emitAction(task.id, "repo_commit", "completed", `Committed session branch changes on ${branch}.`, commitSha, {
          branch,
          commitSha,
          projectPath: worktreePath,
          status: postCommitStatus,
        });
      }
      const summary = summarizeDiff(deliveryPatchText);

      let pushed = false;
      try {
        await this.options.git.pushBranch(worktreePath, branch, remote);
        pushed = true;
      } catch (pushError) {
        const message = [
          `Branch could not be pushed to ${remote}.`,
          formatUnknownError(pushError),
        ].filter(Boolean).join("\n");
        const updated = await this.updateTask({ ...task, status: "branch_ready", updatedAt: new Date().toISOString() });
        await this.emitAction(task.id, "create_pr", "completed", "Local branch ready; push failed.", message, {
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          summary,
        });
        return {
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          task: updated,
        };
      }

      const baseBranch = await this.pullRequestBaseBranch(worktreePath, project.defaultBranch, remote);
      const baseRef = `refs/remotes/${remote}/${baseBranch}`;
      const hasCommits = await this.options.git.branchHasCommitsAhead(worktreePath, baseRef, branch);
      if (!hasCommits) {
        const message = `No pull request can be created because ${branch} has no commits ahead of ${remote}/${baseBranch}. Commit a change on ${branch}, or switch to a branch that differs from ${baseBranch}.`;
        const updated = await this.updateTask({ ...task, status: "branch_ready", updatedAt: new Date().toISOString() });
        await this.emitAction(task.id, "create_pr", "completed", "Branch pushed; no PR changes found.", message, {
          base: baseBranch,
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          summary,
        });
        return {
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          task: updated,
        };
      }

      let pr: Awaited<ReturnType<GitClient["createPullRequest"]>>;
      try {
        pr = await this.options.git.createPullRequest(project.path, {
          base: baseBranch,
          body: input.body?.trim() || defaultPullRequestBody(task),
          draft: input.draft ?? true,
          head: branch,
          remote,
          title: input.title?.trim() || task.title,
        });
      } catch (prError) {
        const message = [
          "Branch was pushed, but Workbench could not create a pull request.",
          formatUnknownError(prError),
        ].filter(Boolean).join("\n");
        const updated = await this.updateTask({ ...task, status: "branch_ready", updatedAt: new Date().toISOString() });
        await this.emitAction(task.id, "create_pr", "completed", "Branch pushed; PR creation needs manual follow-up.", message, {
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          summary,
        });
        return {
          branch,
          commitSha,
          created: false,
          message,
          patchPath,
          pushed,
          remote,
          task: updated,
        };
      }

      const updated = await this.updateTask({ ...task, status: pr.created ? "pr_ready" : "branch_ready", updatedAt: new Date().toISOString() });
      await this.emitAction(
        task.id,
        "create_pr",
        "completed",
        pr.created ? "Draft pull request created." : "Branch pushed; PR compare URL ready.",
        pr.url,
        {
          branch,
          commitSha,
          compareUrl: pr.created ? undefined : pr.url,
          created: pr.created,
          fallbackReason: pr.fallbackReason,
          message: pr.created ? pr.message : "Compare URL ready.",
          patchPath,
          pushed,
          remote,
          summary,
          url: pr.created ? pr.url : undefined,
        },
      );
      return {
        branch,
        commitSha,
        compareUrl: pr.created ? undefined : pr.url,
        created: pr.created,
        message: pr.created ? pr.message : "Compare URL ready.",
        patchPath,
        pushed,
        remote,
        task: updated,
        url: pr.created ? pr.url : undefined,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "create_pr", "failed", "Failed to create pull request.", message);
      throw error;
    }
  }

  private async pullRequestBaseBranch(projectPath: string, projectDefaultBranch: string | undefined, remote: string): Promise<string> {
    const remoteDefault = await this.options.git.defaultRemoteBranch(projectPath, remote);
    const candidates = [remoteDefault, projectDefaultBranch, "main", "master"]
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
      .filter((candidate) => !looksLikeCommitSha(candidate));
    for (const candidate of candidates) {
      if (await this.options.git.branchExists(projectPath, candidate)) {
        return candidate;
      }
      const remoteExists = await this.options.git.run(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${candidate}`], projectPath);
      if (remoteExists.exitCode === 0) {
        return candidate;
      }
    }
    throw new Error(`Cannot find a valid base branch for ${remote}. Configure origin/HEAD or set the project default branch to a branch name.`);
  }

  private async newWorkingBranchStartPoint(projectPath: string, projectDefaultBranch: string | undefined): Promise<string> {
    const remote = "origin";
    const remoteDefault = await this.options.git.defaultRemoteBranch(projectPath, remote);
    const candidates = [remoteDefault, "main", "master", projectDefaultBranch]
      .map((candidate) => candidate?.trim())
      .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
      .filter((candidate) => !looksLikeCommitSha(candidate));
    for (const candidate of candidates) {
      if (await this.options.git.branchExists(projectPath, candidate)) {
        return candidate;
      }
      const remoteRef = `refs/remotes/${remote}/${candidate}`;
      const remoteExists = await this.options.git.run(["rev-parse", "--verify", "--quiet", remoteRef], projectPath);
      if (remoteExists.exitCode === 0) {
        return remoteRef;
      }
    }
    return (await this.options.git.currentBranch(projectPath).catch(() => undefined)) || projectDefaultBranch || "HEAD";
  }

  async applySessionUnsafe(taskId: string): Promise<ApplySessionResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    await this.emitAction(task.id, "apply", "started", "Force applying session patch with git rejects enabled.");
    try {
      const patchText = await this.sessionPatch(task, worktreePath);
      const summary = summarizeDiff(patchText);
      if (!patchText.trim()) {
        throw new Error("No session changes to apply.");
      }
      await this.createSessionPatchSnapshot(task, project, patchText, "before_apply", "Before force apply");
      await this.options.git.applyPatchUnsafe(project.path, patchText);
      const updated = await this.updateTask({ ...task, status: "applied", updatedAt: new Date().toISOString() });
      await this.emitAction(task.id, "apply", "completed", "Force applied changes to original repository.", project.path, {
        projectPath: project.path,
        summary,
      });
      return {
        projectPath: project.path,
        summary,
        task: updated,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "apply", "failed", "Failed to force apply changes.", message);
      throw error;
    }
  }

  private async sessionFileOverlaps(task: Task, summary: DiffSummary): Promise<SessionFileOverlap[]> {
    const changedPaths = new Set(summary.files.map((file) => file.path));
    if (changedPaths.size === 0) {
      return [];
    }

    const candidates = (await this.options.store.listTasks()).filter((candidate) =>
      candidate.id !== task.id &&
      candidate.projectId === task.projectId &&
      candidate.status !== "applied" &&
      candidate.status !== "cancelled",
    );
    const overlaps = new Map<string, SessionFileOverlap>();
    for (const candidate of candidates) {
      const diff = await this.options.store.latestDiff(candidate.id);
      if (!diff) {
        continue;
      }
      for (const file of diff.summary.files) {
        if (!changedPaths.has(file.path)) {
          continue;
        }
        const overlap = overlaps.get(file.path) ?? {
          path: file.path,
          sessions: [],
        };
        overlap.sessions.push({
          status: candidate.status,
          taskId: candidate.id,
          title: candidate.title,
        });
        overlaps.set(file.path, overlap);
      }
    }
    return [...overlaps.values()];
  }

  async createSessionSnapshot(
    taskId: string,
    kind: SessionSnapshot["kind"] = "manual",
    label = "Manual snapshot",
    description?: string,
  ): Promise<SessionSnapshot> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    await this.emitAction(task.id, "snapshot", "started", `Creating snapshot: ${label}.`);
    try {
      const patchText = await this.sessionPatch(task, worktreePath);
      const summary = summarizeDiff(patchText);
      const snapshot = await this.writeSessionSnapshot(task, project, patchText, summary, kind, label, description);
      await this.emitAction(task.id, "snapshot", "completed", `Snapshot saved: ${label}.`, snapshot.patchPath, snapshot);
      return snapshot;
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "snapshot", "failed", "Failed to create snapshot.", message);
      throw error;
    }
  }

  async listSessionSnapshots(taskId: string): Promise<SessionSnapshot[]> {
    return this.options.store.listSnapshots(taskId);
  }

  async updateSessionSnapshot(taskId: string, snapshotId: string, input: UpdateSessionSnapshotRequest): Promise<SessionSnapshot> {
    const snapshot = await this.options.store.getSnapshot(taskId, snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found.");
    }
    const label = input.label?.trim();
    if (input.label !== undefined && !label) {
      throw new Error("Snapshot title cannot be empty.");
    }
    const updated: SessionSnapshot = {
      ...snapshot,
      description: input.description?.trim() || undefined,
      label: label || snapshot.label,
    };
    await this.options.store.updateSnapshot(updated);
    await this.emitAction(taskId, "snapshot", "completed", `Snapshot updated: ${updated.label}.`, undefined, updated);
    return updated;
  }

  async deleteSessionSnapshot(taskId: string, snapshotId: string): Promise<void> {
    const snapshot = await this.options.store.getSnapshot(taskId, snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found.");
    }
    await this.options.store.deleteSnapshot(taskId, snapshotId);
    await this.emitAction(taskId, "snapshot", "completed", `Snapshot deleted: ${snapshot.label}.`, undefined, snapshot);
  }

  async readSessionSnapshotPatch(taskId: string, snapshotId: string): Promise<SessionSnapshotPatchResponse> {
    const snapshot = await this.options.store.getSnapshot(taskId, snapshotId);
    if (!snapshot) {
      throw new Error("Snapshot not found.");
    }
    try {
      const patchText = await readFile(snapshot.patchPath, "utf8");
      return {
        patchText,
        snapshot,
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error(`Snapshot patch file not found: ${snapshot.patchPath}`);
      }
      throw error;
    }
  }

  private async createSessionPatchSnapshot(
    task: Task,
    project: Project,
    patchText: string,
    kind: SessionSnapshot["kind"],
    label: string,
  ): Promise<SessionSnapshot> {
    return this.writeSessionSnapshot(task, project, patchText, summarizeDiff(patchText), kind, label);
  }

  private async writeSessionSnapshot(
    task: Task,
    project: Project,
    patchText: string,
    summary: SessionSnapshot["summary"],
    kind: SessionSnapshot["kind"],
    label: string,
    description?: string,
  ): Promise<SessionSnapshot> {
    const snapshotDir = join(homedir(), ".agent-workbench", "snapshots", sanitizePathSegment(project.name), task.id);
    await mkdir(snapshotDir, { recursive: true });
    const snapshot: SessionSnapshot = {
      description: description?.trim() || undefined,
      id: randomUUID(),
      taskId: task.id,
      kind,
      label,
      patchPath: join(snapshotDir, `${Date.now()}-${sanitizePathSegment(label)}.patch`),
      summary,
      createdAt: new Date().toISOString(),
    };
    await writeFile(snapshot.patchPath, patchText, "utf8");
    await this.options.store.appendSnapshot(snapshot);
    return snapshot;
  }

  async rollbackSession(taskId: string, snapshotId?: string): Promise<RollbackSessionResponse> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    const snapshots = await this.options.store.listSnapshots(taskId);
    const snapshot = snapshotId ? snapshots.find((item) => item.id === snapshotId) : [...snapshots].reverse().find((item) => item.kind === "before_apply");
    if (!snapshot) {
      throw new Error("No snapshot is available to roll back this session.");
    }
    await this.emitAction(task.id, "rollback", "started", `Rolling back with snapshot: ${snapshot.label}.`, snapshot.patchPath);
    try {
      const patchText = await readFile(snapshot.patchPath, "utf8");
      let safetySnapshot: SessionSnapshot | undefined;
      const baseRef = task.baseBranch || "HEAD";
      const currentStatus = await this.options.git.statusPorcelain(worktreePath);
      if (currentStatus.trim()) {
        const currentPatchText = await this.sessionPatch(task, worktreePath);
        safetySnapshot = await this.writeSessionSnapshot(
          task,
          project,
          currentPatchText,
          summarizeDiff(currentPatchText),
          "rollback",
          `Safety before rollback to ${snapshot.label}`,
          "Automatic safety snapshot created before rollback.",
        );
        await this.emitAction(task.id, "snapshot", "completed", `Safety snapshot saved: ${safetySnapshot.label}.`, safetySnapshot.patchPath, safetySnapshot);
      }

      const reset = await this.options.git.run(["reset", "--hard", baseRef], worktreePath);
      if (reset.exitCode !== 0) {
        throw new Error(reset.stderr.trim() || `Failed to reset session worktree to ${baseRef}.`);
      }
      const clean = await this.options.git.run(["clean", "-fd"], worktreePath);
      if (clean.exitCode !== 0) {
        throw new Error(clean.stderr.trim() || "Failed to clean session worktree.");
      }
      if (patchText.trim()) {
        await this.options.git.checkApplyPatchDirect(worktreePath, patchText);
        await this.options.git.applyPatchDirect(worktreePath, patchText);
      }
      const rollbackSnapshot = await this.createSessionSnapshot(taskId, "rollback", `Rollback marker after ${snapshot.label}`);
      await this.captureDiff({ ...task, worktreePath });
      await this.emitAction(task.id, "rollback", "completed", `Restored session worktree to snapshot: ${snapshot.label}.`, snapshot.patchPath, {
        baseRef,
        rollbackSnapshot,
        safetySnapshot,
        snapshot,
        worktreePath,
      });
      return { rollbackSnapshot, safetySnapshot };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "rollback", "failed", "Failed to roll back session.", message);
      throw error;
    }
  }

  async sessionDiagnostics(taskId: string): Promise<SessionDiagnostics> {
    const { backend, task, worktreePath } = await this.requireSession(taskId);
    const [events, backendStatus, status, branch] = await Promise.all([
      this.options.store.listEvents(taskId),
      backend.detect(),
      this.options.git.statusPorcelain(worktreePath),
      this.options.git.currentBranch(worktreePath).catch(() => undefined),
    ]);
    return {
      backend: backendStatus,
      events: {
        approvalsPending: countWaitingApprovals(events),
        errors: events.filter((event) => (event.type === "session.action" || event.type === "turn.finished" || event.type === "task.finished") && event.status === "failed").length,
        lastEventAt: events.at(-1)?.timestamp,
        total: events.length,
      },
      queue: {
        activeTurn: this.activeTurns.has(taskId),
        pending: (this.queuedTurns.get(taskId) ?? []).map((item, index) => ({
          position: index + 1,
          prompt: item.prompt,
          queuedAt: item.queuedAt,
        })),
        queuedTurns: this.queuedTurns.get(taskId)?.length ?? 0,
      },
      session: task,
      worktree: {
        branch,
        changedFiles: changedFilesFromStatus(status),
        path: worktreePath,
        status,
      },
    };
  }

  async exportSessionReport(taskId: string): Promise<ExportSessionReportResponse> {
    const { backend, project, task, worktreePath } = await this.requireSession(taskId);
    await this.emitAction(task.id, "export_report", "started", "Exporting session report.");
    try {
      const [events, diff, snapshots, backendStatus, status, branch] = await Promise.all([
        this.options.store.listEvents(taskId),
        this.options.store.latestDiff(taskId),
        this.options.store.listSnapshots(taskId),
        backend.detect(),
        this.options.git.statusPorcelain(worktreePath),
        this.options.git.currentBranch(worktreePath).catch(() => undefined),
      ]);
      const report = buildSessionReport({
        backend: backendStatus,
        branch,
        diff,
        events,
        project,
        snapshots,
        status,
        task,
        worktreePath,
      });
      const reportDir = join(homedir(), ".agent-workbench", "reports", sanitizePathSegment(project.name));
      await mkdir(reportDir, { recursive: true });
      const reportPath = join(reportDir, `${sanitizePathSegment(task.title)}-${task.id.slice(0, 8)}.md`);
      await writeFile(reportPath, report.markdown, "utf8");
      await this.emitAction(task.id, "export_report", "completed", "Session report exported.", reportPath, {
        reportPath,
        summary: report.summary,
      });
      return {
        markdown: report.markdown,
        reportPath,
        summary: report.summary,
      };
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "export_report", "failed", "Failed to export session report.", message);
      throw error;
    }
  }

  async sessionTerminalContext(taskId: string): Promise<{ project: Project; task: Task; worktreePath: string }> {
    const { project, task, worktreePath } = await this.requireSession(taskId);
    const linkedTask = await this.reconcileNativeSessionLink(task);
    if (isNativeGeminiCliSession(linkedTask) && linkedTask.agentSessionOrigin === "imported") {
      try {
        await bridgeGeminiSessionToWorktree(project.path, worktreePath, linkedTask.agentSessionId!);
      } catch (error) {
        throw new Error(
          `Gemini session ${linkedTask.agentSessionId} is not available for this project. ` +
            "Open Sessions > Resume and import a session from the detected Gemini session list, or start a new session. " +
            `Details: ${formatUnknownError(error)}`,
        );
      }
    }
    return { project, task: linkedTask, worktreePath };
  }

  async readSessionFile(taskId: string, filePath: string): Promise<SessionFileContentResponse> {
    const { worktreePath } = await this.requireSession(taskId);
    const resolved = resolveSessionFilePath(worktreePath, filePath);
    try {
      const [buffer, metadata] = await Promise.all([
        readFile(resolved.absolutePath),
        stat(resolved.absolutePath),
      ]);
      const mimeType = fileMimeType(resolved.relativePath);
      const kind = sessionFileKind(resolved.relativePath, buffer, mimeType);
      return {
        content: kind === "text" ? buffer.toString("utf8") : "",
        encoding: kind === "text" ? "utf8" : "binary",
        kind,
        mimeType,
        path: resolved.relativePath,
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error(`Session file not found: ${resolved.relativePath}`);
      }
      throw error;
    }
  }

  async sessionFileReadInfo(taskId: string, filePath: string): Promise<{
    absolutePath: string;
    kind: SessionFileContentResponse["kind"];
    mimeType: string;
    path: string;
    size: number;
    updatedAt: string;
  }> {
    const { worktreePath } = await this.requireSession(taskId);
    const resolved = resolveSessionFilePath(worktreePath, filePath);
    try {
      const [buffer, metadata] = await Promise.all([
        readFile(resolved.absolutePath),
        stat(resolved.absolutePath),
      ]);
      const mimeType = fileMimeType(resolved.relativePath);
      return {
        absolutePath: resolved.absolutePath,
        kind: sessionFileKind(resolved.relativePath, buffer, mimeType),
        mimeType,
        path: resolved.relativePath,
        size: metadata.size,
        updatedAt: metadata.mtime.toISOString(),
      };
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error(`Session file not found: ${resolved.relativePath}`);
      }
      throw error;
    }
  }

  async listSessionTree(taskId: string): Promise<SessionTreeEntry[]> {
    const { worktreePath } = await this.requireSession(taskId);
    return listSessionTreeEntries(worktreePath);
  }

  async updateSessionFile(taskId: string, input: UpdateSessionFileRequest): Promise<SessionFileContentResponse> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const resolved = resolveSessionFilePath(worktreePath, input.path);
    await mkdir(dirname(resolved.absolutePath), { recursive: true });
    await writeFile(resolved.absolutePath, input.content, "utf8");
    await this.updateTask({ ...task });
    await this.captureDiff(task);
    const metadata = await stat(resolved.absolutePath);
    return {
      content: input.content,
      encoding: "utf8",
      kind: "text",
      mimeType: fileMimeType(resolved.relativePath),
      path: resolved.relativePath,
      size: metadata.size,
      updatedAt: metadata.mtime.toISOString(),
    };
  }

  async createSessionDirectory(taskId: string, input: CreateSessionDirectoryRequest): Promise<SessionTreeEntry> {
    const { task, worktreePath } = await this.requireSession(taskId);
    const resolved = resolveSessionFilePath(worktreePath, input.path);
    await mkdir(resolved.absolutePath, { recursive: true });
    await this.updateTask({ ...task, updatedAt: new Date().toISOString() });
    return {
      kind: "directory",
      path: resolved.relativePath,
    };
  }

  async uploadSessionImage(taskId: string, input: UploadSessionImageRequest): Promise<UploadSessionImageResponse> {
    const { project, task } = await this.requireSession(taskId);
    const mimeType = normalizeUploadImageMimeType(input.mimeType);
    const contentBase64 = input.contentBase64.trim();
    if (!contentBase64) {
      throw new Error("Missing required field: contentBase64");
    }

    const buffer = Buffer.from(contentBase64, "base64");
    if (buffer.byteLength === 0) {
      throw new Error("Uploaded image is empty.");
    }
    if (buffer.byteLength > MAX_SESSION_IMAGE_UPLOAD_BYTES) {
      throw new Error(`Uploaded image is too large. Limit is ${formatBytes(MAX_SESSION_IMAGE_UPLOAD_BYTES)}.`);
    }

    const uploadDir = join(homedir(), ".agent-workbench", "uploads", sanitizePathSegment(project.name || project.id), task.id);
    await mkdir(uploadDir, { recursive: true });
    const fileName = `clipboard-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.${imageExtensionForMimeType(mimeType)}`;
    const absolutePath = join(uploadDir, fileName);
    await writeFile(absolutePath, buffer);
    await this.emitAction(taskId, "context", "completed", "Screenshot uploaded.", absolutePath, {
      fileName: input.fileName,
      kind: "image_upload",
      mimeType,
      path: absolutePath,
      size: buffer.byteLength,
    });

    return {
      mimeType,
      path: absolutePath,
      reference: `@${absolutePath}`,
      size: buffer.byteLength,
    };
  }

  async recordTerminalStarted(taskId: string, command: string, cwd: string): Promise<void> {
    this.activeTerminals.set(taskId, {
      command,
      cwd,
      startedAt: new Date().toISOString(),
    });
    await this.emitAction(taskId, "resume", "started", "Terminal started.", `Running ${command} in ${cwd}.`, {
      command,
      cwd,
      kind: "terminal",
      status: "running",
    });
    for (const delayMs of [300, 1000, 2500]) {
      setTimeout(() => {
        void this.recordTerminalNativeSessionCandidate(taskId).catch(() => undefined);
      }, delayMs);
    }
  }

  async recordTerminalExited(taskId: string, command: string, exitCode: number): Promise<void> {
    this.activeTerminals.delete(taskId);
    await this.emitAction(taskId, "resume", exitCode === 0 ? "completed" : "failed", "Terminal exited.", `Raw terminal process exited with code ${exitCode}.`, {
      command,
      exitCode,
      kind: "terminal",
      status: "exited",
    });
    const task = await this.options.store.getTask(taskId);
    if (task) {
      await this.reconcileNativeSessionLink(task);
    }
  }

  async recordTerminalGeminiSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task || !isGeminiBackendId(task.backendId)) {
      return;
    }
    if (task.agentSessionId === sessionId && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== sessionId) {
      return;
    }

    await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: sessionId,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Captured Gemini resume session.",
      `Gemini CLI reported resumable session ${sessionId}.`,
      {
        agentSessionId: sessionId,
        kind: "gemini-session-link",
        source: "terminal-output",
      },
    );
  }

  async recordTerminalGeminiSessionCandidate(taskId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (task) {
      await this.reconcileGeminiSessionLink(task, { includePending: true });
    }
  }

  async recordTerminalCodexSessionCandidate(taskId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      return;
    }
    await this.reconcileCodexSessionLink(task);
  }

  async recordTerminalCodexSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task || !isCodexBackendId(task.backendId)) {
      return;
    }
    if (task.agentSessionId === sessionId && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== sessionId) {
      return;
    }

    await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: sessionId,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Captured Codex resume session.",
      `Codex CLI reported resumable session ${sessionId}.`,
      {
        agentSessionId: sessionId,
        kind: "codex-session-link",
        source: "terminal-output",
      },
    );
  }

  async recordTerminalClaudeSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task || !isClaudeBackendId(task.backendId)) {
      return;
    }
    if (task.agentSessionId === sessionId && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== sessionId) {
      return;
    }

    await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: sessionId,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Captured Claude Code resume session.",
      `Claude Code reported resumable session ${sessionId}.`,
      {
        agentSessionId: sessionId,
        kind: "claude-session-link",
        source: "terminal-output",
      },
    );
  }

  async recordTerminalQwenSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task || !isQwenBackendId(task.backendId)) {
      return;
    }
    if (!task.worktreePath || !(await qwenSessionFileExists(task.worktreePath, sessionId))) {
      return;
    }
    if (task.agentSessionId === sessionId && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== sessionId) {
      return;
    }

    await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: sessionId,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Captured Qwen Code resume session.",
      `Qwen Code reported resumable session ${sessionId}.`,
      {
        agentSessionId: sessionId,
        kind: "qwen-session-link",
        source: "terminal-output",
      },
    );
  }

  async recordTerminalCopilotSession(taskId: string, sessionId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task || !isCopilotBackendId(task.backendId)) {
      return;
    }
    if (task.agentSessionId === sessionId && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== sessionId) {
      return;
    }

    await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: sessionId,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Captured GitHub Copilot CLI resume session.",
      `GitHub Copilot CLI reported resumable session ${sessionId}.`,
      {
        agentSessionId: sessionId,
        kind: "copilot-session-link",
        source: "terminal-output",
      },
    );
  }

  async recordTerminalNativeSessionCandidate(taskId: string): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      return;
    }
    await this.reconcileNativeSessionLink(task, { includePending: true });
  }

  async refreshSessionDiff(taskId: string): Promise<DiffSnapshot | undefined> {
    const task = await this.options.store.getTask(taskId);
    if (!task?.worktreePath) {
      return undefined;
    }
    return this.captureDiff(task);
  }

  private async reconcileGeminiSessionLink(task: Task, options: { includePending?: boolean } = {}): Promise<Task> {
    if (!isGeminiBackendId(task.backendId) || !task.worktreePath) {
      return task;
    }

    let sessions: GeminiProjectSession[];
    try {
      sessions = options.includePending
        ? await listGeminiProjectSessionCandidates(task.worktreePath)
        : await listGeminiProjectSessions(task.worktreePath);
    } catch {
      return task;
    }
    if (sessions.length === 0) {
      if (shouldClearUnverifiedNativeSession(task)) {
        return this.updateTask({
          ...task,
          agentSessionId: undefined,
          agentSessionKind: undefined,
          agentSessionResumeMode: undefined,
        });
      }
      return task;
    }

    const existing = task.agentSessionId ? sessions.find((session) => session.id === task.agentSessionId) : undefined;
    if (existing) {
      const kind = geminiSessionKind(existing);
      if (task.agentSessionKind !== kind) {
        return this.updateTask({
          ...task,
          agentSessionKind: kind,
          agentSessionOrigin: task.agentSessionOrigin ?? "new",
        });
      }
      return task;
    }
    if (task.agentSessionId && task.agentSessionOrigin === "imported") {
      return task;
    }
    if (shouldClearUnverifiedNativeSession(task)) {
      task = await this.updateTask({
        ...task,
        agentSessionId: undefined,
        agentSessionKind: undefined,
        agentSessionResumeMode: undefined,
      });
    }

    const nativeSession = sessions.find((session) => session.messageCount > 0) ?? (options.includePending ? sessions[0] : undefined);
    if (!nativeSession || nativeSession.id === task.agentSessionId) {
      return task;
    }
    const kind = geminiSessionKind(nativeSession);

    const updated = await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: nativeSession.id,
      agentSessionKind: kind,
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: kind === "native-cli" ? (task.agentSessionResumeMode ?? "new") : task.agentSessionResumeMode,
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      kind === "native-cli" ? "Linked native Gemini session." : "Detected pending Gemini session.",
      kind === "native-cli"
        ? `Gemini session ${nativeSession.id} is now bound to this Workbench session.`
        : `Gemini started session ${nativeSession.id}; Workbench will use it after Gemini confirms it can resume.`,
      {
        agentSessionId: nativeSession.id,
        kind: "gemini-session-link",
        sessionKind: kind,
        source: options.includePending ? "worktree-scan-pending" : "worktree-scan",
      },
    );
    return updated;
  }

  private async reconcileCodexSessionLink(task: Task): Promise<Task> {
    if (!isCodexBackendId(task.backendId) || !task.worktreePath) {
      return task;
    }

    let nativeSession;
    try {
      nativeSession = await findLatestCodexProjectSession(task.worktreePath, task.createdAt);
    } catch {
      return task;
    }
    if (!nativeSession || nativeSession.id === task.agentSessionId) {
      return task;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== nativeSession.id) {
      return task;
    }

    const updated = await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: nativeSession.id,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Linked native Codex session.",
      `Codex session ${nativeSession.id} is now bound to this Workbench session.`,
      {
        agentSessionId: nativeSession.id,
        kind: "codex-session-link",
        source: "codex-rollout-scan",
      },
    );
    return updated;
  }

  private async reconcileClaudeSessionLink(task: Task): Promise<Task> {
    if (!isClaudeBackendId(task.backendId) || !task.worktreePath) {
      return task;
    }

    let nativeSession;
    try {
      nativeSession = task.agentSessionId
        ? await findClaudeProjectSession(task.worktreePath, task.agentSessionId)
        : await findLatestClaudeProjectSession(task.worktreePath, task.createdAt);
    } catch {
      return task;
    }
    if (!nativeSession) {
      return task;
    }
    if (task.agentSessionId === nativeSession.id && task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return task;
    }
    if (task.agentSessionOrigin === "imported" && task.agentSessionId && task.agentSessionId !== nativeSession.id) {
      return task;
    }

    const updated = await this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionId: nativeSession.id,
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
    await this.emitAction(
      task.id,
      "resume",
      "completed",
      "Linked native Claude Code session.",
      `Claude Code session ${nativeSession.id} is now bound to this Workbench session.`,
      {
        agentSessionId: nativeSession.id,
        kind: "claude-session-link",
        source: "claude-jsonl-scan",
      },
    );
    return updated;
  }

  private async reconcileQwenSessionLink(task: Task): Promise<Task> {
    if (!isQwenBackendId(task.backendId) || !task.agentSessionId || !task.worktreePath) {
      return task;
    }
    const resumable = await qwenSessionFileExists(task.worktreePath, task.agentSessionId);
    if (!resumable && task.agentSessionOrigin === "imported") {
      const project = (await this.options.store.listProjects()).find((item) => item.id === task.projectId);
      if (project) {
        try {
          await bridgeQwenSessionToWorktree(project.path, task.worktreePath, task.agentSessionId);
        } catch {
          // Keep the session in fixed-id startup mode; terminal output will show the native Qwen error if resume is attempted.
        }
      }
    }
    const verified = resumable || (await qwenSessionFileExists(task.worktreePath, task.agentSessionId));
    if (!verified) {
      if (task.agentSessionResumeMode === "resume") {
        return this.updateTask({
          ...task,
          agentSessionResumeMode: undefined,
          agentContextStatus: task.agentContextStatus ?? "live",
        });
      }
      return task;
    }

    if (task.agentSessionKind === "native-cli" && task.agentSessionResumeMode === "resume") {
      return task;
    }

    return this.updateTask({
      ...task,
      agentContextStatus: task.agentContextStatus ?? "live",
      agentSessionKind: "native-cli",
      agentSessionOrigin: task.agentSessionOrigin ?? "new",
      agentSessionResumeMode: "resume",
    });
  }

  private async reconcileNativeSessionLink(task: Task, options: { includePending?: boolean } = {}): Promise<Task> {
    if (isGeminiBackendId(task.backendId)) {
      return this.reconcileGeminiSessionLink(task, options);
    }
    if (isCodexBackendId(task.backendId)) {
      return this.reconcileCodexSessionLink(task);
    }
    if (isClaudeBackendId(task.backendId)) {
      return this.reconcileClaudeSessionLink(task);
    }
    if (isQwenBackendId(task.backendId)) {
      return this.reconcileQwenSessionLink(task);
    }
    if (isCopilotBackendId(task.backendId)) {
      return task;
    }
    return task;
  }

  private attachSession(backend: AgentBackend, task: Task, project: Project, worktreePath: string, modeId?: string): Promise<void> | undefined {
    if (!backend.startSession) {
      return undefined;
    }

    const startup = backend
      .startSession({
        agentSessionId: task.agentSessionId,
        task,
        project,
        worktreePath,
        modeId,
        emit: (event) => this.emit(event),
      })
      .then(async (attachment) => {
        if (attachment?.agentSessionId) {
          const current = await this.options.store.getTask(task.id);
          if (current) {
            const status = this.activeTurns.has(current.id)
              ? current.status
              : current.status === "running" || current.status === "starting"
                ? "review_ready"
                : current.status;
            const keepNativeCliSession =
              isNativeGeminiCliSession(current) && attachment.resumeMode === "new" && attachment.agentSessionId !== current.agentSessionId;
            await this.updateTask({
              ...current,
              agentSessionId: keepNativeCliSession ? current.agentSessionId : attachment.agentSessionId,
              agentSessionKind: keepNativeCliSession ? current.agentSessionKind : nativeSessionKindForAttachment(current, attachment.resumeMode),
              agentSessionOrigin: current.agentSessionOrigin,
              agentSessionResumeMode: attachment.resumeMode ?? current.agentSessionResumeMode,
              agentContextStatus: agentContextStatusForAttachment(current, attachment.resumeMode),
              status,
            });
          }
        }
      })
      .catch(async (error: unknown) => {
        const message = formatUnknownError(error);
        await this.updateTask({
          ...task,
          status: "failed",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        await this.emit({
          type: "task.finished",
          taskId: task.id,
          status: "failed",
          error: message,
          timestamp: new Date().toISOString(),
        });
        throw error;
      })
      .finally(() => {
        this.sessionStartups.delete(task.id);
      });

    this.sessionStartups.set(task.id, startup);
    void startup.catch(() => undefined);
    return startup;
  }

  async respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    const backend = this.backends.get(task.backendId);
    if (!backend?.resolveApproval) {
      throw new Error(`Backend does not support approvals: ${task.backendId}`);
    }
    await backend.resolveApproval(approvalId, decision);
  }

  private async requireSession(taskId: string): Promise<{
    backend: AgentBackend;
    project: Project;
    task: Task;
    worktreePath: string;
  }> {
    const task = await this.options.store.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    if (!task.worktreePath) {
      throw new Error("Task has no worktree.");
    }

    const project = (await this.options.store.listProjects()).find((item) => item.id === task.projectId);
    if (!project) {
      throw new Error("Project not found.");
    }

    const backend = this.backends.get(task.backendId);
    if (!backend) {
      throw new Error(`Backend not found: ${task.backendId}`);
    }

    return {
      backend,
      project,
      task,
      worktreePath: task.worktreePath,
    };
  }

  private async ensureSessionAttached(
    backend: AgentBackend,
    task: Task,
    project: Project,
    worktreePath: string,
  ): Promise<"attached" | Task["agentSessionResumeMode"] | undefined> {
    if (!backend.startSession || backend.hasSession?.(task.id) !== false) {
      await this.sessionStartups.get(task.id);
      return "attached";
    }

    if (this.sessionStartups.has(task.id)) {
      await this.sessionStartups.get(task.id);
      const current = await this.options.store.getTask(task.id);
      return current?.agentSessionResumeMode;
    }

    await this.emitAction(task.id, "resume", "started", "Reattaching agent process.");
    try {
      await this.attachSession(backend, task, project, worktreePath);
      const current = await this.options.store.getTask(task.id);
      const details =
        current?.agentSessionResumeMode === "load"
          ? "Loaded the existing agent session and replayed history if the backend provided it."
          : current?.agentSessionResumeMode === "resume"
            ? "Resumed the existing agent session through ACP session/resume."
            : "Started a new agent process in the same isolated worktree because the backend did not expose session restoration.";
      await this.emitAction(
        task.id,
        "resume",
        "completed",
        "Agent process attached.",
        details,
      );
      return current?.agentSessionResumeMode;
    } catch (error) {
      const message = formatUnknownError(error);
      await this.emitAction(task.id, "resume", "failed", "Failed to reattach agent process.", message);
      throw error;
    }
  }

  private async promptWithSessionMemoryIfNeeded(
    task: Task,
    prompt: string,
    attachMode: "attached" | Task["agentSessionResumeMode"] | undefined,
  ): Promise<string> {
    if (!shouldAttachTranscriptFallback(task, attachMode) || isSlashLikePrompt(prompt)) {
      return prompt;
    }

    const events = await this.options.store.listEvents(task.id);
    const diff = await this.options.store.latestDiff(task.id);
    if (!shouldAttachSessionMemoryForPrompt(prompt, events, diff)) {
      await this.emitAction(
        task.id,
        "context",
        "completed",
        "Session memory not attached.",
        "The current message looks conversational or unrelated to the previous coding task, so Workbench did not inject the recovered transcript into the backend prompt.",
        {
          attached: false,
          reason: "unrelated_prompt",
        },
      );
      return prompt;
    }
    const promptWithMemory = buildSessionMemoryPrompt(events, prompt, diff);
    if (!promptWithMemory) {
      return prompt;
    }

    const current = await this.options.store.getTask(task.id);
    if (current) {
      await this.updateTask({
        ...current,
        agentContextStatus: "transcript_fallback",
      });
    }

    await this.emitAction(
      task.id,
      "context",
      "completed",
      "Workbench session memory attached.",
      "The backend is continuing from a new process or recovered transcript, so prior visible user and agent messages were included as context for this turn.",
      {
        attached: true,
        reason: "transcript_fallback",
      },
    );
    return promptWithMemory;
  }

  private async handleNativeSlashCommand(task: Task, project: Project, worktreePath: string, prompt: string, turnId: string): Promise<boolean> {
    const parsed = parseNativeSlashCommand(prompt);
    if (!parsed) {
      return false;
    }

    const toolCallId = `${task.id}:workbench-command:${randomUUID()}`;
    await this.emit({
      type: "tool.started",
      taskId: task.id,
      toolCallId,
      name: `/${parsed.command}`,
      input: {
        args: parsed.args,
        source: "workbench-native",
      },
      timestamp: new Date().toISOString(),
    });

    try {
      const output = await this.runNativeSlashCommand(parsed.command, parsed.args, task, project, worktreePath);
      if (!this.isActiveTurn(task.id, turnId)) {
        return true;
      }
      await this.emit({ type: "message.delta", taskId: task.id, text: output, timestamp: new Date().toISOString() });
      await this.emit({
        type: "tool.finished",
        taskId: task.id,
        toolCallId,
        name: `/${parsed.command}`,
        status: "ok",
        output,
        timestamp: new Date().toISOString(),
      });
      await this.captureDiff(task);
      if (!this.isActiveTurn(task.id, turnId)) {
        return true;
      }
      const current = await this.options.store.getTask(task.id);
      if (current) {
        await this.updateTask({
          ...current,
          status: "review_ready",
          updatedAt: new Date().toISOString(),
        });
      }
      await this.emit({
        type: "turn.finished",
        taskId: task.id,
        status: "completed",
        stopReason: "end_turn",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (!this.isActiveTurn(task.id, turnId)) {
        return true;
      }
      const message = formatUnknownError(error);
      await this.emit({
        type: "tool.finished",
        taskId: task.id,
        toolCallId,
        name: `/${parsed.command}`,
        status: "error",
        output: message,
        timestamp: new Date().toISOString(),
      });
      await this.emit({ type: "message.delta", taskId: task.id, text: `Error: ${message}`, timestamp: new Date().toISOString() });
      await this.updateTask({
        ...task,
        status: "failed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.emit({
        type: "turn.finished",
        taskId: task.id,
        status: "failed",
        error: message,
        timestamp: new Date().toISOString(),
      });
    }

    return true;
  }

  private async handleUnsupportedSlashCommand(task: Task, prompt: string, turnId: string): Promise<boolean> {
    if (!prompt.trimStart().startsWith("/")) {
      return false;
    }

    if (!this.isActiveTurn(task.id, turnId)) {
      return true;
    }

    const message = unsupportedSlashCommandMessage(prompt);
    await this.emit({ type: "message.delta", taskId: task.id, text: message, timestamp: new Date().toISOString() });
    await this.updateTask({
      ...task,
      status: "review_ready",
      updatedAt: new Date().toISOString(),
    });
    await this.emit({
      type: "turn.finished",
      taskId: task.id,
      status: "completed",
      stopReason: "unsupported_slash_command",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  private async runNativeSlashCommand(
    command: NativeSlashCommand,
    args: string,
    task: Task,
    project: Project,
    worktreePath: string,
  ): Promise<string> {
    switch (command) {
      case "memory show":
        return this.nativeMemoryShow(worktreePath);
      case "memory list":
        return this.nativeMemoryList(worktreePath);
      case "memory refresh":
        return this.nativeMemoryRefresh(worktreePath);
      case "memory add":
        return this.nativeMemoryAdd(args);
      case "skills list":
        return this.nativeSkillsList(worktreePath);
      case "skills reload":
        return "Workbench-native skills are read from disk for each command. No reload is required for this view.";
      case "extensions list":
        return this.nativeExtensionsList(worktreePath);
      case "diff":
        return this.nativeDiff(task, worktreePath);
      case "status":
        return this.nativeStatus(task, project, worktreePath);
      case "apply":
        return this.nativeApply(task.id);
      case "branch":
        return this.nativeBranch(task.id);
      case "sessions":
        return this.nativeSessions();
      case "about":
        return nativeAbout(task, project, worktreePath);
      case "help":
        return nativeHelp();
    }
  }

  private async nativeMemoryShow(worktreePath: string): Promise<string> {
    const files = await readMemoryFiles(worktreePath);
    if (files.length === 0) {
      return "Memory is currently empty.";
    }

    return [
      `Current memory content from ${files.length} file(s):`,
      "",
      "---",
      files.map((file) => `Context from: ${file.path}\n\n${file.content.trimEnd()}`).join("\n\n---\n\n"),
      "---",
    ].join("\n");
  }

  private async nativeMemoryList(worktreePath: string): Promise<string> {
    const files = await readMemoryFiles(worktreePath);
    if (files.length === 0) {
      return "No GEMINI.md files in use.";
    }

    return `There are ${files.length} GEMINI.md file(s) in use:\n\n${files.map((file) => file.path).join("\n")}`;
  }

  private async nativeMemoryRefresh(worktreePath: string): Promise<string> {
    const files = await readMemoryFiles(worktreePath);
    const characters = files.reduce((total, file) => total + file.content.length, 0);
    if (files.length === 0) {
      return "Memory reloaded successfully. No memory content found.";
    }

    return `Memory reloaded successfully. Loaded ${characters} characters from ${files.length} file(s).`;
  }

  private async nativeMemoryAdd(args: string): Promise<string> {
    const text = args.trim();
    if (!text) {
      return "Usage: /memory add <text to remember>";
    }

    const target = globalMemoryPath();
    await mkdir(dirname(target), { recursive: true });
    const existing = await readFile(target, "utf8").catch(() => "");
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(target, `${prefix}${text}\n`, "utf8");
    return `Added memory to ${target}:\n\n${text}`;
  }

  private async nativeSkillsList(worktreePath: string): Promise<string> {
    const skills = await listSkills(worktreePath);
    if (skills.length === 0) {
      return "No Workbench-visible skills found in ~/.gemini/skills, ~/.agents/skills, .gemini/skills, or .agents/skills.";
    }

    return [
      `Found ${skills.length} Workbench-visible skill(s):`,
      "",
      ...skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}\n  ${skill.path}`),
    ].join("\n");
  }

  private async nativeExtensionsList(worktreePath: string): Promise<string> {
    const extensions = await listNamedDirectories([
      { label: "global", path: join(homedir(), ".gemini", "extensions") },
      { label: "project", path: join(worktreePath, ".gemini", "extensions") },
    ]);
    if (extensions.length === 0) {
      return "No Gemini extensions found in ~/.gemini/extensions or .gemini/extensions.";
    }

    return [
      `Found ${extensions.length} extension(s):`,
      "",
      ...extensions.map((extension) => `- ${extension.name} (${extension.label})\n  ${extension.path}`),
    ].join("\n");
  }

  private async nativeDiff(task: Task, worktreePath: string): Promise<string> {
    const patchText = await this.sessionPatch(task, worktreePath);
    const summary = summarizeDiff(patchText);
    if (!patchText.trim()) {
      return "No session diff.";
    }
    return [
      `Diff: ${summary.filesChanged} files, ${summary.insertions} additions, ${summary.deletions} deletions.`,
      "",
      ...summary.files.map((file) => `- ${file.path} (${file.status}, +${file.insertions}/-${file.deletions})`),
    ].join("\n");
  }

  private async nativeStatus(task: Task, project: Project, worktreePath: string): Promise<string> {
    const [events, worktreeStatus] = await Promise.all([
      this.options.store.listEvents(task.id),
      this.options.git.statusPorcelain(worktreePath),
    ]);
    return [
      `Session: ${task.title}`,
      `Status: ${task.status}`,
      `Project: ${project.name}`,
      `Worktree: ${worktreePath}`,
      `Context: ${task.agentContextStatus ?? "unknown"}`,
      `Waiting approvals: ${countWaitingApprovals(events)}`,
      "",
      worktreeStatus.trim() ? `Worktree changes:\n${worktreeStatus.trim()}` : "Worktree is clean.",
    ].join("\n");
  }

  private async nativeApply(taskId: string): Promise<string> {
    const result = await this.applySession(taskId);
    if (result.preflight && !result.preflight.canApply) {
      return applyConflictMessage(result.preflight);
    }
    return `Applied ${result.summary.filesChanged} files to ${result.projectPath}.`;
  }

  private async nativeBranch(taskId: string): Promise<string> {
    const result = await this.createSessionBranch(taskId);
    return `Branch ready: ${result.branch}${result.commitSha ? ` @ ${result.commitSha}` : ""}`;
  }

  private async nativeSessions(): Promise<string> {
    const overviews = await this.listSessionOverviews();
    if (overviews.length === 0) {
      return "No sessions.";
    }
    return [
      `Sessions: ${overviews.length}`,
      "",
      ...overviews.map((overview) => `- ${overview.task.title}: ${overview.task.status}, ${overview.filesChanged} files, ${overview.currentStep}`),
    ].join("\n");
  }

  private async runBackend(backend: AgentBackend, task: Task, project: Project, worktreePath: string): Promise<void> {
    const running = await this.updateTask({ ...task, status: "running", updatedAt: new Date().toISOString() });
    await this.emit({ type: "task.started", taskId: running.id, timestamp: new Date().toISOString() });

    try {
      await backend.startTask({
        task: running,
        project,
        worktreePath,
        emit: (event) => this.emit(event),
      });

      await this.captureDiff(running);
      await this.updateTask({
        ...running,
        status: "review_ready",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.emit({ type: "task.finished", taskId: running.id, status: "completed", timestamp: new Date().toISOString() });
    } catch (error) {
      const message = formatUnknownError(error);
      await this.updateTask({
        ...running,
        status: "failed",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await this.emit({
        type: "task.finished",
        taskId: running.id,
        status: "failed",
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async captureDiff(task: Task): Promise<DiffSnapshot | undefined> {
    if (!task.worktreePath) {
      return undefined;
    }

    const diffText = await this.sessionPatch(task, task.worktreePath);
    const summary = summarizeDiff(diffText);
    const snapshot: DiffSnapshot = {
      id: randomUUID(),
      taskId: task.id,
      summary,
      diffText,
      createdAt: new Date().toISOString(),
    };
    await this.options.store.appendDiff(snapshot);
    await this.emit({ type: "diff.updated", taskId: task.id, summary, timestamp: new Date().toISOString() });
    return snapshot;
  }

  private async sessionPatch(task: Task, worktreePath: string): Promise<string> {
    if (task.baseBranch) {
      try {
        return await this.options.git.patchFromBase(worktreePath, task.baseBranch);
      } catch {
        return this.options.git.patch(worktreePath);
      }
    }
    return this.options.git.patch(worktreePath);
  }

  private async writePatchFile(project: Project, task: Task, patchText: string): Promise<string> {
    const patchDir = join(homedir(), ".agent-workbench", "patches", sanitizePathSegment(project.name));
    await mkdir(patchDir, { recursive: true });
    const patchPath = join(patchDir, `${sanitizePathSegment(task.title)}-${task.id.slice(0, 8)}.patch`);
    await writeFile(patchPath, patchText, "utf8");
    return patchPath;
  }

  private async updateTask(task: Task): Promise<Task> {
    const updated = await this.options.store.upsertTask({ ...task, updatedAt: new Date().toISOString() });
    this.options.eventBus.publishTask(updated);
    return updated;
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.options.store.appendEvent(event.taskId, event);
    this.options.eventBus.publishEvent(event);
  }

  private async emitAction(
    taskId: string,
    action: SessionAction,
    status: "started" | "completed" | "failed",
    title: string,
    details?: string,
    data?: unknown,
  ): Promise<void> {
    await this.emit({
      type: "session.action",
      taskId,
      action,
      status,
      title,
      details,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  private clearActiveTurn(taskId: string, turnId: string): void {
    if (this.activeTurns.get(taskId) === turnId) {
      this.activeTurns.delete(taskId);
    }
  }

  private clearQueuedTurns(taskId: string): number {
    const count = this.queuedTurns.get(taskId)?.length ?? 0;
    this.queuedTurns.delete(taskId);
    return count;
  }

  private isActiveTurn(taskId: string, turnId: string): boolean {
    return this.activeTurns.get(taskId) === turnId;
  }

  private liveTerminalSummary(taskId: string, historical: SessionOverview["terminal"] | undefined): SessionOverview["terminal"] | undefined {
    const live = this.activeTerminals.get(taskId);
    if (live) {
      return {
        command: live.command,
        lastEventAt: live.startedAt,
        status: "running",
      };
    }
    if (historical?.status === "running") {
      return {
        ...historical,
        status: "exited",
      };
    }
    return historical;
  }
}

type NativeSlashCommand =
  | "about"
  | "apply"
  | "branch"
  | "diff"
  | "extensions list"
  | "help"
  | "memory add"
  | "memory list"
  | "memory refresh"
  | "memory show"
  | "sessions"
  | "skills list"
  | "skills reload"
  | "status";

interface NativeSlashCommandDefinition {
  aliases: string[];
  command: NativeSlashCommand;
  description: string;
  usage: string;
}

interface TextFileContent {
  content: string;
  path: string;
}

interface NamedPath {
  label: string;
  name: string;
  path: string;
}

interface SkillPath extends NamedPath {
  description?: string;
}

const NATIVE_SLASH_COMMANDS: NativeSlashCommandDefinition[] = [
  {
    aliases: ["memory", "memory show", "memory view"],
    command: "memory show",
    description: "Show loaded GEMINI.md memory without attaching Gemini ACP.",
    usage: "/memory show",
  },
  {
    aliases: ["memory list"],
    command: "memory list",
    description: "List Workbench-visible GEMINI.md files.",
    usage: "/memory list",
  },
  {
    aliases: ["memory refresh", "memory reload"],
    command: "memory refresh",
    description: "Re-read Workbench-visible GEMINI.md files.",
    usage: "/memory refresh",
  },
  {
    aliases: ["memory add"],
    command: "memory add",
    description: "Append text to ~/.gemini/GEMINI.md.",
    usage: "/memory add TEXT",
  },
  {
    aliases: ["diff"],
    command: "diff",
    description: "Show current session diff summary.",
    usage: "/diff",
  },
  {
    aliases: ["status"],
    command: "status",
    description: "Show session, worktree, and approval status.",
    usage: "/status",
  },
  {
    aliases: ["apply"],
    command: "apply",
    description: "Apply session changes to the original repository.",
    usage: "/apply",
  },
  {
    aliases: ["branch"],
    command: "branch",
    description: "Commit changes on the isolated worktree branch.",
    usage: "/branch",
  },
  {
    aliases: ["sessions"],
    command: "sessions",
    description: "List all sessions.",
    usage: "/sessions",
  },
  {
    aliases: ["skills", "skills list"],
    command: "skills list",
    description: "List Workbench-visible SKILL.md files.",
    usage: "/skills list",
  },
  {
    aliases: ["skills reload"],
    command: "skills reload",
    description: "Re-read skills from disk for the Workbench view.",
    usage: "/skills reload",
  },
  {
    aliases: ["extensions", "extensions list"],
    command: "extensions list",
    description: "List Gemini extension directories.",
    usage: "/extensions list",
  },
  {
    aliases: ["about"],
    command: "about",
    description: "Show session/backend/worktree details.",
    usage: "/about",
  },
  {
    aliases: ["help"],
    command: "help",
    description: "Show Workbench-native command help.",
    usage: "/help",
  },
];

const NATIVE_SLASH_COMMAND_ALIASES = new Map<string, NativeSlashCommand>(
  NATIVE_SLASH_COMMANDS.flatMap((definition) => definition.aliases.map((alias) => [alias, definition.command])),
);

function nativeSlashCommandInfo(): SlashCommandInfo[] {
  return NATIVE_SLASH_COMMANDS.map((definition) => ({
    aliases: definition.aliases.filter((alias) => alias !== definition.command),
    description: definition.description,
    name: definition.command,
    requiresSession: true,
    source: "workbench",
    usage: definition.usage,
  }));
}


function parseNativeSlashCommand(prompt: string): { args: string; command: NativeSlashCommand } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const parts = trimmed.slice(1).trim().split(/\s+/).filter(Boolean);
  for (let length = Math.min(2, parts.length); length >= 1; length -= 1) {
    const commandName = parts.slice(0, length).join(" ").toLowerCase();
    const command = NATIVE_SLASH_COMMAND_ALIASES.get(commandName);
    if (command) {
      return {
        args: parts.slice(length).join(" "),
        command,
      };
    }
  }

  return undefined;
}

function globalMemoryPath(): string {
  return join(homedir(), ".gemini", "GEMINI.md");
}

async function readMemoryFiles(worktreePath: string): Promise<TextFileContent[]> {
  return readExistingTextFiles([
    globalMemoryPath(),
    join(worktreePath, "GEMINI.md"),
  ]);
}

async function readExistingTextFiles(paths: string[]): Promise<TextFileContent[]> {
  const seen = new Set<string>();
  const uniquePaths = paths.filter((path) => {
    if (seen.has(path)) {
      return false;
    }
    seen.add(path);
    return true;
  });

  const files = await Promise.all(
    uniquePaths.map(async (path): Promise<TextFileContent | undefined> => {
      const content = await readFile(path, "utf8").catch(() => undefined);
      return content === undefined ? undefined : { content, path };
    }),
  );

  return files.filter((file): file is TextFileContent => Boolean(file));
}

async function listNamedDirectories(roots: Array<{ label: string; path: string }>): Promise<NamedPath[]> {
  const entries = await Promise.all(
    roots.map(async (root): Promise<NamedPath[]> => {
      const dirents = await readdir(root.path, { withFileTypes: true }).catch(() => []);
      return dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => ({
          label: root.label,
          name: dirent.name,
          path: join(root.path, dirent.name),
        }));
    }),
  );

  return entries.flat();
}

async function listSkills(worktreePath: string): Promise<SkillPath[]> {
  const candidates = await listNamedDirectories([
    { label: "global gemini", path: join(homedir(), ".gemini", "skills") },
    { label: "global agents", path: join(homedir(), ".agents", "skills") },
    { label: "project gemini", path: join(worktreePath, ".gemini", "skills") },
    { label: "project agents", path: join(worktreePath, ".agents", "skills") },
  ]);

  const skills = await Promise.all(
    candidates.map(async (candidate): Promise<SkillPath | undefined> => {
      const skillFile = join(candidate.path, "SKILL.md");
      const content = await readFile(skillFile, "utf8").catch(() => undefined);
      if (content === undefined) {
        return undefined;
      }
      const metadata = parseSkillMetadata(content, candidate.name);
      return {
        ...candidate,
        description: metadata.description,
        name: metadata.name,
        path: skillFile,
      };
    }),
  );

  return skills.filter((skill): skill is SkillPath => Boolean(skill));
}

function parseSkillMetadata(content: string, fallbackName: string): { description?: string; name: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatterText = frontmatter?.[1] ?? "";
  const frontmatterName = frontmatterText.match(/^name:\s*(.+)$/m)?.[1];
  const frontmatterDescription = frontmatterText.match(/^description:\s*(.+)$/m)?.[1];
  const headingName = content.match(/^#\s+(.+)$/m)?.[1];

  return {
    description: cleanMetadataValue(frontmatterDescription),
    name: cleanMetadataValue(frontmatterName) ?? cleanMetadataValue(headingName) ?? fallbackName,
  };
}

function cleanMetadataValue(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/^["']|["']$/g, "");
  return cleaned || undefined;
}

function nativeHelp(): string {
  return [
    "Workbench-native slash commands:",
    "",
    ...NATIVE_SLASH_COMMANDS.map((command) => `${command.usage.padEnd(18)} ${command.description}`),
    "",
    "Other slash commands are forwarded to the selected agent backend.",
  ].join("\n");
}

function unsupportedSlashCommandMessage(prompt: string): string {
  const command = prompt.trim().split(/\s+/)[0] ?? "/";
  return [
    `Unsupported slash command: ${command}`,
    "",
    "Workbench did not send this to the agent backend. Gemini ACP currently exposes command discovery, but not a stable execute-command API for every CLI slash command.",
    "",
    nativeHelp(),
  ].join("\n");
}

function nativeAbout(task: Task, project: Project, worktreePath: string): string {
  return [
    "Agent Workbench",
    "",
    `Session: ${task.title}`,
    `Session ID: ${displaySessionId(task)}`,
    displaySessionId(task) !== task.id ? `Workbench internal ID: ${task.id}` : undefined,
    `Backend: ${task.backendId}`,
    `Status: ${task.status}`,
    `Context: ${task.agentContextStatus ?? "unknown"}`,
    `Project: ${project.name}`,
    `Project path: ${project.path}`,
    `Worktree: ${worktreePath}`,
    task.agentSessionId ? `Agent session ID: ${task.agentSessionId}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

const SESSION_TREE_IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

async function listSessionTreeEntries(worktreePath: string): Promise<SessionTreeEntry[]> {
  const entries: SessionTreeEntry[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const directoryPath = relativeDir ? join(worktreePath, relativeDir) : worktreePath;
    const dirents = await readdir(directoryPath, { withFileTypes: true });
    dirents.sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });

    for (const dirent of dirents) {
      const nextRelativePath = relativeDir ? join(relativeDir, dirent.name) : dirent.name;
      const normalizedPath = nextRelativePath.split(sep).join("/");
      if (dirent.isDirectory()) {
        if (SESSION_TREE_IGNORED_DIRS.has(dirent.name)) {
          continue;
        }
        entries.push({
          kind: "directory",
          path: normalizedPath,
        });
        await walk(nextRelativePath);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      entries.push({
        kind: "file",
        path: normalizedPath,
      });
    }
  }

  await walk("");
  return entries;
}

function resolveSessionFilePath(worktreePath: string, filePath: string): { absolutePath: string; relativePath: string } {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("Missing required field: path");
  }
  if (isAbsolute(trimmed)) {
    throw new Error("Session file paths must be relative to the session worktree.");
  }
  const absolutePath = resolve(worktreePath, trimmed);
  const relativePath = relative(worktreePath, absolutePath);
  if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Session file path escapes the session worktree.");
  }
  return {
    absolutePath,
    relativePath: relativePath.split(sep).join("/"),
  };
}

function fileMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html; charset=utf-8";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".xml":
      return "application/xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sessionFileKind(path: string, buffer: Buffer, mimeType: string): SessionFileContentResponse["kind"] {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (isTextFilePath(path) || isProbablyTextBuffer(buffer)) {
    return "text";
  }
  return "binary";
}

function isTextFilePath(path: string): boolean {
  return new Set([
    ".c",
    ".cc",
    ".cfg",
    ".conf",
    ".cpp",
    ".css",
    ".csv",
    ".env",
    ".go",
    ".h",
    ".hpp",
    ".htm",
    ".html",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".lock",
    ".log",
    ".md",
    ".mjs",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
  ]).has(extname(path).toLowerCase());
}

function isProbablyTextBuffer(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      suspicious += 1;
    }
  }
  return suspicious / sample.length < 0.02;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function summarizeDiff(diffText: string): DiffSnapshot["summary"] {
  const files = [...diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => ({
    path: match[2] ?? match[1] ?? "unknown",
    status: "modified" as const,
    insertions: 0,
    deletions: 0,
  }));

  const insertions = diffText.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diffText.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;

  return {
    filesChanged: files.length,
    insertions,
    deletions,
    files,
  };
}

function changedFilesFromStatus(statusPorcelain: string): string[] {
  return statusPorcelain
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) {
        return [];
      }

      const path = line.slice(3).trim();
      const renameParts = path.split(" -> ");
      if (renameParts.length === 2) {
        return renameParts.map(cleanStatusPath);
      }
      return [cleanStatusPath(path)];
    })
    .filter(Boolean);
}

function applyPreflight(
  projectPath: string,
  summary: ApplyPreflight["summary"],
  originalStatus: string,
  overlapFiles: SessionFileOverlap[] = [],
): ApplyPreflight {
  const originalByPath = new Map(changedFilesFromStatusWithCodes(originalStatus).map((file) => [file.path, file.status]));
  const conflictFiles = summary.files
    .filter((file) => originalByPath.has(file.path))
    .map((file) => ({
      path: file.path,
      originalStatus: originalByPath.get(file.path) ?? "modified",
      sessionStatus: file.status,
    }));
  return {
    canApply: conflictFiles.length === 0 && overlapFiles.length === 0,
    conflictFiles,
    overlapFiles,
    projectPath,
    summary,
  };
}

function applyConflictMessage(preflight: ApplyPreflight): string {
  const lines: string[] = [];
  if (preflight.conflictFiles.length > 0) {
    lines.push(
      `Original repository has local changes in ${preflight.conflictFiles.length} file(s) this session also changes:`,
      "",
      ...preflight.conflictFiles.map((file) => `- ${file.path} (original: ${file.originalStatus}, session: ${file.sessionStatus})`),
      "",
    );
  }
  if (preflight.overlapFiles.length > 0) {
    lines.push(
      `Other active sessions also change ${preflight.overlapFiles.length} file(s) from this session:`,
      "",
      ...preflight.overlapFiles.map((file) => `- ${file.path}: ${file.sessions.map((session) => `${session.title} (${session.status})`).join(", ")}`),
      "",
    );
  }
  lines.push(
    "Use Branch Manager or Export patch to review separately. Force apply only when you understand the overwrite and divergence risk.",
  );
  return lines.join("\n");
}

function applyBlockSummary(preflight: ApplyPreflight): string {
  return [
    preflight.conflictFiles.length > 0 ? `${preflight.conflictFiles.length} local conflict${preflight.conflictFiles.length === 1 ? "" : "s"}` : undefined,
    preflight.overlapFiles.length > 0 ? `${preflight.overlapFiles.length} session overlap${preflight.overlapFiles.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join(", ");
}

function buildSessionReport(input: {
  backend: BackendStatus;
  branch?: string;
  diff?: DiffSnapshot;
  events: AgentEvent[];
  project: Project;
  snapshots: SessionSnapshot[];
  status: string;
  task: Task;
  worktreePath: string;
}): Omit<ExportSessionReportResponse, "reportPath"> {
  const latestDelivery = summarizeLatestDelivery(input.events);
  const errors = input.events.filter((event) => {
    if (event.type === "session.action") {
      return event.status === "failed";
    }
    if (event.type === "turn.finished" || event.type === "task.finished") {
      return event.status === "failed" || Boolean(event.error);
    }
    return false;
  }).length;
  const approvalsPending = countWaitingApprovals(input.events);
  const summary = {
    approvalsPending,
    deletions: input.diff?.summary.deletions ?? 0,
    errors,
    events: input.events.length,
    filesChanged: input.diff?.summary.filesChanged ?? 0,
    insertions: input.diff?.summary.insertions ?? 0,
    snapshots: input.snapshots.length,
  };
  const timeline = reportTimelineEvents(input.events).map((event) => `- ${event}`).join("\n") || "- No timeline events.";
  const changedFiles = input.diff?.summary.files.length
    ? input.diff.summary.files.map((file) => `- ${file.path} (${file.status}, +${file.insertions}, -${file.deletions})`).join("\n")
    : "- No changed files captured.";
  const snapshots = input.snapshots.length
    ? input.snapshots
        .map((snapshot) =>
          `- ${snapshot.label}${snapshot.description ? ` - ${snapshot.description}` : ""} (${snapshot.kind}, ${snapshot.summary.filesChanged} files, ${snapshot.createdAt})`,
        )
        .join("\n")
    : "- No snapshots.";

  return {
    markdown: [
      `# Agent Workbench Session Report`,
      "",
      `## Session`,
      "",
      `- Title: ${md(input.task.title)}`,
      `- Session ID: \`${displaySessionId(input.task)}\``,
      displaySessionId(input.task) !== input.task.id ? `- Workbench internal ID: \`${input.task.id}\`` : undefined,
      `- Status: \`${input.task.status}\``,
      `- Agent: ${md(input.backend.name)} (${input.backend.available ? "available" : "unavailable"})`,
      `- Backend ID: \`${input.task.backendId}\``,
      `- Mode: \`${input.task.modeId ?? "default"}\``,
      `- Context: \`${input.task.agentContextStatus ?? "unknown"}\``,
      `- Resume mode: \`${input.task.agentSessionResumeMode ?? "none"}\``,
      `- Created: ${input.task.createdAt}`,
      `- Updated: ${input.task.updatedAt}`,
      "",
      `## Repository`,
      "",
      `- Project: ${md(input.project.name)}`,
      `- Project path: \`${input.project.path}\``,
      `- Worktree path: \`${input.worktreePath}\``,
      `- Worktree branch: \`${input.branch ?? input.task.worktreeBranch ?? "unknown"}\``,
      `- Base branch: \`${input.task.baseBranch ?? input.project.defaultBranch ?? "unknown"}\``,
      `- Worktree status:`,
      "",
      "```text",
      input.status.trim() || "clean",
      "```",
      "",
      `## Summary`,
      "",
      `- Events: ${summary.events}`,
      `- Errors: ${summary.errors}`,
      `- Pending approvals: ${summary.approvalsPending}`,
      `- Changed files: ${summary.filesChanged}`,
      `- Insertions: ${summary.insertions}`,
      `- Deletions: ${summary.deletions}`,
      `- Snapshots: ${summary.snapshots}`,
      "",
      `## Delivery`,
      "",
      `- Status: \`${latestDelivery.status}\``,
      `- Title: ${md(latestDelivery.title)}`,
      latestDelivery.branch ? `- Branch: \`${latestDelivery.branch}\`` : undefined,
      latestDelivery.commitSha ? `- Commit: \`${latestDelivery.commitSha}\`` : undefined,
      latestDelivery.patchPath ? `- Patch: \`${latestDelivery.patchPath}\`` : undefined,
      latestDelivery.url ? `- PR: ${latestDelivery.url}` : undefined,
      latestDelivery.compareUrl ? `- Compare: ${latestDelivery.compareUrl}` : undefined,
      "",
      `## Changed Files`,
      "",
      changedFiles,
      "",
      `## Snapshots`,
      "",
      snapshots,
      "",
      `## Timeline`,
      "",
      timeline,
      "",
    ].filter((line): line is string => line !== undefined).join("\n"),
    summary,
  };
}

function reportTimelineEvents(events: AgentEvent[]): string[] {
  return events.slice(-80).flatMap((event): string[] => {
    switch (event.type) {
      case "user.message":
        return [`${event.timestamp} user: ${oneLine(event.text)}`];
      case "message.delta":
        return [`${event.timestamp} agent: ${oneLine(event.text)}`];
      case "session.action":
        return [`${event.timestamp} ${event.action}: ${event.status} - ${oneLine(event.title)}`];
      case "diff.updated":
        return [`${event.timestamp} diff: ${event.summary.filesChanged} files, +${event.summary.insertions}, -${event.summary.deletions}`];
      case "approval.requested":
        return [`${event.timestamp} approval requested: ${oneLine(event.request.title)}`];
      case "approval.resolved":
        return [`${event.timestamp} approval resolved: ${event.decision}`];
      case "turn.finished":
        return [`${event.timestamp} turn: ${event.status}${event.error ? ` - ${oneLine(event.error)}` : ""}`];
      case "task.finished":
        return [`${event.timestamp} task: ${event.status}${event.error ? ` - ${oneLine(event.error)}` : ""}`];
      case "task.started":
      case "shell.output":
      case "tool.started":
      case "tool.finished":
        return [];
    }
  });
}

function md(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 260);
}

function changedFilesFromStatusWithCodes(statusPorcelain: string): Array<{ path: string; status: string }> {
  return statusPorcelain
    .split(/\r?\n/)
    .flatMap((line): Array<{ path: string; status: string }> => {
      if (!line.trim()) {
        return [];
      }
      const status = line.slice(0, 2).trim() || "modified";
      const path = line.slice(3).trim().split(" -> ").at(-1)?.replace(/^"|"$/g, "") ?? "";
      return path ? [{ path, status }] : [];
    });
}

function cleanStatusPath(path: string): string {
  return path.replace(/^"|"$/g, "");
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

function isSlashLikePrompt(prompt: string): boolean {
  const trimmed = prompt.trimStart();
  return trimmed.startsWith("/") || trimmed.startsWith("$");
}

function shouldAttachSessionMemoryForPrompt(prompt: string, events: AgentEvent[], diff?: DiffSnapshot): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return false;
  }
  if (isConversationalPrompt(trimmed)) {
    return false;
  }
  if (hasExplicitContinuationIntent(trimmed)) {
    return true;
  }
  if (looksLikeCodingTask(trimmed)) {
    return true;
  }
  const hasPriorWork = Boolean(diff?.diffText.trim()) || events.some((event) => event.type === "diff.updated" && event.summary.filesChanged > 0);
  if (!hasPriorWork) {
    return false;
  }
  return false;
}

function isConversationalPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[?!.,。！？\s]+$/g, "").trim();
  return [
    "hi",
    "hello",
    "hey",
    "how are you",
    "how are u",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "你好",
    "在吗",
    "谢谢",
    "辛苦了",
  ].includes(normalized);
}

function hasExplicitContinuationIntent(prompt: string): boolean {
  return /\b(continue|resume|keep going|fix it|finish|do that|apply that|use the previous|same task|this task|these changes|the diff|rollback|snapshot|branch|pr)\b/i.test(prompt)
    || /(继续|接着|恢复|刚才|上面|这个任务|这些改动|这个改动|修复|完成|回滚|快照|分支|提交|PR|创建\s*PR)/i.test(prompt);
}

function looksLikeCodingTask(prompt: string): boolean {
  return /\b(file|repo|repository|code|test|build|diff|patch|commit|branch|function|class|api|bug|error|readme|python|typescript|javascript|react|server|client|package|npm|git)\b/i.test(prompt)
    || /(文件|仓库|代码|测试|构建|补丁|提交|函数|接口|错误|修复|实现|新增|删除|修改|分析|项目|目录|脚本|文档)/i.test(prompt);
}

function agentContextStatusForAttachment(task: Task, resumeMode?: "new" | "load" | "resume"): AgentContextStatus {
  if (resumeMode === "load") {
    return "restored";
  }
  if (resumeMode === "resume") {
    return "resumed";
  }
  if (task.agentSessionId) {
    return "new_process";
  }
  return "live";
}

function isGeminiBackendId(backendId: string): boolean {
  return backendId === "gemini" || backendId === "gemini-acp";
}

function isCodexBackendId(backendId: string): boolean {
  return backendId === "codex";
}

function isClaudeBackendId(backendId: string): boolean {
  return backendId === "claude";
}

function isQwenBackendId(backendId: string): boolean {
  return backendId === "qwen";
}

function isCopilotBackendId(backendId: string): boolean {
  return backendId === "copilot";
}

function isNativeCliBackendId(backendId: string): boolean {
  return isGeminiBackendId(backendId) || isCodexBackendId(backendId) || isClaudeBackendId(backendId) || isQwenBackendId(backendId) || isCopilotBackendId(backendId);
}

function usesPreallocatedNativeSessionId(backendId: string): boolean {
  return isClaudeBackendId(backendId) || isQwenBackendId(backendId) || isCopilotBackendId(backendId);
}

async function qwenSessionFileExists(worktreePath: string, sessionId: string): Promise<boolean> {
  try {
    await access(qwenSessionFilePath(worktreePath, sessionId));
    return true;
  } catch {
    return false;
  }
}

function qwenSessionFilePath(worktreePath: string, sessionId: string): string {
  return join(process.env.QWEN_RUNTIME_DIR || join(homedir(), ".qwen"), "projects", sanitizeQwenCwd(worktreePath), "chats", `${sessionId}.jsonl`);
}

function sanitizeQwenCwd(cwd: string): string {
  const normalized = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

function nativeCliBackendName(backendId: NativeCliBackendId): string {
  if (backendId === "gemini-acp") {
    return "Gemini CLI";
  }
  if (backendId === "codex") {
    return "OpenAI Codex";
  }
  if (backendId === "qwen") {
    return "Qwen Code";
  }
  if (backendId === "copilot") {
    return "GitHub Copilot CLI";
  }
  return "Claude Code";
}

function isNativeGeminiCliSession(task: Task): boolean {
  return Boolean(
    task.agentSessionId &&
      isGeminiBackendId(task.backendId) &&
      (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported")),
  );
}

function shouldClearUnverifiedNativeSession(task: Task): boolean {
  return task.agentSessionKind === "native-cli" && task.agentSessionOrigin !== "imported" && task.agentSessionResumeMode !== "resume";
}

function geminiSessionKind(session: GeminiProjectSession): Task["agentSessionKind"] {
  return session.messageCount > 0 ? "native-cli" : "native-cli-pending";
}

function nativeSessionKindForAttachment(task: Task, resumeMode?: "new" | "load" | "resume"): Task["agentSessionKind"] {
  if (task.agentSessionKind === "native-cli" && resumeMode !== "new") {
    return "native-cli";
  }
  if (task.agentSessionOrigin === "imported" && resumeMode !== "new") {
    return "native-cli";
  }
  return "acp";
}

function shouldAttachTranscriptFallback(task: Task, attachMode: "attached" | Task["agentSessionResumeMode"] | undefined): boolean {
  return attachMode === "new" || task.agentContextStatus === "transcript_fallback" || task.agentContextStatus === "new_process";
}

function buildSessionMemoryPrompt(events: AgentEvent[], currentPrompt: string, diff?: DiffSnapshot): string | undefined {
  const messages: Array<{ role: "Agent" | "User"; text: string }> = [];
  const actions: string[] = [];

  for (const event of events) {
    if (event.type === "user.message") {
      messages.push({ role: "User", text: event.text });
      continue;
    }
    if (event.type === "message.delta") {
      const previous = messages.at(-1);
      if (previous?.role === "Agent") {
        previous.text += event.text;
      } else {
        messages.push({ role: "Agent", text: event.text });
      }
      continue;
    }
    if (event.type === "session.action" && event.status !== "started") {
      actions.push(`${event.action}: ${event.status}${event.details ? ` (${event.details})` : ""}`);
      continue;
    }
    if (event.type === "diff.updated") {
      actions.push(`diff: ${event.summary.filesChanged} files, ${event.summary.insertions} additions, ${event.summary.deletions} deletions`);
    }
  }

  const last = messages.at(-1);
  if (last?.role === "User" && last.text.trim() === currentPrompt.trim()) {
    messages.pop();
  }

  const cleaned = messages
    .map((message) => ({
      role: message.role,
      text: message.text.trim(),
    }))
    .filter((message) => message.text);

  if (cleaned.length === 0) {
    return undefined;
  }

  const transcript = limitTranscript(cleaned)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n\n");
  const stateLines = [
    diff
      ? `Current diff: ${diff.summary.filesChanged} files, ${diff.summary.insertions} additions, ${diff.summary.deletions} deletions.`
      : undefined,
    diff && diff.summary.files.length > 0 ? `Changed files: ${diff.summary.files.map((file) => file.path).slice(0, 20).join(", ")}` : undefined,
    actions.length > 0 ? `Recent actions: ${actions.slice(-12).join(" | ")}` : undefined,
  ].filter(Boolean);

  return [
    "You are continuing an Agent Workbench session.",
    "The previous Gemini ACP process could not be restored, so the visible session transcript is provided as memory for this turn.",
    "Use this continuity context only when it is relevant to the current user message.",
    "Do not continue previous work, inspect files, create files, or summarize old work unless the current user message asks for that.",
    "If the current user message is conversational, answer it directly and ignore the previous task context.",
    "Do not repeat or summarize this hidden continuity context unless the user asks.",
    "Respect file state in the current worktree as the source of truth.",
    "",
    stateLines.length > 0 ? "Session state:" : undefined,
    ...stateLines,
    stateLines.length > 0 ? "" : undefined,
    "Compressed visible transcript:",
    transcript,
    "",
    "Current user message:",
    currentPrompt,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function limitTranscript(messages: Array<{ role: "Agent" | "User"; text: string }>): Array<{ role: "Agent" | "User"; text: string }> {
  const maxChars = 24_000;
  const selected: Array<{ role: "Agent" | "User"; text: string }> = [];
  let total = 0;

  for (const message of [...messages].reverse()) {
    const size = message.role.length + message.text.length + 4;
    if (selected.length > 0 && total + size > maxChars) {
      break;
    }
    selected.push(message);
    total += size;
  }

  return selected.reverse();
}

function countWaitingApprovals(events: AgentEvent[]): number {
  const requested = new Set<string>();
  const resolved = new Set<string>();
  for (const event of events) {
    if (event.type === "approval.requested") {
      requested.add(event.approvalId);
    }
    if (event.type === "approval.resolved") {
      resolved.add(event.approvalId);
    }
  }
  return [...requested].filter((approvalId) => !resolved.has(approvalId)).length;
}

function latestApplyConflictFiles(events: AgentEvent[]): string[] {
  const latest = [...events].reverse().find((event) => event.type === "session.action" && event.action === "apply" && event.status === "failed");
  if (!latest || latest.type !== "session.action") {
    return [];
  }
  const data = latest.data as { conflictFiles?: Array<{ path?: unknown }> } | undefined;
  return data?.conflictFiles?.flatMap((file) => (typeof file.path === "string" ? [file.path] : [])) ?? [];
}

function summarizeLastAgentMessage(events: AgentEvent[]): string | undefined {
  const latest = [...events].reverse().find((event) => event.type === "message.delta");
  if (!latest || latest.type !== "message.delta") {
    return undefined;
  }
  return latest.text.trim().replace(/\s+/g, " ").slice(0, 180) || undefined;
}

function summarizeLastError(events: AgentEvent[]): string | undefined {
  const latest = [...events].reverse().find((event) => {
    if (event.type === "session.action") {
      return event.status === "failed";
    }
    if (event.type === "turn.finished" || event.type === "task.finished") {
      return event.status === "failed" || Boolean(event.error);
    }
    return false;
  });
  if (!latest) {
    return undefined;
  }
  if (latest.type === "session.action") {
    return cleanOverviewText(latest.details ?? latest.title);
  }
  if (latest.type === "turn.finished" || latest.type === "task.finished") {
    return cleanOverviewText(latest.error ?? latest.status);
  }
  return undefined;
}

function summarizeTerminal(events: AgentEvent[]): SessionOverview["terminal"] | undefined {
  const terminalEvents = events.filter((event) => event.type === "session.action" && event.action === "resume" && terminalActionData(event.data));
  const latest = terminalEvents.at(-1);
  if (!latest || latest.type !== "session.action") {
    return undefined;
  }
  const data = terminalActionData(latest.data);
  if (!data) {
    return undefined;
  }
  return {
    command: typeof data.command === "string" ? data.command : undefined,
    exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
    lastEventAt: latest.timestamp,
    status: data.status === "running" ? "running" : "exited",
  };
}

function terminalActionData(data: unknown): { command?: unknown; exitCode?: unknown; kind?: unknown; status?: unknown } | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const value = data as { command?: unknown; exitCode?: unknown; kind?: unknown; status?: unknown };
  return value.kind === "terminal" ? value : undefined;
}

function summarizeLatestDelivery(events: AgentEvent[]): SessionOverview["latestDelivery"] {
  const latest = [...events].reverse().find((event) => event.type === "session.action" && deliveryActionKind(event.action) !== undefined);
  if (!latest || latest.type !== "session.action") {
    return {
      status: "none",
      title: "No delivery action yet.",
    };
  }

  const data = latest.data && typeof latest.data === "object" && !Array.isArray(latest.data)
    ? latest.data as Record<string, unknown>
    : {};
  const kind = deliveryActionKind(latest.action);
  return {
    branch: stringField(data, "branch"),
    commitSha: stringField(data, "commitSha"),
    compareUrl: stringField(data, "compareUrl"),
    kind,
    message: stringField(data, "message") ?? latest.details,
    patchPath: stringField(data, "patchPath") ?? (latest.action === "export_patch" ? latest.details : undefined),
    projectPath: stringField(data, "projectPath") ?? (latest.action === "apply" ? latest.details : undefined),
    status: deliveryStatus(latest, data),
    timestamp: latest.timestamp,
    title: latest.title,
    url: stringField(data, "url"),
  };
}

function deliveryActionKind(action: SessionAction): SessionOverview["latestDelivery"]["kind"] {
    switch (action) {
    case "enqueue":
    case "clear_queue":
      return undefined;
    case "apply":
      return "apply";
    case "repo_add":
      return "add";
    case "repo_commit":
      return "commit";
    case "export_patch":
      return "patch";
    case "create_branch":
      return "branch";
    case "push_branch":
      return "push";
    case "create_pr":
      return "pr";
    case "discard":
    case "context":
    case "recover":
    case "resume":
    case "terminal":
    case "export_report":
    case "rollback":
    case "set_mode":
    case "snapshot":
    case "sync_latest":
      return undefined;
  }
}

function deliveryStatus(event: Extract<AgentEvent, { type: "session.action" }>, data: Record<string, unknown>): SessionOverview["latestDelivery"]["status"] {
  if (event.status === "started") {
    return "started";
  }
  if (event.status === "failed") {
    return "failed";
  }
    switch (event.action) {
    case "enqueue":
    case "clear_queue":
      return "none";
    case "apply":
      return "applied";
    case "repo_add":
      return "started";
    case "repo_commit":
      return "branch_ready";
    case "export_patch":
      return "patch_exported";
    case "create_branch":
      return "branch_ready";
    case "push_branch":
      return "pushed";
    case "create_pr":
      if (data.created === true) {
        return "pr_ready";
      }
      if (typeof data.compareUrl === "string" && data.compareUrl.trim()) {
        return "compare_ready";
      }
      return "branch_ready";
    case "discard":
    case "context":
    case "recover":
    case "resume":
    case "terminal":
    case "export_report":
    case "rollback":
    case "set_mode":
    case "snapshot":
    case "sync_latest":
      return "none";
  }
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cleanOverviewText(value: string): string {
  try {
    const parsed = JSON.parse(value) as { data?: { details?: unknown }; message?: unknown };
    if (typeof parsed.data?.details === "string") {
      return parsed.data.details.replace(/\s+/g, " ").slice(0, 220);
    }
    if (typeof parsed.message === "string") {
      return parsed.message.replace(/\s+/g, " ").slice(0, 220);
    }
  } catch {
    // Fall through to plain text cleanup.
  }
  if (value.includes("Failed to initialize checkpointing") && value.includes("initial-branch=main")) {
    return "Gemini checkpointing failed on older Git; restart Workbench with checkpointing disabled.";
  }
  return value.replace(/\s+/g, " ").slice(0, 220);
}

function overviewStage(
  task: Task,
  waitingApprovals: number,
  stuck: boolean,
  conflictFiles: string[],
  terminal?: SessionOverview["terminal"],
  input?: {
    activeTurn: boolean;
    filesChanged: number;
    latestDelivery: SessionDeliverySummary;
    queuedTurns: number;
    snapshots: number;
  },
): SessionOverview["stage"] {
  if (waitingApprovals > 0) {
    return "approval";
  }
  if (conflictFiles.length > 0) {
    return "conflict";
  }
  if (stuck || task.status === "failed" || task.status === "cancelled") {
    return "failed";
  }
  if (input && hasReviewMaterial(input.filesChanged, input.snapshots, input.latestDelivery, task.status)) {
    return "review";
  }
  if (input && (input.activeTurn || input.queuedTurns > 0)) {
    return "running";
  }
  if (terminal?.status === "running") {
    return "terminal";
  }
  if (task.status === "pr_ready") {
    return "pr";
  }
  if (task.status === "branch_ready") {
    return "branch";
  }
  if (task.status === "applied") {
    return "applied";
  }
  if (task.status === "review_ready") {
    return "review";
  }
  if (task.status === "running" || task.status === "starting" || task.status === "waiting_approval") {
    return "running";
  }
  return "idle";
}

function overviewState(
  task: Task,
  input: {
    activeTurn: boolean;
    conflictFiles: string[];
    filesChanged: number;
    latestDelivery: SessionDeliverySummary;
    queuedTurns: number;
    snapshots: number;
    stuck: boolean;
    terminal?: SessionOverview["terminal"];
    waitingApprovals: number;
  },
): SessionState {
  if (input.stuck || task.status === "failed" || task.status === "cancelled") {
    return "failed";
  }
  if (input.waitingApprovals > 0 || input.conflictFiles.length > 0 || input.latestDelivery.status === "failed") {
    return "needs_action";
  }
  if (input.activeTurn || input.queuedTurns > 0) {
    return "running";
  }
  if (hasReviewMaterial(input.filesChanged, input.snapshots, input.latestDelivery, task.status)) {
    return "review";
  }
  if (input.terminal?.status === "running") {
    return "ready";
  }
  return "detached";
}

function overviewStateReason(
  state: SessionState,
  task: Task,
  input: {
    activeTurn: boolean;
    conflictFiles: string[];
    filesChanged: number;
    latestDelivery: SessionDeliverySummary;
    queuedTurns: number;
    snapshots: number;
    stuck: boolean;
    terminal?: SessionOverview["terminal"];
    waitingApprovals: number;
  },
): string {
  if (state === "failed") {
    if (input.stuck) {
      return "No activity while the session was marked running.";
    }
    return task.status === "cancelled" ? "The session was stopped." : "The latest session operation failed.";
  }
  if (state === "needs_action") {
    if (input.conflictFiles.length > 0) {
      return `${input.conflictFiles.length} conflict${input.conflictFiles.length === 1 ? "" : "s"} need resolution.`;
    }
    if (input.waitingApprovals > 0) {
      return `${input.waitingApprovals} approval request${input.waitingApprovals === 1 ? "" : "s"} waiting.`;
    }
    return "The latest delivery operation needs follow-up.";
  }
  if (state === "running") {
    return input.queuedTurns > 0 ? `${input.queuedTurns} queued turn${input.queuedTurns === 1 ? "" : "s"} waiting behind active work.` : "Agent work is actively running.";
  }
  if (state === "review") {
    if (input.filesChanged > 0) {
      return `${input.filesChanged} changed file${input.filesChanged === 1 ? "" : "s"} ready for review.`;
    }
    if (input.latestDelivery.status !== "none") {
      return "Delivery output is ready for review.";
    }
    return "Session has review material.";
  }
  if (state === "ready") {
    return "Native terminal is attached and ready for input.";
  }
  return "No terminal is currently attached; the session worktree is preserved.";
}

function hasReviewMaterial(filesChanged: number, snapshots: number, latestDelivery: SessionDeliverySummary, status: Task["status"]): boolean {
  return filesChanged > 0 || snapshots > 0 || latestDelivery.status !== "none" || status === "review_ready" || status === "branch_ready" || status === "pr_ready" || status === "applied";
}

function isRestartRecoverableStatus(status: Task["status"]): boolean {
  return status === "running" || status === "starting" || status === "waiting_approval";
}

function addFileOverlapRisk(overviews: SessionOverview[]): SessionOverview[] {
  const fileMap = new Map<string, Array<{ path: string; task: Task }>>();
  for (const overview of overviews) {
    if (overview.task.status === "applied" || overview.task.status === "cancelled") {
      continue;
    }
    for (const path of overview.touchedFiles) {
      const key = `${overview.task.projectId}\0${path}`;
      const entries = fileMap.get(key) ?? [];
      entries.push({ path, task: overview.task });
      fileMap.set(key, entries);
    }
  }

  return overviews.map((overview) => {
    const overlapFiles: SessionFileOverlap[] = overview.touchedFiles.flatMap((path) => {
      const entries = fileMap.get(`${overview.task.projectId}\0${path}`) ?? [];
      const sessions = entries
        .filter((entry) => entry.task.id !== overview.task.id)
        .map((entry) => ({
          status: entry.task.status,
          taskId: entry.task.id,
          title: entry.task.title,
        }));
      return sessions.length > 0 ? [{ path, sessions }] : [];
    });
    if (overlapFiles.length === 0) {
      return overview;
    }

    const riskReasons = uniqueStrings([...overview.riskReasons.filter((reason) => reason !== "normal"), "file overlap"]);
    const nextAction = overview.nextAction.startsWith("Review overlapping files")
      ? overview.nextAction
      : `Review overlapping files before apply or PR. ${overview.nextAction}`;

    return {
      ...overview,
      health: overview.health === "ok" ? "attention" : overview.health,
      healthReason: overview.health === "ok" ? "Changed files overlap another active session." : overview.healthReason,
      nextAction,
      overlapFiles,
      risk: overview.risk === "high" ? "high" : "medium",
      riskReasons,
    };
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isOrphanedRunningTask(
  task: Task,
  input: {
    activeTurn: boolean;
    idleMs: number;
    startupActive: boolean;
    terminal?: SessionOverview["terminal"];
  },
): boolean {
  return (
    task.status === "running" &&
    !input.activeTurn &&
    !input.startupActive &&
    input.terminal?.status !== "running" &&
    input.idleMs > 30 * 1000
  );
}

function overviewHealth(
  task: Task,
  stage: SessionOverview["stage"],
  waitingApprovals: number,
  conflictFiles: string[],
  stuck: boolean,
  state?: SessionState,
): SessionHealth {
  if (state === "ready" || state === "detached") {
    return "ok";
  }
  if (state === "review") {
    return "attention";
  }
  if (state === "running") {
    return "running";
  }
  if (state === "needs_action") {
    return "blocked";
  }
  if (state === "failed") {
    return "failed";
  }
  if (stuck) {
    return "stuck";
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return "failed";
  }
  if (waitingApprovals > 0 || conflictFiles.length > 0) {
    return "blocked";
  }
  if (stage === "running" || stage === "terminal") {
    return "running";
  }
  if (stage === "review" || stage === "branch") {
    return "attention";
  }
  return "ok";
}

function overviewHealthReason(
  health: SessionHealth,
  task: Task,
  waitingApprovals: number,
  conflictFiles: string[],
  stuck: boolean,
  orphanedRunning: boolean,
): string {
  if (orphanedRunning) {
    return "The session is marked running, but no active turn is attached in this server process.";
  }
  if (stuck) {
    return "No activity for more than 5 minutes while marked running.";
  }
  if (task.status === "failed") {
    return "The last turn failed and needs inspection.";
  }
  if (task.status === "cancelled") {
    return "The session was cancelled.";
  }
  if (waitingApprovals > 0) {
    return `${waitingApprovals} approval request${waitingApprovals === 1 ? "" : "s"} waiting.`;
  }
  if (conflictFiles.length > 0) {
    return `${conflictFiles.length} apply conflict${conflictFiles.length === 1 ? "" : "s"} need resolution.`;
  }
  if (health === "running") {
    return "Agent or raw terminal activity is in progress.";
  }
  if (health === "attention") {
    return "Ready for human review or publishing.";
  }
  return "No immediate action required.";
}

function overviewRisk(
  task: Task,
  input: {
    conflictFiles: string[];
    filesChanged: number;
    insertions: number;
    stuck: boolean;
    terminal?: SessionOverview["terminal"];
    waitingApprovals: number;
  },
): { level: SessionRisk; reasons: string[] } {
  const reasons: string[] = [];
  if (input.stuck) {
    reasons.push("stuck session");
  }
  if (task.status === "failed" || task.status === "cancelled") {
    reasons.push("recent failure");
  }
  if (input.conflictFiles.length > 0) {
    reasons.push("apply conflict");
  }
  if (input.waitingApprovals > 0) {
    reasons.push("approval waiting");
  }
  if (input.terminal?.status === "running") {
    reasons.push("raw terminal running");
  }
  if (input.filesChanged >= 20 || input.insertions >= 1000) {
    reasons.push("large diff");
  }

  if (reasons.some((reason) => ["stuck session", "recent failure", "apply conflict"].includes(reason))) {
    return { level: "high", reasons };
  }
  if (reasons.length > 0) {
    return { level: "medium", reasons };
  }
  return { level: "low", reasons: ["normal"] };
}

function overviewNextAction(
  task: Task,
  stage: SessionOverview["stage"],
  waitingApprovals: number,
  conflictFiles: string[],
  filesChanged: number,
  terminal?: SessionOverview["terminal"],
): string {
  if (waitingApprovals > 0) {
    return "Review and resolve the pending approval.";
  }
  if (conflictFiles.length > 0) {
    return "Resolve apply conflicts, export a patch, or force apply deliberately.";
  }
  if (stage === "failed") {
    return task.status === "running" ? "Open diagnostics, then stop or reconnect the session." : "Open the session and inspect the latest error.";
  }
  if (terminal?.status === "running") {
    return "Attach the terminal to inspect or stop the raw CLI command.";
  }
  if (stage === "running") {
    return "Monitor progress; stop only if it stalls.";
  }
  if (stage === "review") {
    return filesChanged > 0 ? "Review the diff, then apply, branch, or continue prompting." : "Continue prompting or remove the empty session.";
  }
  if (stage === "applied") {
    return "Verify the original repository and commit if needed.";
  }
  if (stage === "branch") {
    return "Push the branch or create a draft PR.";
  }
  if (stage === "pr") {
    return "Open the PR and review CI or comments.";
  }
  return "Start or continue the session.";
}

function summarizeCurrentStep(events: AgentEvent[], task: Task): string {
  const lastMeaningful = [...events]
    .reverse()
    .find((event) =>
      event.type === "approval.requested" ||
      event.type === "diff.updated" ||
      event.type === "session.action" ||
      event.type === "tool.started" ||
      event.type === "tool.finished" ||
      event.type === "turn.finished" ||
      event.type === "task.finished" ||
      event.type === "message.delta",
    );

  if (!lastMeaningful) {
    return task.status === "running" ? "Starting agent" : task.status;
  }

  switch (lastMeaningful.type) {
    case "approval.requested":
      return lastMeaningful.request.title;
    case "diff.updated":
      return `${lastMeaningful.summary.filesChanged} files changed`;
    case "session.action":
      return lastMeaningful.title;
    case "tool.started":
      return `Running ${lastMeaningful.name}`;
    case "tool.finished":
      return `${lastMeaningful.name ?? lastMeaningful.toolCallId}: ${lastMeaningful.status}`;
    case "turn.finished":
      return lastMeaningful.status === "completed" ? "Ready for review" : lastMeaningful.error ?? lastMeaningful.status;
    case "task.finished":
      return lastMeaningful.status;
    case "message.delta":
      return lastMeaningful.text.trim().slice(0, 120) || "Agent replied";
    default:
      return task.status;
  }
}

function defaultPullRequestBody(task: Task): string {
  return [
    "Created from Agent Workbench.",
    "",
    `Session: ${displaySessionId(task)}`,
    displaySessionId(task) !== task.id ? `Workbench internal ID: ${task.id}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function defaultDeliveryCommitMessage(task: Task): string {
  const title = task.title.trim();
  return title ? `Agent Workbench: ${title}` : "Agent Workbench changes";
}

function createInitialSessionBranches(branchName: string, now: string, id: string = randomUUID()): SessionBranch[] {
  return [
    {
      checkedOutHere: true,
      checkedOutPath: undefined,
      id,
      name: branchName,
      role: "primary",
      applySelected: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function defaultSessionBranchName(sessionId: string): string {
  return `aw/session-${sessionId.slice(0, 8)}`;
}

function normalizeTaskBranches(task: Task): Task {
  if (task.branches?.length) {
    return task;
  }
  const now = new Date().toISOString();
  const branchName = task.worktreeBranch || `agent-workbench/${task.id}`;
  return {
    ...task,
    worktreeBranch: task.worktreeBranch || branchName,
    branches: createInitialSessionBranches(branchName, task.createdAt || now, `${task.id}:primary`),
  };
}

function selectedSessionBranch(task: Task): SessionBranch {
  const branches = normalizeTaskBranches(task).branches ?? [];
  const selected = branches.filter((branch) => branch.applySelected);
  if (selected.length === 0) {
    throw new Error("Select one branch in Branch Manager before pushing or creating a PR.");
  }
  if (selected.length > 1) {
    throw new Error("Multiple branch targets are selected. This version can push or create a PR from one branch at a time; select exactly one branch.");
  }
  return selected[0]!;
}

function normalizeBranchName(value?: string): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^refs\/heads\//, "")
    .replace(/^\/+|\/+$/g, "");
}

function looksLikeCommitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function ensureUniqueBranchName(branches: SessionBranch[], name: string): void {
  if (branches.some((branch) => branch.name === name)) {
    throw new Error(`Branch target already exists: ${name}`);
  }
}

function nextSessionBranchName(_task: Task, branches: SessionBranch[]): string {
  let candidate = `agent-workbench/${randomUUID()}`;
  while (branches.some((branch) => branch.name === candidate)) {
    candidate = `agent-workbench/${randomUUID()}`;
  }
  return candidate;
}

const MAX_SESSION_IMAGE_UPLOAD_BYTES = 12 * 1024 * 1024;

function normalizeUploadImageMimeType(value: string): string {
  const mimeType = value.trim().toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"].includes(mimeType)) {
    return mimeType;
  }
  throw new Error(`Unsupported image type: ${value || "unknown"}`);
}

function imageExtensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "png";
  }
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${Math.round(value / 1024 / 1024)} MB`;
  }
  return `${Math.round(value / 1024)} KB`;
}

function displaySessionId(task: Task): string {
  return isNativeGeminiCliSession(task) ? task.agentSessionId! : task.id;
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}
