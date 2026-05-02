export type TaskStatus =
  | "created"
  | "starting"
  | "running"
  | "waiting_approval"
  | "review_ready"
  | "completed"
  | "applied"
  | "branch_ready"
  | "pr_ready"
  | "failed"
  | "cancelled";

export type AgentContextStatus =
  | "live"
  | "restored"
  | "resumed"
  | "new_process"
  | "transcript_fallback"
  | "unknown";

export type BackendKind = "gemini" | "codex" | "claude" | "generic-pty" | "external";

export type AgentCapability =
  | "terminal"
  | "structured_stream"
  | "tool_events"
  | "approval"
  | "diff_events"
  | "resume"
  | "cancel"
  | "worktree"
  | "cost_usage"
  | "external_dashboard"
  | "cloud_pr";

export type AgentFeatureId =
  | "chat"
  | "persistent_session"
  | "slash_commands"
  | "command_execution"
  | "skills"
  | "memory"
  | "modes"
  | "models"
  | "approvals"
  | "checkpoints"
  | "terminal_fallback"
  | "worktree_isolation"
  | "diff_review"
  | "apply_to_repo"
  | "git_branch"
  | "pull_request";

export type CapabilitySupport = "supported" | "partial" | "unsupported" | "planned";

export type CapabilitySource =
  | "backend-native"
  | "acp"
  | "workbench"
  | "terminal"
  | "external";

export interface BackendCapabilityFeature {
  id: AgentFeatureId;
  label: string;
  support: CapabilitySupport;
  source: CapabilitySource;
  description: string;
  limitation?: string;
}

export interface BackendCommandCapability {
  name: string;
  source: CapabilitySource;
  support: CapabilitySupport;
  description: string;
  examples?: string[];
  limitation?: string;
}

export interface BackendSkillCapability {
  name: string;
  source: CapabilitySource;
  support: CapabilitySupport;
  description: string;
  limitation?: string;
}

export interface BackendCapabilityProfile {
  summary: string;
  features: BackendCapabilityFeature[];
  commands: BackendCommandCapability[];
  skills: BackendSkillCapability[];
  recommendedUse: string[];
  limitations: string[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBranch {
  active: boolean;
  checkedOutHere?: boolean;
  checkedOutPath?: string;
  name: string;
  updatedAt?: string;
}

export interface Task {
  id: string;
  projectId: string;
  backendId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  agentSessionId?: string;
  agentSessionKind?: "acp" | "native-cli" | "native-cli-pending";
  agentSessionOrigin?: "imported" | "new";
  agentSessionResumeMode?: "new" | "load" | "resume";
  agentContextStatus?: AgentContextStatus;
  baseBranch?: string;
  modeId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  branches?: SessionBranch[];
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBranch {
  checkedOutHere?: boolean;
  checkedOutPath?: string;
  id: string;
  name: string;
  role: "primary" | "extra";
  applySelected: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackendStatus {
  id: string;
  name: string;
  kind: BackendKind;
  available: boolean;
  capabilities: AgentCapability[];
  profile?: BackendCapabilityProfile;
  version?: string;
  command?: string;
  details?: string;
}

export interface DiffFileSummary {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  insertions: number;
  deletions: number;
}

export interface DiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: DiffFileSummary[];
}

export interface DiffSnapshot {
  id: string;
  taskId: string;
  summary: DiffSummary;
  diffText: string;
  createdAt: string;
}

export interface ApplyConflictFile {
  path: string;
  originalStatus: string;
  sessionStatus: DiffFileSummary["status"];
}

export interface ApplyPreflight {
  canApply: boolean;
  conflictFiles: ApplyConflictFile[];
  overlapFiles: SessionFileOverlap[];
  projectPath: string;
  summary: DiffSummary;
}

export interface SessionSnapshot {
  description?: string;
  id: string;
  taskId: string;
  kind: "manual" | "before_apply" | "rollback";
  label: string;
  patchPath: string;
  summary: DiffSummary;
  createdAt: string;
}

export interface CreateSessionSnapshotRequest {
  description?: string;
  label?: string;
}

export interface UpdateSessionSnapshotRequest {
  description?: string;
  label?: string;
}

export interface RollbackSessionResponse {
  rollbackSnapshot: SessionSnapshot;
  safetySnapshot?: SessionSnapshot;
}

export interface SessionSnapshotPatchResponse {
  patchText: string;
  snapshot: SessionSnapshot;
}

export interface GeminiProjectSession {
  displayName: string;
  fileName: string;
  firstUserMessage: string;
  id: string;
  lastUpdated: string;
  messageCount: number;
  startTime: string;
  summary?: string;
}

export type NativeCliBackendId = "gemini-acp" | "codex" | "claude";

export interface NativeCliProjectSession {
  backendId: NativeCliBackendId;
  backendName: string;
  displayName: string;
  fileName?: string;
  firstUserMessage: string;
  id: string;
  lastUpdated: string;
  messageCount: number;
  startTime: string;
  summary?: string;
}

export interface ImportGeminiSessionRequest {
  modeId?: string;
  sessionId: string;
}

export interface ImportNativeCliSessionRequest {
  backendId: NativeCliBackendId;
  modeId?: string;
  sessionId: string;
}

export interface SessionDiagnostics {
  backend: BackendStatus;
  events: {
    approvalsPending: number;
    errors: number;
    lastEventAt?: string;
    total: number;
  };
  queue: {
    activeTurn: boolean;
    queuedTurns: number;
    pending: Array<{
      position: number;
      prompt: string;
      queuedAt: string;
    }>;
  };
  session: Task;
  worktree: {
    branch?: string;
    changedFiles: string[];
    path?: string;
    status: string;
  };
}

export interface ExportSessionReportResponse {
  markdown: string;
  reportPath: string;
  summary: {
    approvalsPending: number;
    deletions: number;
    errors: number;
    events: number;
    filesChanged: number;
    insertions: number;
    snapshots: number;
  };
}

export type SessionAction =
  | "enqueue"
  | "clear_queue"
  | "resume"
  | "recover"
  | "context"
  | "terminal"
  | "set_mode"
  | "apply"
  | "discard"
  | "repo_add"
  | "repo_commit"
  | "export_patch"
  | "export_report"
  | "snapshot"
  | "rollback"
  | "create_branch"
  | "sync_latest"
  | "push_branch"
  | "create_pr";

export type ApprovalKind =
  | "shell_command"
  | "file_write"
  | "file_delete"
  | "network_access"
  | "credential_access"
  | "git_push"
  | "external_app";

export type ApprovalDecision =
  | "allow_once"
  | "allow_for_task"
  | "deny"
  | "deny_and_stop";

export interface ApprovalRequest {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  risk: "low" | "medium" | "high" | "critical";
  title: string;
  body?: string;
  payload?: unknown;
  createdAt: string;
}

export type AgentEvent =
  | { type: "task.started"; taskId: string; timestamp: string }
  | { type: "user.message"; taskId: string; text: string; timestamp: string }
  | { type: "message.delta"; taskId: string; text: string; timestamp: string }
  | {
      type: "shell.output";
      taskId: string;
      stream: "stdout" | "stderr";
      data: string;
      timestamp: string;
    }
  | {
      type: "tool.started";
      taskId: string;
      toolCallId: string;
      name: string;
      input?: unknown;
      timestamp: string;
    }
  | {
      type: "tool.finished";
      taskId: string;
      toolCallId: string;
      name?: string;
      status: "ok" | "error";
      output?: unknown;
      timestamp: string;
    }
  | {
      type: "approval.requested";
      taskId: string;
      approvalId: string;
      request: ApprovalRequest;
      timestamp: string;
    }
  | {
      type: "approval.resolved";
      taskId: string;
      approvalId: string;
      decision: ApprovalDecision;
      timestamp: string;
    }
  | {
      type: "diff.updated";
      taskId: string;
      summary: DiffSummary;
      timestamp: string;
    }
  | {
      type: "session.action";
      taskId: string;
      action: SessionAction;
      status: "started" | "completed" | "failed";
      title: string;
      details?: string;
      data?: unknown;
      timestamp: string;
    }
  | {
      type: "task.finished";
      taskId: string;
      status: "completed" | "failed" | "cancelled";
      timestamp: string;
      error?: string;
    }
  | {
      type: "turn.finished";
      taskId: string;
      status: "completed" | "failed" | "cancelled";
      stopReason?: string;
      error?: string;
      timestamp: string;
    };

export interface CreateProjectRequest {
  path: string;
}

export interface UpdateProjectRequest {
  name: string;
}

export interface DeleteProjectResponse {
  ok: true;
  projectId: string;
  removedSessions: number;
}

export interface CreateTaskRequest {
  projectId: string;
  title?: string;
  prompt: string;
  backendId?: string;
  baseBranch?: string;
  modeId?: string;
}

export interface CreateSessionRequest {
  projectId: string;
  title?: string;
  backendId?: string;
  baseBranch?: string;
  workingBranch?: string;
  modeId?: string;
  agentSessionId?: string;
}

export interface ProjectBranchListResponse {
  branches: ProjectBranch[];
  currentBranch?: string;
}

export interface SendSessionMessageRequest {
  prompt: string;
}

export interface SetSessionModeRequest {
  modeId: string;
}

export interface RenameSessionRequest {
  title: string;
}

export interface SessionFileContentResponse {
  content: string;
  encoding: "binary" | "utf8";
  kind: "binary" | "image" | "text";
  mimeType: string;
  path: string;
  size: number;
  updatedAt: string;
}

export interface SessionTreeEntry {
  kind: "directory" | "file";
  path: string;
}

export interface DirectoryBrowserEntry {
  gitRepository: boolean;
  hidden: boolean;
  name: string;
  path: string;
}

export interface DirectoryBrowserResponse {
  entries: DirectoryBrowserEntry[];
  gitRepository: boolean;
  parentPath?: string;
  path: string;
}

export interface UpdateSessionFileRequest {
  content: string;
  path: string;
}

export interface CreateSessionDirectoryRequest {
  path: string;
}

export interface UploadSessionImageRequest {
  contentBase64: string;
  fileName?: string;
  mimeType: string;
}

export interface UploadSessionImageResponse {
  mimeType: string;
  path: string;
  reference: string;
  size: number;
}

export interface RespondApprovalRequest {
  taskId: string;
  decision: ApprovalDecision;
}

export type SessionHealth = "ok" | "running" | "attention" | "blocked" | "stuck" | "failed";

export type SessionState = "ready" | "running" | "review" | "needs_action" | "detached" | "failed";

export type SessionRisk = "low" | "medium" | "high";

export type SessionDeliveryKind = "apply" | "add" | "commit" | "patch" | "branch" | "push" | "pr";

export type SessionDeliveryStatus =
  | "none"
  | "started"
  | "applied"
  | "patch_exported"
  | "branch_ready"
  | "pushed"
  | "pr_ready"
  | "compare_ready"
  | "failed";

export interface SessionDeliverySummary {
  branch?: string;
  commitSha?: string;
  compareUrl?: string;
  kind?: SessionDeliveryKind;
  message?: string;
  patchPath?: string;
  projectPath?: string;
  status: SessionDeliveryStatus;
  timestamp?: string;
  title: string;
  url?: string;
}

export interface SessionFileOverlap {
  path: string;
  sessions: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
  }>;
}

export interface SessionOverview {
  agentName: string;
  applied: boolean;
  activeTurn: boolean;
  branchReady: boolean;
  conflictFiles: string[];
  currentStep: string;
  health: SessionHealth;
  healthReason: string;
  idleMs: number;
  lastAgentMessage?: string;
  lastError?: string;
  filesChanged: number;
  insertions: number;
  lastEventAt?: string;
  latestDelivery: SessionDeliverySummary;
  nextAction: string;
  overlapFiles: SessionFileOverlap[];
  prReady: boolean;
  projectName: string;
  projectPath: string;
  queuedTurns: number;
  risk: SessionRisk;
  riskReasons: string[];
  runtimeMs: number;
  snapshotCount: number;
  stage: "running" | "terminal" | "approval" | "review" | "conflict" | "applied" | "branch" | "pr" | "failed" | "idle";
  state: SessionState;
  stateReason: string;
  stuck: boolean;
  task: Task;
  terminal?: {
    command?: string;
    exitCode?: number;
    lastEventAt?: string;
    status: "running" | "exited";
  };
  touchedFiles: string[];
  waitingApprovals: number;
}

export interface ApplySessionResponse {
  alreadyApplied?: boolean;
  preflight?: ApplyPreflight;
  task: Task;
  projectPath: string;
  summary: DiffSummary;
}

export interface ApplySessionRequest {
  expectedOriginalBranch?: string;
  expectedOriginalHead?: string;
  targetBranch?: string;
}

export interface ApplyTargetResponse {
  branches: ProjectBranch[];
  originalBranch?: string;
  originalHead: string;
  projectPath: string;
  worktreePath?: string;
}

export interface ExportPatchResponse {
  diffText: string;
  patchPath: string;
  summary: DiffSummary;
}

export interface CreateBranchRequest {
  commitMessage?: string;
  remote?: string;
}

export interface CommitProjectRequest {
  message: string;
}

export interface AddProjectChangesRequest {
  files: string[];
}

export interface ProjectStatusFile {
  path: string;
  status: string;
}

export interface DeliveryTargetResponse {
  currentBranch?: string;
  currentHead: string;
  files: ProjectStatusFile[];
  projectPath: string;
  remotes: string[];
  status: string;
}

export interface ProjectDeliveryResponse {
  branch?: string;
  commitSha?: string;
  files?: ProjectStatusFile[];
  message?: string;
  projectPath: string;
  remote?: string;
  status: string;
  task: Task;
}

export interface CreateSessionBranchRequest {
  name?: string;
}

export interface UpdateSessionBranchRequest {
  applySelected?: boolean;
  name?: string;
}

export interface SessionBranchListResponse {
  branches: SessionBranch[];
  task: Task;
}

export interface SyncSessionToLatestResponse {
  branch: string;
  head: string;
  originalBranch?: string;
  task: Task;
}

export interface CreateBranchResponse {
  branch: string;
  commitSha?: string;
  summary: DiffSummary;
  task: Task;
}

export interface PushBranchResponse {
  branch: string;
  commitSha?: string;
  remote?: string;
  summary: DiffSummary;
  task: Task;
}

export interface CreatePullRequestRequest {
  body?: string;
  commitMessage?: string;
  draft?: boolean;
  remote?: string;
  title?: string;
}

export interface CreatePullRequestResponse {
  branch: string;
  commitSha?: string;
  compareUrl?: string;
  created: boolean;
  message?: string;
  patchPath?: string;
  pushed?: boolean;
  remote?: string;
  task: Task;
  url?: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

export interface HealthResponse {
  ok: true;
  version: string;
  storagePath: string;
}

export interface SystemDoctorCheck {
  details?: string;
  name: string;
  ok: boolean;
  output: string;
}

export interface SystemDoctorResponse {
  checks: SystemDoctorCheck[];
  host: string;
  port: number;
  storage: {
    backupExists: boolean;
    exists: boolean;
    lastRecovery?: {
      at: string;
      source: "backup" | "primary_trailing_data";
    };
    path: string;
  };
  warnings: string[];
}

export interface RuntimeConfigResponse {
  backendCommands: Array<{
    command: string;
    envVar?: string;
    id: string;
    label: string;
  }>;
  host: string;
  port: number;
  security: {
    allInterfaces: boolean;
    tokenSource: "environment" | "generated";
  };
  storage: {
    path: string;
    type: "json" | "sqlite";
  };
  terminal: {
    command: string;
  };
  worktrees: {
    root: string;
  };
}

export interface SlashCommandInfo {
  aliases: string[];
  description: string;
  name: string;
  requiresSession: boolean;
  source: CapabilitySource;
  usage: string;
}

export interface TerminalStatusMessage {
  cols?: number;
  command?: string;
  cwd?: string;
  exitCode?: number;
  rows?: number;
  status: "starting" | "running" | "exited" | "error";
}

export interface ServerMessage {
  type: "event" | "task.updated" | "backend.updated" | "terminal.output" | "terminal.status" | "shell.output" | "shell.status";
  event?: AgentEvent;
  task?: Task;
  backend?: BackendStatus;
  taskId?: string;
  terminal?: TerminalStatusMessage;
  data?: string;
}

export interface ClientMessage {
  type:
    | "subscribe.task"
    | "approval.respond"
    | "terminal.open"
    | "terminal.restart"
    | "terminal.clear"
    | "terminal.input"
    | "terminal.resize"
    | "terminal.stop"
    | "shell.open"
    | "shell.restart"
    | "shell.clear"
    | "shell.input"
    | "shell.resize"
    | "shell.stop";
  taskId?: string;
  approvalId?: string;
  decision?: ApprovalDecision;
  command?: string;
  data?: string;
  cols?: number;
  rows?: number;
}
