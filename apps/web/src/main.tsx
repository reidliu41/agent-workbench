import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  AgentFeatureId,
  ApplyPreflight,
  ApplySessionResponse,
  ApplyTargetResponse,
  ApprovalDecision,
  ApprovalRequest,
  BackendCapabilityFeature,
  BackendStatus,
  CreateSessionSnapshotRequest,
  DeleteProjectResponse,
  DiffSummary,
  CreateBranchResponse,
  CreatePullRequestResponse,
  CreateSessionDirectoryRequest,
  DirectoryBrowserResponse,
  DeliveryTargetResponse,
  DiffSnapshot,
  ExportSessionReportResponse,
  ExportPatchResponse,
  NativeCliBackendId,
  NativeCliProjectSession,
  Project,
  ProjectBranchListResponse,
  ProjectDeliveryResponse,
  ProjectStatusFile,
  PushBranchResponse,
  RollbackSessionResponse,
  SessionAction,
  SessionDiagnostics,
  SessionFileContentResponse,
  SessionOverview,
  SessionSnapshot,
  SessionSnapshotPatchResponse,
  SessionTreeEntry,
  ServerMessage,
  SyncSessionToLatestResponse,
  RuntimeConfigResponse,
  SessionBranch,
  SessionBranchListResponse,
  SessionState,
  SlashCommandInfo,
  SystemDoctorResponse,
  Task,
  TaskStatus,
  UpdateSessionFileRequest,
  UpdateSessionSnapshotRequest,
} from "@agent-workbench/protocol";
import "./styles.css";

const TerminalPanel = React.lazy(() => import("./TerminalPanel"));
const ProjectShellPanel = React.lazy(() => import("./ProjectShellPanel"));

const token = getToken();
const initialSessionId = getInitialSessionId();
const popoutView = new URL(window.location.href).searchParams.get("popout") === "1";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "agent-workbench-sidebar-collapsed";
const SIDEBAR_WIDTH_STORAGE_KEY = "agent-workbench-sidebar-width";
const SESSION_TERMINAL_WIDTH_STORAGE_KEY = "agent-workbench-session-terminal-width";
const FEED_STORAGE_KEYS = {
  attention: feedStorageKey("Attention feed"),
  ship: feedStorageKey("Ship feed"),
} as const;
const SHOW_EXPERIMENTAL_QUEUE_UI = false;
const modeOptions = [
  { id: "default", label: "Default" },
  { id: "plan", label: "Plan" },
  { id: "autoEdit", label: "Auto Edit" },
  { id: "yolo", label: "YOLO" },
] as const;
type SessionUiAction = SessionAction | "apply_force" | "copy_worktree" | "diagnostics" | "cancel";
type DiffPanelAction = "apply" | "apply_force" | "branch_manager" | "delivery" | "repo_add" | "repo_commit" | "export_patch" | "export_report" | "copy_worktree" | "create_branch" | "sync_latest" | "push_branch" | "create_pr" | "resume" | "clear_queue" | "snapshot" | "rollback" | "diagnostics" | "cancel";
type ConfirmableAction = "apply" | "sync_latest" | "push_branch" | "create_pr";
type OverviewRowAction = "apply" | "cancel" | "clear_queue" | "create_branch" | "snapshot" | "rollback" | "discard";
type OverviewFilter = "all" | "needs_action" | "running" | "review" | "blocked" | "overlap";
type OverviewSort = "priority" | "recent" | "project";
type OverviewGroupId = "attention" | "quiet" | "ready" | "running";
type SessionWorkspaceTab = "changes" | "work" | "snapshots" | "debug" | "shell";
const nativeSessionBackendOptions: Array<{ id: NativeCliBackendId; label: string; placeholder: string }> = [
  { id: "gemini-acp", label: "Gemini CLI", placeholder: "7488de20-aa48-4775-a09f-79e2738cec80" },
  { id: "codex", label: "OpenAI Codex", placeholder: "codex resume id" },
  { id: "claude", label: "Claude Code", placeholder: "b7cd7ff9-6fbe-483b-947b-b74daafc4936" },
];

interface PendingConfirmation {
  action: ConfirmableAction;
  applyTarget?: ApplyTargetResponse;
  task: Task;
}

interface SessionOpenIntent {
  tab?: SessionWorkspaceTab;
  taskId: string;
}

interface NewSessionDraft {
  backendId: string;
  branchName: string;
  modeId: string;
  projectId: string;
  title: string;
}

interface NativeSessionDialogState {
  project: Project;
  sessions: NativeCliProjectSession[];
}

interface LinkedNativeSessionState {
  current: boolean;
  task: Task;
}

interface ConflictState {
  preflight: ApplyPreflight;
  task: Task;
}

type DeliveryKind = "apply" | "add" | "commit" | "patch" | "branch" | "push" | "pr";

interface DeliveryItem {
  branch?: string;
  commitSha?: string;
  compareUrl?: string;
  created?: boolean;
  details?: string;
  kind: DeliveryKind;
  message?: string;
  patchPath?: string;
  projectPath?: string;
  pushed?: boolean;
  status: "started" | "completed" | "failed";
  summary?: DiffSummary;
  timestamp: string;
  title: string;
  url?: string;
}

interface DeliveryActionInput {
  commitMessage?: string;
  files?: string[];
  remote?: string;
  targetBranch?: string;
}

interface ContextDecision {
  attached?: boolean;
  reason?: string;
  status: "attached" | "skipped" | "failed" | "unknown";
  timestamp?: string;
  title: string;
  details?: string;
}

function getToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    window.localStorage.setItem("agent-workbench-token", fromUrl);
    return fromUrl;
  }
  return window.localStorage.getItem("agent-workbench-token") ?? "dev-token";
}

function getInitialSessionId(): string | undefined {
  const value = new URL(window.location.href).searchParams.get("session");
  return value || undefined;
}

function feedStorageKey(title: string): string {
  return `agent-workbench-feed-state:${title.toLowerCase().replace(/\s+/g, "-")}`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, {
      ...init,
      headers,
    });
  } catch (error) {
    throw new Error(networkErrorMessage(error));
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorMessageFromResponse(text, response.statusText));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function networkErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Cannot reach the Agent Workbench server.",
    "",
    "The web page is loaded, but the API request failed before the server responded. If you are using SSH port forwarding, this usually means the Workbench process stopped or the forwarded port is pointing at the wrong host/port.",
    "",
    "Restart with `npm run serve -- --host 0.0.0.0 --port 3031`, then reload this page.",
    message ? `Browser error: ${message}` : undefined,
  ].filter(Boolean).join("\n");
}

function errorMessageFromResponse(text: string, fallback: string): string {
  if (!text.trim()) {
    return fallback;
  }

  try {
    const payload = JSON.parse(text) as { error?: unknown; hint?: unknown; message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) {
      return typeof payload.hint === "string" && payload.hint.trim()
        ? `${payload.message}\n\n${payload.hint}`
        : payload.message;
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    return text;
  }

  return text;
}

function sessionFileRawUrl(taskId: string, path: string): string {
  return `/api/sessions/${encodeURIComponent(taskId)}/files/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
}

function readStoredBoolean(key: string, fallback = false): boolean {
  const value = window.localStorage.getItem(key);
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return fallback;
}

function readStoredNumber(key: string, fallback: number): number {
  const value = window.localStorage.getItem(key);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function useDismissibleMenu<T extends HTMLElement>(open: boolean, onClose: () => void): React.RefObject<T | null> {
  const rootRef = useRef<T | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && rootRef.current && !rootRef.current.contains(target)) {
        onClose();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open, onClose]);

  return rootRef;
}

function prNotice(result: CreatePullRequestResponse): string {
  if (result.created) {
    return `Draft PR created: ${result.url ?? "created"}`;
  }
  return [
    result.message ?? (result.pushed ? "Branch pushed. Open the compare URL to create the PR." : "Local branch is ready, but it was not pushed."),
    result.compareUrl ? `Compare: ${result.compareUrl}` : undefined,
    result.patchPath ? `Patch: ${result.patchPath}` : undefined,
  ].filter(Boolean).join("\n");
}

function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [overviews, setOverviews] = useState<SessionOverview[]>([]);
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [nativeSlashCommands, setNativeSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [activeView, setActiveView] = useState<"overview" | "session" | "settings">("session");
  const selectedTaskIdRef = useRef<string | undefined>(undefined);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const eventListRef = useRef<HTMLDivElement>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [diff, setDiff] = useState<DiffSnapshot>();
  const [projectPath, setProjectPath] = useState("");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [selectedBackendId, setSelectedBackendId] = useState("gemini-acp");
  const [selectedModeId, setSelectedModeId] = useState("default");
  const [newSessionDraft, setNewSessionDraft] = useState<NewSessionDraft>();
  const [sessionTab, setSessionTab] = useState<SessionWorkspaceTab>("changes");
  const [sessionSearch, setSessionSearch] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Task>();
  const [pendingProjectDelete, setPendingProjectDelete] = useState<Project>();
  const [branchManagerTask, setBranchManagerTask] = useState<Task>();
  const [deliveryTask, setDeliveryTask] = useState<Task>();
  const [renameDraft, setRenameDraft] = useState<Task>();
  const [renameTitle, setRenameTitle] = useState("");
  const [projectRenameDraft, setProjectRenameDraft] = useState<Project>();
  const [projectRenameName, setProjectRenameName] = useState("");
  const [nativeSessionDialog, setNativeSessionDialog] = useState<NativeSessionDialogState>();
  const [nativeSessionLoading, setNativeSessionLoading] = useState(false);
  const [nativeSessionImportingKey, setNativeSessionImportingKey] = useState<string>();
  const [applyConflict, setApplyConflict] = useState<ConflictState>();
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>();
  const [sessionDiagnostics, setSessionDiagnostics] = useState<SessionDiagnostics>();
  const [systemDoctor, setSystemDoctor] = useState<SystemDoctorResponse>();
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigResponse>();
  const [snapshots, setSnapshots] = useState<SessionSnapshot[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isProjectDeleting, setIsProjectDeleting] = useState(false);
  const [isProjectRenaming, setIsProjectRenaming] = useState(false);
  const [isDoctorRunning, setIsDoctorRunning] = useState(false);
  const [busyAction, setBusyAction] = useState<SessionUiAction>();
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string>();
  const [sessionToolsMenuOpen, setSessionToolsMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [pendingApprovals, setPendingApprovals] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [draggingPopoutTaskId, setDraggingPopoutTaskId] = useState<string>();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY));
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber(SIDEBAR_WIDTH_STORAGE_KEY, 340));
  const [sessionTerminalWidth, setSessionTerminalWidth] = useState(() => readStoredNumber(SESSION_TERMINAL_WIDTH_STORAGE_KEY, 640));
  const [projectedTerminalTaskId, setProjectedTerminalTaskId] = useState<string>();
  const [terminalProjectionLines, setTerminalProjectionLines] = useState<string[]>([]);
  const appShellRef = useRef<HTMLElement>(null);
  const sidebarDragSuppressedClickRef = useRef(false);
  const sessionDragSuppressedClickRef = useRef(false);
  const sessionWorkspaceRef = useRef<HTMLDivElement>(null);
  const sessionToolsMenuRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SESSION_TERMINAL_WIDTH_STORAGE_KEY, String(sessionTerminalWidth));
  }, [sessionTerminalWidth]);

  useEffect(() => {
    if (projectedTerminalTaskId && projectedTerminalTaskId !== selectedTaskId) {
      setProjectedTerminalTaskId(undefined);
    }
  }, [projectedTerminalTaskId, selectedTaskId]);

  useEffect(() => {
    setTerminalProjectionLines([]);
  }, [selectedTaskId]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timeout = window.setTimeout(() => setNotice(undefined), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!sessionToolsMenuOpen && !openSessionMenuId) {
      return;
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (sessionToolsMenuOpen && !sessionToolsMenuRootRef.current?.contains(target)) {
        setSessionToolsMenuOpen(false);
      }

      if (openSessionMenuId) {
        const element = target instanceof Element ? target : target.parentElement;
        const menuRoot = element?.closest("[data-session-menu-id]");
        if (menuRoot?.getAttribute("data-session-menu-id") !== openSessionMenuId) {
          setOpenSessionMenuId(undefined);
        }
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [openSessionMenuId, sessionToolsMenuOpen]);

  const selectedTask = useMemo(() => tasks.find((task) => task.id === selectedTaskId), [selectedTaskId, tasks]);
  const visibleEvents = useMemo(() => compactMessageDeltas(events), [events]);
  const workTimelineEvents = useMemo(() => defaultTimelineEvents(visibleEvents), [visibleEvents]);
  const deliveryItems = useMemo(() => summarizeDelivery(events), [events]);
  const approvalStates = useMemo(() => approvalStateById(events), [events]);
  const diffFiles = useMemo(() => parseUnifiedDiff(diff?.diffText ?? ""), [diff]);
  const sessionBackends = useMemo(() => sessionCapableBackends(backends), [backends]);
  const visibleTasks = useMemo(() => filterSessions(tasks, sessionSearch, backends), [backends, sessionSearch, tasks]);
  const activeProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0],
    [projects, selectedProjectId],
  );
  const selectedTaskProject = useMemo(
    () => projects.find((project) => project.id === selectedTask?.projectId),
    [projects, selectedTask],
  );
  const selectedOverview = useMemo(
    () => overviews.find((overview) => overview.task.id === selectedTaskId),
    [overviews, selectedTaskId],
  );
  const overviewByTaskId = useMemo(() => new Map(overviews.map((overview) => [overview.task.id, overview])), [overviews]);
  const displayProject = selectedTaskProject ?? activeProject;
  const selectedBackendStatus = useMemo(
    () => backends.find((backend) => backend.id === (selectedTask?.backendId ?? selectedBackendId)),
    [backends, selectedBackendId, selectedTask?.backendId],
  );
  const selectedTaskBackend = selectedTask ? backendLabel(backends, selectedTask.backendId) : undefined;
  const terminalProjected = Boolean(selectedTask && projectedTerminalTaskId === selectedTask.id);
  const availableCommands = useMemo(() => mergeAvailableCommands(nativeSlashCommands, availableCommandsFromEvents(events)), [events, nativeSlashCommands]);
  const acpCommands = useMemo(() => availableCommandsFromEvents(events), [events]);
  const slashMatches = useMemo(() => commandMatches(prompt, availableCommands), [prompt, availableCommands]);
  const selectedTaskRunning = isTaskRunning(selectedTask);

  useEffect(() => {
    if (sessionTab === "work" || sessionTab === "changes" || sessionTab === "snapshots" || sessionTab === "debug" || sessionTab === "shell") {
      return;
    }
    setSessionTab("changes");
  }, [sessionTab]);

  useEffect(() => {
    void refreshAll();
  }, []);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
  }, [selectedTaskId]);

  useEffect(() => {
    if (selectedTask?.modeId) {
      setSelectedModeId(selectedTask.modeId);
    }
  }, [selectedTask?.modeId]);

  useEffect(() => {
    if (snapshots.length === 0) {
      setSelectedSnapshotId(undefined);
      return;
    }
    if (!selectedSnapshotId || !snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
      setSelectedSnapshotId(snapshots.at(-1)?.id);
    }
  }, [selectedSnapshotId, snapshots]);

  useEffect(() => {
    if (activeView !== "session" && !popoutView) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const list = eventListRef.current;
      if (list) {
        list.scrollTop = list.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, selectedTaskId, sessionTab, workTimelineEvents.length, visibleEvents.length]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);

    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(message.data as string) as ServerMessage | { type: string };
      if (parsed.type === "event" && "event" in parsed && parsed.event) {
        const event = parsed.event as AgentEvent;
        if (event.taskId === selectedTaskIdRef.current) {
          setEvents((current) => [...current, event]);
        }
        if (event.type === "diff.updated" && event.taskId === selectedTaskIdRef.current) {
          void loadDiff(event.taskId);
        }
        void loadOverviews();
      }
      if (parsed.type === "task.updated" && "task" in parsed && parsed.task) {
        setTasks((current) => upsert(current, parsed.task as Task));
        void loadOverviews();
      }
      if (parsed.type === "backend.updated" && "backend" in parsed && parsed.backend) {
        setBackends((current) => upsert(current, parsed.backend as BackendStatus));
      }
    });

    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setEvents([]);
      setDiff(undefined);
      return;
    }
    void api<AgentEvent[]>(`/api/tasks/${selectedTaskId}/events`)
      .then(setEvents)
      .catch((err: unknown) => setError(String(err)));
    void loadDiff(selectedTaskId);
    void api<SessionSnapshot[]>(`/api/sessions/${selectedTaskId}/snapshots`)
      .then(setSnapshots)
      .catch(() => setSnapshots([]));
  }, [selectedTaskId]);

  async function loadDiff(taskId: string): Promise<void> {
    await api<DiffSnapshot | undefined>(`/api/tasks/${taskId}/diff`)
      .then(setDiff)
      .catch(() => setDiff(undefined));
  }

  async function refreshSessionWorkspace(taskId: string): Promise<void> {
    await Promise.all([loadDiff(taskId), loadOverviews()]);
  }

  function openSessionIntent(intent: SessionOpenIntent): void {
    setSelectedTaskId(intent.taskId);
    setActiveView("session");
    setSessionToolsMenuOpen(false);
    if (intent.tab) {
      setSessionTab(intent.tab);
    }
  }

  async function loadOverviews(): Promise<void> {
    await api<SessionOverview[]>("/api/sessions/overview")
      .then(setOverviews)
      .catch(() => setOverviews([]));
  }

  async function refreshAll(): Promise<void> {
    try {
      const [projectList, taskList, backendList, commandList] = await Promise.all([
        api<Project[]>("/api/projects"),
        api<Task[]>("/api/tasks"),
        api<BackendStatus[]>("/api/backends"),
        api<SlashCommandInfo[]>("/api/slash-commands"),
      ]);
      setProjects(projectList);
      setTasks(taskList);
      setBackends(backendList);
      setNativeSlashCommands(commandList);
      setSelectedProjectId((current) => current ?? projectList[0]?.id);
      setSelectedTaskId((current) => current ?? initialSessionId ?? taskList[0]?.id);
      setSelectedBackendId((current) => {
        const availableSessionBackends = sessionCapableBackends(backendList);
        if (availableSessionBackends.some((backend) => backend.id === current)) {
          return current;
        }
        return availableSessionBackends.find((backend) => backend.id === "gemini-acp")?.id ?? availableSessionBackends[0]?.id ?? "gemini-acp";
      });
      void loadOverviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function addProject(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    setError(undefined);
    try {
      const project = await api<Project>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path: projectPath }),
      });
      setProjects((current) => upsert(current, project));
      setSelectedProjectId(project.id);
      setProjectPath("");
      setProjectDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openNewSessionDialog(): void {
    if (!activeProject) {
      setError("Add a git repository first.");
      return;
    }
    setError(undefined);
    setSessionToolsMenuOpen(false);
    setNewSessionDraft({
      backendId: selectedBackendId,
      branchName: nextWorkingBranchName(tasks, activeProject.id),
      modeId: selectedModeId,
      projectId: activeProject.id,
      title: nextSessionTitle(tasks, activeProject.id),
    });
  }

  async function createNewSession(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    if (!activeProject && projects.length === 0) {
      setError("Add a git repository first.");
      return;
    }
    const draft = newSessionDraft ?? {
      backendId: selectedBackendId,
      branchName: nextWorkingBranchName(tasks, activeProject?.id ?? projects[0]?.id ?? ""),
      modeId: selectedModeId,
      projectId: activeProject?.id ?? projects[0]?.id ?? "",
      title: nextSessionTitle(tasks, activeProject?.id ?? projects[0]?.id ?? ""),
    };
    const project = projects.find((item) => item.id === draft.projectId);
    if (!project) {
      setError("Select a project before creating a session.");
      return;
    }
    const title = uniqueSessionTitle(tasks, project.id, draft.title);
    setError(undefined);
    setNotice(undefined);
    try {
      const created = await api<Task>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          projectId: project.id,
          title,
          backendId: draft.backendId,
          workingBranch: draft.branchName.trim(),
          modeId: draft.modeId,
        }),
      });
      setTasks((current) => upsert(current, created));
      selectedTaskIdRef.current = created.id;
      setSelectedTaskId(created.id);
      setSelectedProjectId(project.id);
      setActiveView("session");
      setSelectedBackendId(draft.backendId);
      setSelectedModeId(draft.modeId);
      setNewSessionDraft(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitComposer(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (isSending) {
      return;
    }
    const message = prompt.trim();
    if (!message) {
      setError("Enter a message first.");
      return;
    }
    const slashError = slashCommandError(message, availableCommands, selectedBackendStatus);
    if (slashError) {
      setError(slashError);
      return;
    }
    setError(undefined);
    setPrompt("");
    setIsSending(true);
    try {
      let session = selectedTask;
      const requiresNewSession = !session;
      if (requiresNewSession) {
        const project = activeProject;
        if (!project) {
          setPrompt((current) => current || message);
          setError("Add a git repository first.");
          return;
        }
        const created = await api<Task>("/api/sessions", {
          method: "POST",
          body: JSON.stringify({
            projectId: project.id,
            title: nextSessionTitle(tasks, project.id),
            backendId: selectedBackendId,
            modeId: selectedModeId,
          }),
        });
        session = created;
        setTasks((current) => upsert(current, created));
        selectedTaskIdRef.current = session.id;
        setSelectedTaskId(session.id);
        setActiveView("session");
        if (session.status === "failed") {
          setPrompt((current) => current || message);
          return;
        }
      }
      if (!session) {
        setPrompt((current) => current || message);
        setError("No session is available.");
        return;
      }

      const updated = await api<Task>(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          prompt: message,
        }),
      });
      setTasks((current) => upsert(current, updated));
      await loadDiff(session.id);
    } catch (err) {
      setPrompt((current) => current || message);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
    }
  }

  async function confirmDeleteSession(): Promise<void> {
    const task = pendingDelete;
    if (!task || isDeleting) {
      return;
    }
    setError(undefined);
    setNotice(undefined);
    setIsDeleting(true);
    setBusyAction("discard");
    try {
      await api<{ ok: true }>(`/api/sessions/${task.id}/discard`, { method: "POST" });
      const remaining = tasks.filter((item) => item.id !== task.id);
      setTasks(remaining);
      setOverviews((current) => current.filter((overview) => overview.task.id !== task.id));
      if (selectedTaskId === task.id) {
        const nextId = remaining[0]?.id;
        selectedTaskIdRef.current = nextId;
        setSelectedTaskId(nextId);
      }
      setNotice(`Removed session: ${task.title}`);
      setPendingDelete(undefined);
      await loadOverviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeleting(false);
      setBusyAction(undefined);
    }
  }

  function openProjectManageDialog(project: Project): void {
    setProjectRenameDraft(project);
    setProjectRenameName(project.name);
  }

  async function renameProject(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    const project = projectRenameDraft;
    const name = projectRenameName.trim();
    if (!project || isProjectRenaming) {
      return;
    }
    if (!name) {
      setError("Project name cannot be empty.");
      return;
    }
    setError(undefined);
    setNotice(undefined);
    setIsProjectRenaming(true);
    try {
      const updated = await api<Project>(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      setProjects((current) => upsert(current, updated));
      setNotice(`Renamed project: ${updated.name}`);
      setProjectRenameDraft(undefined);
      setProjectRenameName("");
      await loadOverviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProjectRenaming(false);
    }
  }

  async function confirmDeleteProject(): Promise<void> {
    const project = pendingProjectDelete;
    if (!project || isProjectDeleting) {
      return;
    }
    setError(undefined);
    setNotice(undefined);
    setIsProjectDeleting(true);
    try {
      const result = await api<DeleteProjectResponse>(`/api/projects/${project.id}`, { method: "DELETE" });
      const remainingProjects = projects.filter((item) => item.id !== project.id);
      const remainingTasks = tasks.filter((task) => task.projectId !== project.id);
      setProjects(remainingProjects);
      setTasks(remainingTasks);
      setOverviews((current) => current.filter((overview) => overview.task.projectId !== project.id));
      if (selectedProjectId === project.id) {
        setSelectedProjectId(remainingProjects[0]?.id);
      }
      if (selectedTaskId && tasks.find((task) => task.id === selectedTaskId)?.projectId === project.id) {
        const nextId = remainingTasks[0]?.id;
        selectedTaskIdRef.current = nextId;
        setSelectedTaskId(nextId);
        if (!nextId) {
          setEvents([]);
          setDiff(undefined);
          setSnapshots([]);
          setSelectedSnapshotId(undefined);
        }
      }
      setNotice(`Removed project: ${project.name}. Removed ${result.removedSessions} session${result.removedSessions === 1 ? "" : "s"}.`);
      setPendingProjectDelete(undefined);
      await loadOverviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProjectDeleting(false);
    }
  }

  function openRenameDialog(task: Task): void {
    setOpenSessionMenuId(undefined);
    setRenameDraft(task);
    setRenameTitle(task.title);
  }

  async function renameSession(event?: React.FormEvent): Promise<void> {
    event?.preventDefault();
    const task = renameDraft;
    const title = renameTitle.trim();
    if (!task || isRenaming) {
      return;
    }
    if (!title) {
      setError("Session title cannot be empty.");
      return;
    }
    setError(undefined);
    setNotice(undefined);
    setIsRenaming(true);
    try {
      const updated = await api<Task>(`/api/sessions/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setTasks((current) => upsert(current, updated));
      setNotice(`Renamed session: ${updated.title}`);
      setRenameDraft(undefined);
      setRenameTitle("");
      await loadOverviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRenaming(false);
    }
  }

  async function runSystemDoctor(): Promise<void> {
    setError(undefined);
    setIsDoctorRunning(true);
    try {
      setSystemDoctor(await api<SystemDoctorResponse>("/api/system/doctor"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDoctorRunning(false);
    }
  }

  async function loadRuntimeConfig(): Promise<void> {
    setError(undefined);
    try {
      setRuntimeConfig(await api<RuntimeConfigResponse>("/api/runtime/config"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmSessionAction(input: DeliveryActionInput = {}): Promise<void> {
    const confirmation = pendingConfirmation;
    if (!confirmation) {
      return;
    }
    setPendingConfirmation(undefined);
    await performSessionAction(confirmation.action, confirmation.task, confirmation.applyTarget, input);
  }

  async function openSessionActionConfirmation(action: ConfirmableAction, task: Task): Promise<void> {
    if (action !== "apply" && action !== "sync_latest") {
      setPendingConfirmation({ action, task });
      return;
    }

    setError(undefined);
    try {
      const applyTarget = await api<ApplyTargetResponse>(`/api/sessions/${task.id}/apply-target`);
      setPendingConfirmation({ action, applyTarget, task });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function openPopoutSession(task: Task): void {
    setOpenSessionMenuId(undefined);
    window.open(`/?token=${encodeURIComponent(token)}&session=${encodeURIComponent(task.id)}&popout=1`, "_blank", "noopener,noreferrer");
  }

  function beginSessionPopoutDrag(event: React.MouseEvent<HTMLButtonElement>, task: Task): void {
    if (event.button !== 0) {
      return;
    }

    const startX = event.clientX;
    const startY = event.clientY;
    let didPopout = false;
    let moved = false;
    const threshold = 90;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (distance < threshold) {
        return;
      }
      moved = true;
      setDraggingPopoutTaskId(task.id);
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      setDraggingPopoutTaskId(undefined);
      const distance = Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY);
      if (moved || distance >= threshold) {
        didPopout = true;
        sessionDragSuppressedClickRef.current = true;
        openPopoutSession(task);
      }
      if (!didPopout) {
        sessionDragSuppressedClickRef.current = false;
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  async function openNativeSessionDialog(projectId: string): Promise<void> {
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      setError("Project not found.");
      return;
    }
    setOpenSessionMenuId(undefined);
    setSessionToolsMenuOpen(false);
    setError(undefined);
    setNativeSessionLoading(true);
    try {
      const sessions = await api<NativeCliProjectSession[]>(`/api/projects/${project.id}/native-sessions`);
      setNativeSessionDialog({ project, sessions });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNativeSessionLoading(false);
    }
  }

  async function importNativeSession(projectId: string, backendId: NativeCliBackendId, sessionId: string): Promise<void> {
    const linked = linkedNativeTaskForSession(tasks, projectId, backendId, sessionId, selectedTaskId);
    if (linked) {
      selectedTaskIdRef.current = linked.task.id;
      setSelectedTaskId(linked.task.id);
      setActiveView("session");
      setSessionTab("changes");
      setNativeSessionDialog(undefined);
      setSelectedBackendId(backendId);
      setNotice(linked.current ? `Native CLI session is already open: ${linked.task.title}` : `Opened linked native CLI session: ${linked.task.title}`);
      return;
    }
    const importingKey = nativeSessionKey(backendId, sessionId);
    setError(undefined);
    setNotice(undefined);
    setNativeSessionImportingKey(importingKey);
    try {
      const created = await api<Task>(`/api/projects/${projectId}/native-sessions/import`, {
        method: "POST",
        body: JSON.stringify({
          backendId,
          modeId: selectedModeId,
          sessionId,
        }),
      });
      setTasks((current) => upsert(current, created));
      selectedTaskIdRef.current = created.id;
      setSelectedTaskId(created.id);
      setActiveView("session");
      setSelectedBackendId(backendId);
      setSessionTab("changes");
      setNativeSessionDialog(undefined);
      setNotice(`Imported native CLI session: ${created.title}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNativeSessionImportingKey(undefined);
    }
  }

  async function createSnapshot(task: Task, input?: CreateSessionSnapshotRequest): Promise<SessionSnapshot> {
    const snapshot = await api<SessionSnapshot>(`/api/sessions/${task.id}/snapshots`, {
      method: "POST",
      body: JSON.stringify({
        description: input?.description,
        label: input?.label,
      }),
    });
    setSnapshots((current) => [...current, snapshot]);
    setSelectedSnapshotId(snapshot.id);
    setNotice(`Snapshot saved: ${snapshot.label}`);
    return snapshot;
  }

  async function performSessionAction(action: SessionUiAction, targetTask?: Task, applyTarget?: ApplyTargetResponse, input: DeliveryActionInput = {}): Promise<void> {
    const task = targetTask ?? selectedTask;
    if (!task) {
      setError("Select a session first.");
      return;
    }
    selectedTaskIdRef.current = task.id;
    setSelectedTaskId(task.id);
    setError(undefined);
    setNotice(undefined);
    setBusyAction(action);
    try {
      if (action === "copy_worktree") {
        if (!task.worktreePath) {
          throw new Error("This session has no worktree path.");
        }
        await copyText(task.worktreePath);
        setNotice(`Copied worktree path: ${task.worktreePath}`);
        return;
      }

      if (action === "resume") {
        const updated = await api<Task>(`/api/sessions/${task.id}/resume`, { method: "POST" });
        setTasks((current) => upsert(current, updated));
        setNotice("Reconnect started. Watch the timeline for completion.");
        return;
      }

      if (action === "cancel") {
        const updated = await api<Task>(`/api/sessions/${task.id}/cancel`, { method: "POST" });
        setTasks((current) => upsert(current, updated));
        await loadOverviews();
        setNotice("Stop requested. Background output and queued messages from this session will no longer update the result.");
        return;
      }

      if (action === "clear_queue") {
        const result = await api<{ cleared: number; queuedTurns: number; task: Task }>(`/api/sessions/${task.id}/queue/clear`, { method: "POST" });
        setTasks((current) => upsert(current, result.task));
        await loadOverviews();
        setNotice(result.cleared > 0 ? `Cleared ${result.cleared} queued message${result.cleared === 1 ? "" : "s"}.` : "No queued messages to clear.");
        return;
      }

      if (action === "apply") {
        const targetBranch = input.targetBranch?.trim() || applyTarget?.originalBranch;
        const result = await api<ApplySessionResponse>(`/api/sessions/${task.id}/apply`, {
          method: "POST",
          body: JSON.stringify({
            expectedOriginalBranch: applyTarget?.originalBranch,
            expectedOriginalHead: applyTarget?.originalHead,
            targetBranch,
          }),
        });
        setTasks((current) => upsert(current, result.task));
        if (result.preflight && !result.preflight.canApply) {
          setApplyConflict({ preflight: result.preflight, task: result.task });
          setNotice(applyPreflightNotice(result.preflight));
          return;
        }
        setNotice(
          result.alreadyApplied
            ? `Already applied to ${result.projectPath}`
            : `Applied ${result.summary.filesChanged} files to ${result.projectPath}`,
        );
        await loadDiff(task.id);
        return;
      }

      if (action === "apply_force") {
        const result = await api<ApplySessionResponse>(`/api/sessions/${task.id}/apply-force`, { method: "POST" });
        setTasks((current) => upsert(current, result.task));
        setApplyConflict(undefined);
        setNotice(`Force applied ${result.summary.filesChanged} files to ${result.projectPath}`);
        return;
      }

      if (action === "export_patch") {
        const result = await api<ExportPatchResponse>(`/api/sessions/${task.id}/export-patch`, { method: "POST" });
        downloadTextFile(patchDownloadName(task), result.diffText, "text/x-patch;charset=utf-8");
        setNotice(`Patch exported on server: ${result.patchPath}`);
        return;
      }

      if (action === "export_report") {
        const result = await api<ExportSessionReportResponse>(`/api/sessions/${task.id}/report`, { method: "POST" });
        downloadTextFile(reportDownloadName(task), result.markdown, "text/markdown;charset=utf-8");
        setNotice(`Session report exported on server: ${result.reportPath}`);
        return;
      }

      if (action === "sync_latest") {
        const result = await api<SyncSessionToLatestResponse>(`/api/sessions/${task.id}/sync-latest`, { method: "POST" });
        setTasks((current) => upsert(current, result.task));
        setNotice(`Synced isolated worktree from ${result.originalBranch ? `${result.originalBranch}@` : ""}${result.head.slice(0, 12)}.`);
        await loadDiff(task.id);
        return;
      }

      if (action === "repo_add") {
        const result = await api<ProjectDeliveryResponse>(`/api/sessions/${task.id}/delivery/add`, {
          method: "POST",
          body: JSON.stringify({ files: input.files ?? [] }),
        });
        setTasks((current) => upsert(current, result.task));
        setNotice(`Staged changes in ${result.projectPath}${result.branch ? ` on ${result.branch}` : ""}.`);
        return;
      }

      if (action === "repo_commit") {
        const message = input.commitMessage?.trim();
        if (!message) {
          throw new Error("Commit message cannot be empty.");
        }
        const result = await api<ProjectDeliveryResponse>(`/api/sessions/${task.id}/delivery/commit`, {
          method: "POST",
          body: JSON.stringify({ message }),
        });
        setTasks((current) => upsert(current, result.task));
        setNotice(`Committed ${result.commitSha ? shortSha(result.commitSha) : "changes"}${result.branch ? ` on ${result.branch}` : ""}.`);
        return;
      }

      if (action === "create_branch") {
        const result = await api<CreateBranchResponse>(`/api/sessions/${task.id}/branch`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        setTasks((current) => upsert(current, result.task));
        setNotice(`Branch ready: ${result.branch}${result.commitSha ? ` @ ${result.commitSha.slice(0, 12)}` : ""}`);
        return;
      }

      if (action === "push_branch") {
        const result = await api<PushBranchResponse>(`/api/sessions/${task.id}/push`, {
          method: "POST",
          body: JSON.stringify({ remote: input.remote }),
        });
        setTasks((current) => upsert(current, result.task));
        setNotice(`Branch pushed: ${result.branch}${result.remote ? ` to ${result.remote}` : ""}${result.commitSha ? ` @ ${result.commitSha.slice(0, 12)}` : ""}`);
        return;
      }

      if (action === "create_pr") {
        const result = await api<CreatePullRequestResponse>(`/api/sessions/${task.id}/pr`, {
          method: "POST",
          body: JSON.stringify({ draft: true, remote: input.remote }),
        });
        setTasks((current) => upsert(current, result.task));
        setNotice(prNotice(result));
        return;
      }

      if (action === "snapshot") {
        await createSnapshot(task, { label: suggestSnapshotLabel(task) });
        return;
      }

      if (action === "rollback") {
        if (!selectedSnapshotId) {
          throw new Error("Select a snapshot before rolling back.");
        }
        const result = await api<RollbackSessionResponse>(`/api/sessions/${task.id}/rollback`, {
          method: "POST",
          body: JSON.stringify({ snapshotId: selectedSnapshotId }),
        });
        setSnapshots((current) => [...current, ...(result.safetySnapshot ? [result.safetySnapshot] : []), result.rollbackSnapshot]);
        setSelectedSnapshotId(result.rollbackSnapshot.id);
        setNotice(
          result.safetySnapshot
            ? `Rollback completed. Safety snapshot saved: ${result.safetySnapshot.label}.`
            : `Rollback completed. Marker snapshot: ${result.rollbackSnapshot.label}.`,
        );
        return;
      }

      if (action === "diagnostics") {
        const diagnostics = await api<SessionDiagnostics>(`/api/sessions/${task.id}/diagnostics`);
        setSessionDiagnostics(diagnostics);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
      await Promise.all([
        api<AgentEvent[]>(`/api/tasks/${task.id}/events`).then(setEvents).catch(() => undefined),
        action === "copy_worktree" ? Promise.resolve() : loadDiff(task.id).catch(() => undefined),
      ]);
    }
  }

  async function changeSessionMode(modeId: string): Promise<void> {
    setSelectedModeId(modeId);
    const task = selectedTask;
    if (!task) {
      return;
    }
    setError(undefined);
    try {
      const updated = await api<Task>(`/api/sessions/${task.id}/mode`, {
        method: "POST",
        body: JSON.stringify({ modeId }),
      });
      setTasks((current) => upsert(current, updated));
      setNotice(`Mode changed to ${modeLabel(modeId)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function respondApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (pendingApprovals.has(approvalId) || approvalStates.has(approvalId)) {
      return;
    }
    setError(undefined);
    setPendingApprovals((current) => new Set(current).add(approvalId));
    try {
      await api<{ ok: true }>(`/api/approvals/${approvalId}/respond`, {
        method: "POST",
        body: JSON.stringify({
          taskId,
          decision,
        }),
      });
    } catch (err) {
      setPendingApprovals((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <main
        className={`app-shell ${popoutView ? "popout" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
        ref={appShellRef}
        style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      >
      {popoutView || sidebarCollapsed ? null : <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AW</span>
          <div>
            <h1>Agent Workbench</h1>
            <p>Local agent supervision</p>
          </div>
          <div className="brand-actions">
            <button
              className="secondary compact-button"
              onClick={() => {
                setActiveView((current) => (current === "settings" ? "session" : "settings"));
                setOpenSessionMenuId(undefined);
                if (activeView !== "settings") {
                  void loadRuntimeConfig();
                }
              }}
              type="button"
            >
              Settings
            </button>
          </div>
        </div>

        <section className="panel">
          <div className="panel-title-row">
            <h2>Projects</h2>
            <button aria-label="Add project" className="icon-button" onClick={() => setProjectDialogOpen(true)} type="button">
              +
            </button>
          </div>
          <div className="list">
            {projects.map((project) => (
              <div className="project-row" key={project.id}>
                <button
                  className={`project-button ${project.id === activeProject?.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setOpenSessionMenuId(undefined);
                    setSessionToolsMenuOpen(false);
                    openProjectManageDialog(project);
                  }}
                  title={`${project.name} · ${project.defaultBranch ?? "no branch"} · ${project.path}`}
                  type="button"
                >
                  <span className="project-title-row">
                    <strong>{project.name}</strong>
                    <span className="project-branch-badge">{project.defaultBranch ?? "no branch"}</span>
                  </span>
                  <small>{project.path}</small>
                </button>
              </div>
            ))}
          </div>
        </section>

        <SessionOverviewButton
          active={activeView === "overview"}
          onClick={() => {
            setActiveView("overview");
            setOpenSessionMenuId(undefined);
          }}
          overviews={overviews}
        />

        <section className="panel">
          <div className="panel-title-row" ref={sessionToolsMenuRootRef}>
            <h2>Sessions</h2>
            <button
              aria-expanded={sessionToolsMenuOpen}
              aria-label="Session tools"
              className="session-menu-button secondary"
              onClick={() => setSessionToolsMenuOpen((current) => !current)}
              type="button"
            >
              ...
            </button>
            {sessionToolsMenuOpen ? (
              <div className="session-header-menu" role="menu">
                <button onClick={openNewSessionDialog} role="menuitem" type="button">
                  New session...
                </button>
                <button
                  disabled={!activeProject || nativeSessionLoading}
                  onClick={() => activeProject && void openNativeSessionDialog(activeProject.id)}
                  role="menuitem"
                  type="button"
                >
                  {nativeSessionLoading ? "Loading sessions..." : "Import native CLI session..."}
                </button>
              </div>
            ) : null}
          </div>
          <select className="agent-select" value={selectedBackendId} onChange={(event) => setSelectedBackendId(event.target.value)}>
            {sessionBackends.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.name}
              </option>
            ))}
          </select>
          <input
            aria-label="Search sessions"
            className="session-search"
            onChange={(event) => setSessionSearch(event.target.value)}
            placeholder="keyword"
            type="search"
            value={sessionSearch}
          />
          <div className="list">
            {visibleTasks.map((task) => (
              <div className="task-row" key={task.id}>
                <button
                  className={`task-button ${task.id === selectedTaskId ? "selected" : ""} ${draggingPopoutTaskId === task.id ? "dragging-popout" : ""}`}
                  draggable={false}
                  onClick={() => {
                    if (sessionDragSuppressedClickRef.current) {
                      sessionDragSuppressedClickRef.current = false;
                      return;
                    }
                    setSelectedTaskId(task.id);
                    setActiveView("session");
                    setOpenSessionMenuId(undefined);
                    setSessionToolsMenuOpen(false);
                  }}
                  onMouseDown={(event) => beginSessionPopoutDrag(event, task)}
                  type="button"
                  title={`${task.title} · ${sessionIdentityTitle(task)} · ${backendLabel(backends, task.backendId)} · ${sidebarTaskStatusLabel(task.status)} · drag to pop out`}
                >
                  <span className="task-title-row">
                    <span>{task.title}</span>
                    <SessionStateBadge overview={overviewByTaskId.get(task.id)} task={task} />
                  </span>
                  <small>{sessionListSubtitle(task, backendLabel(backends, task.backendId))}</small>
                </button>
                <span className="session-row-menu" data-session-menu-id={task.id}>
                  <button
                    aria-expanded={openSessionMenuId === task.id}
                    aria-label={`Session actions for ${task.title}`}
                    className="session-menu-button secondary"
                    onClick={() => setOpenSessionMenuId((current) => (current === task.id ? undefined : task.id))}
                    type="button"
                  >
                    ...
                  </button>
                  {openSessionMenuId === task.id ? (
                    <div className="session-menu" role="menu">
                      <button onClick={() => openRenameDialog(task)} role="menuitem" type="button">
                        Rename
                      </button>
                      <button onClick={() => openPopoutSession(task)} role="menuitem" type="button">
                        Pop out
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          setOpenSessionMenuId(undefined);
                          setPendingDelete(task);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ) : null}
                </span>
              </div>
            ))}
            {visibleTasks.length === 0 ? (
              <p className="empty">No matching sessions.</p>
            ) : null}
          </div>
        </section>
      </aside>}

      {!popoutView ? (
        <button
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="sidebar-resize-rail"
          onClick={() => {
            if (sidebarDragSuppressedClickRef.current) {
              sidebarDragSuppressedClickRef.current = false;
              return;
            }
            setSidebarCollapsed((current) => !current);
          }}
          onMouseDown={(event) => {
            if (sidebarCollapsed || event.button !== 0) {
              return;
            }
            const shell = appShellRef.current;
            if (!shell) {
              return;
            }
            event.preventDefault();
            const shellLeft = shell.getBoundingClientRect().left;
            const minWidth = 240;
            const maxWidth = Math.min(520, Math.max(minWidth, window.innerWidth - 560));
            let dragged = false;
            const handleMouseMove = (moveEvent: MouseEvent) => {
              dragged = true;
              const nextWidth = Math.max(minWidth, Math.min(maxWidth, moveEvent.clientX - shellLeft));
              setSidebarWidth(nextWidth);
            };
            const handleMouseUp = () => {
              window.removeEventListener("mousemove", handleMouseMove);
              window.removeEventListener("mouseup", handleMouseUp);
              if (dragged) {
                sidebarDragSuppressedClickRef.current = true;
              }
            };
            window.addEventListener("mousemove", handleMouseMove);
            window.addEventListener("mouseup", handleMouseUp);
          }}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          type="button"
        >
          <span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span>
        </button>
      ) : null}

      <section className={`main-panel ${activeView !== "session" && !popoutView ? "overview-mode" : ""}`}>
        {activeView === "settings" && !popoutView ? (
          <SettingsWorkspace
            backends={backends}
            config={runtimeConfig}
            doctor={systemDoctor}
            doctorRunning={isDoctorRunning}
            onRefresh={() => {
              void loadRuntimeConfig();
              void runSystemDoctor();
            }}
          />
        ) : activeView === "overview" && !popoutView ? (
          <SessionOverviewWorkspace
            busyAction={busyAction}
            onAction={(action, task) => {
              selectedTaskIdRef.current = task.id;
              setSelectedTaskId(task.id);
              setActiveView("session");
              setSessionTab(sessionTabForOverviewAction(action));
              if (action === "discard") {
                setPendingDelete(task);
                return;
              }
              if (action === "apply") {
                void openSessionActionConfirmation(action, task);
                return;
              }
              void performSessionAction(action, task);
            }}
            onOpen={openSessionIntent}
            overviews={overviews}
            selectedTaskId={selectedTaskId}
          />
        ) : (
        <div
          className="workspace session-workspace"
          ref={sessionWorkspaceRef}
          style={{ "--session-terminal-width": `${sessionTerminalWidth}px` } as React.CSSProperties}
        >
          {(error || notice) ? (
            <div className="workspace-session-banner" aria-live="polite">
              {error ? <div className="error">{error}</div> : null}
              {notice ? <div className="notice">{notice}</div> : null}
            </div>
          ) : null}
          <section className={`timeline ${terminalProjected ? "terminal-projection-shell" : ""}`}>
            {terminalProjected ? (
              <TerminalProjection lines={terminalProjectionLines} task={selectedTask} />
            ) : (
              <>
                <header>
                  <div className="timeline-heading">
                    <h2>{selectedTask?.title ?? "No session selected"}</h2>
                    <div className="timeline-meta">
                      {displayProject?.name ? <span className="source-badge">{displayProject.name}</span> : null}
                      {selectedTaskBackend ? <span className="source-badge">{selectedTaskBackend}</span> : null}
                      {selectedTask && isLinkedGeminiSession(selectedTask) ? (
                        <span className="source-badge" title={nativeSessionTitle(selectedTask)}>
                          {nativeSessionDisplayLabel(selectedTask)}
                        </span>
                      ) : null}
                      {selectedTask?.worktreePath ? (
                        <span
                          className="source-badge"
                          title={selectedTask.worktreePath}
                        >
                          {truncateMiddle(selectedTask.worktreePath, 44)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="timeline-controls">
                    <select value={selectedModeId} onChange={(event) => void changeSessionMode(event.target.value)}>
                      {modeOptions.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                    {selectedTask ? <span className={`context-status ${agentContextClass(selectedTask)}`}>{agentContextLabel(selectedTask)}</span> : null}
                    {selectedTask ? <span className="status">{selectedTask.status}</span> : null}
                    {selectedTaskRunning ? (
                      <button className="danger compact-button" disabled={busyAction === "cancel"} onClick={() => void performSessionAction("cancel")} type="button">
                        {busyAction === "cancel" ? "Stopping" : "Stop"}
                      </button>
                    ) : null}
                  </div>
                </header>
                <SessionWorkspaceTabs
                  active={sessionTab}
                  diffCount={diff?.summary.filesChanged ?? 0}
                  onSelect={setSessionTab}
                  snapshotCount={snapshots.length}
                />
                <SessionWorkspacePanel
                  applyConflict={applyConflict}
                  approvalStates={approvalStates}
                  busyAction={busyAction}
                  diff={diff}
                  events={events}
                  files={diffFiles}
                  pendingApprovals={pendingApprovals}
                  panelRef={eventListRef}
                  workEvents={workTimelineEvents}
                  onAction={(action) => {
                    if (action === "branch_manager") {
                      if (selectedTask) {
                        setBranchManagerTask(selectedTask);
                      }
                      return;
                    }
                    if (action === "delivery") {
                      if (selectedTask) {
                        setDeliveryTask(selectedTask);
                      }
                      return;
                    }
                    if (action === "apply" || action === "sync_latest" || action === "push_branch" || action === "create_pr") {
                      if (selectedTask) {
                        void openSessionActionConfirmation(action, selectedTask);
                      }
                      return;
                    }
                    void performSessionAction(action);
                  }}
                  onApproval={respondApproval}
                  onCreateSnapshot={(input) => (selectedTask ? createSnapshot(selectedTask, input) : Promise.reject(new Error("Select a session first.")))}
                  onRefreshChanges={() => (selectedTask ? refreshSessionWorkspace(selectedTask.id) : Promise.resolve())}
                  onSelectTab={setSessionTab}
                  onSelectSnapshot={setSelectedSnapshotId}
                  onSnapshotsChange={setSnapshots}
                  selectedSnapshotId={selectedSnapshotId}
                  snapshots={snapshots}
                  tab={sessionTab}
                  task={selectedTask}
                  token={token}
                />
              </>
            )}
          </section>

          <div
            aria-label="Resize terminal panel"
            className="session-workspace-splitter"
            onMouseDown={(event) => {
              const workspace = sessionWorkspaceRef.current;
              if (!workspace) {
                return;
              }
              event.preventDefault();
              const startX = event.clientX;
              const startWidth = sessionTerminalWidth;
              const totalWidth = workspace.getBoundingClientRect().width;
              const minWidth = 360;
              const maxWidth = Math.max(minWidth, Math.min(920, totalWidth - 360));
              const handleMouseMove = (moveEvent: MouseEvent) => {
                const delta = startX - moveEvent.clientX;
                const nextWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
                setSessionTerminalWidth(nextWidth);
              };
              const handleMouseUp = () => {
                window.removeEventListener("mousemove", handleMouseMove);
                window.removeEventListener("mouseup", handleMouseUp);
              };
              window.addEventListener("mousemove", handleMouseMove);
              window.addEventListener("mouseup", handleMouseUp);
            }}
            role="separator"
          />

          <aside className="inspector session-terminal-sidebar">
            <div className="session-terminal-header">
              <div>
                <h3>Agent Terminal</h3>
                <small>Native agent CLI for this session. Linked Gemini, Codex, and Claude sessions reopen with their native resume command.</small>
              </div>
              {selectedTask ? <SessionStateBadge overview={selectedOverview} task={selectedTask} /> : null}
            </div>
            <React.Suspense fallback={<p className="empty">Loading terminal...</p>}>
              <TerminalPanel
                autoAttach={selectedOverview?.terminal?.status === "running"}
                isProjected={terminalProjected}
                key={selectedTask?.id ?? "no-session"}
                onProjectionLinesChange={setTerminalProjectionLines}
                onToggleProjection={() => {
                  if (selectedTask) {
                    setProjectedTerminalTaskId((current) => current === selectedTask.id ? undefined : selectedTask.id);
                  }
                }}
                task={selectedTask}
                token={token}
              />
            </React.Suspense>
          </aside>
        </div>
        )}

      </section>
      </main>

      {pendingDelete ? (
        <DeleteSessionDialog
          isDeleting={isDeleting}
          onCancel={() => {
            if (!isDeleting) {
              setPendingDelete(undefined);
            }
          }}
          onConfirm={() => void confirmDeleteSession()}
          task={pendingDelete}
        />
      ) : null}

      {pendingProjectDelete ? (
        <DeleteProjectDialog
          isDeleting={isProjectDeleting}
          onCancel={() => {
            if (!isProjectDeleting) {
              setPendingProjectDelete(undefined);
            }
          }}
          onConfirm={() => void confirmDeleteProject()}
          project={pendingProjectDelete}
          sessionCount={tasks.filter((task) => task.projectId === pendingProjectDelete.id).length}
        />
      ) : null}

      {renameDraft ? (
        <RenameSessionDialog
          isRenaming={isRenaming}
          onCancel={() => {
            if (!isRenaming) {
              setRenameDraft(undefined);
              setRenameTitle("");
            }
          }}
          onSubmit={(event) => void renameSession(event)}
          setTitle={setRenameTitle}
          task={renameDraft}
          title={renameTitle}
        />
      ) : null}

      {projectRenameDraft ? (
        <ProjectManageDialog
          isRenaming={isProjectRenaming}
          name={projectRenameName}
          onCancel={() => {
            if (!isProjectRenaming) {
              setProjectRenameDraft(undefined);
              setProjectRenameName("");
            }
          }}
          onRemove={() => {
            setPendingProjectDelete(projectRenameDraft);
            setProjectRenameDraft(undefined);
            setProjectRenameName("");
          }}
          onSubmit={(event) => void renameProject(event)}
          project={projectRenameDraft}
          setName={setProjectRenameName}
        />
      ) : null}

      {branchManagerTask ? (
        <BranchManagerDialog
          onCancel={() => setBranchManagerTask(undefined)}
          onTaskUpdated={(task) => {
            setBranchManagerTask(task);
            setTasks((current) => upsert(current, task));
          }}
          task={branchManagerTask}
        />
      ) : null}

      {deliveryTask ? (
        <DeliveryDialog
          busyAction={busyAction}
          items={deliveryItems}
          onAction={(action, input) => {
            if (action === "repo_add" || action === "repo_commit" || action === "push_branch" || action === "create_pr") {
              void performSessionAction(action, deliveryTask, undefined, input);
            }
          }}
          onCancel={() => setDeliveryTask(undefined)}
          task={deliveryTask}
        />
      ) : null}

      {pendingConfirmation ? (
        <ConfirmSessionActionDialog
          action={pendingConfirmation.action}
          applyTarget={pendingConfirmation.applyTarget}
          busy={busyAction === pendingConfirmation.action}
          onCancel={() => setPendingConfirmation(undefined)}
          onConfirm={(targetBranch) => void confirmSessionAction({ targetBranch })}
          task={pendingConfirmation.task}
        />
      ) : null}

      {projectDialogOpen ? (
        <ProjectDialog
          onCancel={() => {
            setProjectDialogOpen(false);
            setProjectPath("");
          }}
          onSubmit={(event) => void addProject(event)}
          path={projectPath}
          setPath={setProjectPath}
        />
      ) : null}

      {newSessionDraft ? (
        <NewSessionDialog
          backends={sessionBackends}
          draft={newSessionDraft}
          onCancel={() => setNewSessionDraft(undefined)}
          onChange={setNewSessionDraft}
          onSubmit={(event) => void createNewSession(event)}
          projects={projects}
          tasks={tasks}
        />
      ) : null}

      {nativeSessionDialog ? (
        <NativeSessionImportDialog
          currentTaskId={selectedTaskId}
          importingKey={nativeSessionImportingKey}
          onCancel={() => {
            if (!nativeSessionImportingKey) {
              setNativeSessionDialog(undefined);
            }
          }}
          onImport={(backendId, sessionId) => void importNativeSession(nativeSessionDialog.project.id, backendId, sessionId)}
          project={nativeSessionDialog.project}
          sessions={nativeSessionDialog.sessions}
          tasks={tasks}
        />
      ) : null}

      {sessionDiagnostics ? (
        <AgentConsoleDialog
          diagnostics={sessionDiagnostics}
          onClose={() => setSessionDiagnostics(undefined)}
        />
      ) : null}
    </>
  );
}

const capabilityRows: Array<{ id: AgentFeatureId; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "persistent_session", label: "Session" },
  { id: "slash_commands", label: "Slash" },
  { id: "skills", label: "Skills" },
  { id: "memory", label: "Memory" },
  { id: "modes", label: "Modes" },
  { id: "models", label: "Models" },
  { id: "approvals", label: "Approval" },
  { id: "terminal_fallback", label: "Terminal" },
  { id: "diff_review", label: "Diff" },
];

function CapabilityCenterWorkspace({
  acpCommands,
  backends,
  doctor,
  doctorRunning,
  onRunDoctor,
  selectedBackendId,
  selectedTask,
  workbenchCommands,
}: {
  acpCommands: AvailableCommandView[];
  backends: BackendStatus[];
  doctor?: SystemDoctorResponse;
  doctorRunning: boolean;
  onRunDoctor: () => void;
  selectedBackendId: string;
  selectedTask?: Task;
  workbenchCommands: AvailableCommandView[];
}): React.JSX.Element {
  const selectedBackend = backends.find((backend) => backend.id === selectedBackendId) ?? backends[0];
  const profile = selectedBackend?.profile;

  return (
    <div className="capability-workspace">
      <section className="capability-main">
        <header>
          <div>
            <h2>Capability Center</h2>
            <p>Backend support for CLI parity, commands, skills, memory, approvals, and Workbench-native review flow.</p>
          </div>
        </header>

        <div className="capability-matrix" role="table" aria-label="Backend capability matrix">
          <div className="capability-head" role="row">
            <span>Capability</span>
            {backends.map((backend) => (
              <span key={backend.id}>{backend.name}</span>
            ))}
          </div>
          {capabilityRows.map((row) => (
            <div className="capability-row" key={row.id} role="row">
              <span>{row.label}</span>
              {backends.map((backend) => {
                const feature = featureForBackend(backend, row.id);
                return (
                  <span
                    className={`capability-cell ${feature ? capabilityClass(feature.support) : "unsupported"}`}
                    key={`${backend.id}-${row.id}`}
                    title={feature ? capabilityTitle(feature) : "Not declared by this backend."}
                  >
                    {feature ? supportLabel(feature.support) : "No"}
                  </span>
                );
              })}
            </div>
          ))}
        </div>

        <section className="capability-detail">
          <h3>{selectedBackend?.name ?? "No backend selected"}</h3>
          <p>{profile?.summary ?? selectedBackend?.details ?? "No capability profile has been declared for this backend."}</p>
          {profile ? (
            <div className="capability-detail-grid">
              <div>
                <h4>Best For</h4>
                <ul>
                  {profile.recommendedUse.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Known Gaps</h4>
                <ul>
                  {profile.limitations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </section>
      </section>

      <aside className="command-skill-panel">
        <section>
          <div className="panel-title-row">
            <h2>Runtime Health</h2>
            <button className="secondary compact-button" disabled={doctorRunning} onClick={onRunDoctor} type="button">
              {doctorRunning ? "Checking" : "Run doctor"}
            </button>
          </div>
          {doctor ? <SystemDoctorPanel doctor={doctor} /> : <p className="empty">Run doctor to verify Node, Git, Gemini CLI, storage, and bind warnings.</p>}
        </section>

        <section>
          <h2>Command Center</h2>
          <p>Workbench-executable commands are separated from backend-discovered commands so CLI parity gaps stay explicit.</p>

          <div className="command-group">
            <h3>Workbench Slash Commands</h3>
            <small>Executed locally by Workbench before backend attachment.</small>
            <CommandList
              commands={workbenchCommands}
              empty="No Workbench slash commands are registered."
              state="supported"
              stateLabel="Executable"
            />
          </div>

          <div className="command-group">
            <h3>Current Session ACP Commands</h3>
            {selectedTask ? <small>{selectedTask.title}</small> : <small>No session selected.</small>}
            <p className="command-note">
              Discovery only. Gemini ACP can list these commands, but Workbench does not assume every discovered slash command has a stable execute path.
            </p>
            <CommandList
              commands={acpCommands}
              empty="No ACP commands have been discovered for the selected session yet."
              state="partial"
              stateLabel="Discovered"
            />
          </div>

          <div className="command-group">
            <h3>Backend Commands</h3>
            {profile?.commands.length ? (
              <CapabilityList items={profile.commands.map((command) => ({
                description: command.description,
                label: command.name,
                limitation: command.limitation,
                source: command.source,
                support: command.support,
              }))} />
            ) : (
              <p className="empty">This backend has no declared command profile.</p>
            )}
          </div>

          <div className="command-group">
            <h3>Workbench Commands</h3>
            <CapabilityList
              items={[
                {
                  description: "Apply the isolated worktree patch back to the original repository.",
                  label: "Apply to repo",
                  source: "workbench",
                  support: "supported",
                },
                {
                  description: "Export the current session diff as a patch file.",
                  label: "Export patch",
                  source: "workbench",
                  support: "supported",
                },
                {
                  description: "Create, push, or open a PR from the isolated session branch.",
                  label: "Branch / Push / Draft PR",
                  source: "workbench",
                  support: "supported",
                },
              ]}
            />
          </div>
        </section>

        <section>
          <h2>Skill Center</h2>
          <p>Skill support is now explicit. Workbench-native skill execution is the next implementation layer.</p>
          {profile?.skills.length ? (
            <CapabilityList items={profile.skills.map((skill) => ({
              description: skill.description,
              label: skill.name,
              limitation: skill.limitation,
              source: skill.source,
              support: skill.support,
            }))} />
          ) : (
            <p className="empty">No skill profile declared for this backend.</p>
          )}
        </section>
      </aside>
    </div>
  );
}

function CommandList({
  commands,
  empty,
  state,
  stateLabel,
}: {
  commands: AvailableCommandView[];
  empty: string;
  state: "supported" | "partial";
  stateLabel: string;
}): React.JSX.Element {
  if (commands.length === 0) {
    return <p className="empty">{empty}</p>;
  }

  return (
    <div className="command-list">
      {commands.map((command) => (
        <div className="command-item" key={`${command.source ?? "unknown"}-${command.name}`}>
          <div className="command-item-head">
            <strong>{command.usage ?? `/${command.name}`}</strong>
            <span className={`support-badge ${state}`}>{stateLabel}</span>
          </div>
          <span>{command.description ?? "No description available."}</span>
          {command.aliases?.length ? <small>Aliases: {command.aliases.map((alias) => `/${alias}`).join(", ")}</small> : null}
          {command.source ? <span className="source-badge">{sourceLabel(command.source)}</span> : null}
        </div>
      ))}
    </div>
  );
}

function CapabilityList({
  items,
}: {
  items: Array<{
    description: string;
    label: string;
    limitation?: string;
    source: string;
    support: string;
  }>;
}): React.JSX.Element {
  return (
    <div className="capability-list">
      {items.map((item) => (
        <div className="capability-list-item" key={`${item.label}-${item.source}`}>
          <div>
            <strong>{item.label}</strong>
            <span className={`support-badge ${capabilityClass(item.support)}`}>{supportLabel(item.support)}</span>
          </div>
          <p>{item.description}</p>
          {item.limitation ? <small>{item.limitation}</small> : null}
          <span className="source-badge">{sourceLabel(item.source)}</span>
        </div>
      ))}
    </div>
  );
}

function SettingsWorkspace({
  backends,
  config,
  doctor,
  doctorRunning,
  onRefresh,
}: {
  backends: BackendStatus[];
  config?: RuntimeConfigResponse;
  doctor?: SystemDoctorResponse;
  doctorRunning: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <div className="settings-workspace">
      <section className="settings-main">
        <header>
          <div>
            <h2>Settings</h2>
            <p>Read-only runtime configuration for this local Workbench process.</p>
          </div>
          <button className="secondary compact-button" disabled={doctorRunning} onClick={onRefresh} type="button">
            {doctorRunning ? "Refreshing" : "Refresh"}
          </button>
        </header>

        {config ? (
          <div className="settings-grid">
            <SettingCard label="Server" value={`${config.host}:${config.port}`} detail={config.security.allInterfaces ? "Listening on all interfaces" : "Loopback/local bind"} />
            <SettingCard label="Token" value={config.security.tokenSource} detail={config.security.tokenSource === "environment" ? "AGENT_WORKBENCH_TOKEN" : "Generated for this server process"} />
            <SettingCard label="Storage" value={config.storage.type} detail={config.storage.path} />
            <SettingCard label="Worktrees" value="Root" detail={config.worktrees.root} />
            <SettingCard label="Terminal" value={config.terminal.command} detail="AGENT_WORKBENCH_TERMINAL_COMMAND" />
          </div>
        ) : (
          <p className="empty">Refresh to load runtime configuration.</p>
        )}

        {config ? (
          <section className="settings-section">
            <h3>Backend Commands</h3>
            <div className="settings-list">
              {config.backendCommands.map((backend) => (
                <div key={backend.id}>
                  <strong>{backend.label}</strong>
                  <code>{backend.command}</code>
                  <small>{backend.envVar ?? "default"}</small>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <aside className="settings-side">
        <h2>Backend Health</h2>
        <BackendHealthPanel backends={backends} />
        <h2>Runtime Health</h2>
        {doctor ? <SystemDoctorPanel doctor={doctor} /> : <p className="empty">Refresh to run doctor and verify prerequisites.</p>}
      </aside>
    </div>
  );
}

function BackendHealthPanel({ backends }: { backends: BackendStatus[] }): React.JSX.Element {
  if (backends.length === 0) {
    return <p className="empty">No backend configured.</p>;
  }

  return (
    <div className="backend-health-list">
      {backends.map((backend) => (
        <div className="backend-health-item" key={backend.id} title={backend.details}>
          <span className={backend.available ? "dot ok" : "dot missing"} />
          <div>
            <strong>{backend.name}</strong>
            <small>{backend.available ? "Connected" : backend.details ?? "Unavailable"}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function SettingCard({ detail, label, value }: { detail: string; label: string; value: string }): React.JSX.Element {
  return (
    <div className="setting-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SystemDoctorPanel({ doctor }: { doctor: SystemDoctorResponse }): React.JSX.Element {
  return (
    <div className="system-doctor">
      <div className="doctor-checks">
        {doctor.checks.map((check) => (
          <div className={`doctor-check ${check.ok ? "ok" : "missing"}`} key={check.name}>
            <span>{check.ok ? "OK" : "Missing"}</span>
            <strong>{check.name}</strong>
            <small>{check.output || check.details || "No output"}</small>
          </div>
        ))}
      </div>
      <div className="doctor-storage">
        <strong>Storage</strong>
        <small>{doctor.storage.path}</small>
        <span>{doctor.storage.exists ? "primary ok" : "primary missing"} · {doctor.storage.backupExists ? "backup ok" : "backup missing"}</span>
        {doctor.storage.lastRecovery ? <span>recovered from {doctor.storage.lastRecovery.source} at {doctor.storage.lastRecovery.at}</span> : null}
      </div>
      <div className="doctor-bind">
        <strong>Server</strong>
        <small>{doctor.host}:{doctor.port}</small>
      </div>
      {doctor.warnings.length > 0 ? (
        <div className="doctor-warnings">
          {doctor.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : (
        <p className="empty">No runtime warnings.</p>
      )}
    </div>
  );
}

function SessionOverviewButton({
  active,
  onClick,
  overviews,
}: {
  active: boolean;
  onClick: () => void;
  overviews: SessionOverview[];
}): React.JSX.Element {
  const waiting = overviews.reduce((count, overview) => count + overview.waitingApprovals, 0);
  const stuck = overviews.filter((overview) => overview.stuck).length;
  const running = overviews.filter((overview) => ["running", "starting", "waiting_approval"].includes(overview.task.status)).length;
  return (
    <section className="panel">
      <button className={`overview-entry ${active ? "selected" : ""}`} onClick={onClick} type="button">
        <span className="overview-entry-copy">
          <strong>Session Overview</strong>
          <small>{overviews.length} sessions</small>
        </span>
        <span className="overview-entry-meta">
          {running > 0 ? <span className="status">{running} running</span> : null}
          {waiting > 0 ? <span className="status warning">{waiting} approvals</span> : stuck > 0 ? <span className="status danger">{stuck} stuck</span> : null}
        </span>
      </button>
    </section>
  );
}

function sidebarTaskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "created":
      return "New";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting_approval":
      return "Approval";
    case "failed":
      return "Failed";
    case "completed":
      return "Done";
    case "review_ready":
      return "Review";
    case "branch_ready":
      return "Branch";
    case "pr_ready":
      return "PR";
    case "applied":
      return "Applied";
    case "cancelled":
      return "Stopped";
  }
}

function SessionStateBadge({ overview, task }: { overview?: SessionOverview; task: Task }): React.JSX.Element {
  const state = overview?.state ?? fallbackSessionState(task.status);
  const label = sessionStateLabel(state);
  return (
    <span
      className={`task-status-badge session-state-${state}`}
      title={overview?.stateReason ?? label}
    >
      {label}
    </span>
  );
}

function fallbackSessionState(status: TaskStatus): SessionState {
  switch (status) {
    case "created":
    case "starting":
      return "detached";
    case "running":
    case "waiting_approval":
      return "running";
    case "failed":
    case "cancelled":
      return "failed";
    case "completed":
    case "review_ready":
    case "branch_ready":
    case "pr_ready":
    case "applied":
      return "review";
  }
}

function sessionStateLabel(state: SessionState): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "review":
      return "Review";
    case "needs_action":
      return "Needs action";
    case "detached":
      return "Detached";
    case "failed":
      return "Failed";
  }
}

function SessionOverviewWorkspace({
  busyAction,
  onAction,
  onOpen,
  overviews,
  selectedTaskId,
}: {
  busyAction?: SessionUiAction;
  onAction: (action: OverviewRowAction, task: Task) => void;
  onOpen: (intent: SessionOpenIntent) => void;
  overviews: SessionOverview[];
  selectedTaskId?: string;
}): React.JSX.Element {
  const [filter, setFilter] = useState<OverviewFilter>("all");
  const [sort, setSort] = useState<OverviewSort>("recent");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<OverviewGroupId, boolean>>({
    attention: false,
    quiet: true,
    ready: false,
    running: false,
  });
  const running = overviews.filter((overview) => ["running", "starting", "waiting_approval"].includes(overview.task.status)).length;
  const waiting = overviews.reduce((count, overview) => count + overview.waitingApprovals, 0);
  const filesChanged = overviews.reduce((count, overview) => count + overview.filesChanged, 0);
  const blocked = overviews.filter((overview) => ["blocked", "stuck", "failed"].includes(overview.health)).length;
  const overlaps = overviews.reduce((count, overview) => count + overview.overlapFiles.length, 0);
  const needsAction = overviews.filter((overview) => ["attention", "blocked", "stuck", "failed"].includes(overview.health)).length;
  const filteredOverviews = useMemo(
    () => overviews
      .filter((overview) => overviewMatchesFilter(overview, filter))
      .sort((left, right) => compareOverview(left, right, sort)),
    [filter, overviews, sort],
  );
  const groupedOverviews = useMemo(
    () => groupOverviews(filteredOverviews),
    [filteredOverviews],
  );
  const attentionFeed = useMemo(
    () => buildAttentionFeed(overviews),
    [overviews],
  );
  const shipFeed = useMemo(
    () => buildShipFeed(overviews),
    [overviews],
  );
  const filters: Array<{ count: number; id: OverviewFilter; label: string }> = [
    { count: overviews.length, id: "all", label: "All" },
    { count: needsAction, id: "needs_action", label: "Needs action" },
    { count: overviews.filter((overview) => overview.health === "running").length, id: "running", label: "Running" },
    { count: overviews.filter((overview) => overview.overlapFiles.length > 0).length, id: "overlap", label: "Overlaps" },
  ];

  return (
    <div className="overview-workspace">
      <section className="overview-main">
        <header>
          <div>
            <h2>Session Overview</h2>
            <p>All isolated agent sessions, status, review state, and changed files.</p>
          </div>
        </header>

        <div className="overview-metrics" aria-label="Session metrics">
          <div>
            <strong>{overviews.length}</strong>
            <span>Total</span>
          </div>
          <div>
            <strong>{running}</strong>
            <span>Running</span>
          </div>
          <div>
            <strong>{needsAction}</strong>
            <span>Need action</span>
          </div>
          <div>
            <strong>{blocked}</strong>
            <span>Blocked</span>
          </div>
          <div>
            <strong>{waiting}</strong>
            <span>Approvals</span>
          </div>
          <div>
            <strong>{filesChanged}</strong>
            <span>Files changed</span>
          </div>
        </div>

        <div className="overview-filterbar" aria-label="Session filters">
          {filters.map((item) => (
            <button
              className={filter === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => setFilter(item.id)}
              type="button"
            >
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </button>
          ))}
        </div>

        <div className="overview-toolbar">
          <small>Showing {filteredOverviews.length} of {overviews.length} sessions.</small>
          <label className="overview-sorter">
            <span>Sort</span>
            <select onChange={(event) => setSort(event.target.value as OverviewSort)} value={sort}>
              <option value="priority">Priority</option>
              <option value="recent">Recent activity</option>
              <option value="project">Project</option>
            </select>
          </label>
        </div>

        {SHOW_EXPERIMENTAL_QUEUE_UI ? (
          <div className="overview-feeds">
            <OverviewFeedPanel
              empty="No urgent approvals, conflicts, overlaps, or failed sessions right now."
              items={attentionFeed}
              onAction={onAction}
              onOpen={onOpen}
              title="Attention feed"
            />
            <OverviewFeedPanel
              empty="No review-ready or delivery-ready sessions yet."
              items={shipFeed}
              onAction={onAction}
              onOpen={onOpen}
              title="Ship feed"
            />
          </div>
        ) : null}

        <div className="overview-table">
          <div className="overview-head">
            <span>Session</span>
            <span>Status</span>
            <span>Delivery</span>
            <span>Files</span>
            <span>Summary</span>
            <span>Actions</span>
          </div>
          {sort === "priority" ? groupedOverviews.map((group) => (
            <div className="overview-group" key={group.id}>
              <div className="overview-group-header">
                <button
                  aria-expanded={!collapsedGroups[group.id]}
                  className="overview-group-toggle"
                  onClick={() => setCollapsedGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}
                  title={group.description}
                  type="button"
                >
                  <span className="overview-group-copy">
                    <strong>{group.label} ({group.items.length})</strong>
                  </span>
                </button>
                <span className="overview-group-meta">
                  {SHOW_EXPERIMENTAL_QUEUE_UI ? group.shortcuts.map((shortcut) => (
                    <button
                      className="secondary compact-button"
                      key={`${group.id}-${shortcut.label}-${shortcut.overview.task.id}`}
                      onClick={() => {
                        if (shortcut.kind === "open") {
                          onOpen({
                            tab: shortcut.tab,
                            taskId: shortcut.overview.task.id,
                          });
                          return;
                        }
                        if (shortcut.action) {
                          onAction(shortcut.action, shortcut.overview.task);
                        }
                      }}
                      title={shortcut.title}
                      type="button"
                    >
                      {shortcut.label}
                    </button>
                  )) : null}
                  {group.summary.map((item) => (
                    <span className="source-badge" key={`${group.id}-${item}`}>{item}</span>
                  ))}
                </span>
              </div>
              {!collapsedGroups[group.id] ? group.items.map((overview) => (
                <OverviewRow
                  busyAction={busyAction}
                  key={overview.task.id}
                  onAction={onAction}
                  onOpen={onOpen}
                  overview={overview}
                  selectedTaskId={selectedTaskId}
                />
              )) : null}
            </div>
          )) : filteredOverviews.map((overview) => (
            <OverviewRow
              busyAction={busyAction}
              key={overview.task.id}
              onAction={onAction}
              onOpen={onOpen}
              overview={overview}
              selectedTaskId={selectedTaskId}
            />
          ))}
          {overviews.length === 0 ? <p className="empty">No sessions yet.</p> : null}
          {overviews.length > 0 && filteredOverviews.length === 0 ? <p className="empty">No sessions match this filter.</p> : null}
        </div>
      </section>
    </div>
  );
}

interface OverviewFeedItem {
  action?: OverviewRowAction;
  actionLabel?: string;
  category: string;
  id: string;
  intent: SessionOpenIntent;
  meta: string;
  overview: SessionOverview;
  priority: "p0" | "p1" | "p2";
  wakeSignature: string;
  summary: string;
  title: string;
}

interface FeedItemSuppression {
  doneWakeSignature?: string;
  seenWakeSignature?: string;
  snoozeUntil?: number;
  snoozeWakeSignature?: string;
}

type FeedPolicyState = "active" | "done" | "later" | "seen";

function OverviewFeedPanel({
  empty,
  items,
  onAction,
  onOpen,
  title,
}: {
  empty: string;
  items: OverviewFeedItem[];
  onAction: (action: OverviewRowAction, task: Task) => void;
  onOpen: (intent: SessionOpenIntent) => void;
  title: string;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string>();
  const [policyResult, setPolicyResult] = useState<string>();
  const storageKey = `agent-workbench-feed-state:${title.toLowerCase().replace(/\s+/g, "-")}`;
  const [suppression, setSuppression] = useState<Record<string, FeedItemSuppression>>(() => loadFeedSuppression(storageKey));
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const visibleItems = useMemo(() => {
    const now = Date.now();
    return items.filter((item) => {
      const state = suppression[item.id];
      if (!state) {
        return true;
      }
      if (state.doneWakeSignature === item.wakeSignature) {
        return false;
      }
      if (state.snoozeUntil && state.snoozeUntil > now && state.snoozeWakeSignature === item.wakeSignature) {
        return false;
      }
      return true;
    });
  }, [items, suppression]);
  const suppressionSummary = useMemo(() => summarizeFeedSuppression(suppression, itemById), [itemById, suppression]);
  const hiddenCount = items.length - visibleItems.length;
  const preferredHead = visibleItems.find((item) => !isSeenFeedItem(item, suppression[item.id])) ?? visibleItems[0];
  const selectedItem = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0];
  const selectedIndex = selectedItem ? visibleItems.findIndex((item) => item.id === selectedItem.id) : -1;
  const nextItem = selectedIndex >= 0 ? visibleItems[selectedIndex + 1] : undefined;
  const p0 = visibleItems.filter((item) => item.priority === "p0").length;
  const p1 = visibleItems.filter((item) => item.priority === "p1").length;
  const p2 = visibleItems.filter((item) => item.priority === "p2").length;
  const queueSignature = visibleItems
    .map((item) => `${item.id}:${item.priority}:${item.category}:${item.actionLabel ?? ""}`)
    .join("|");
  const previousQueueSignatureRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    saveFeedSuppression(storageKey, suppression);
  }, [storageKey, suppression]);

  useEffect(() => {
    const cleaned = cleanupFeedSuppression(suppression, itemById);
    if (cleaned !== suppression) {
      setSuppression(cleaned);
    }
  }, [itemById, suppression]);

  useEffect(() => {
    const first = preferredHead;
    if (!visibleItems.length) {
      setSelectedId(undefined);
      previousQueueSignatureRef.current = undefined;
      return;
    }
    if (first && previousQueueSignatureRef.current && previousQueueSignatureRef.current !== queueSignature) {
      setSelectedId(first.id);
      previousQueueSignatureRef.current = queueSignature;
      return;
    }
    if (first && (!selectedId || !visibleItems.some((item) => item.id === selectedId))) {
      setSelectedId(first.id);
    }
    previousQueueSignatureRef.current = queueSignature;
  }, [preferredHead, queueSignature, selectedId, visibleItems]);

  function stepSelection(direction: 1 | -1, anchorId?: string): void {
    if (!visibleItems.length) {
      return;
    }
    const baseId = anchorId ?? selectedItem?.id;
    const currentIndex = baseId ? visibleItems.findIndex((item) => item.id === baseId) : 0;
    const nextIndex = (currentIndex + direction + visibleItems.length) % visibleItems.length;
    const nextItem = visibleItems[nextIndex];
    if (nextItem) {
      setSelectedId(nextItem.id);
    }
  }

  function markDone(item: OverviewFeedItem): void {
    setSuppression((current) => ({
      ...current,
      [item.id]: {
        ...current[item.id],
        doneWakeSignature: item.wakeSignature,
        seenWakeSignature: undefined,
        snoozeUntil: undefined,
        snoozeWakeSignature: undefined,
      },
    }));
  }

  function markAllVisibleDone(): void {
    const count = visibleItems.length;
    setSuppression((current) => {
      const next = { ...current };
      for (const item of visibleItems) {
        next[item.id] = {
          ...next[item.id],
          doneWakeSignature: item.wakeSignature,
          seenWakeSignature: undefined,
          snoozeUntil: undefined,
          snoozeWakeSignature: undefined,
        };
      }
      return next;
    });
    setPolicyResult(`Marked ${count} visible item${count === 1 ? "" : "s"} done. Queue now expects 0 visible and ${hiddenCount + count} hidden item${hiddenCount + count === 1 ? "" : "s"} until wake changes.`);
  }

  function markSeen(item: OverviewFeedItem): void {
    setSuppression((current) => ({
      ...current,
      [item.id]: {
        ...current[item.id],
        seenWakeSignature: item.wakeSignature,
      },
    }));
  }

  function markAllVisibleSeen(): void {
    const count = visibleItems.length;
    setSuppression((current) => {
      const next = { ...current };
      for (const item of visibleItems) {
        next[item.id] = {
          ...next[item.id],
          seenWakeSignature: item.wakeSignature,
        };
      }
      return next;
    });
    setPolicyResult(`Marked ${count} visible item${count === 1 ? "" : "s"} seen. Visible queue stays at ${visibleItems.length}, but those items no longer reclaim the head until their wake signature changes.`);
  }

  function snooze(item: OverviewFeedItem, durationMs = 10 * 60 * 1000): void {
    setSuppression((current) => ({
      ...current,
      [item.id]: {
        ...current[item.id],
        doneWakeSignature: undefined,
        seenWakeSignature: undefined,
        snoozeUntil: Date.now() + durationMs,
        snoozeWakeSignature: item.wakeSignature,
      },
    }));
  }

  function snoozeAllVisible(durationMs = 10 * 60 * 1000): void {
    const count = visibleItems.length;
    setSuppression((current) => {
      const next = { ...current };
      const snoozeUntil = Date.now() + durationMs;
      for (const item of visibleItems) {
        next[item.id] = {
          ...next[item.id],
          doneWakeSignature: undefined,
          seenWakeSignature: undefined,
          snoozeUntil,
          snoozeWakeSignature: item.wakeSignature,
        };
      }
      return next;
    });
    setPolicyResult(`Snoozed ${count} visible item${count === 1 ? "" : "s"} for 10 minutes. Queue now expects 0 visible and ${hiddenCount + count} hidden item${hiddenCount + count === 1 ? "" : "s"} until timeout or wake changes.`);
  }

  function clearSuppressed(): void {
    const count = hiddenCount;
    setSuppression({});
    if (count > 0) {
      setPolicyResult(`Restored ${count} hidden item${count === 1 ? "" : "s"} to the active queue. Visible queue now expects ${visibleItems.length + count} item${visibleItems.length + count === 1 ? "" : "s"}.`);
    }
  }

  function clearDone(): void {
    const count = suppressionSummary.done;
    setSuppression((current) => {
      const next: Record<string, FeedItemSuppression> = {};
      for (const [id, state] of Object.entries(current)) {
        if (!state.doneWakeSignature) {
          next[id] = state;
          continue;
        }
        const remaining: FeedItemSuppression = {
          doneWakeSignature: undefined,
          seenWakeSignature: state.seenWakeSignature,
          snoozeUntil: state.snoozeUntil,
          snoozeWakeSignature: state.snoozeWakeSignature,
        };
        if (remaining.seenWakeSignature || remaining.snoozeUntil || remaining.snoozeWakeSignature) {
          next[id] = remaining;
        }
      }
      return next;
    });
    if (count > 0) {
      setPolicyResult(`Restored ${count} done item${count === 1 ? "" : "s"} to normal queue handling. Visible queue will increase by ${count}.`);
    }
  }

  function clearSeen(): void {
    const count = suppressionSummary.seen;
    setSuppression((current) => {
      const next: Record<string, FeedItemSuppression> = {};
      for (const [id, state] of Object.entries(current)) {
        if (!state.seenWakeSignature) {
          next[id] = state;
          continue;
        }
        const remaining: FeedItemSuppression = {
          doneWakeSignature: state.doneWakeSignature,
          seenWakeSignature: undefined,
          snoozeUntil: state.snoozeUntil,
          snoozeWakeSignature: state.snoozeWakeSignature,
        };
        if (remaining.doneWakeSignature || remaining.snoozeUntil || remaining.snoozeWakeSignature) {
          next[id] = remaining;
        }
      }
      return next;
    });
    if (count > 0) {
      setPolicyResult(`Restored ${count} seen item${count === 1 ? "" : "s"} so they can reclaim queue head again without changing visibility.`);
    }
  }

  function clearSnoozed(): void {
    const count = suppressionSummary.snoozed;
    setSuppression((current) => {
      const next: Record<string, FeedItemSuppression> = {};
      for (const [id, state] of Object.entries(current)) {
        if (!state.snoozeUntil && !state.snoozeWakeSignature) {
          next[id] = state;
          continue;
        }
        const remaining: FeedItemSuppression = {
          doneWakeSignature: state.doneWakeSignature,
          seenWakeSignature: state.seenWakeSignature,
          snoozeUntil: undefined,
          snoozeWakeSignature: undefined,
        };
        if (remaining.doneWakeSignature || remaining.seenWakeSignature) {
          next[id] = remaining;
        }
      }
      return next;
    });
    if (count > 0) {
      setPolicyResult(`Restored ${count} snoozed item${count === 1 ? "" : "s"} to the visible queue. Visible queue will increase by ${count}.`);
    }
  }

  function openSelected(): void {
    if (!selectedItem) {
      return;
    }
    onOpen(selectedItem.intent);
    stepSelection(1);
  }

  function runSelectedAction(): void {
    if (!selectedItem?.action) {
      return;
    }
    onAction(selectedItem.action, selectedItem.overview.task);
    stepSelection(1);
  }

  return (
    <section className="overview-feed-panel">
      <header>
        <div>
          <h3>{title}</h3>
          <small>{visibleItems.length > 0 ? `${visibleItems.length} items · queue mode · auto-head on queue change` : hiddenCount > 0 ? "All items currently suppressed" : "Clear"}</small>
        </div>
        {visibleItems.length > 0 ? (
          <div className="overview-feed-header-summary">
            {p0 > 0 ? <span className="support-badge unsupported">P0 {p0}</span> : null}
            {p1 > 0 ? <span className="support-badge partial">P1 {p1}</span> : null}
            {p2 > 0 ? <span className="support-badge planned">P2 {p2}</span> : null}
            {suppressionSummary.done > 0 ? <span className="source-badge">{suppressionSummary.done} done</span> : null}
            {suppressionSummary.seen > 0 ? <span className="source-badge">{suppressionSummary.seen} seen</span> : null}
            {suppressionSummary.snoozed > 0 ? <span className="source-badge">{suppressionSummary.snoozed} later</span> : null}
            {hiddenCount > 0 ? <span className="source-badge">{hiddenCount} hidden</span> : null}
          </div>
        ) : null}
        {visibleItems.length > 0 || hiddenCount > 0 ? (
          <div className="overview-feed-policy">
            <div className="overview-feed-policy-copy">
              <strong>Queue policy</strong>
              <small>Seen keeps the item visible but stops it reclaiming the head. Done hides it until the wake signature changes. Later snoozes it for 10 minutes.</small>
              <p>{feedPolicyFeedback({
                hiddenCount,
                selectedItem,
                suppression,
                suppressionSummary,
                visibleItems,
              })}</p>
              {policyResult ? <p className="overview-feed-policy-result">{policyResult}</p> : null}
            </div>
            <div className="overview-feed-policy-actions">
              {visibleItems.length > 1 ? (
                <button className="secondary compact-button" onClick={markAllVisibleSeen} type="button">
                  Mark visible seen
                </button>
              ) : null}
              {visibleItems.length > 1 ? (
                <button className="secondary compact-button" onClick={() => snoozeAllVisible()} type="button">
                  Snooze visible
                </button>
              ) : null}
              {visibleItems.length > 1 ? (
                <button className="secondary compact-button" onClick={markAllVisibleDone} type="button">
                  Done visible
                </button>
              ) : null}
              {suppressionSummary.seen > 0 ? (
                <button className="secondary compact-button" onClick={clearSeen} type="button">
                  Restore seen
                </button>
              ) : null}
              {suppressionSummary.done > 0 ? (
                <button className="secondary compact-button" onClick={clearDone} type="button">
                  Restore done
                </button>
              ) : null}
              {suppressionSummary.snoozed > 0 ? (
                <button className="secondary compact-button" onClick={clearSnoozed} type="button">
                  Restore later
                </button>
              ) : null}
              {hiddenCount > 0 ? (
                <button className="secondary compact-button" onClick={clearSuppressed} type="button">
                  Restore all
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {selectedItem ? (
          <div className="overview-feed-header-actions">
            <button className="secondary compact-button" onClick={() => stepSelection(-1)} title="Focus the previous queue item." type="button">
              Prev
            </button>
            <button className="secondary compact-button" onClick={() => stepSelection(1)} title="Focus the next queue item." type="button">
              Next
            </button>
            <button className="secondary compact-button" onClick={openSelected} title={`Open ${selectedItem.title}`} type="button">
              Open top
            </button>
            {selectedItem.action && selectedItem.actionLabel ? (
              <button className="compact-button" onClick={runSelectedAction} title={`${selectedItem.actionLabel} ${selectedItem.title}`} type="button">
                {selectedItem.actionLabel}
              </button>
            ) : null}
            <button className="secondary compact-button" onClick={() => {
              markDone(selectedItem);
              stepSelection(1, selectedItem.id);
            }} title={`Hide ${selectedItem.title} until this queue item changes.`} type="button">
              Done
            </button>
            <button className="secondary compact-button" onClick={() => {
              markSeen(selectedItem);
              stepSelection(1, selectedItem.id);
            }} title={`Keep ${selectedItem.title} visible but stop it reclaiming the queue head until it meaningfully changes.`} type="button">
              Seen
            </button>
            <button className="secondary compact-button" onClick={() => {
              snooze(selectedItem);
              stepSelection(1, selectedItem.id);
            }} title={`Snooze ${selectedItem.title} for 10 minutes.`} type="button">
              Later
            </button>
          </div>
        ) : hiddenCount > 0 ? (
          <button className="secondary compact-button" onClick={clearSuppressed} type="button">
            Restore all
          </button>
        ) : <small>Clear</small>}
      </header>
      {selectedItem ? (
        <div className="overview-feed-focus">
          <div className="overview-feed-focus-main">
            <div className="overview-feed-badges">
              <span className="status">Now {selectedIndex + 1}/{visibleItems.length}</span>
              <span className={`support-badge ${feedPriorityClass(selectedItem.priority)}`}>{feedPriorityLabel(selectedItem.priority)}</span>
              <span className="source-badge">{selectedItem.category}</span>
              {visibleItems.length - (selectedIndex + 1) > 0 ? <span className="source-badge">{visibleItems.length - (selectedIndex + 1)} remaining</span> : null}
            </div>
            <strong>{selectedItem.title}</strong>
            <small>{selectedItem.summary}</small>
          </div>
          <div className="overview-feed-focus-next">
            <span>Next</span>
            <strong>{nextItem?.title ?? "Queue clear after this item"}</strong>
            <small>{nextItem?.meta ?? "No further queued items."}</small>
          </div>
        </div>
      ) : null}
      {visibleItems.length > 0 ? (
        <div className="overview-feed-list">
          {visibleItems.map((item, index) => (
            <article className={`overview-feed-item ${selectedItem?.id === item.id ? "selected" : ""}`} key={item.id}>
              <div className="overview-feed-copy">
                <div className="overview-feed-badges">
                  <span className="status">{index + 1}</span>
                  <span className={`support-badge ${feedPriorityClass(item.priority)}`}>{feedPriorityLabel(item.priority)}</span>
                  <span className="source-badge">{item.category}</span>
                  {isSeenFeedItem(item, suppression[item.id]) ? <span className="source-badge">Seen</span> : null}
                </div>
                <strong>{item.title}</strong>
                <small>{item.meta}</small>
                <p>{item.summary}</p>
              </div>
              <div className="overview-feed-actions">
                <button
                  className="secondary compact-button"
                  onClick={() => {
                    setSelectedId(item.id);
                    onOpen(item.intent);
                    stepSelection(1, item.id);
                  }}
                  type="button"
                >
                  Open
                </button>
                {item.action && item.actionLabel ? (
                  <button
                    className="compact-button"
                    onClick={() => {
                      setSelectedId(item.id);
                      onAction(item.action!, item.overview.task);
                      stepSelection(1, item.id);
                    }}
                    type="button"
                  >
                    {item.actionLabel}
                  </button>
                ) : null}
                <button className="secondary compact-button" onClick={() => setSelectedId(item.id)} type="button">
                  Focus
                </button>
                <button className="secondary compact-button" onClick={() => {
                  markDone(item);
                  stepSelection(1, item.id);
                }} type="button">
                  Done
                </button>
                <button className="secondary compact-button" onClick={() => {
                  markSeen(item);
                  stepSelection(1, item.id);
                }} type="button">
                  Seen
                </button>
                <button className="secondary compact-button" onClick={() => {
                  snooze(item);
                  stepSelection(1, item.id);
                }} type="button">
                  Later
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : <p className="empty">{hiddenCount > 0 ? "All current items are suppressed. Use Show hidden to restore them." : empty}</p>}
    </section>
  );
}

function loadFeedSuppression(storageKey: string): Record<string, FeedItemSuppression> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, FeedItemSuppression>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveFeedSuppression(storageKey: string, suppression: Record<string, FeedItemSuppression>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(suppression));
    window.dispatchEvent(new CustomEvent("agent-workbench:feed-policy", {
      detail: { storageKey },
    }));
  } catch {
    // Ignore local persistence failures and keep the in-memory queue state working.
  }
}

function setFeedPolicyState(storageKey: string, item: OverviewFeedItem, state: FeedPolicyState): FeedPolicyState {
  const suppression = loadFeedSuppression(storageKey);
  if (state === "active") {
    delete suppression[item.id];
    saveFeedSuppression(storageKey, suppression);
    return state;
  }

  if (state === "done") {
    suppression[item.id] = {
      doneWakeSignature: item.wakeSignature,
    };
  } else if (state === "later") {
    suppression[item.id] = {
      snoozeUntil: Date.now() + 10 * 60 * 1000,
      snoozeWakeSignature: item.wakeSignature,
    };
  } else {
    suppression[item.id] = {
      seenWakeSignature: item.wakeSignature,
    };
  }
  saveFeedSuppression(storageKey, suppression);
  return state;
}

function summarizeFeedSuppression(
  suppression: Record<string, FeedItemSuppression>,
  itemById: Map<string, OverviewFeedItem>,
): { done: number; seen: number; snoozed: number } {
  const now = Date.now();
  let done = 0;
  let seen = 0;
  let snoozed = 0;
  for (const [id, state] of Object.entries(suppression)) {
    const item = itemById.get(id);
    if (!item) {
      continue;
    }
    if (state.doneWakeSignature && state.doneWakeSignature === item.wakeSignature) {
      done += 1;
      continue;
    }
    if (state.seenWakeSignature && state.seenWakeSignature === item.wakeSignature) {
      seen += 1;
    }
    if (state.snoozeUntil && state.snoozeUntil > now && state.snoozeWakeSignature === item.wakeSignature) {
      snoozed += 1;
    }
  }
  return { done, seen, snoozed };
}

function cleanupFeedSuppression(
  suppression: Record<string, FeedItemSuppression>,
  itemById: Map<string, OverviewFeedItem>,
): Record<string, FeedItemSuppression> {
  const now = Date.now();
  let changed = false;
  const next: Record<string, FeedItemSuppression> = {};
  for (const [id, state] of Object.entries(suppression)) {
    const item = itemById.get(id);
    if (!item) {
      changed = true;
      continue;
    }
    const cleaned: FeedItemSuppression = {};
    if (state.doneWakeSignature && state.doneWakeSignature === item.wakeSignature) {
      cleaned.doneWakeSignature = state.doneWakeSignature;
    } else if (state.doneWakeSignature) {
      changed = true;
    }
    if (state.seenWakeSignature && state.seenWakeSignature === item.wakeSignature) {
      cleaned.seenWakeSignature = state.seenWakeSignature;
    } else if (state.seenWakeSignature) {
      changed = true;
    }
    if (state.snoozeUntil && state.snoozeUntil > now && state.snoozeWakeSignature === item.wakeSignature) {
      cleaned.snoozeUntil = state.snoozeUntil;
      cleaned.snoozeWakeSignature = state.snoozeWakeSignature;
    } else if (state.snoozeUntil || state.snoozeWakeSignature) {
      changed = true;
    }
    if (cleaned.doneWakeSignature || cleaned.seenWakeSignature || cleaned.snoozeUntil || cleaned.snoozeWakeSignature) {
      next[id] = cleaned;
    } else if (Object.keys(state).length > 0) {
      changed = true;
    }
  }
  return changed ? next : suppression;
}

function isSeenFeedItem(item: OverviewFeedItem, state?: FeedItemSuppression): boolean {
  return Boolean(state?.seenWakeSignature && state.seenWakeSignature === item.wakeSignature);
}

function feedPolicyEntriesForOverview(overview: SessionOverview): FeedPolicyEntry[] {
  const entries: FeedPolicyEntry[] = [];
  const attentionItem = buildAttentionFeed([overview])[0];
  const shipItem = buildShipFeed([overview])[0];

  const attentionState = attentionItem ? feedPolicyStateFromStorage(FEED_STORAGE_KEYS.attention, attentionItem) : undefined;
  if (attentionItem) {
    entries.push({
      description: feedPolicyDescription("Attention", attentionState),
      feed: "Attention",
      item: attentionItem,
      label: feedPolicyLabel(attentionState ?? "active"),
      state: attentionState ?? "active",
      storageKey: FEED_STORAGE_KEYS.attention,
    });
  }

  const shipState = shipItem ? feedPolicyStateFromStorage(FEED_STORAGE_KEYS.ship, shipItem) : undefined;
  if (shipItem) {
    entries.push({
      description: feedPolicyDescription("Ship", shipState),
      feed: "Ship",
      item: shipItem,
      label: feedPolicyLabel(shipState ?? "active"),
      state: shipState ?? "active",
      storageKey: FEED_STORAGE_KEYS.ship,
    });
  }

  return entries;
}

function feedPolicyStateFromStorage(storageKey: string, item: OverviewFeedItem): Exclude<FeedPolicyState, "active"> | undefined {
  const suppression = loadFeedSuppression(storageKey);
  const state = suppression[item.id];
  if (!state) {
    return undefined;
  }
  if (state.doneWakeSignature === item.wakeSignature) {
    return "done";
  }
  if (state.snoozeUntil && state.snoozeUntil > Date.now() && state.snoozeWakeSignature === item.wakeSignature) {
    return "later";
  }
  if (state.seenWakeSignature === item.wakeSignature) {
    return "seen";
  }
  return undefined;
}

function feedPolicyLabel(state: FeedPolicyState): string {
  switch (state) {
    case "active":
      return "Active";
    case "done":
      return "Done";
    case "later":
      return "Later";
    case "seen":
      return "Seen";
  }
}

function feedPolicyDescription(feed: FeedPolicyEntry["feed"], state?: Exclude<FeedPolicyState, "active">): string {
  switch (state) {
    case "done":
      return `${feed} feed hides this session until its wake signature materially changes.`;
    case "later":
      return `${feed} feed snoozes this session temporarily until timeout or wake change.`;
    case "seen":
      return `${feed} feed keeps this session visible but prevents it from reclaiming queue head automatically.`;
    default:
      return `${feed} feed treats this session as active and eligible for normal queue ordering.`;
  }
}

function detailPolicySummary(entries: FeedPolicyEntry[]): string {
  return entries.map((entry) => `${entry.feed} is ${entry.label.toLowerCase()}`).join(" · ");
}

function detailSnapshotSummary(overview: SessionOverview): string {
  if (overview.snapshotCount > 0) {
    return `${overview.snapshotCount} snapshot restore point${overview.snapshotCount === 1 ? "" : "s"} available. Open Snapshots before risky apply or delivery steps.`;
  }
  if (overview.filesChanged > 0) {
    return "No snapshot saved yet. Create one now before risky apply or delivery steps.";
  }
  return "No snapshot needed until this session has changed files.";
}

function detailPolicyActionResult(feed: FeedPolicyEntry["feed"], state: FeedPolicyState): string {
  switch (state) {
    case "active":
      return `${feed} queue policy restored. This session can participate in normal queue ordering again.`;
    case "done":
      return `${feed} queue now marks this session done until its wake signature materially changes.`;
    case "later":
      return `${feed} queue snoozed this session for 10 minutes or until its wake signature changes.`;
    case "seen":
      return `${feed} queue now keeps this session visible without letting it automatically reclaim queue head.`;
  }
}

function feedPolicyFeedback({
  hiddenCount,
  selectedItem,
  suppression,
  suppressionSummary,
  visibleItems,
}: {
  hiddenCount: number;
  selectedItem?: OverviewFeedItem;
  suppression: Record<string, FeedItemSuppression>;
  suppressionSummary: { done: number; seen: number; snoozed: number };
  visibleItems: OverviewFeedItem[];
}): string {
  if (visibleItems.length === 0) {
    if (hiddenCount > 0) {
      return "All current queue items are suppressed by policy. Restore seen, done, later, or all items to resume triage.";
    }
    return "No active queue items.";
  }

  const unseenVisible = visibleItems.filter((item) => !isSeenFeedItem(item, suppression[item.id])).length;
  const parts = [
    unseenVisible > 0
      ? `Head prefers unread visible items; ${unseenVisible} item${unseenVisible === 1 ? "" : "s"} can still reclaim the queue head.`
      : "All visible items are marked seen, so the queue head falls back to the oldest remaining visible item.",
    suppressionSummary.done > 0 ? `${suppressionSummary.done} done item${suppressionSummary.done === 1 ? "" : "s"} hidden until wake changes.` : undefined,
    suppressionSummary.snoozed > 0 ? `${suppressionSummary.snoozed} later item${suppressionSummary.snoozed === 1 ? "" : "s"} snoozed until timeout or wake change.` : undefined,
    selectedItem && isSeenFeedItem(selectedItem, suppression[selectedItem.id]) ? "The current focus is seen, so it will stay visible without automatically reclaiming head position." : undefined,
  ].filter(Boolean);

  return parts.join(" ");
}

function OverviewRow({
  busyAction,
  onAction,
  onOpen,
  overview,
  selectedTaskId,
}: {
  busyAction?: SessionUiAction;
  onAction: (action: OverviewRowAction, task: Task) => void;
  onOpen: (intent: SessionOpenIntent) => void;
  overview: SessionOverview;
  selectedTaskId?: string;
}): React.JSX.Element {
  return (
    <div
      className={`overview-table-row ${overview.task.id === selectedTaskId ? "selected" : ""}`}
      key={overview.task.id}
    >
      <span className="overview-session">
        <strong>{overview.task.title}</strong>
        <small>
          {overview.projectName} · {overview.agentName} · {shortSessionIdentity(overview.task)}
        </small>
      </span>
      <span className="overview-status" title={[overviewHealthTitle(overview), overviewActivityTitle(overview)].filter(Boolean).join("\n\n")}>
        <span className="overview-status-head">
          <HealthPill overview={overview} />
          <StagePill overview={overview} />
        </span>
        <small>{overviewStatusText(overview)}</small>
      </span>
      <span className="overview-delivery" title={overviewDeliveryTitle(overview)}>
        <DeliveryPill overview={overview} />
        <small>{overviewDeliveryText(overview)}</small>
      </span>
      <span className="overview-files" title={overviewFilesTitle(overview)}>
        <strong>{overview.filesChanged}</strong>
        <small>{overviewFilesText(overview)}</small>
      </span>
      <span
        className={overview.lastError && ["blocked", "stuck", "failed"].includes(overview.health) ? "overview-summary error-text" : "overview-summary"}
        title={[overviewBlockerTitle(overview), overviewNextActionTitle(overview)].filter(Boolean).join("\n\n")}
      >
        <strong>{overviewBlockerText(overview)}</strong>
        <small>{overview.nextAction}</small>
      </span>
      <OverviewRowActions
        busyAction={busyAction}
        onAction={onAction}
        onOpen={onOpen}
        overview={overview}
      />
    </div>
  );
}

function overviewMatchesFilter(overview: SessionOverview, filter: OverviewFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs_action":
      return ["attention", "blocked", "stuck", "failed"].includes(overview.health);
    case "running":
      return overview.health === "running";
    case "review":
      return overview.health === "attention";
    case "blocked":
      return ["blocked", "stuck", "failed"].includes(overview.health);
    case "overlap":
      return overview.overlapFiles.length > 0;
  }
}

function buildAttentionFeed(overviews: SessionOverview[]): OverviewFeedItem[] {
  return overviews
    .filter((overview) => (
      overview.waitingApprovals > 0
      || overview.conflictFiles.length > 0
      || overview.overlapFiles.length > 0
      || overview.stuck
      || overview.health === "failed"
      || overview.health === "blocked"
    ))
    .sort(compareAttentionFeedOverview)
    .slice(0, 5)
    .map((overview) => ({
      action: attentionFeedAction(overview),
      actionLabel: attentionFeedActionLabel(overview),
      category: attentionFeedCategory(overview),
      id: `attention-${overview.task.id}`,
      intent: {
        tab: defaultSessionTabForOverview(overview),
        taskId: overview.task.id,
      },
      meta: `${overview.projectName} · ${overview.agentName}`,
      overview,
      priority: attentionFeedPriority(overview),
      wakeSignature: `attention:${overview.task.id}:${overviewBlockerText(overview)}:${attentionFeedPriority(overview)}:${attentionFeedActionLabel(overview) ?? ""}`,
      summary: overviewBlockerSecondaryText(overview),
      title: `${overview.task.title} · ${overviewBlockerText(overview)}`,
    }));
}

function buildShipFeed(overviews: SessionOverview[]): OverviewFeedItem[] {
  return overviews
    .filter((overview) => (
      ["branch_ready", "compare_ready", "pr_ready", "pushed"].includes(overview.latestDelivery.status)
      || (overview.health === "attention" && overview.filesChanged > 0)
    ))
    .sort(compareShipFeedOverview)
    .slice(0, 5)
    .map((overview) => {
      const action = hasOverviewAction(overview, "apply")
        ? "apply"
        : hasOverviewAction(overview, "create_branch")
          ? "create_branch"
          : undefined;
      return {
        action,
        actionLabel: action === "apply" ? "Apply" : action === "create_branch" ? "Branch" : undefined,
        category: shipFeedCategory(overview),
        id: `ship-${overview.task.id}`,
        intent: {
          tab: defaultSessionTabForOverview(overview),
          taskId: overview.task.id,
        },
        meta: `${overview.projectName} · ${overviewDeliveryText(overview)}`,
        overview,
        priority: shipFeedPriority(overview),
        wakeSignature: `ship:${overview.task.id}:${overview.latestDelivery.status}:${shipFeedPriority(overview)}:${action ?? ""}`,
        summary: overview.health === "attention"
          ? "Review the diff and choose whether to apply, branch, or continue the session."
          : "Delivery outputs are ready. Confirm branch, compare link, or PR details before shipping.",
        title: `${overview.task.title} · ${overview.nextAction}`,
      };
    });
}

function attentionFeedPriority(overview: SessionOverview): "p0" | "p1" | "p2" {
  if (overview.waitingApprovals > 0 || overview.health === "failed" || overview.stuck) {
    return "p0";
  }
  if (overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) {
    return "p1";
  }
  return "p2";
}

function compareAttentionFeedOverview(left: SessionOverview, right: SessionOverview): number {
  return attentionFeedScore(right) - attentionFeedScore(left)
    || compareByRecentActivity(left, right)
    || left.task.title.localeCompare(right.task.title);
}

function attentionFeedScore(overview: SessionOverview): number {
  let score = 0;
  if (overview.waitingApprovals > 0) {
    score += 3000 + overview.waitingApprovals * 10;
  }
  if (overview.health === "failed") {
    score += 2600;
  }
  if (overview.stuck) {
    score += 2500;
  }
  if (overview.conflictFiles.length > 0) {
    score += 2200 + overview.conflictFiles.length * 5;
  }
  if (overview.overlapFiles.length > 0) {
    score += 2000 + overview.overlapFiles.length * 5;
  }
  if (overview.health === "blocked") {
    score += 1800;
  }
  if (overview.queuedTurns > 0) {
    score += Math.min(overview.queuedTurns, 10) * 8;
  }
  return score;
}

function attentionFeedCategory(overview: SessionOverview): string {
  if (overview.waitingApprovals > 0) {
    return "Approvals";
  }
  if (overview.conflictFiles.length > 0) {
    return "Conflicts";
  }
  if (overview.overlapFiles.length > 0) {
    return "Overlaps";
  }
  if (overview.stuck) {
    return "Stuck";
  }
  if (overview.health === "failed") {
    return "Failed";
  }
  return "Attention";
}

function attentionFeedAction(overview: SessionOverview): OverviewRowAction | undefined {
  if ((overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) && hasOverviewAction(overview, "create_branch")) {
    return "create_branch";
  }
  if ((overview.stuck || overview.health === "failed") && hasOverviewAction(overview, "rollback")) {
    return "rollback";
  }
  if (overview.queuedTurns > 0 && hasOverviewAction(overview, "clear_queue")) {
    return "clear_queue";
  }
  return undefined;
}

function attentionFeedActionLabel(overview: SessionOverview): string | undefined {
  const action = attentionFeedAction(overview);
  switch (action) {
    case "create_branch":
      return "Branch";
    case "rollback":
      return "Undo";
    case "clear_queue":
      return "Clear queue";
    default:
      return undefined;
  }
}

function shipFeedPriority(overview: SessionOverview): "p0" | "p1" | "p2" {
  if (overview.latestDelivery.status === "pr_ready") {
    return "p0";
  }
  if (overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pushed") {
    return "p1";
  }
  return "p2";
}

function compareShipFeedOverview(left: SessionOverview, right: SessionOverview): number {
  return shipFeedScore(right) - shipFeedScore(left)
    || compareByRecentActivity(left, right)
    || left.task.title.localeCompare(right.task.title);
}

function shipFeedScore(overview: SessionOverview): number {
  let score = 0;
  if (overview.latestDelivery.status === "pr_ready") {
    score += 3000;
  } else if (overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pushed") {
    score += 2400;
  } else if (overview.latestDelivery.status === "branch_ready") {
    score += 2000;
  } else if (overview.health === "attention" && overview.filesChanged > 0) {
    score += 1600;
  }
  if (hasOverviewAction(overview, "apply")) {
    score += 120;
  }
  if (overview.filesChanged > 0) {
    score += Math.min(overview.filesChanged, 20);
  }
  return score;
}

function shipFeedCategory(overview: SessionOverview): string {
  if (overview.latestDelivery.status === "pr_ready") {
    return "PR ready";
  }
  if (overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pushed") {
    return "Compare ready";
  }
  if (overview.latestDelivery.status === "branch_ready") {
    return "Branch ready";
  }
  return "Review ready";
}

function feedPriorityLabel(priority: "p0" | "p1" | "p2"): string {
  switch (priority) {
    case "p0":
      return "P0";
    case "p1":
      return "P1";
    case "p2":
      return "P2";
  }
}

function feedPriorityClass(priority: "p0" | "p1" | "p2"): "unsupported" | "partial" | "planned" {
  switch (priority) {
    case "p0":
      return "unsupported";
    case "p1":
      return "partial";
    case "p2":
      return "planned";
  }
}

function compareOverview(left: SessionOverview, right: SessionOverview, sort: OverviewSort): number {
  if (sort === "recent") {
    return compareByRecentActivity(left, right);
  }
  if (sort === "project") {
    return left.projectName.localeCompare(right.projectName)
      || compareByPriority(left, right)
      || left.task.title.localeCompare(right.task.title);
  }
  return compareByPriority(left, right) || compareByRecentActivity(left, right);
}

function compareByPriority(left: SessionOverview, right: SessionOverview): number {
  return overviewPriorityScore(right) - overviewPriorityScore(left)
    || compareByRecentActivity(left, right);
}

function compareByRecentActivity(left: SessionOverview, right: SessionOverview): number {
  return dateMs(right.lastEventAt ?? right.task.updatedAt) - dateMs(left.lastEventAt ?? left.task.updatedAt);
}

function overviewPriorityScore(overview: SessionOverview): number {
  let score = 0;
  if (overview.stuck) {
    score += 1000;
  }
  if (overview.health === "failed") {
    score += 950;
  }
  if (overview.waitingApprovals > 0) {
    score += 900 + overview.waitingApprovals * 10;
  }
  if (overview.conflictFiles.length > 0) {
    score += 850 + overview.conflictFiles.length * 5;
  }
  if (overview.overlapFiles.length > 0) {
    score += 780 + overview.overlapFiles.length * 5;
  }
  if (overview.health === "attention") {
    score += 700;
  }
  if (overview.latestDelivery.status === "pr_ready") {
    score += 680;
  } else if (overview.latestDelivery.status === "compare_ready") {
    score += 660;
  } else if (overview.latestDelivery.status === "branch_ready" || overview.latestDelivery.status === "pushed") {
    score += 620;
  }
  if (overview.filesChanged > 0) {
    score += Math.min(overview.filesChanged, 20) * 4;
  }
  if (overview.queuedTurns > 0) {
    score += Math.min(overview.queuedTurns, 10) * 8;
  }
  if (overview.activeTurn) {
    score += 220;
  }
  if (overview.health === "running") {
    score += 180;
  }
  if (overview.idleMs > 0) {
    score -= Math.min(Math.floor(overview.idleMs / 60000), 240);
  }
  return score;
}

function dateMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function groupOverviews(overviews: SessionOverview[]): Array<{
  description: string;
  id: OverviewGroupId;
  items: SessionOverview[];
  label: string;
  shortcuts: OverviewGroupShortcut[];
  summary: string[];
}> {
  const groups: Record<OverviewGroupId, SessionOverview[]> = {
    attention: [],
    quiet: [],
    ready: [],
    running: [],
  };

  for (const overview of overviews) {
    groups[overviewGroupId(overview)].push(overview);
  }

  const orderedGroups: Array<{
    description: string;
    id: OverviewGroupId;
    items: SessionOverview[];
    label: string;
    shortcuts: OverviewGroupShortcut[];
    summary: string[];
  }> = [
    {
      description: "Blocked, stuck, failed, overlapping, or waiting for operator input.",
      id: "attention",
      items: groups.attention,
      label: "Needs attention",
      shortcuts: overviewGroupShortcuts("attention", groups.attention),
      summary: summarizeOverviewGroup(groups.attention),
    },
    {
      description: "Actively executing or draining queued work.",
      id: "running",
      items: groups.running,
      label: "Running",
      shortcuts: overviewGroupShortcuts("running", groups.running),
      summary: summarizeOverviewGroup(groups.running),
    },
    {
      description: "Review-ready or delivery-ready sessions waiting for a ship decision.",
      id: "ready",
      items: groups.ready,
      label: "Ready",
      shortcuts: overviewGroupShortcuts("ready", groups.ready),
      summary: summarizeOverviewGroup(groups.ready),
    },
    {
      description: "Low-noise sessions with no urgent operator action.",
      id: "quiet",
      items: groups.quiet,
      label: "Quiet",
      shortcuts: overviewGroupShortcuts("quiet", groups.quiet),
      summary: summarizeOverviewGroup(groups.quiet),
    },
  ];

  return orderedGroups.filter((group) => group.items.length > 0);
}

function overviewGroupId(overview: SessionOverview): OverviewGroupId {
  if (
    overview.stuck
    || ["blocked", "failed"].includes(overview.health)
    || overview.waitingApprovals > 0
    || overview.conflictFiles.length > 0
    || overview.overlapFiles.length > 0
  ) {
    return "attention";
  }
  if (overview.health === "running" || overview.activeTurn || overview.queuedTurns > 0) {
    return "running";
  }
  if (
    overview.health === "attention"
    || ["branch_ready", "compare_ready", "pr_ready", "pushed"].includes(overview.latestDelivery.status)
  ) {
    return "ready";
  }
  return "quiet";
}

function summarizeOverviewGroup(items: SessionOverview[]): string[] {
  const approvals = items.reduce((count, overview) => count + overview.waitingApprovals, 0);
  const conflicts = items.reduce((count, overview) => count + overview.conflictFiles.length, 0);
  const overlaps = items.reduce((count, overview) => count + overview.overlapFiles.length, 0);
  const queued = items.reduce((count, overview) => count + overview.queuedTurns, 0);
  const active = items.filter((overview) => overview.activeTurn).length;
  const readyToShip = items.filter((overview) => ["branch_ready", "compare_ready", "pr_ready", "pushed"].includes(overview.latestDelivery.status)).length;
  const changed = items.reduce((count, overview) => count + overview.filesChanged, 0);

  return [
    approvals > 0 ? `${approvals} approvals` : undefined,
    conflicts > 0 ? `${conflicts} conflicts` : undefined,
    overlaps > 0 ? `${overlaps} overlaps` : undefined,
    queued > 0 ? `${queued} queued` : undefined,
    active > 0 ? `${active} active` : undefined,
    readyToShip > 0 ? `${readyToShip} ship-ready` : undefined,
    changed > 0 ? `${changed} files changed` : undefined,
  ].filter((value): value is string => Boolean(value)).slice(0, 1);
}

interface OverviewGroupShortcut {
  action?: OverviewRowAction;
  tab?: SessionWorkspaceTab;
  kind: "open" | "session_action";
  label: string;
  overview: SessionOverview;
  title: string;
}

function overviewGroupShortcuts(id: OverviewGroupId, items: SessionOverview[]): OverviewGroupShortcut[] {
  const [first] = items;
  if (!first) {
    return [];
  }

  switch (id) {
    case "attention": {
      const approvals = items.find((overview) => overview.waitingApprovals > 0);
      const conflicts = items.find((overview) => overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0);
      const failures = items.find((overview) => overview.stuck || ["blocked", "failed"].includes(overview.health));
      return dedupeOverviewGroupShortcuts([
        approvals ? {
          kind: "open",
          label: "Open approvals",
          tab: "changes",
          overview: approvals,
          title: `Open ${approvals.task.title} to resolve the first waiting approval in this group.`,
        } : undefined,
        conflicts ? {
          kind: "open",
          label: conflicts.conflictFiles.length > 0 ? "Open conflict" : "Open overlap",
          tab: "changes",
          overview: conflicts,
          title: `Open ${conflicts.task.title} to inspect the first ${conflicts.conflictFiles.length > 0 ? "conflict" : "overlap"} in this group.`,
        } : undefined,
        failures ? {
          kind: "open",
          label: failures.stuck ? "Open stuck" : "Open failed",
          tab: "debug",
          overview: failures,
          title: `Open ${failures.task.title} to inspect the first ${failures.stuck ? "stuck" : "failed"} session in this group.`,
        } : undefined,
        {
          kind: "open",
          label: "Open first blocked",
          tab: defaultSessionTabForOverview(first),
          overview: first,
          title: `Open ${first.task.title} to resolve the highest-ranked blocked session in this group.`,
        },
      ], 2);
    }
    case "running": {
      const live = items.find((overview) => overview.activeTurn) ?? first;
      const queued = items.find((overview) => overview.queuedTurns > 0);
      return dedupeOverviewGroupShortcuts([
        {
          kind: "open",
          label: "Open live",
          tab: "debug",
          overview: live,
          title: `Open ${live.task.title} to monitor the most active running session.`,
        },
        queued ? {
          kind: "open",
          label: "Open queue",
          tab: "debug",
          overview: queued,
          title: `Open ${queued.task.title} to inspect the first running session with queued work.`,
        } : undefined,
      ], 2);
    }
    case "ready": {
      const applyReady = items.find((overview) => hasOverviewAction(overview, "apply"));
      const branchReady = items.find((overview) => hasOverviewAction(overview, "create_branch"));
      return dedupeOverviewGroupShortcuts([
        applyReady ? {
          action: "apply",
          tab: "changes",
          kind: "session_action",
          label: "Apply ready",
          overview: applyReady,
          title: `Apply the highest-ranked ready session: ${applyReady.task.title}.`,
        } : undefined,
        !applyReady && branchReady ? {
          action: "create_branch",
          tab: "changes",
          kind: "session_action",
          label: "Branch ready",
          overview: branchReady,
          title: `Create a branch from the highest-ranked ready session: ${branchReady.task.title}.`,
        } : undefined,
        {
          kind: "open",
          label: "Open first ready",
          tab: defaultSessionTabForOverview(first),
          overview: first,
          title: `Open ${first.task.title} to review the highest-priority ready session.`,
        },
      ], 2);
    }
    case "quiet":
      return [{
        kind: "open",
        label: "Open latest quiet",
        tab: defaultSessionTabForOverview(first),
        overview: first,
        title: `Open ${first.task.title}, the highest-ranked quiet session.`,
      }];
  }
}

function dedupeOverviewGroupShortcuts(
  shortcuts: Array<OverviewGroupShortcut | undefined>,
  maxItems: number,
): OverviewGroupShortcut[] {
  const seen = new Set<string>();
  const result: OverviewGroupShortcut[] = [];
  for (const shortcut of shortcuts) {
    if (!shortcut) {
      continue;
    }
    if (seen.has(shortcut.overview.task.id)) {
      continue;
    }
    seen.add(shortcut.overview.task.id);
    result.push(shortcut);
    if (result.length >= maxItems) {
      break;
    }
  }
  return result;
}

function hasOverviewAction(overview: SessionOverview, action: OverviewRowAction): boolean {
  return overviewActionOptions(overview, false).some((option) => option.action === action && !option.disabled && option.priority > 0);
}

function defaultSessionTabForOverview(overview: SessionOverview): SessionWorkspaceTab {
  if (overview.waitingApprovals > 0 || overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) {
    return "changes";
  }
  if (["branch_ready", "compare_ready", "pr_ready", "pushed"].includes(overview.latestDelivery.status)) {
    return "changes";
  }
  if (overview.stuck || ["blocked", "failed"].includes(overview.health)) {
    return "debug";
  }
  if (overview.filesChanged > 0) {
    return "changes";
  }
  if (overview.activeTurn || overview.queuedTurns > 0) {
    return "debug";
  }
  return "changes";
}

function sessionTabForOverviewAction(action: OverviewRowAction): SessionWorkspaceTab {
  switch (action) {
    case "apply":
      return "changes";
    case "create_branch":
      return "changes";
    case "rollback":
    case "snapshot":
      return "snapshots";
    case "cancel":
    case "clear_queue":
      return "debug";
    case "discard":
      return "changes";
  }
}

function OverviewRowActions({
  busyAction,
  onAction,
  onOpen,
  overview,
}: {
  busyAction?: SessionUiAction;
  onAction: (action: OverviewRowAction, task: Task) => void;
  onOpen: (intent: SessionOpenIntent) => void;
  overview: SessionOverview;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismissibleMenu<HTMLDivElement>(menuOpen, () => setMenuOpen(false));
  const isBusy = busyAction !== undefined;
  const options = overviewActionOptions(overview, isBusy);
  const menuActions = options.filter((option) => option.priority > 0 || option.action === "discard");

  return (
    <div className="overview-row-action">
      <button
        className="compact-button"
        onClick={() => onOpen({ tab: defaultSessionTabForOverview(overview), taskId: overview.task.id })}
        type="button"
      >
        Open
      </button>
      {menuActions.length > 0 ? (
        <div className="overview-row-menu" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-label={`More actions for ${overview.task.title}`}
            className="session-menu-button secondary"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            ...
          </button>
          {menuOpen ? (
            <div className="session-menu" role="menu">
              {menuActions.map((option) => (
                <button
                  className={option.danger ? "danger" : undefined}
                  disabled={option.disabled}
                  key={option.action}
                  onClick={() => {
                    setMenuOpen(false);
                    onAction(option.action, overview.task);
                  }}
                  role="menuitem"
                  title={option.title}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface OverviewActionOption {
  action: OverviewRowAction;
  danger?: boolean;
  disabled: boolean;
  label: string;
  priority: number;
  title: string;
}

function overviewActionOptions(overview: SessionOverview, isBusy: boolean): OverviewActionOption[] {
  const isRunning = isTaskRunning(overview.task);
  const hasDiff = overview.filesChanged > 0;
  const hasSnapshot = overview.snapshotCount > 0;
  const hasConflict = overview.conflictFiles.length > 0;
  const hasOverlap = overview.overlapFiles.length > 0;
  const deliveryReady = ["branch_ready", "compare_ready", "pr_ready", "pushed"].includes(overview.latestDelivery.status);

  return [
    {
      action: "cancel",
      disabled: isBusy || !isRunning,
      label: "Stop",
      priority: isRunning ? 100 : 0,
      title: isRunning ? "Stop the current turn for this session." : "This session is not running.",
    },
    {
      action: "clear_queue",
      disabled: isBusy || overview.queuedTurns === 0,
      label: "Clear queue",
      priority: overview.queuedTurns > 0 ? (isRunning ? 90 : 55) : 0,
      title: overview.queuedTurns > 0 ? `Clear ${overview.queuedTurns} queued message${overview.queuedTurns === 1 ? "" : "s"}.` : "This session has no queued messages.",
    },
    {
      action: "apply",
      disabled: isBusy || isRunning || !hasDiff,
      label: "Apply",
      priority: !isRunning && hasDiff && !hasConflict && !hasOverlap ? (deliveryReady ? 98 : 95) : 0,
      title: hasDiff ? "Apply this session to the original repository." : "No changes to apply.",
    },
    {
      action: "create_branch",
      disabled: isBusy || isRunning || !hasDiff,
      label: "Branch",
      priority: !isRunning && hasDiff ? (hasConflict || hasOverlap ? 94 : deliveryReady ? 35 : 78) : 0,
      title: hasDiff ? "Create or update a branch from this session." : "No changes to branch.",
    },
    {
      action: "rollback",
      disabled: isBusy || isRunning || !hasSnapshot,
      label: "Undo",
      priority: !isRunning && hasSnapshot && !hasDiff ? 82 : !isRunning && hasSnapshot && overview.health === "failed" ? 72 : 0,
      title: hasSnapshot ? "Rollback this session worktree to the original repository state." : "No snapshot available.",
    },
    {
      action: "snapshot",
      disabled: isBusy,
      label: "Snapshot",
      priority: !isRunning && !deliveryReady ? (hasDiff ? 40 : 8) : 0,
      title: "Take a restore-point snapshot for this session.",
    },
    {
      action: "discard",
      danger: true,
      disabled: isBusy || isRunning,
      label: "Remove",
      priority: !isRunning && !hasDiff ? 25 : 0,
      title: isRunning ? "Stop or wait for the running task before removing it." : "Remove this isolated session.",
    },
  ];
}

function overviewFilesText(overview: SessionOverview): string {
  const files = overview.touchedFiles.slice(0, 4);
  if (files.length === 0) {
    return `+${overview.insertions} · no files`;
  }
  const suffix = overview.touchedFiles.length > files.length ? ` +${overview.touchedFiles.length - files.length} more` : "";
  return `+${overview.insertions} · ${files.join(", ")}${suffix}`;
}

function overviewFilesTitle(overview: SessionOverview): string {
  if (overview.touchedFiles.length === 0) {
    return "No changed files";
  }
  return [
    overview.touchedFiles.join("\n"),
    overview.overlapFiles.length > 0 ? `\nOverlaps:\n${overviewOverlapTitle(overview)}` : undefined,
  ].filter(Boolean).join("\n");
}

function overviewOverlapTitle(overview: SessionOverview): string {
  return overview.overlapFiles
    .map((file) => `${file.path}: ${file.sessions.map((session) => `${session.title} (${session.status})`).join(", ")}`)
    .join("\n");
}

function overviewRiskText(overview: SessionOverview): string {
  const idle = overview.idleMs > 0 ? `idle ${formatDuration(overview.idleMs)}` : undefined;
  const parts = [
    overview.risk,
    overview.overlapFiles.length > 0 ? `${overview.overlapFiles.length} overlaps` : undefined,
    overview.activeTurn ? "active" : idle,
    overview.queuedTurns > 0 ? `${overview.queuedTurns} queued` : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function overviewStatusText(overview: SessionOverview): string {
  return [overviewActivityText(overview), overviewRiskText(overview)]
    .filter(Boolean)
    .join(" · ");
}

function overviewHealthTitle(overview: SessionOverview): string {
  return [
    `Health: ${overview.health}`,
    overview.healthReason,
    `Risk: ${overview.risk}`,
    overview.riskReasons.length > 0 ? `Risk reasons: ${overview.riskReasons.join(", ")}` : undefined,
    `Status: ${overview.task.status}`,
    `Stage: ${overview.stage}`,
    `Agent: ${overview.agentName}`,
    `Queued turns: ${overview.queuedTurns}`,
    overview.overlapFiles.length > 0 ? `Overlapping files:\n${overviewOverlapTitle(overview)}` : undefined,
    `Runtime: ${formatDuration(overview.runtimeMs)}`,
    `Idle: ${formatDuration(overview.idleMs)}`,
    `Delivery: ${overview.latestDelivery.status}`,
    overview.latestDelivery.branch ? `Branch: ${overview.latestDelivery.branch}` : undefined,
    overview.latestDelivery.commitSha ? `Commit: ${overview.latestDelivery.commitSha}` : undefined,
    overview.latestDelivery.patchPath ? `Patch: ${overview.latestDelivery.patchPath}` : undefined,
    overview.latestDelivery.url ? `PR: ${overview.latestDelivery.url}` : undefined,
    overview.latestDelivery.compareUrl ? `Compare: ${overview.latestDelivery.compareUrl}` : undefined,
    overview.terminal ? `Terminal: ${overview.terminal.status}${overview.terminal.command ? ` (${overview.terminal.command})` : ""}` : undefined,
    overview.conflictFiles.length > 0 ? `Conflicts:\n${overview.conflictFiles.join("\n")}` : undefined,
    overview.snapshotCount > 0 ? `Snapshots: ${overview.snapshotCount}` : undefined,
  ].filter(Boolean).join("\n");
}

function overviewActivityText(overview: SessionOverview): string {
  const details = [
    overview.activeTurn ? "active now" : undefined,
    !overview.activeTurn && overview.terminal?.status === "running" ? "terminal live" : undefined,
    overview.queuedTurns > 0 ? `${overview.queuedTurns} queued` : undefined,
    overview.lastEventAt ? `last ${formatDuration(overview.idleMs)} ago` : undefined,
  ].filter(Boolean);
  return details.join(" · ") || "new";
}

function overviewActivityTitle(overview: SessionOverview): string {
  return [
    `Stage: ${overview.stage}`,
    overview.activeTurn ? "The session has an active turn in this server process." : "No active turn is attached right now.",
    overview.terminal?.status === "running" ? `Raw terminal is running${overview.terminal.command ? ` (${overview.terminal.command})` : ""}.` : undefined,
    overview.lastEventAt ? `Last active: ${formatDateTime(overview.lastEventAt)}` : undefined,
    `Runtime: ${formatDuration(overview.runtimeMs)}`,
    `Idle: ${formatDuration(overview.idleMs)}`,
    overview.queuedTurns > 0 ? `Queued turns: ${overview.queuedTurns}` : undefined,
  ].filter(Boolean).join("\n");
}

function overviewDeliveryTitle(overview: SessionOverview): string {
  const delivery = overview.latestDelivery;
  return [
    delivery.title,
    `Status: ${delivery.status}`,
    delivery.branch ? `Branch: ${delivery.branch}` : undefined,
    delivery.commitSha ? `Commit: ${delivery.commitSha}` : undefined,
    delivery.patchPath ? `Patch: ${delivery.patchPath}` : undefined,
    delivery.projectPath ? `Original repo: ${delivery.projectPath}` : undefined,
    delivery.url ? `PR: ${delivery.url}` : undefined,
    delivery.compareUrl ? `Compare: ${delivery.compareUrl}` : undefined,
    delivery.message ? `Message: ${delivery.message}` : undefined,
  ].filter(Boolean).join("\n");
}

function overviewDeliveryText(overview: SessionOverview): string {
  const delivery = overview.latestDelivery;
  if (delivery.status === "none") {
    return "not shipped";
  }
  if (delivery.url) {
    return "PR ready";
  }
  if (delivery.compareUrl) {
    return "compare ready";
  }
  if (delivery.patchPath) {
    return "patch saved";
  }
  if (delivery.branch) {
    return delivery.branch;
  }
  return delivery.title;
}

function overviewBlockerText(overview: SessionOverview): string {
  if (overview.waitingApprovals > 0) {
    return `${overview.waitingApprovals} approval${overview.waitingApprovals === 1 ? "" : "s"}`;
  }
  if (overview.conflictFiles.length > 0) {
    return `${overview.conflictFiles.length} conflict${overview.conflictFiles.length === 1 ? "" : "s"}`;
  }
  if (overview.overlapFiles.length > 0) {
    return `${overview.overlapFiles.length} overlap${overview.overlapFiles.length === 1 ? "" : "s"}`;
  }
  if (overview.stuck) {
    return "stuck";
  }
  if (overview.lastError && overview.health === "failed") {
    return "failed turn";
  }
  if (overview.health === "attention") {
    if (overview.latestDelivery.status === "branch_ready" || overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pr_ready") {
      return "delivery ready";
    }
    if (overview.filesChanged > 0) {
      return "review ready";
    }
  }
  return "none";
}

function overviewBlockerSecondaryText(overview: SessionOverview): string {
  if (overview.waitingApprovals > 0) {
    return "Awaiting operator decision";
  }
  if (overview.conflictFiles.length > 0) {
    return "Original repo differs on changed files";
  }
  if (overview.overlapFiles.length > 0) {
    return "Another session touches the same files";
  }
  if (overview.stuck) {
    return overview.healthReason;
  }
  if (overview.lastError && overview.health === "failed") {
    return overview.lastError;
  }
  if (overview.health === "attention") {
    return overview.latestDelivery.status === "none" ? "Human review recommended" : "Ready for ship decision";
  }
  return "No operator blocker";
}

function overviewBlockerTitle(overview: SessionOverview): string {
  return [
    `Blockers: ${overviewBlockerText(overview)}`,
    overview.waitingApprovals > 0 ? `${overview.waitingApprovals} approval request${overview.waitingApprovals === 1 ? "" : "s"} are unresolved.` : undefined,
    overview.conflictFiles.length > 0 ? `Conflicting files:\n${overview.conflictFiles.join("\n")}` : undefined,
    overview.overlapFiles.length > 0 ? `Overlapping files:\n${overviewOverlapTitle(overview)}` : undefined,
    overview.stuck ? overview.healthReason : undefined,
    overview.lastError && overview.health === "failed" ? `Last error: ${overview.lastError}` : undefined,
  ].filter(Boolean).join("\n");
}

function applyPreflightNotice(preflight: ApplyPreflight): string {
  const reason = [
    preflight.conflictFiles.length > 0 ? `${preflight.conflictFiles.length} local conflict${preflight.conflictFiles.length === 1 ? "" : "s"}` : undefined,
    preflight.overlapFiles.length > 0 ? `${preflight.overlapFiles.length} session overlap${preflight.overlapFiles.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join(", ") || "preflight issue";
  return `Apply blocked by ${reason}.`;
}

function overviewNextActionTitle(overview: SessionOverview): string {
  return [
    overview.nextAction,
    `Current step: ${overview.currentStep}`,
    overview.queuedTurns > 0 ? `Queued turns: ${overview.queuedTurns}` : undefined,
    overview.overlapFiles.length > 0 ? `Overlaps:\n${overviewOverlapTitle(overview)}` : undefined,
    overview.lastAgentMessage ? `Last agent message: ${overview.lastAgentMessage}` : undefined,
    overview.lastError ? `Last error: ${overview.lastError}` : undefined,
  ].filter(Boolean).join("\n");
}

function overviewSecondaryText(overview: SessionOverview): string {
  if (overview.lastError && ["blocked", "stuck", "failed"].includes(overview.health)) {
    return overview.lastError;
  }
  return overview.currentStep || overview.lastAgentMessage || overview.healthReason;
}

function HealthPill({ overview }: { overview: SessionOverview }): React.JSX.Element {
  return <span className={`status session-state-${overview.state}`}>{sessionStateLabel(overview.state)}</span>;
}

function StagePill({ overview }: { overview: SessionOverview }): React.JSX.Element {
  const labels: Record<SessionOverview["stage"], string> = {
    applied: "Applied",
    approval: `Approval ${overview.waitingApprovals}`,
    branch: "Branch",
    conflict: "Conflict",
    failed: overview.stuck ? "Stuck" : "Failed",
    idle: overview.task.status,
    pr: "PR",
    review: "Review",
    terminal: "Terminal",
    running: "Running",
  };
  return <span className={`status stage-${overview.stage}`}>{labels[overview.stage]}</span>;
}

function DeliveryPill({ overview }: { overview: SessionOverview }): React.JSX.Element {
  const labels: Record<SessionOverview["latestDelivery"]["status"], string> = {
    applied: "Applied",
    branch_ready: "Branch",
    compare_ready: "Compare",
    failed: "Failed",
    none: "None",
    patch_exported: "Patch",
    pr_ready: "PR",
    pushed: "Pushed",
    started: "Shipping",
  };
  return <span className={`status delivery-${overview.latestDelivery.status}`}>{labels[overview.latestDelivery.status]}</span>;
}

function isTaskRunning(task?: Task): boolean {
  return Boolean(task && ["running", "starting", "waiting_approval"].includes(task.status));
}

function ProjectDialog({
  onCancel,
  onSubmit,
  path,
  setPath,
}: {
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
  path: string;
  setPath: (path: string) => void;
}): React.JSX.Element {
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState(path.trim() || undefined);
  const [browserData, setBrowserData] = useState<DirectoryBrowserResponse>();
  const [browserError, setBrowserError] = useState<string>();
  const [browserLoading, setBrowserLoading] = useState(false);

  async function loadDirectory(targetPath?: string): Promise<void> {
    setBrowserOpen(true);
    setBrowserLoading(true);
    setBrowserError(undefined);
    try {
      const query = targetPath?.trim() ? `?path=${encodeURIComponent(targetPath.trim())}` : "";
      const result = await api<DirectoryBrowserResponse>(`/api/filesystem/directories${query}`);
      setBrowserData(result);
      setBrowserPath(result.path);
    } catch (directoryError) {
      setBrowserError(directoryError instanceof Error ? directoryError.message : String(directoryError));
    } finally {
      setBrowserLoading(false);
    }
  }

  function selectDirectory(selectedPath: string): void {
    setPath(selectedPath);
    setBrowserOpen(false);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        aria-labelledby="add-project-title"
        aria-modal="true"
        className={`modal ${browserOpen ? "wide project-browser-modal" : ""}`}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
      >
        <header>
          <h2 id="add-project-title">Add project</h2>
          <p>Register a local git repository for isolated agent sessions.</p>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>Repository path</span>
            <input autoFocus placeholder="/path/to/git/repo" value={path} onChange={(event) => setPath(event.target.value)} />
          </label>
          {browserOpen ? (
            <div className="directory-browser">
              <div className="directory-browser-toolbar">
                <button className="secondary compact-button" disabled={browserLoading || !browserData?.parentPath} onClick={() => void loadDirectory(browserData?.parentPath)} type="button">
                  Up
                </button>
                <button className="secondary compact-button" disabled={browserLoading} onClick={() => void loadDirectory()} type="button">
                  Home
                </button>
                <code title={browserData?.path ?? browserPath}>{browserData?.path ?? browserPath ?? "Loading..."}</code>
                <button
                  className="secondary compact-button"
                  disabled={browserLoading || !browserData}
                  onClick={() => browserData && selectDirectory(browserData.path)}
                  type="button"
                >
                  Use current
                </button>
              </div>
              {browserError ? <div className="error">{browserError}</div> : null}
              <div className="directory-browser-list" aria-label="Directories">
                {browserLoading ? <p className="empty">Loading directories...</p> : null}
                {!browserLoading && browserData?.entries.length === 0 ? <p className="empty">No readable child directories.</p> : null}
                {!browserLoading && browserData?.entries.map((entry) => (
                  <div className={`directory-browser-row ${entry.gitRepository ? "git-repo" : ""}`} key={entry.path}>
                    <button onClick={() => void loadDirectory(entry.path)} title={entry.path} type="button">
                      <span>{entry.gitRepository ? "Git" : "Dir"}</span>
                      <strong>{entry.name}</strong>
                      <small>{entry.path}</small>
                    </button>
                    <button className="secondary compact-button" onClick={() => selectDirectory(entry.path)} type="button">
                      Select
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <footer>
          <button className="secondary" onClick={() => void loadDirectory(path.trim() || undefined)} type="button">
            Browse
          </button>
          <button className="secondary" onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={!path.trim()} type="submit">
            Add project
          </button>
        </footer>
      </form>
    </div>
  );
}

function NewSessionDialog({
  backends,
  draft,
  onCancel,
  onChange,
  onSubmit,
  projects,
  tasks,
}: {
  backends: BackendStatus[];
  draft: NewSessionDraft;
  onCancel: () => void;
  onChange: (draft: NewSessionDraft) => void;
  onSubmit: (event: React.FormEvent) => void;
  projects: Project[];
  tasks: Task[];
}): React.JSX.Element {
  const selectedProject = projects.find((project) => project.id === draft.projectId);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchError, setBranchError] = useState<string>();
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement | null>(null);
  const branchAlreadyExists = branches.includes(draft.branchName.trim());

  useEffect(() => {
    if (!draft.projectId) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    void api<ProjectBranchListResponse>(`/api/projects/${draft.projectId}/branches`)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const projectBranches = result.branches.map((branch) => branch.name).filter((name) => !name.startsWith("agent-workbench/"));
        setBranches(projectBranches);
        setBranchError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBranches([]);
          setBranchError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [draft.projectId]);

  useEffect(() => {
    if (!branchMenuOpen) {
      return;
    }
    function closeOnOutsidePointer(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && branchPickerRef.current?.contains(target)) {
        return;
      }
      setBranchMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [branchMenuOpen]);

  useEffect(() => {
    const current = draft.branchName.trim();
    if (/^new-branch-\d+$/.test(current) && branches.includes(current)) {
      onChange({
        ...draft,
        branchName: nextWorkingBranchName(tasks, draft.projectId, branches),
      });
    }
  }, [branches, draft, onChange, tasks]);

  function updateProject(projectId: string): void {
    onChange({
      ...draft,
      branchName: nextWorkingBranchName(tasks, projectId),
      projectId,
    });
    setBranchMenuOpen(false);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        aria-labelledby="new-session-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
      >
        <header>
          <h2 id="new-session-title">New session</h2>
          <p>Create an isolated agent session for a selected project.</p>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>Project</span>
            <select
              autoFocus
              value={draft.projectId}
              onChange={(event) => updateProject(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {selectedProject ? <small>{selectedProject.path}</small> : null}
          </label>
          <label className="field">
            <span>Session branch</span>
            <div className="branch-picker" ref={branchPickerRef}>
              <input
                placeholder="new-branch-1"
                value={draft.branchName}
                onChange={(event) => onChange({ ...draft, branchName: event.currentTarget.value })}
              />
              <button
                aria-expanded={branchMenuOpen}
                aria-label="Show branches"
                className="secondary branch-picker-toggle"
                onClick={() => setBranchMenuOpen((open) => !open)}
                type="button"
              >
                ▾
              </button>
              {branchMenuOpen ? (
                <div className="branch-picker-menu">
                  {branches.length > 0 ? branches.map((branch) => (
                    <button
                      className="secondary"
                      key={branch}
                      onClick={() => {
                        onChange({ ...draft, branchName: branch });
                        setBranchMenuOpen(false);
                      }}
                      type="button"
                    >
                      {branch}
                    </button>
                  )) : <small>No branches found.</small>}
                </div>
              ) : null}
            </div>
            <small>Workbench creates this real branch in a dedicated session worktree. Use a new branch name for each session.</small>
            {branchAlreadyExists ? <small className="error-text">Branch already exists. Choose a new session branch name.</small> : null}
            {branchError ? <small className="error-text">{branchError}</small> : null}
          </label>
          <label className="field">
            <span>Session name</span>
            <input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
          </label>
          <label className="field">
            <span>Agent</span>
            <select value={draft.backendId} onChange={(event) => onChange({ ...draft, backendId: event.target.value })}>
              {backends.map((backend) => (
                <option key={backend.id} value={backend.id}>
                  {backend.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Mode</span>
            <select value={draft.modeId} onChange={(event) => onChange({ ...draft, modeId: event.target.value })}>
              {modeOptions.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
          {draft.backendId === "gemini-acp" ? (
            <small>Gemini ACP sessions create and keep a native Gemini session ID automatically.</small>
          ) : null}
          {draft.backendId === "codex" ? (
            <small>Codex sessions run in the native terminal and Workbench links the Codex resume ID after Codex writes metadata.</small>
          ) : null}
          {draft.backendId === "claude" ? (
            <small>Claude Code sessions use a fixed Workbench-created Claude session ID from the first attach, then reopen with claude --resume.</small>
          ) : null}
        </div>
        <footer>
          <button className="secondary" onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={!draft.projectId || !draft.title.trim() || !draft.branchName.trim() || branchAlreadyExists} type="submit">
            Create session
          </button>
        </footer>
      </form>
    </div>
  );
}

function NativeSessionImportDialog({
  currentTaskId,
  importingKey,
  onCancel,
  onImport,
  project,
  sessions,
  tasks,
}: {
  currentTaskId?: string;
  importingKey?: string;
  onCancel: () => void;
  onImport: (backendId: NativeCliBackendId, sessionId: string) => void;
  project: Project;
  sessions: NativeCliProjectSession[];
  tasks: Task[];
}): React.JSX.Element {
  const pageSize = 10;
  const availableBackendIds = useMemo(() => nativeSessionBackendOptions.filter((option) => sessions.some((session) => session.backendId === option.id)), [sessions]);
  const [backendId, setBackendId] = useState<NativeCliBackendId>(availableBackendIds[0]?.id ?? "gemini-acp");
  const [query, setQuery] = useState("");
  const [manualSessionId, setManualSessionId] = useState("");
  const [page, setPage] = useState(0);
  const selectedBackend = nativeSessionBackendOptions.find((option) => option.id === backendId) ?? nativeSessionBackendOptions[0]!;
  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = sessions
      .filter((session) => session.backendId === backendId)
      .filter((session) =>
        [
          session.backendName,
          session.displayName,
          session.firstUserMessage,
          session.summary,
          session.id,
        ]
          .filter(Boolean)
          .some((value) => !needle || value?.toLowerCase().includes(needle)),
      );
    return [...matching].sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
  }, [backendId, query, sessions]);
  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const visibleSessions = filteredSessions.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  useEffect(() => {
    setPage(0);
  }, [backendId, query]);

  function submitManualSessionId(event: React.FormEvent): void {
    event.preventDefault();
    const sessionId = manualSessionId.trim();
    if (!sessionId || importingKey) {
      return;
    }
    onImport(backendId, sessionId);
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        aria-labelledby="native-session-import-title"
        aria-modal="true"
        className="modal wide"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="native-session-import-title">Import native CLI session</h2>
          <p>{project.name} · open or import an existing Gemini, Codex, or Claude session into a linked Workbench session.</p>
        </header>
        <div className="modal-body">
          <div className="resume-gemini-grid">
            <label className="field">
              <span>Agent</span>
              <select value={backendId} onChange={(event) => setBackendId(event.target.value as NativeCliBackendId)}>
                {nativeSessionBackendOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}{availableBackendIds.some((available) => available.id === option.id) ? "" : " (none found)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Search {selectedBackend.label} sessions</span>
              <input
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title, prompt, or session ID"
                value={query}
              />
            </label>
            <form className="resume-gemini-manual" onSubmit={submitManualSessionId}>
              <label className="field">
                <span>{selectedBackend.label} session ID</span>
                <input
                  onChange={(event) => setManualSessionId(event.target.value)}
                  placeholder={selectedBackend.placeholder}
                  value={manualSessionId}
                />
              </label>
              <button disabled={!manualSessionId.trim() || Boolean(importingKey)} type="submit">
                {importingKey === nativeSessionKey(backendId, manualSessionId.trim()) ? "Opening" : "Access"}
              </button>
            </form>
          </div>
        </div>
        <div className="modal-body">
          {filteredSessions.length === 0 && !query.trim() ? (
            <p className="empty">No {selectedBackend.label} sessions were found for this project.</p>
          ) : filteredSessions.length === 0 ? (
            <p className="empty">No {selectedBackend.label} sessions match this search.</p>
          ) : (
            <>
              <div className="resume-gemini-toolbar">
                <small>
                  Showing {visibleSessions.length} of {filteredSessions.length} sessions · newest first
                </small>
                <div className="resume-gemini-pagination">
                  <button
                    className="secondary compact-button"
                    disabled={currentPage === 0 || Boolean(importingKey)}
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                    type="button"
                  >
                    Prev
                  </button>
                  <span>
                    Page {currentPage + 1} / {totalPages}
                  </span>
                  <button
                    className="secondary compact-button"
                    disabled={currentPage >= totalPages - 1 || Boolean(importingKey)}
                    onClick={() => setPage((value) => Math.min(totalPages - 1, value + 1))}
                    type="button"
                  >
                    Next
                  </button>
                </div>
              </div>
              <div className="native-session-list">
                {visibleSessions.map((session) => {
                  const linked = linkedNativeTaskForSession(tasks, project.id, session.backendId, session.id, currentTaskId);
                  const key = nativeSessionKey(session.backendId, session.id);
                  return (
                    <div className="native-session-item" key={key}>
                      <span className="native-session-copy">
                        <strong>{session.displayName}</strong>
                        <small>{session.summary || session.firstUserMessage || session.id}</small>
                        <div className="native-session-meta">
                          <small>{session.backendName}</small>
                          <small>{formatDateTime(session.lastUpdated)}</small>
                          <small>{session.messageCount} messages</small>
                          <code>{session.id}</code>
                        </div>
                      </span>
                      <span className="native-session-side">
                        {linked ? (
                          <span className={`source-badge ${linked.current ? "native-session-badge-current" : ""}`}>
                            {linked.current ? "Current" : "Linked"}
                          </span>
                        ) : null}
                        {linked ? <small>{linked.task.title}</small> : null}
                        <button
                          className="native-session-action secondary compact-button"
                          disabled={Boolean(importingKey)}
                          onClick={() => onImport(session.backendId, session.id)}
                          type="button"
                        >
                          {importingKey === key ? "Opening" : linked ? (linked.current ? "Open current" : "Open linked") : "Access"}
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <footer>
          <button className="secondary" disabled={Boolean(importingKey)} onClick={onCancel} type="button">
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}

function SessionActions({
  busyAction,
  diff,
  onAction,
  task,
  variant = "all",
}: {
  busyAction?: SessionUiAction;
  diff?: DiffSnapshot;
  onAction: (action: DiffPanelAction, input?: DeliveryActionInput) => void;
  task?: Task;
  variant?: "agent" | "apply" | "all" | "changes" | "delivery" | "snapshots";
}): React.JSX.Element {
  const hasDiff = Boolean(diff?.diffText.trim());
  const busy = busyAction !== undefined;
  const applied = task?.status === "applied";
  const running = isTaskRunning(task);
  const applyTooltip = "Advanced: apply this session branch patch to another branch.";
  const draftPrTooltip = "Create a draft PR from this session branch. Workbench automatically stages, commits, pushes, then creates the draft PR.";
  if (variant === "changes") {
    return (
      <section className="session-actions" aria-label="Changes actions">
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("delivery")} type="button">
          Delivery
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("branch_manager")} type="button">
          Session branch
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("snapshot")} type="button">
          {busyAction === "snapshot" ? "Saving" : "Take snapshot"}
        </button>
        <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("apply")} title={applyTooltip} type="button">
          {busyAction === "apply" ? "Applying" : !hasDiff && applied ? "Applied" : "Apply patch"}
        </button>
      </section>
    );
  }
  if (variant === "apply") {
    return (
      <section className="session-actions" aria-label="Apply actions">
        <button disabled={!task || !hasDiff || busy} onClick={() => onAction("apply")} title={applyTooltip} type="button">
          {busyAction === "apply" ? "Applying" : !hasDiff && applied ? "Applied" : "Apply to repo"}
        </button>
        <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("export_patch")} type="button">
          {busyAction === "export_patch" ? "Exporting" : "Export patch"}
        </button>
        <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("create_branch")} type="button">
          {busyAction === "create_branch" ? "Creating" : "Create branch"}
        </button>
      </section>
    );
  }
  if (variant === "delivery") {
    return (
      <section className="session-actions" aria-label="Delivery actions">
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("repo_add")} type="button">
          {busyAction === "repo_add" ? "Adding" : "Add"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("repo_commit")} type="button">
          {busyAction === "repo_commit" ? "Committing" : "Commit"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("push_branch")} type="button">
          {busyAction === "push_branch" ? "Pushing" : "Push"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("create_pr")} title={draftPrTooltip} type="button">
          {busyAction === "create_pr" ? "Creating" : "Draft PR"}
        </button>
      </section>
    );
  }
  if (variant === "snapshots") {
    return (
      <section className="session-actions" aria-label="Snapshot actions">
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("snapshot")} type="button">
          {busyAction === "snapshot" ? "Saving" : "Take snapshot"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("rollback")} type="button">
          {busyAction === "rollback" ? "Rolling back" : "Rollback"}
        </button>
      </section>
    );
  }
  if (variant === "agent") {
    return (
      <section className="session-actions" aria-label="Agent actions">
        <button className="danger" disabled={!task || !running || busy} onClick={() => onAction("cancel")} type="button">
          {busyAction === "cancel" ? "Stopping" : "Stop turn"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("resume")} type="button">
          {busyAction === "resume" ? "Reconnecting" : "Reconnect agent"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("clear_queue")} type="button">
          {busyAction === "clear_queue" ? "Clearing" : "Clear queue"}
        </button>
        <button className="secondary" disabled={!task || busy} onClick={() => onAction("diagnostics")} type="button">
          Agent console
        </button>
      </section>
    );
  }
  return (
    <section className="session-actions" aria-label="Session actions">
      <button disabled={!task || !hasDiff || busy} onClick={() => onAction("apply")} title={applyTooltip} type="button">
        {busyAction === "apply" ? "Applying" : !hasDiff && applied ? "Applied" : "Apply to repo"}
      </button>
      <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("export_patch")} type="button">
        {busyAction === "export_patch" ? "Exporting" : "Export patch"}
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("snapshot")} type="button">
        {busyAction === "snapshot" ? "Saving" : "Take snapshot"}
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("rollback")} type="button">
        {busyAction === "rollback" ? "Rolling back" : "Rollback"}
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("clear_queue")} type="button">
        {busyAction === "clear_queue" ? "Clearing" : "Clear queue"}
      </button>
      <button className="secondary" disabled={!task || !task.worktreePath || busy} onClick={() => onAction("copy_worktree")} type="button">
        {busyAction === "copy_worktree" ? "Copying" : "Copy path"}
      </button>
      <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("create_branch")} type="button">
        {busyAction === "create_branch" ? "Creating" : "Create branch"}
      </button>
      <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("push_branch")} type="button">
        {busyAction === "push_branch" ? "Pushing" : "Push branch"}
      </button>
      <button className="secondary" disabled={!task || !hasDiff || busy} onClick={() => onAction("create_pr")} title={draftPrTooltip} type="button">
        {busyAction === "create_pr" ? "Creating" : "Draft PR"}
      </button>
      <button className="danger" disabled={!task || !running || busy} onClick={() => onAction("cancel")} type="button">
        {busyAction === "cancel" ? "Stopping" : "Stop turn"}
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("resume")} type="button">
        {busyAction === "resume" ? "Reconnecting" : "Reconnect agent"}
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("diagnostics")} type="button">
        Agent console
      </button>
      <button className="secondary" disabled={!task || busy} onClick={() => onAction("export_report")} type="button">
        {busyAction === "export_report" ? "Exporting" : "Export report"}
      </button>
    </section>
  );
}

function sessionWorkspaceTabTitle(tab: SessionWorkspaceTab): string {
  switch (tab) {
    case "work":
      return "Events";
    case "changes":
      return "Changes";
    case "snapshots":
      return "Snapshots";
    case "debug":
      return "Diagnostics";
    case "shell":
      return "Terminal";
  }
}

function SessionWorkspaceTabs({
  active,
  diffCount,
  onSelect,
  snapshotCount,
}: {
  active: SessionWorkspaceTab;
  diffCount: number;
  onSelect: (tab: SessionWorkspaceTab) => void;
  snapshotCount: number;
}): React.JSX.Element {
  const tabs: Array<{ id: SessionWorkspaceTab; label: string; badge?: number }> = [
    { id: "changes", label: "Changes", badge: diffCount },
    { id: "work", label: "Events" },
    { id: "snapshots", label: "Snapshots", badge: snapshotCount },
    { id: "debug", label: "Diagnostics" },
    { id: "shell", label: "Terminal" },
  ];
  return (
    <nav className="session-tabs" aria-label="Session tabs">
      {tabs.map((tab) => (
        <button
          className={tab.id === active ? "selected" : ""}
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          type="button"
        >
          <span>{tab.label}</span>
          {tab.badge ? <strong>{tab.badge}</strong> : null}
        </button>
      ))}
    </nav>
  );
}

function SessionDetailSummary({
  busyAction,
  onAction,
  onOpenSession,
  onSelectTab,
  overview,
  task,
  tab,
}: {
  busyAction?: SessionUiAction;
  onAction: (action: DiffPanelAction, input?: DeliveryActionInput) => void;
  onOpenSession: (intent: SessionOpenIntent) => void;
  onSelectTab: (tab: SessionWorkspaceTab) => void;
  overview: SessionOverview;
  task?: Task;
  tab: SessionWorkspaceTab;
}): React.JSX.Element {
  const summary = detailSummaryBadges(overview);
  const policyEntries = useFeedPolicyEntries(overview);
  const visiblePolicyEntries = SHOW_EXPERIMENTAL_QUEUE_UI ? policyEntries : [];
  const [policyResult, setPolicyResult] = useState<string>();
  const [deliveryResult, setDeliveryResult] = useState<string>();
  const snapshotBusy = busyAction === "snapshot" || busyAction === "rollback";
  const hasSnapshots = overview.snapshotCount > 0;
  const recommendedActions = detailRecommendedActions(overview, busyAction !== undefined, tab);
  const deliveryEntryPoints = detailDeliveryEntryPoints(overview);
  const decision = detailDecisionState(overview);
  const fileScope = detailFileScope(overview);
  const relatedSessions = detailRelatedSessions(overview);
  const coordination = detailCoordinationState(relatedSessions);
  const applyReadiness = detailApplyReadiness(overview, busyAction !== undefined);
  const runtimeState = detailRuntimeState(overview, busyAction !== undefined);
  const deliveryArtifacts = detailDeliveryArtifacts(overview);
  const handoffState = detailHandoffState(overview, task, busyAction !== undefined);

  useEffect(() => {
    setPolicyResult(undefined);
    setDeliveryResult(undefined);
  }, [overview.task.id]);

  return (
    <section className="detail-summary" aria-label="Session state summary">
      <div className="detail-summary-row">
        <HealthPill overview={overview} />
        <DeliveryPill overview={overview} />
        <span className="source-badge">{detailSummaryGroupLabel(overview)}</span>
        {summary.map((item) => (
          <span className="source-badge" key={`${overview.task.id}-${item}`}>{item}</span>
        ))}
      </div>
      {recommendedActions.length > 0 ? (
        <div className="detail-recommended-actions">
          {recommendedActions.map((action) => (
            <button
              className={action.tone === "secondary" ? "secondary compact-button" : "compact-button"}
              disabled={action.disabled}
              key={`${overview.task.id}-${action.label}`}
              onClick={() => {
                if (action.tab) {
                  onSelectTab(action.tab);
                  return;
                }
                onAction(action.action);
              }}
              title={action.title}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {task?.agentSessionId && (task.backendId === "gemini" || task.backendId === "gemini-acp") ? (
        <div className="detail-summary-inline-note">
          <span className="source-badge" title={nativeSessionTitle(task)}>
            {nativeSessionDisplayLabel(task)}
          </span>
          <small>{nativeSessionSummary(task)}</small>
        </div>
      ) : null}
      <div className="detail-summary-groups">
        {(decision || fileScope) ? (
          <section className="detail-summary-group" aria-label="Operate">
            <span className="detail-summary-group-label">Operate</span>
            {decision ? (
              <div className="detail-decision-row">
                <span className="source-badge" title={overviewBlockerTitle(overview)}>
                  Decision: {decision.label}
                </span>
                <small>{decision.summary}</small>
                {tab !== decision.tab ? (
                  <div className="detail-decision-actions">
                    <button
                      className="secondary compact-button"
                      onClick={() => onSelectTab(decision.tab)}
                      type="button"
                    >
                      {decision.actionLabel}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {fileScope ? (
              <div className="detail-files-row">
                <span className="source-badge" title={overviewFilesTitle(overview)}>
                  Files: {overview.filesChanged}
                </span>
                {applyReadiness ? <span className="source-badge">Apply: {applyReadiness.label}</span> : null}
                <small>{applyReadiness ? `${fileScope.summary} · ${applyReadiness.summary}` : fileScope.summary}</small>
                <div className="detail-files-actions">
                  {tab !== "changes" ? (
                    <button
                      className="secondary compact-button"
                      onClick={() => onSelectTab("changes")}
                      type="button"
                    >
                      Open changes
                    </button>
                  ) : null}
                  {applyReadiness?.openTab && tab !== applyReadiness.openTab ? (
                    <button
                      className="secondary compact-button"
                      onClick={() => onSelectTab(applyReadiness.openTab!)}
                      type="button"
                    >
                      {applyReadiness.openLabel}
                    </button>
                  ) : null}
                  {applyReadiness?.action ? (
                    <button
                      className="secondary compact-button"
                      disabled={applyReadiness.disabled}
                      onClick={() => onAction(applyReadiness.action!)}
                      type="button"
                    >
                      {applyReadiness.actionLabel}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {(relatedSessions.length > 0 || runtimeState || visiblePolicyEntries.length > 0) ? (
          <section className="detail-summary-group" aria-label="Session flow">
            <span className="detail-summary-group-label">Session flow</span>
            {relatedSessions.length > 0 ? (
              <div className="detail-related-row">
                <span className="source-badge" title={overviewOverlapTitle(overview)}>
                  Related sessions: {relatedSessions.length}
                </span>
                <small>{coordination ? coordination.summary : detailRelatedSessionsSummary(relatedSessions.length)}</small>
                {coordination ? (
                  <div className="detail-coordination-actions">
                    <button
                      className="secondary compact-button"
                      onClick={() => onOpenSession({
                        tab: detailRelatedSessionTab(coordination.session.status),
                        taskId: coordination.session.taskId,
                      })}
                      type="button"
                    >
                      Open {coordination.session.title}
                    </button>
                  </div>
                ) : null}
                <div className="detail-related-items">
                  {relatedSessions.map((session) => (
                    <div className="detail-related-session" key={`${overview.task.id}-${session.taskId}`}>
                      <div className="detail-related-session-header">
                        <button
                          className="secondary compact-button"
                          onClick={() => onOpenSession({
                            tab: detailRelatedSessionTab(session.status),
                            taskId: session.taskId,
                          })}
                          title={`${session.title} · ${session.status}`}
                          type="button"
                        >
                          {session.title}
                        </button>
                        <span className="source-badge">{detailRelatedSessionStatusLabel(session.status)}</span>
                      </div>
                      <small>{detailRelatedSessionPathsSummary(session)}</small>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {runtimeState ? (
              <div className="detail-runtime-row">
                <span className="source-badge" title={overviewActivityTitle(overview)}>
                  Runtime: {runtimeState.label}
                </span>
                <small>{runtimeState.summary}</small>
                <div className="detail-runtime-actions">
                  {tab !== "debug" ? (
                    <button
                      className="secondary compact-button"
                      onClick={() => onSelectTab("debug")}
                      type="button"
                    >
                      Open diagnostics
                    </button>
                  ) : null}
                  {runtimeState.showStop ? (
                    <button
                      className="secondary compact-button"
                      disabled={runtimeState.disabled}
                      onClick={() => onAction("cancel")}
                      type="button"
                    >
                      Stop
                    </button>
                  ) : null}
                  {runtimeState.showClearQueue ? (
                    <button
                      className="secondary compact-button"
                      disabled={runtimeState.disabled}
                      onClick={() => onAction("clear_queue")}
                      type="button"
                    >
                      Clear queue
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {visiblePolicyEntries.length > 0 ? (
              <div className="detail-policy-row">
                {visiblePolicyEntries.map((entry) => (
                  <div className="detail-policy-control" key={`${overview.task.id}-${entry.feed}`} title={entry.description}>
                    <span className="source-badge">
                      {entry.feed}: {entry.label}
                    </span>
                    <div className="detail-policy-actions">
                      {(["seen", "later", "done"] as FeedPolicyState[]).map((nextState) => (
                        <button
                          className="secondary compact-button"
                          disabled={entry.state === nextState}
                          key={nextState}
                          onClick={() => {
                            setFeedPolicyState(entry.storageKey, entry.item, nextState);
                            setPolicyResult(detailPolicyActionResult(entry.feed, nextState));
                          }}
                          type="button"
                        >
                          {feedPolicyLabel(nextState)}
                        </button>
                      ))}
                      <button
                        className="secondary compact-button"
                        disabled={entry.state === "active"}
                        onClick={() => {
                          setFeedPolicyState(entry.storageKey, entry.item, "active");
                          setPolicyResult(detailPolicyActionResult(entry.feed, "active"));
                        }}
                        type="button"
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                ))}
                {policyResult ? <small>{policyResult}</small> : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {(deliveryEntryPoints.length > 0 || deliveryArtifacts.length > 0 || handoffState || hasSnapshots) ? (
          <section className="detail-summary-group" aria-label="Delivery and recovery">
            <span className="detail-summary-group-label">Delivery and recovery</span>
            {deliveryEntryPoints.length > 0 ? (
              <div className="detail-delivery-row">
                <span className="source-badge" title={overviewDeliveryTitle(overview)}>
                  Delivery: {overviewDeliveryText(overview)}
                </span>
                <div className="detail-delivery-actions">
                  {deliveryEntryPoints.map((entry) => (
                    <button
                      className="secondary compact-button"
                      key={`${overview.task.id}-${entry.label}`}
                      onClick={() => window.open(entry.href, "_blank", "noopener,noreferrer")}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {deliveryArtifacts.length > 0 ? (
              <div className="detail-delivery-artifacts-row">
                <span className="source-badge">Delivery artifacts: {deliveryArtifacts.length}</span>
                <div className="detail-delivery-artifacts">
                  {deliveryArtifacts.map((artifact) => (
                    <div className="detail-delivery-artifact" key={`${overview.task.id}-${artifact.label}`}>
                      <span className="source-badge">{artifact.label}</span>
                      <code title={artifact.value}>{artifact.displayValue}</code>
                      <button
                        className="secondary compact-button"
                        onClick={() => {
                          void copyText(artifact.value)
                            .then(() => setDeliveryResult(`${artifact.label} copied.`))
                            .catch(() => setDeliveryResult(`Failed to copy ${artifact.label.toLowerCase()}.`));
                        }}
                        type="button"
                      >
                        Copy
                      </button>
                    </div>
                  ))}
                </div>
                {deliveryResult ? <small>{deliveryResult}</small> : null}
              </div>
            ) : null}
            {handoffState ? (
              <div className="detail-handoff-row">
                <span className="source-badge">Handoff: {handoffState.label}</span>
                <small>{handoffState.summary}</small>
                <div className="detail-handoff-actions">
                  {handoffState.showExportReport ? (
                    <button
                      className="secondary compact-button"
                      disabled={handoffState.disabled}
                      onClick={() => onAction("export_report")}
                      type="button"
                    >
                      Export report
                    </button>
                  ) : null}
                  {handoffState.showExportPatch ? (
                    <button
                      className="secondary compact-button"
                      disabled={handoffState.disabled}
                      onClick={() => onAction("export_patch")}
                      type="button"
                    >
                      Export patch
                    </button>
                  ) : null}
                  {handoffState.showCopyPath ? (
                    <button
                      className="secondary compact-button"
                      disabled={handoffState.disabled}
                      onClick={() => onAction("copy_worktree")}
                      type="button"
                    >
                      Copy worktree
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {hasSnapshots ? (
              <div className="detail-snapshot-row">
                <span
                  className="source-badge"
                  title={hasSnapshots ? `${overview.snapshotCount} snapshot restore point${overview.snapshotCount === 1 ? "" : "s"} available.` : "No snapshot saved yet."}
                >
                  {hasSnapshots ? `Snapshots: ${overview.snapshotCount}` : "Snapshots: none"}
                </span>
                <div className="detail-snapshot-actions">
                  <button
                    className="secondary compact-button"
                    disabled={!hasSnapshots}
                    onClick={() => onSelectTab("snapshots")}
                    type="button"
                  >
                    Open snapshots
                  </button>
                  <button
                    className="secondary compact-button"
                    disabled={snapshotBusy}
                    onClick={() => onAction("snapshot")}
                    type="button"
                  >
                    {busyAction === "snapshot" ? "Saving" : "Take snapshot"}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      <div className="detail-summary-copy">
        <strong>{overview.nextAction}</strong>
        <small>{detailFocusText(tab, overview)}</small>
        <small>{detailPrimaryNarrative({
          applyReadiness,
          coordination,
          deliveryArtifactsCount: deliveryArtifacts.length,
          deliveryEntryPointsCount: deliveryEntryPoints.length,
          fileScope,
          handoffState,
          overview,
          policyEntries: visiblePolicyEntries,
          relatedSessionsCount: relatedSessions.length,
          runtimeState,
          snapshotsVisible: hasSnapshots,
        })}</small>
      </div>
    </section>
  );
}

interface FeedPolicyEntry {
  description: string;
  feed: "Attention" | "Ship";
  item: OverviewFeedItem;
  label: string;
  state: FeedPolicyState;
  storageKey: string;
}

function useFeedPolicyEntries(overview: SessionOverview): FeedPolicyEntry[] {
  const compute = () => feedPolicyEntriesForOverview(overview);
  const [entries, setEntries] = useState<FeedPolicyEntry[]>(compute);

  useEffect(() => {
    setEntries(compute());
  }, [overview]);

  useEffect(() => {
    const refresh = () => setEntries(compute());
    window.addEventListener("agent-workbench:feed-policy", refresh);
    return () => window.removeEventListener("agent-workbench:feed-policy", refresh);
  }, [overview]);

  return entries;
}

interface DetailRecommendedAction {
  action: DiffPanelAction;
  disabled: boolean;
  label: string;
  tab?: SessionWorkspaceTab;
  title: string;
  tone?: "primary" | "secondary";
}

function detailRecommendedActions(
  overview: SessionOverview,
  isBusy: boolean,
  currentTab: SessionWorkspaceTab,
): DetailRecommendedAction[] {
  const actions: DetailRecommendedAction[] = [];
  const defaultTab = defaultSessionTabForOverview(overview);
  if (defaultTab !== currentTab) {
    actions.push({
      action: "diagnostics",
      disabled: false,
      label: `Open ${sessionWorkspaceTabTitle(defaultTab)}`,
      tab: defaultTab,
      title: `Jump to the ${sessionWorkspaceTabTitle(defaultTab)} view for this session's current state.`,
    });
  }

  for (const option of overviewActionOptions(overview, isBusy)) {
    if (option.priority <= 0 || option.action === "discard") {
      continue;
    }
    actions.push({
      action: option.action,
      disabled: option.disabled,
      label: option.label,
      title: option.title,
      tone: actions.length === 0 ? "primary" : "secondary",
    });
    if (actions.length >= 2) {
      break;
    }
  }

  return actions.slice(0, 2);
}

interface DetailDeliveryEntryPoint {
  href: string;
  label: string;
}

interface DetailDeliveryArtifact {
  displayValue: string;
  label: string;
  value: string;
}

interface DetailDecisionState {
  actionLabel: string;
  explanation: string;
  label: string;
  summary: string;
  tab: SessionWorkspaceTab;
}

interface DetailFileScope {
  explanation: string;
  summary: string;
}

interface DetailRelatedSession {
  sharedPaths: string[];
  status: TaskStatus;
  taskId: string;
  title: string;
}

interface DetailCoordinationState {
  explanation: string;
  label: string;
  session: DetailRelatedSession;
  summary: string;
}

interface DetailApplyReadiness {
  action?: DiffPanelAction;
  actionLabel?: string;
  disabled?: boolean;
  explanation: string;
  label: string;
  openLabel?: string;
  openTab?: SessionWorkspaceTab;
  summary: string;
}

interface DetailRuntimeState {
  disabled: boolean;
  explanation: string;
  label: string;
  showClearQueue: boolean;
  showStop: boolean;
  summary: string;
}

interface DetailHandoffState {
  disabled: boolean;
  explanation: string;
  label: string;
  showCopyPath: boolean;
  showExportPatch: boolean;
  showExportReport: boolean;
  summary: string;
}

function detailDeliveryEntryPoints(overview: SessionOverview): DetailDeliveryEntryPoint[] {
  const entries: DetailDeliveryEntryPoint[] = [];
  if (overview.latestDelivery.url) {
    entries.push({ href: overview.latestDelivery.url, label: "Open PR" });
  }
  if (overview.latestDelivery.compareUrl) {
    entries.push({ href: overview.latestDelivery.compareUrl, label: "Open compare" });
  }
  return entries;
}

function detailDeliveryArtifacts(overview: SessionOverview): DetailDeliveryArtifact[] {
  const artifacts: DetailDeliveryArtifact[] = [];
  if (overview.latestDelivery.branch) {
    artifacts.push({
      displayValue: overview.latestDelivery.branch,
      label: "Branch",
      value: overview.latestDelivery.branch,
    });
  }
  if (overview.latestDelivery.commitSha) {
    artifacts.push({
      displayValue: overview.latestDelivery.commitSha.slice(0, 12),
      label: "Commit",
      value: overview.latestDelivery.commitSha,
    });
  }
  if (overview.latestDelivery.patchPath) {
    artifacts.push({
      displayValue: truncateMiddle(overview.latestDelivery.patchPath, 52),
      label: "Patch",
      value: overview.latestDelivery.patchPath,
    });
  }
  return artifacts;
}

function detailDeliverySummary(overview: SessionOverview): string {
  if (overview.latestDelivery.url) {
    return "A PR delivery path already exists. Review the PR directly from summary before making another ship decision.";
  }
  if (overview.latestDelivery.compareUrl) {
    return "A compare-ready delivery path already exists. Review the branch diff directly from summary.";
  }
  if (overview.latestDelivery.branch) {
    return `Delivery output is already on branch ${overview.latestDelivery.branch}.`;
  }
  return "Delivery output is available for this session.";
}

function detailDeliveryArtifactsSummary(count: number): string {
  return `${count} delivery artifact${count === 1 ? "" : "s"} are directly available from summary for handoff, audit, or downstream shipping.`;
}

function detailDecisionState(overview: SessionOverview): DetailDecisionState | undefined {
  if (overview.waitingApprovals > 0) {
    return {
      actionLabel: "Open Changes",
      explanation: `This session is waiting on ${overview.waitingApprovals} approval request${overview.waitingApprovals === 1 ? "" : "s"}, so operator attention belongs in Changes first.`,
      label: overviewBlockerText(overview),
      summary: overviewBlockerSecondaryText(overview),
      tab: "changes",
    };
  }
  if (overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) {
    return {
      actionLabel: "Open Changes",
      explanation: "This session cannot be cleanly applied right now because the original repo or another session overlaps on changed files.",
      label: overviewBlockerText(overview),
      summary: overviewBlockerSecondaryText(overview),
      tab: "changes",
    };
  }
  if (overview.stuck || (overview.lastError && overview.health === "failed")) {
    return {
      actionLabel: "Open Diagnostics",
      explanation: "This session needs agent-level recovery work before further delivery decisions make sense.",
      label: overviewBlockerText(overview),
      summary: overviewBlockerSecondaryText(overview),
      tab: "debug",
    };
  }
  if (overview.latestDelivery.status !== "none") {
    return {
      actionLabel: "Open Changes",
      explanation: "This session already has delivery output, so the next operator decision is available from Delivery beside Session branch.",
      label: overviewBlockerText(overview),
      summary: overviewBlockerSecondaryText(overview),
      tab: "changes",
    };
  }
  if (overview.filesChanged > 0) {
    return {
      actionLabel: "Open Changes",
      explanation: "This session has changed files but no final delivery output yet, so review starts in Changes.",
      label: overviewBlockerText(overview),
      summary: overviewBlockerSecondaryText(overview),
      tab: "changes",
    };
  }
  return undefined;
}

function detailFileScope(overview: SessionOverview): DetailFileScope | undefined {
  if (overview.filesChanged === 0) {
    return undefined;
  }

  const listed = overview.touchedFiles.slice(0, 3);
  const remainder = overview.touchedFiles.length - listed.length;
  const fileSummary = listed.length > 0
    ? `${listed.join(", ")}${remainder > 0 ? ` +${remainder} more` : ""}`
    : `${overview.filesChanged} changed file${overview.filesChanged === 1 ? "" : "s"}`;

  if (overview.overlapFiles.length > 0) {
    return {
      explanation: `This session's file scope overlaps with ${overview.overlapFiles.length} active file target${overview.overlapFiles.length === 1 ? "" : "s"} in other sessions, so apply decisions need extra care.`,
      summary: `${fileSummary} · ${overview.overlapFiles.length} overlap${overview.overlapFiles.length === 1 ? "" : "s"}`,
    };
  }

  if (overview.conflictFiles.length > 0) {
    return {
      explanation: "The original repository already differs on part of this file scope, so direct apply is currently blocked.",
      summary: `${fileSummary} · ${overview.conflictFiles.length} conflict${overview.conflictFiles.length === 1 ? "" : "s"}`,
    };
  }

  return {
    explanation: "This is the current blast radius of the session. Review these files before apply or delivery actions.",
    summary: fileSummary,
  };
}

function detailRelatedSessions(overview: SessionOverview): DetailRelatedSession[] {
  const seen = new Map<string, DetailRelatedSession>();
  for (const overlap of overview.overlapFiles) {
    for (const session of overlap.sessions) {
      if (session.taskId === overview.task.id) {
        continue;
      }
      const existing = seen.get(session.taskId);
      if (existing) {
        existing.sharedPaths.push(overlap.path);
        continue;
      }
      seen.set(session.taskId, {
        ...session,
        sharedPaths: [overlap.path],
      });
    }
  }
  return Array.from(seen.values())
    .sort((left, right) =>
      detailRelatedSessionPriority(right.status) - detailRelatedSessionPriority(left.status)
      || right.sharedPaths.length - left.sharedPaths.length
      || left.title.localeCompare(right.title))
    .slice(0, 4);
}

function detailRelatedSessionsSummary(count: number): string {
  return `${count} related session${count === 1 ? "" : "s"} currently touch the same file scope. Open them directly from summary before deciding to apply or branch.`;
}

function detailRelatedSessionPathsSummary(session: DetailRelatedSession): string {
  const listed = session.sharedPaths.slice(0, 2);
  const remainder = session.sharedPaths.length - listed.length;
  return `${listed.join(", ")}${remainder > 0 ? ` +${remainder} more` : ""}`;
}

function detailRelatedSessionPriority(status: TaskStatus): number {
  switch (status) {
    case "running":
    case "starting":
      return 5;
    case "waiting_approval":
      return 4;
    case "failed":
      return 3;
    case "review_ready":
    case "branch_ready":
    case "pr_ready":
      return 2;
    default:
      return 1;
  }
}

function detailRelatedSessionStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "waiting_approval":
      return "Approval";
    case "review_ready":
      return "Review";
    case "branch_ready":
      return "Branch";
    case "pr_ready":
      return "PR";
    case "failed":
      return "Failed";
    case "completed":
      return "Done";
    case "applied":
      return "Applied";
    case "cancelled":
      return "Cancelled";
    case "created":
      return "Created";
  }
}

function detailRelatedSessionTab(status: TaskStatus): SessionWorkspaceTab {
  switch (status) {
    case "running":
    case "starting":
    case "failed":
      return "debug";
    case "waiting_approval":
      return "changes";
    case "branch_ready":
    case "pr_ready":
      return "changes";
    case "review_ready":
    case "completed":
    case "applied":
      return "changes";
    default:
      return "changes";
  }
}

function detailCoordinationState(relatedSessions: DetailRelatedSession[]): DetailCoordinationState | undefined {
  const first = relatedSessions[0];
  if (!first) {
    return undefined;
  }
  if (first.status === "running" || first.status === "starting") {
    return {
      explanation: `${first.title} is still actively running on the same file scope, so coordination should start there before applying or branching here.`,
      label: "live overlap",
      session: first,
      summary: "Another overlapping session is still running.",
    };
  }
  if (first.status === "waiting_approval") {
    return {
      explanation: `${first.title} is already waiting on operator approval for the same scope, so review that decision before pushing this session forward.`,
      label: "approval overlap",
      session: first,
      summary: "Another overlapping session is blocked on approval.",
    };
  }
  if (first.status === "failed") {
    return {
      explanation: `${first.title} already failed on the same scope, so inspect that failure before reusing the same files here.`,
      label: "failed overlap",
      session: first,
      summary: "Another overlapping session failed on this scope.",
    };
  }
  return {
    explanation: `${first.title} is the highest-priority related session on this scope right now. Review it before final apply or delivery decisions here.`,
    label: "review overlap",
    session: first,
    summary: "Another overlapping session already reached a review or delivery stage.",
  };
}

function detailApplyReadiness(overview: SessionOverview, isBusy: boolean): DetailApplyReadiness | undefined {
  if (overview.filesChanged === 0) {
    return undefined;
  }
  if (overview.conflictFiles.length > 0) {
    return {
      disabled: false,
      explanation: "Direct apply is blocked because the original repository already differs on files this session changed.",
      label: "blocked",
      openLabel: "Open changes",
      openTab: "changes",
      summary: `${overview.conflictFiles.length} conflict${overview.conflictFiles.length === 1 ? "" : "s"} block direct apply.`,
    };
  }
  if (overview.overlapFiles.length > 0) {
    return {
      action: "create_branch",
      actionLabel: "Branch now",
      disabled: isBusy,
      explanation: "Another session touches the same file scope, so branch is the safer path before merging work back.",
      label: "branch first",
      openLabel: "Open changes",
      openTab: "changes",
      summary: `${overview.overlapFiles.length} overlap${overview.overlapFiles.length === 1 ? "" : "s"} make direct apply risky.`,
    };
  }
  if (isTaskRunning(overview.task)) {
    return {
      disabled: false,
      explanation: "This session is still running, so apply decisions should wait until the active turn settles.",
      label: "running",
      openLabel: "Open diagnostics",
      openTab: "debug",
      summary: "An active turn is still attached.",
    };
  }
  if (hasOverviewAction(overview, "apply")) {
    return {
      action: "apply",
      actionLabel: "Apply now",
      disabled: isBusy,
      explanation: "No current conflict or overlap blocks a direct apply path for this session.",
      label: "safe apply",
      openLabel: "Open changes",
      openTab: "changes",
      summary: "This session can be applied directly.",
    };
  }
  if (hasOverviewAction(overview, "create_branch")) {
    return {
      action: "create_branch",
      actionLabel: "Create branch",
      disabled: isBusy,
      explanation: "This session is not directly applicable right now, but it has enough diff to move forward through a branch workflow.",
      label: "branchable",
      openLabel: "Open changes",
      openTab: "changes",
      summary: "Branch delivery is available.",
    };
  }
  return {
    disabled: false,
    explanation: "This session does not have an actionable apply path yet. Review the diff or keep iterating first.",
    label: "idle",
    openLabel: "Open changes",
    openTab: "changes",
    summary: "No direct apply action is available yet.",
  };
}

function detailRuntimeState(overview: SessionOverview, isBusy: boolean): DetailRuntimeState | undefined {
  if (!overview.activeTurn && overview.queuedTurns === 0 && overview.terminal?.status !== "running" && !overview.lastEventAt) {
    return undefined;
  }
  if (overview.activeTurn) {
    return {
      disabled: isBusy,
      explanation: "This session still has a live turn attached. Stop it here or open Diagnostics for runtime details before making downstream decisions.",
      label: "live",
      showClearQueue: overview.queuedTurns > 0,
      showStop: true,
      summary: overview.queuedTurns > 0
        ? `${overview.queuedTurns} queued behind the active turn.`
        : "Active turn attached right now.",
    };
  }
  if (overview.terminal?.status === "running") {
    return {
      disabled: isBusy,
      explanation: "A raw terminal fallback is still live in this session worktree. Open Diagnostics to inspect it before applying or shipping.",
      label: "terminal live",
      showClearQueue: overview.queuedTurns > 0,
      showStop: false,
      summary: overview.queuedTurns > 0
        ? `${overview.queuedTurns} queued while terminal fallback is active.`
        : "Terminal fallback is still running.",
    };
  }
  if (overview.queuedTurns > 0) {
    return {
      disabled: isBusy,
      explanation: "This session already has pending work queued. Clear or inspect the queue before deciding whether to add more work.",
      label: "queued",
      showClearQueue: true,
      showStop: false,
      summary: `${overview.queuedTurns} queued turn${overview.queuedTurns === 1 ? "" : "s"} waiting.`,
    };
  }
  return {
    disabled: false,
    explanation: "The session is currently idle. Use Diagnostics for runtime details or continue with review and delivery decisions.",
    label: "idle",
    showClearQueue: false,
    showStop: false,
    summary: overview.lastEventAt ? `Last active ${formatDuration(overview.idleMs)} ago.` : "No active runtime pressure.",
  };
}

function detailHandoffState(overview: SessionOverview, task: Task | undefined, isBusy: boolean): DetailHandoffState | undefined {
  if (!task?.worktreePath && overview.filesChanged === 0) {
    return undefined;
  }
  return {
    disabled: isBusy,
    explanation: "Handoff actions should be available from the main summary so a reviewer can export evidence or pass the session on without opening deeper agent-only panels.",
    label: overview.filesChanged > 0 ? "ready" : "minimal",
    showCopyPath: Boolean(task?.worktreePath),
    showExportPatch: overview.filesChanged > 0,
    showExportReport: true,
    summary: overview.filesChanged > 0
      ? "Report, patch, and worktree path are ready for review handoff."
      : "Report and worktree path are ready for review handoff.",
  };
}

function detailPrimaryNarrative({
  applyReadiness,
  coordination,
  deliveryArtifactsCount,
  deliveryEntryPointsCount,
  fileScope,
  handoffState,
  overview,
  policyEntries,
  relatedSessionsCount,
  runtimeState,
  snapshotsVisible,
}: {
  applyReadiness?: DetailApplyReadiness;
  coordination?: DetailCoordinationState;
  deliveryArtifactsCount: number;
  deliveryEntryPointsCount: number;
  fileScope?: DetailFileScope;
  handoffState?: DetailHandoffState;
  overview: SessionOverview;
  policyEntries: FeedPolicyEntry[];
  relatedSessionsCount: number;
  runtimeState?: DetailRuntimeState;
  snapshotsVisible: boolean;
}): string {
  const parts: string[] = [];

  if (applyReadiness) {
    parts.push(`Apply posture: ${applyReadiness.label}. ${applyReadiness.explanation}`);
  } else if (fileScope) {
    parts.push(fileScope.explanation);
  }

  if (coordination && relatedSessionsCount > 0) {
    parts.push(`Coordination: ${coordination.explanation}`);
  } else if (relatedSessionsCount > 0) {
    parts.push(detailRelatedSessionsSummary(relatedSessionsCount));
  }

  if (runtimeState) {
    parts.push(`Runtime: ${runtimeState.explanation}`);
  }

  if (overview.latestDelivery.status !== "none") {
    parts.push(detailDeliverySummary(overview));
  } else if (deliveryArtifactsCount > 0 || deliveryEntryPointsCount > 0) {
    parts.push("Delivery output already exists for this session and can be reviewed directly from summary.");
  }

  if (handoffState) {
    parts.push(handoffState.explanation);
  }

  if (snapshotsVisible) {
    parts.push(hasSnapshotsText(overview.snapshotCount, overview.filesChanged));
  }

  if (policyEntries.length > 0) {
    parts.push(`${policyEntries.length} queue policy mirror${policyEntries.length === 1 ? "" : "s"} are visible here so overview triage state stays aligned with this detail panel.`);
  }

  return parts.join(" ");
}

function hasSnapshotsText(snapshotCount: number, filesChanged: number): string {
  if (snapshotCount > 0) {
    return `${snapshotCount} snapshot restore point${snapshotCount === 1 ? "" : "s"} are available from summary.`;
  }
  if (filesChanged > 0) {
    return "This session has changed files but no saved snapshot yet.";
  }
  return "No snapshot state is available yet.";
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const segment = Math.max(8, Math.floor((max - 3) / 2));
  return `${value.slice(0, segment)}...${value.slice(-segment)}`;
}

function detailRecommendedActionReason(overview: SessionOverview): string {
  if (overview.waitingApprovals > 0) {
    return `Recommended actions are biased toward Apply because ${overview.waitingApprovals} approval request${overview.waitingApprovals === 1 ? "" : "s"} still block progress.`;
  }
  if (overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) {
    return "Recommended actions are biased toward Branch or review because current repo state prevents a clean direct apply.";
  }
  if (overview.latestDelivery.status === "pr_ready" || overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pushed") {
    return "Recommended actions are biased toward Delivery because this session already has a ship-ready output path.";
  }
  if (overview.activeTurn || overview.queuedTurns > 0) {
    return "Recommended actions are biased toward Diagnostics because this session is still actively running or queued.";
  }
  if (overview.filesChanged > 0 && overview.snapshotCount === 0) {
    return "Recommended actions include Snapshot because this session has changed files without a saved restore point yet.";
  }
  return "Recommended actions reflect the highest-value next move for this session's current delivery and risk state.";
}

function TerminalProjection({ lines, task }: { lines: string[]; task?: Task }): React.JSX.Element {
  return (
    <div className="terminal-projection">
      <header>
        <div>
          <h3>{task ? `${task.title} terminal output` : "Terminal output"}</h3>
          <small>Read-only projection from the right-side native terminal. Input stays in the terminal panel.</small>
        </div>
      </header>
      <pre aria-label="Projected terminal output">
        {lines.length > 0 ? lines.join("\n") : "Attach the Agent Terminal on the right to start projecting conversation output here."}
      </pre>
    </div>
  );
}

function SessionWorkspacePanel({
  applyConflict,
  approvalStates,
  busyAction,
  diff,
  events,
  files,
  onAction,
  onApproval,
  onCreateSnapshot,
  onRefreshChanges,
  onSelectTab,
  onSelectSnapshot,
  onSnapshotsChange,
  panelRef,
  pendingApprovals,
  selectedSnapshotId,
  snapshots,
  tab,
  task,
  token,
  workEvents,
}: {
  applyConflict?: ConflictState;
  approvalStates: Map<string, ApprovalDecision>;
  busyAction?: SessionUiAction;
  diff?: DiffSnapshot;
  events: AgentEvent[];
  files: ParsedDiffFile[];
  onAction: (action: DiffPanelAction, input?: DeliveryActionInput) => void;
  onApproval: (taskId: string, approvalId: string, decision: ApprovalDecision) => Promise<void>;
  onCreateSnapshot: (input: CreateSessionSnapshotRequest) => Promise<SessionSnapshot>;
  onRefreshChanges: () => Promise<void>;
  onSelectTab: (tab: SessionWorkspaceTab) => void;
  onSelectSnapshot: (snapshotId: string) => void;
  onSnapshotsChange: (snapshots: SessionSnapshot[]) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  pendingApprovals: Set<string>;
  selectedSnapshotId?: string;
  snapshots: SessionSnapshot[];
  tab: SessionWorkspaceTab;
  task?: Task;
  token: string;
  workEvents: AgentEvent[];
}): React.JSX.Element {
  const [showAllEvents, setShowAllEvents] = useState(false);
  if (tab === "work") {
    const visibleWorkEvents = showAllEvents ? events : workEvents;
    return (
      <div className="events-panel">
        <div className="events-toolbar">
          <div>
            <strong>Events</strong>
            <small>{showAllEvents ? "Showing all raw events." : "Showing user messages, final agent replies, approvals, diff, and delivery actions."}</small>
          </div>
          <label className="debug-toggle">
            <input checked={showAllEvents} onChange={(event) => setShowAllEvents(event.target.checked)} type="checkbox" />
            <span>Debug</span>
          </label>
        </div>
        <div className="event-list" ref={panelRef}>
          {visibleWorkEvents.map((event, index) => (
            <EventRow
              approvalDecision={event.type === "approval.requested" ? approvalStates.get(event.approvalId) : undefined}
              approvalPending={event.type === "approval.requested" ? pendingApprovals.has(event.approvalId) : false}
              debug={showAllEvents}
              event={event}
              key={`${event.type}-${index}`}
              onApproval={onApproval}
            />
          ))}
          {visibleWorkEvents.length === 0 ? <p className="empty">No events yet.</p> : null}
        </div>
      </div>
    );
  }
  if (tab === "changes") {
    return (
      <div className="session-workspace-panel changes-session-panel">
        <SessionActions busyAction={busyAction} diff={diff} onAction={onAction} task={task} variant="changes" />
        {applyConflict ? (
          <ApplyConflictPanel
            conflict={applyConflict}
            onCreateBranch={() => onAction("create_branch")}
            onExportPatch={() => onAction("export_patch")}
            onForceApply={() => onAction("apply_force")}
          />
        ) : null}
        <ChangesWorkspace diff={diff} files={files} onRefresh={onRefreshChanges} refreshKey={diff?.id} task={task} />
      </div>
    );
  }
  if (tab === "snapshots") {
    return (
      <div className="session-workspace-panel">
        <SessionActions busyAction={busyAction} diff={diff} onAction={onAction} task={task} variant="snapshots" />
        <SnapshotComposer
          busy={busyAction === "snapshot"}
          defaultLabel={suggestSnapshotLabel(task)}
          disabled={!task}
          onCreate={onCreateSnapshot}
        />
        {snapshots.length > 0 ? (
          <SnapshotList
            busy={busyAction === "rollback"}
            currentDiff={diff}
            onOpenChanges={() => onSelectTab("changes")}
            onRollback={() => onAction("rollback")}
            onSelect={onSelectSnapshot}
            onSnapshotsChange={onSnapshotsChange}
            selectedSnapshotId={selectedSnapshotId}
            snapshots={snapshots}
            task={task}
          />
        ) : (
          <p className="empty">No snapshots yet.</p>
        )}
      </div>
    );
  }
  if (tab === "shell") {
    return (
      <div className="session-workspace-panel shell-session-panel">
        <React.Suspense fallback={<p className="empty">Loading project shell...</p>}>
          <ProjectShellPanel task={task} token={token} />
        </React.Suspense>
      </div>
    );
  }
  return (
    <div className="session-workspace-panel debug-panel">
      <SessionActions busyAction={busyAction} diff={diff} onAction={onAction} task={task} variant="agent" />
      <div className="agent-summary">
        <div>
          <span>Status</span>
          <strong>{task?.status ?? "No session"}</strong>
        </div>
        <div>
          <span>Backend</span>
          <strong>{task?.backendId ?? "none"}</strong>
        </div>
        <div>
          <span>Context</span>
          <strong>{task?.agentContextStatus ?? "unknown"}</strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>{task?.modeId ?? "default"}</strong>
        </div>
      </div>
      <AgentContextPanel decision={latestContextDecision(events)} task={task} />
      {task?.worktreePath ? <code className="path-chip">{task.worktreePath}</code> : null}
      <div className="event-list debug-event-list" ref={panelRef}>
        {events.map((event, index) => (
          <EventRow
            approvalDecision={event.type === "approval.requested" ? approvalStates.get(event.approvalId) : undefined}
            approvalPending={event.type === "approval.requested" ? pendingApprovals.has(event.approvalId) : false}
            debug
            event={event}
            key={`${event.type}-${index}`}
            onApproval={onApproval}
          />
        ))}
        {events.length === 0 ? <p className="empty">No events yet.</p> : null}
      </div>
    </div>
  );
}

function ChangesWorkspace({
  diff,
  files,
  onRefresh,
  refreshKey,
  task,
}: {
  diff?: DiffSnapshot;
  files: ParsedDiffFile[];
  onRefresh: () => Promise<void>;
  refreshKey?: string;
  task?: Task;
}): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string>();
  const [treeEntries, setTreeEntries] = useState<SessionTreeEntry[]>([]);
  const [treeError, setTreeError] = useState<string>();
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [baselineContent, setBaselineContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [selectedFileInfo, setSelectedFileInfo] = useState<SessionFileContentResponse>();
  const [editorError, setEditorError] = useState<string>();
  const [editorNotice, setEditorNotice] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isInlineEditing, setIsInlineEditing] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{ path?: string; type: "reload" | "switch" }>();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [createEntry, setCreateEntry] = useState<{ kind: "directory" | "file"; path: string }>();
  const [createEntryError, setCreateEntryError] = useState<string>();
  const [isCreatingEntry, setIsCreatingEntry] = useState(false);

  useEffect(() => {
    setExpandedPaths(new Set());
  }, [task?.id]);

  useEffect(() => {
    if (!editorNotice) {
      return;
    }
    const timeout = window.setTimeout(() => setEditorNotice(undefined), 5000);
    return () => window.clearTimeout(timeout);
  }, [editorNotice]);

  useEffect(() => {
    if (!task) {
      setTreeEntries([]);
      setTreeError(undefined);
      setTreeLoading(false);
      return;
    }

    let cancelled = false;
    setTreeLoading(true);
    setTreeError(undefined);
    void api<SessionTreeEntry[]>(`/api/sessions/${task.id}/tree`)
      .then((entries) => {
        if (!cancelled) {
          setTreeEntries(entries);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTreeEntries([]);
          setTreeError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTreeLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [files, refreshKey, task?.id]);

  const treeNodes = useMemo(() => buildChangesTree(treeEntries, files), [files, treeEntries]);
  const selectablePaths = useMemo(() => collectChangesTreeFilePaths(treeNodes), [treeNodes]);

  useEffect(() => {
    if (selectablePaths.length === 0) {
      setSelectedPath(undefined);
      return;
    }
    if (!selectedPath || !selectablePaths.includes(selectedPath)) {
      setSelectedPath(preferredTreeSelectionPath(files, selectablePaths));
    }
  }, [files, selectablePaths, selectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    setExpandedPaths((current) => expandTreeAncestors(current, selectedPath));
  }, [selectedPath]);

  const selectedFile = useMemo(() => files.find((file) => file.path === selectedPath), [files, selectedPath]);
  const isDeleted = selectedFile?.status === "deleted";
  const isDirty = draftContent !== baselineContent;
  const selectedFileReview = selectedFile ? summarizeReviewFile(selectedFile) : undefined;
  const isFallbackSelection = Boolean(selectedPath && !selectedFile);
  const selectedFileKind = selectedFileInfo?.kind;
  const selectedFileIsText = selectedFileKind === "text";
  const selectedFileHelpText = selectedFileHelp({
    isDeleted,
    isFallbackSelection,
    selectedFile: Boolean(selectedFile),
    selectedFileKind,
  });

  useEffect(() => {
    if (!isDirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    setEditorError(undefined);
    setEditorNotice(undefined);
    setSelectedFileInfo(undefined);
    setIsInlineEditing(false);
    if (!task || !selectedPath || isDeleted) {
      setBaselineContent("");
      setDraftContent("");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    void api<SessionFileContentResponse>(`/api/sessions/${task.id}/files?path=${encodeURIComponent(selectedPath)}`)
      .then((file) => {
        if (cancelled) {
          return;
        }
        setSelectedFileInfo(file);
        setBaselineContent(file.content);
        setDraftContent(file.content);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setSelectedFileInfo(undefined);
        setBaselineContent("");
        setDraftContent("");
        setEditorError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDeleted, refreshKey, reloadVersion, selectedPath, task?.id]);

  async function saveSelectedFile(): Promise<boolean> {
    if (!task || !selectedPath || !selectedFileIsText || isDeleted || isSaving || !isDirty) {
      return false;
    }
    setEditorError(undefined);
    setEditorNotice(undefined);
    setIsSaving(true);
    try {
      const result = await api<SessionFileContentResponse>(`/api/sessions/${task.id}/files`, {
        method: "PUT",
        body: JSON.stringify({
          content: draftContent,
          path: selectedPath,
        }),
      });
      setBaselineContent(result.content);
      setDraftContent(result.content);
      setIsInlineEditing(false);
      setEditorNotice(`Saved ${result.path}`);
      await onRefresh();
      return true;
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setIsSaving(false);
    }
  }

  async function refreshSessionTree(): Promise<SessionTreeEntry[]> {
    if (!task) {
      setTreeEntries([]);
      return [];
    }
    const entries = await api<SessionTreeEntry[]>(`/api/sessions/${task.id}/tree`);
    setTreeEntries(entries);
    return entries;
  }

  async function createSessionEntry(): Promise<void> {
    if (!task || !createEntry || isCreatingEntry) {
      return;
    }
    const nextPath = createEntry.path.trim();
    if (!nextPath) {
      setCreateEntry(undefined);
      setCreateEntryError(undefined);
      return;
    }
    setCreateEntryError(undefined);
    setIsCreatingEntry(true);
    try {
      if (createEntry.kind === "file") {
        await api<SessionFileContentResponse>(`/api/sessions/${task.id}/files`, {
          method: "PUT",
          body: JSON.stringify({
            content: "",
            path: nextPath,
          } satisfies UpdateSessionFileRequest),
        });
      } else {
        await api<SessionTreeEntry>(`/api/sessions/${task.id}/directories`, {
          method: "POST",
          body: JSON.stringify({
            path: nextPath,
          } satisfies CreateSessionDirectoryRequest),
        });
      }
      await Promise.all([
        refreshSessionTree(),
        onRefresh(),
      ]);
      setExpandedPaths((current) => expandTreeAncestors(current, nextPath));
      if (createEntry.kind === "file") {
        setSelectedPath(nextPath);
        setReloadVersion((current) => current + 1);
      }
      setEditorNotice(`Created ${createEntry.kind === "file" ? "file" : "folder"} ${nextPath}`);
      setCreateEntry(undefined);
    } catch (error) {
      setCreateEntryError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCreatingEntry(false);
    }
  }

  function executePendingNavigation(): void {
    if (!pendingNavigation) {
      return;
    }
    if (pendingNavigation.type === "reload") {
      setReloadVersion((current) => current + 1);
    } else if (pendingNavigation.path) {
      setSelectedPath(pendingNavigation.path);
    }
    setIsInlineEditing(false);
    setPendingNavigation(undefined);
  }

  async function saveAndContinue(): Promise<void> {
    const saved = await saveSelectedFile();
    if (saved) {
      executePendingNavigation();
    }
  }

  function discardAndContinue(): void {
    setDraftContent(baselineContent);
    setEditorError(undefined);
    setIsInlineEditing(false);
    setEditorNotice("Discarded unsaved edits.");
    executePendingNavigation();
  }

  function reloadSelectedFile(): void {
    if (!selectedPath || isDeleted || isLoading) {
      return;
    }
    if (isDirty) {
      setPendingNavigation({ type: "reload" });
      return;
    }
    setReloadVersion((current) => current + 1);
  }

  function selectFile(path: string): void {
    if (path === selectedPath) {
      return;
    }
    if (isDirty) {
      setPendingNavigation({ path, type: "switch" });
      return;
    }
    setSelectedPath(path);
  }

  return (
    <div className="changes-workspace">
      <aside className="changes-file-list">
        <header>
          <div>
            <h3>Explorer</h3>
            <small>{files.length} changed file{files.length === 1 ? "" : "s"} in this session</small>
          </div>
          <div className="changes-explorer-actions" aria-label="Explorer actions">
            <button
              className="icon-button"
              disabled={!task}
              onClick={() => {
                setCreateEntry({ kind: "file", path: "" });
                setCreateEntryError(undefined);
              }}
              title="New file"
              type="button"
            >
              <span aria-hidden="true" className="explorer-icon new-file" />
              <span className="sr-only">New file</span>
            </button>
            <button
              className="icon-button"
              disabled={!task}
              onClick={() => {
                setCreateEntry({ kind: "directory", path: "" });
                setCreateEntryError(undefined);
              }}
              title="New folder"
              type="button"
            >
              <span aria-hidden="true" className="explorer-icon new-folder" />
              <span className="sr-only">New folder</span>
            </button>
          </div>
        </header>
        {treeError ? <div className="changes-feedback error">{treeError}</div> : null}
        {treeLoading && treeNodes.length === 0 ? (
          <p className="empty">Loading project tree...</p>
        ) : treeNodes.length > 0 ? (
          <div className="changes-tree">
            <ChangesTreeList
              dirtyPath={!isDeleted && isDirty ? selectedPath : undefined}
              expandedPaths={expandedPaths}
              nodes={treeNodes}
              onSelectFile={selectFile}
              onToggleDirectory={(path) =>
                setExpandedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(path)) {
                    next.delete(path);
                  } else {
                    next.add(path);
                  }
                  return next;
                })}
              selectedPath={selectedPath}
            />
          </div>
        ) : (
          <p className="empty">No files in this session worktree.</p>
        )}
      </aside>

      <div className="changes-main">
        <section className="changes-editor-card">
          <header className="changes-editor-header">
            <div>
              <h3>{selectedPath ?? "No file selected"}</h3>
              {selectedFileHelpText ? <small>{selectedFileHelpText}</small> : null}
            </div>
            <div className="changes-editor-status">
              {selectedFile ? <span className={`diff-status ${selectedFile.status}`}>{selectedFile.status}</span> : null}
              <span className={`changes-editor-state ${isDeleted ? "readonly" : isDirty ? "unsaved" : isFallbackSelection ? "clean" : "saved"}`}>
                {isDeleted ? "read only" : isDirty ? "unsaved edits" : selectedFileKind ?? (isFallbackSelection ? "clean" : "saved")}
              </span>
            </div>
            <div className="changes-editor-actions">
              <button
                className="secondary compact-button"
                disabled={!selectedPath || isDeleted || isLoading || isSaving}
                onClick={reloadSelectedFile}
                type="button"
              >
                Reload file
              </button>
              <button
                disabled={!selectedPath || !selectedFileIsText || isDeleted || isLoading || isSaving || !isDirty}
                onClick={() => void (pendingNavigation ? saveAndContinue() : saveSelectedFile())}
                type="button"
              >
                {isSaving ? "Saving" : pendingNavigation ? "Save and continue" : "Save file"}
              </button>
            </div>
          </header>
          {pendingNavigation ? (
            <div className="changes-guard">
              <div>
                <strong>Unsaved edits</strong>
                <small>
                  {pendingNavigation.type === "switch"
                    ? `Save or discard changes in ${selectedPath ?? "this file"} before opening ${pendingNavigation.path}.`
                    : `Save or discard changes in ${selectedPath ?? "this file"} before reloading from disk.`}
                </small>
              </div>
              <div className="changes-guard-actions">
                {!isDeleted ? (
                  <button disabled={isSaving} onClick={() => void saveAndContinue()} type="button">
                    {isSaving ? "Saving" : "Save and continue"}
                  </button>
                ) : null}
                <button className="secondary compact-button" disabled={isSaving} onClick={discardAndContinue} type="button">
                  Discard
                </button>
                <button className="secondary compact-button" disabled={isSaving} onClick={() => setPendingNavigation(undefined)} type="button">
                  Stay here
                </button>
              </div>
            </div>
          ) : null}
          {editorError ? <div className="changes-feedback error">{editorError}</div> : null}
          {editorNotice ? <div className="changes-feedback notice">{editorNotice}</div> : null}
          {selectedFileReview ? (
            <div className="changes-review-summary compact">
              <p>{selectedFileReview.summary}</p>
              <div className="changes-review-meta">
                <span>{selectedFileReview.changeCountLabel}</span>
                <span>{selectedFileReview.hunksLabel}</span>
                <span>{selectedFileReview.lineDeltaLabel}</span>
              </div>
            </div>
          ) : null}
          {isDeleted && selectedFile ? (
            <InlineFileDiffView content="" file={selectedFile} />
          ) : isLoading ? (
            <p className="empty">Loading file content...</p>
          ) : selectedPath && selectedFileInfo?.kind === "image" && task ? (
            <SessionImagePreview file={selectedFileInfo} rawUrl={sessionFileRawUrl(task.id, selectedPath)} />
          ) : selectedPath && selectedFileInfo?.kind === "binary" ? (
            <BinaryFileNotice file={selectedFileInfo} />
          ) : isInlineEditing && selectedFileIsText && !isDeleted ? (
            <InlineFileEditorView
              content={draftContent}
              onChange={setDraftContent}
            />
          ) : (
            <InlineFileDiffView
              content={baselineContent}
              file={selectedFile}
              onStartEdit={selectedFileIsText && !isDeleted ? () => setIsInlineEditing(true) : undefined}
            />
          )}
        </section>

        {diff?.diffText.trim() ? (
          <details className="changes-full-patch">
            <summary>Full patch</summary>
            <DiffViewer diff={diff} files={files} />
          </details>
        ) : null}
      </div>
      {createEntry ? (
        <CreateExplorerEntryModal
          busy={isCreatingEntry}
          error={createEntryError}
          kind={createEntry.kind}
          onCancel={() => {
            if (!isCreatingEntry) {
              setCreateEntry(undefined);
              setCreateEntryError(undefined);
            }
          }}
          onChange={(path) => setCreateEntry((current) => current ? { ...current, path } : current)}
          onSubmit={() => void createSessionEntry()}
          path={createEntry.path}
        />
      ) : null}
    </div>
  );
}

function CreateExplorerEntryModal({
  busy,
  error,
  kind,
  onCancel,
  onChange,
  onSubmit,
  path,
}: {
  busy: boolean;
  error?: string;
  kind: "directory" | "file";
  onCancel: () => void;
  onChange: (path: string) => void;
  onSubmit: () => void;
  path: string;
}): React.JSX.Element {
  const title = kind === "file" ? "New file" : "New folder";
  return (
    <div className="modal-backdrop nested" role="presentation">
      <form
        aria-labelledby="create-explorer-entry-title"
        className="modal compact-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header>
          <h2 id="create-explorer-entry-title">{title}</h2>
          <p>Create it inside the current session worktree.</p>
        </header>
        <label className="field">
          <span>Relative path</span>
          <input
            autoFocus
            disabled={busy}
            onChange={(event) => onChange(event.target.value)}
            placeholder={kind === "file" ? "src/example.ts" : "src/components"}
            value={path}
          />
        </label>
        {error ? <div className="changes-feedback error">{error}</div> : null}
        <footer>
          <button className="secondary" disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={busy} type="submit">
            {busy ? "Creating" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function selectedFileHelp({
  isDeleted,
  isFallbackSelection,
  selectedFile,
  selectedFileKind,
}: {
  isDeleted: boolean;
  isFallbackSelection: boolean;
  selectedFile: boolean;
  selectedFileKind?: SessionFileContentResponse["kind"];
}): string | undefined {
  if (isDeleted) {
    return "Deleted file.";
  }
  if (selectedFileKind === "image") {
    return "Image preview.";
  }
  if (selectedFileKind === "binary") {
    return "Binary file.";
  }
  if (isFallbackSelection) {
    return "No changed file is selected. Showing a project entry file.";
  }
  return selectedFile ? undefined : "Select a file from Explorer.";
}

interface ChangesTreeNode {
  changed: boolean;
  changedDescendantCount: number;
  children?: ChangesTreeNode[];
  kind: "directory" | "file";
  missingFromTree?: boolean;
  name: string;
  path: string;
  status?: ParsedDiffFile["status"];
}

interface CompactDirectoryView {
  changedDescendantCount: number;
  children: ChangesTreeNode[];
  label: string;
  path: string;
}

function ChangesTreeList({
  depth = 0,
  dirtyPath,
  expandedPaths,
  nodes,
  onSelectFile,
  onToggleDirectory,
  selectedPath,
}: {
  depth?: number;
  dirtyPath?: string;
  expandedPaths: Set<string>;
  nodes: ChangesTreeNode[];
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  selectedPath?: string;
}): React.JSX.Element {
  return (
    <div className="changes-tree-list">
      {nodes.map((node) => {
        if (node.kind === "directory") {
          const compact = compactDirectory(node);
          const expanded = expandedPaths.has(compact.path);
          return (
            <div className="changes-tree-branch" key={compact.path}>
              <button
                className={`changes-tree-row changes-tree-directory ${expanded ? "expanded" : ""} ${node.changed ? "changed" : ""}`}
                onClick={() => onToggleDirectory(compact.path)}
                style={{ paddingInlineStart: `${12 + depth * 16}px` }}
                title={compact.path}
                type="button"
              >
                <span className="changes-tree-toggle" aria-hidden="true">
                  {expanded ? "▾" : "▸"}
                </span>
                <span className="changes-tree-icon folder" aria-hidden="true" />
                <span className="changes-tree-name">{compact.label}</span>
                <span className="changes-tree-meta">
                  {compact.changedDescendantCount > 0 ? <span className="changes-tree-count">{compact.changedDescendantCount}</span> : null}
                </span>
              </button>
              {expanded && compact.children.length ? (
                <ChangesTreeList
                  depth={depth + 1}
                  dirtyPath={dirtyPath}
                  expandedPaths={expandedPaths}
                  nodes={compact.children}
                  onSelectFile={onSelectFile}
                  onToggleDirectory={onToggleDirectory}
                  selectedPath={selectedPath}
                />
              ) : null}
            </div>
          );
        }

        const statusMark = treeStatusMarker(node.status);
        return (
          <button
            className={`changes-tree-row changes-tree-file ${selectedPath === node.path ? "selected" : ""} ${node.changed ? "changed" : ""}`}
            key={node.path}
            onClick={() => onSelectFile(node.path)}
            style={{ paddingInlineStart: `${12 + depth * 16}px` }}
            title={node.path}
            type="button"
          >
            <span className="changes-tree-icon file" aria-hidden="true" />
            <span className={`changes-tree-name ${node.missingFromTree ? "missing" : ""}`}>{node.name}</span>
            <span className="changes-tree-meta">
              {dirtyPath === node.path ? <span className="changes-file-dirty">dirty</span> : null}
              {statusMark ? <span className={`changes-tree-status-mark ${node.status ?? "unknown"}`}>{statusMark}</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function preferredTreeSelectionPath(files: ParsedDiffFile[], selectablePaths: string[]): string | undefined {
  const preferredChanged = files.find((file) => file.status !== "deleted")?.path ?? files[0]?.path;
  if (preferredChanged && selectablePaths.includes(preferredChanged)) {
    return preferredChanged;
  }
  return preferredFallbackTreeSelectionPath(selectablePaths);
}

function preferredFallbackTreeSelectionPath(selectablePaths: string[]): string | undefined {
  if (selectablePaths.length === 0) {
    return undefined;
  }

  const textPaths = selectablePaths.filter(isLikelyTextPath);
  const preferredPaths = textPaths.length > 0 ? textPaths : selectablePaths;
  const lowerByPath = new Map(preferredPaths.map((path) => [path.toLowerCase(), path]));
  const exactPriority = [
    "readme.md",
    "readme",
    "readme.markdown",
    "readme.txt",
    "package.json",
    "cargo.toml",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
  ];

  for (const candidate of exactPriority) {
    const match = lowerByPath.get(candidate);
    if (match) {
      return match;
    }
  }

  const rootReadme = preferredPaths.find((path) => !path.includes("/") && path.toLowerCase().startsWith("readme."));
  if (rootReadme) {
    return rootReadme;
  }

  const nestedReadme = preferredPaths.find((path) => path.split("/").at(-1)?.toLowerCase().startsWith("readme."));
  if (nestedReadme) {
    return nestedReadme;
  }

  const sourceEntry = preferredPaths.find((path) => /^src\/(main|index|lib)\.[^.]+$/i.test(path));
  if (sourceEntry) {
    return sourceEntry;
  }

  return preferredPaths[0];
}

function isLikelyTextPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (/\.(avif|bmp|gif|heic|heif|ico|jpeg|jpg|pdf|png|webp|zip)$/i.test(lower)) {
    return false;
  }
  return true;
}

function compactDirectory(node: ChangesTreeNode): CompactDirectoryView {
  let current = node;
  const names = [node.name];
  while (current.children?.length === 1 && current.children[0]?.kind === "directory") {
    current = current.children[0];
    names.push(current.name);
  }
  return {
    changedDescendantCount: current.changedDescendantCount,
    children: current.children ?? [],
    label: names.join("/"),
    path: current.path,
  };
}

function collectChangesTreeFilePaths(nodes: ChangesTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      paths.push(node.path);
      continue;
    }
    if (node.children?.length) {
      paths.push(...collectChangesTreeFilePaths(node.children));
    }
  }
  return paths;
}

function expandTreeAncestors(current: Set<string>, filePath: string): Set<string> {
  const next = new Set(current);
  const segments = filePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    next.add(segments.slice(0, index).join("/"));
  }
  return next;
}

function treeStatusMarker(status?: ParsedDiffFile["status"]): string | undefined {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return undefined;
  }
}

function buildChangesTree(entries: SessionTreeEntry[], files: ParsedDiffFile[]): ChangesTreeNode[] {
  type MutableNode = {
    changed: boolean;
    children: Map<string, MutableNode>;
    kind: "directory" | "file";
    missingFromTree?: boolean;
    name: string;
    path: string;
    status?: ParsedDiffFile["status"];
  };

  const root = new Map<string, MutableNode>();
  const changedByPath = new Map(files.map((file) => [file.path, file]));

  function ensureDirectory(directoryPath: string): MutableNode | undefined {
    if (!directoryPath) {
      return undefined;
    }
    const segments = directoryPath.split("/");
    let currentChildren = root;
    let currentNode: MutableNode | undefined;
    for (let index = 0; index < segments.length; index += 1) {
      const name = segments[index];
      if (!name) {
        continue;
      }
      const path = segments.slice(0, index + 1).join("/");
      const existing = currentChildren.get(path);
      if (existing && existing.kind === "directory") {
        currentNode = existing;
        currentChildren = existing.children;
        continue;
      }
      const created: MutableNode = {
        changed: false,
        children: new Map(),
        kind: "directory",
        name,
        path,
      };
      currentChildren.set(path, created);
      currentNode = created;
      currentChildren = created.children;
    }
    return currentNode;
  }

  function insertFile(path: string, status?: ParsedDiffFile["status"], missingFromTree = false): void {
    const segments = path.split("/");
    const fileName = segments.at(-1);
    if (!fileName) {
      return;
    }
    const parentDirectory = segments.slice(0, -1).join("/");
    const parentNode = ensureDirectory(parentDirectory);
    const container = parentNode?.children ?? root;
    container.set(path, {
      changed: Boolean(status),
      children: new Map(),
      kind: "file",
      missingFromTree,
      name: fileName,
      path,
      status,
    });
  }

  for (const entry of entries) {
    if (entry.kind === "directory") {
      ensureDirectory(entry.path);
      continue;
    }
    insertFile(entry.path, changedByPath.get(entry.path)?.status);
  }

  for (const file of files) {
    if (!entries.some((entry) => entry.kind === "file" && entry.path === file.path)) {
      insertFile(file.path, file.status, true);
    }
  }

  function finalize(nodes: Map<string, MutableNode>): ChangesTreeNode[] {
    return [...nodes.values()]
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .map((node) => {
        if (node.kind === "directory") {
          const children = finalize(node.children);
          const changedDescendantCount = children.reduce((count, child) => count + (child.kind === "directory" ? child.changedDescendantCount : child.changed ? 1 : 0), 0);
          return {
            changed: changedDescendantCount > 0,
            changedDescendantCount,
            children,
            kind: "directory",
            name: node.name,
            path: node.path,
          } satisfies ChangesTreeNode;
        }
        return {
          changed: node.changed,
          changedDescendantCount: node.changed ? 1 : 0,
          kind: "file",
          missingFromTree: node.missingFromTree,
          name: node.name,
          path: node.path,
          status: node.status,
        } satisfies ChangesTreeNode;
      });
  }

  return finalize(root);
}

function summarizeReviewFile(file: ParsedDiffFile): {
  changeCountLabel: string;
  firstHunkHeader?: string;
  hunksLabel: string;
  lineDeltaLabel: string;
  summary: string;
} {
  const hunkCount = file.hunks.length;
  const hunksLabel = `${hunkCount} hunk${hunkCount === 1 ? "" : "s"}`;
  const lineDeltaLabel = `+${file.additions} -${file.deletions}`;
  const changedLineCount = file.additions + file.deletions;
  const changeCountLabel = `${changedLineCount} changed line${changedLineCount === 1 ? "" : "s"}`;
  const firstHunkHeader = file.hunks[0]?.header;

  if (file.status === "added") {
    return {
      changeCountLabel,
      firstHunkHeader,
      hunksLabel,
      lineDeltaLabel,
      summary: `New file added in this session with ${file.additions} added line${file.additions === 1 ? "" : "s"} across ${hunksLabel}.`,
    };
  }
  if (file.status === "deleted") {
    return {
      changeCountLabel,
      firstHunkHeader,
      hunksLabel,
      lineDeltaLabel,
      summary: `File removed in this session diff with ${file.deletions} deleted line${file.deletions === 1 ? "" : "s"} across ${hunksLabel}.`,
    };
  }
  if (file.status === "renamed") {
    return {
      changeCountLabel,
      firstHunkHeader,
      hunksLabel,
      lineDeltaLabel,
      summary: `Renamed file with content changes across ${hunksLabel}; review the patch header before keeping or reverting the rename.`,
    };
  }
  return {
    changeCountLabel,
    firstHunkHeader,
    hunksLabel,
    lineDeltaLabel,
    summary: `Modified file touching ${changeCountLabel} across ${hunksLabel}.`,
  };
}

function SessionImagePreview({ file, rawUrl }: { file: SessionFileContentResponse; rawUrl: string }): React.JSX.Element {
  return (
    <figure className="changes-media-preview">
      <div className="changes-media-frame">
        <img alt={file.path} src={rawUrl} />
      </div>
      <figcaption>
        <strong>{file.mimeType}</strong>
        <span>{formatFileSize(file.size)}</span>
        <span>{file.path}</span>
      </figcaption>
    </figure>
  );
}

function BinaryFileNotice({ file }: { file: SessionFileContentResponse }): React.JSX.Element {
  return (
    <div className="changes-binary-notice">
      <strong>Binary file</strong>
      <p>Workbench skipped text rendering for this file to avoid corrupt output.</p>
      <div className="changes-review-meta">
        <span>{file.mimeType}</span>
        <span>{formatFileSize(file.size)}</span>
        <code>{file.path}</code>
      </div>
    </div>
  );
}

function InlineFileDiffView({
  content,
  file,
  onStartEdit,
}: {
  content: string;
  file?: ParsedDiffFile;
  onStartEdit?: () => void;
}): React.JSX.Element {
  const lines = buildInlineFileDiffLines(content, file);
  if (lines.length === 0) {
    return <p className="empty">No file content available.</p>;
  }

  return (
    <div
      className={`ide-diff-viewer file-content ${onStartEdit ? "editable" : ""}`}
      onDoubleClick={onStartEdit}
      onMouseDown={(event) => {
        if (!onStartEdit || event.button !== 0) {
          return;
        }
        onStartEdit();
      }}
      role="table"
      aria-label={file ? `File content diff for ${file.path}` : "File content"}
      title={onStartEdit ? "Click to edit this file inline." : undefined}
    >
      <div className="ide-diff-ruler" aria-hidden="true">
        <span />
        <span>old</span>
        <span>new</span>
        <span />
        <span>file content</span>
      </div>
      <div className="ide-diff-code">
        {lines.map((line, index) => (
          <div className={`ide-diff-line ${line.type}`} key={`${line.type}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${index}`}>
            <span className="ide-diff-gutter old">{line.oldLine ?? ""}</span>
            <span className="ide-diff-gutter new">{line.newLine ?? ""}</span>
            <span className="ide-diff-marker">{line.marker}</span>
            <code>{line.content || " "}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function InlineFileEditorView({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}): React.JSX.Element {
  const lines = content.split(/\r?\n/);
  const lineCount = Math.max(1, lines.length);
  return (
    <div className="ide-inline-editor">
      <div className="ide-diff-ruler" aria-hidden="true">
        <span />
        <span>old</span>
        <span>new</span>
        <span />
        <span>file content</span>
      </div>
      <div className="ide-inline-editor-body">
        <div className="ide-inline-editor-gutters" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <div className="ide-diff-line editor-line-number" key={index}>
              <span className="ide-diff-gutter old" />
              <span className="ide-diff-gutter new">{index + 1}</span>
              <span className="ide-diff-marker" />
            </div>
          ))}
        </div>
        <textarea
          autoFocus
          className="ide-inline-editor-textarea"
          onChange={(event) => onChange(event.target.value)}
          rows={lineCount}
          spellCheck={false}
          value={content}
        />
      </div>
    </div>
  );
}

function buildInlineFileDiffLines(content: string, file?: ParsedDiffFile): DiffLineView[] {
  if (file?.status === "deleted") {
    return file.hunks.flatMap((hunk) =>
      hunk.lines
        .filter((line) => line.kind === "delete")
        .map((line) => ({
          content: line.content,
          marker: "-" as const,
          oldLine: line.oldLine,
          type: "delete" as const,
        })),
    );
  }

  const fileLines = splitDisplayLines(content);
  if (!file) {
    return fileLines.map((line, index) => ({
      content: line,
      marker: " " as const,
      newLine: index + 1,
      oldLine: index + 1,
      type: "context" as const,
    }));
  }

  const addedNewLines = new Set<number>();
  const oldLineByContextNewLine = new Map<number, number>();
  const deletedBeforeNewLine = new Map<number, ParsedDiffLine[]>();
  const deletedAfterNewLine = new Map<number, ParsedDiffLine[]>();
  const deletedAtStart: ParsedDiffLine[] = [];

  for (const hunk of file.hunks) {
    for (let index = 0; index < hunk.lines.length; index += 1) {
      const line = hunk.lines[index];
      if (!line) {
        continue;
      }
      if (line.kind === "add" && line.newLine !== undefined) {
        addedNewLines.add(line.newLine);
      }
      if (line.kind === "context" && line.newLine !== undefined && line.oldLine !== undefined) {
        oldLineByContextNewLine.set(line.newLine, line.oldLine);
      }
      if (line.kind !== "delete") {
        continue;
      }
      const nextNewLine = hunk.lines.slice(index + 1).find((candidate) => candidate.newLine !== undefined)?.newLine;
      if (nextNewLine !== undefined) {
        pushMapValue(deletedBeforeNewLine, nextNewLine, line);
        continue;
      }
      const previousNewLine = [...hunk.lines.slice(0, index)].reverse().find((candidate) => candidate.newLine !== undefined)?.newLine;
      if (previousNewLine !== undefined) {
        pushMapValue(deletedAfterNewLine, previousNewLine, line);
      } else {
        deletedAtStart.push(line);
      }
    }
  }

  const result: DiffLineView[] = deletedAtStart.map((line) => deletedLineView(line));
  fileLines.forEach((line, index) => {
    const newLine = index + 1;
    for (const deleted of deletedBeforeNewLine.get(newLine) ?? []) {
      result.push(deletedLineView(deleted));
    }
    result.push({
      content: line,
      marker: addedNewLines.has(newLine) ? "+" : " ",
      newLine,
      oldLine: addedNewLines.has(newLine) ? undefined : (oldLineByContextNewLine.get(newLine) ?? newLine),
      type: addedNewLines.has(newLine) ? "add" : "context",
    });
    for (const deleted of deletedAfterNewLine.get(newLine) ?? []) {
      result.push(deletedLineView(deleted));
    }
  });
  return result;
}

function splitDisplayLines(content: string): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function pushMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function deletedLineView(line: ParsedDiffLine): DiffLineView {
  return {
    content: line.content,
    marker: "-",
    oldLine: line.oldLine,
    type: "delete",
  };
}

function SnapshotComposer({
  busy,
  defaultLabel,
  disabled,
  onCreate,
}: {
  busy: boolean;
  defaultLabel: string;
  disabled: boolean;
  onCreate: (input: CreateSessionSnapshotRequest) => Promise<SessionSnapshot>;
}): React.JSX.Element {
  const [label, setLabel] = useState(defaultLabel);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    setLabel(defaultLabel);
  }, [defaultLabel]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (disabled || busy) {
      return;
    }
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setError("Snapshot title cannot be empty.");
      return;
    }
    setError(undefined);
    try {
      await onCreate({
        description: description.trim() || undefined,
        label: trimmedLabel,
      });
      setDescription("");
      setLabel(nextSnapshotLabel(trimmedLabel));
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  }

  return (
    <form className="snapshot-composer" onSubmit={(event) => void submit(event)}>
      <div className="snapshot-composer-header">
        <div>
          <h3>Take snapshot</h3>
          <small>Name the restore point and optionally record why you saved it.</small>
        </div>
        <button disabled={disabled || busy} type="submit">
          {busy ? "Saving" : "Take snapshot"}
        </button>
      </div>
      {error ? <div className="changes-feedback error">{error}</div> : null}
      <div className="snapshot-composer-grid">
        <label className="field">
          <span>Title</span>
          <input
            disabled={disabled || busy}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            value={label}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            disabled={disabled || busy}
            maxLength={400}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Why is this restore point useful?"
            value={description}
          />
        </label>
      </div>
    </form>
  );
}

function suggestSnapshotLabel(task?: Task): string {
  return task ? `${task.title} restore point` : "Manual snapshot";
}

function nextSnapshotLabel(current: string): string {
  const match = current.match(/^(.*?)(?:\s+#(\d+))?$/);
  if (!match) {
    return `${current} #2`;
  }
  const base = (match[1] ?? current).trim();
  const currentNumber = Number.parseInt(match[2] ?? "1", 10);
  return `${base} #${Number.isFinite(currentNumber) ? currentNumber + 1 : 2}`;
}

function detailSummaryBadges(overview: SessionOverview): string[] {
  return [
    overview.waitingApprovals > 0 ? `${overview.waitingApprovals} approvals` : undefined,
    overview.conflictFiles.length > 0 ? `${overview.conflictFiles.length} conflicts` : undefined,
    overview.overlapFiles.length > 0 ? `${overview.overlapFiles.length} overlaps` : undefined,
    overview.queuedTurns > 0 ? `${overview.queuedTurns} queued` : undefined,
    overview.filesChanged > 0 ? `${overview.filesChanged} files` : undefined,
    overview.snapshotCount > 0 ? `${overview.snapshotCount} snapshots` : undefined,
  ].filter((value): value is string => Boolean(value)).slice(0, 5);
}

function detailSummaryGroupLabel(overview: SessionOverview): string {
  switch (overviewGroupId(overview)) {
    case "attention":
      return "Needs attention";
    case "running":
      return "Running";
    case "ready":
      return "Ready";
    case "quiet":
      return "Quiet";
  }
}

function detailFocusText(tab: SessionWorkspaceTab, overview: SessionOverview): string {
  switch (tab) {
    case "work":
      return "Use Events for the clean human loop: prompts, final agent replies, approvals, and major session outcomes.";
    case "changes":
      if (overview.waitingApprovals > 0) {
        return `Resolve ${overview.waitingApprovals} pending approval request${overview.waitingApprovals === 1 ? "" : "s"} before shipping this session.`;
      }
      if (overview.latestDelivery.status === "pr_ready") {
        return "This session already has a PR-ready delivery path. Review changed files and delivery outputs from Changes before shipping.";
      }
      if (overview.latestDelivery.status === "compare_ready" || overview.latestDelivery.status === "pushed") {
        return "This session is pushed or compare-ready. Use Delivery beside Session branch to confirm branch, compare, and PR outputs.";
      }
      if (overview.latestDelivery.status === "branch_ready") {
        return "This session has a clean branch outcome. Use Delivery beside Session branch to push, export, or open a PR.";
      }
      if (overview.conflictFiles.length > 0 || overview.overlapFiles.length > 0) {
        return "Review conflicts, overlaps, diff scope, and manual edits before applying changes back to the original repository.";
      }
      return "Review changed files, edit manually if needed, then deliver, snapshot, apply as a patch, or keep iterating.";
    case "snapshots":
      return overview.snapshotCount > 0
        ? "Use snapshots as restore points before risky apply or delivery actions."
        : "Create a snapshot before high-risk edits or apply operations.";
    case "debug":
      if (overview.stuck || ["blocked", "failed"].includes(overview.health)) {
        return "Inspect runtime status, recovery state, raw events, and recent errors before resuming work.";
      }
      if (overview.activeTurn || overview.queuedTurns > 0) {
        return "Monitor live execution, queue pressure, terminal state, and raw event flow if the session drifts.";
      }
      return "Diagnostics shows raw runtime state, context decisions, and verbose event flow for this isolated session.";
    case "shell":
      return "Open an independent shell in the original project repository for manual git, conflict, and inspection work.";
  }
}

function ApplyConflictPanel({
  conflict,
  onCreateBranch,
  onExportPatch,
  onForceApply,
}: {
  conflict: ConflictState;
  onCreateBranch: () => void;
  onExportPatch: () => void;
  onForceApply: () => void;
}): React.JSX.Element {
  return (
    <section className="conflict-panel">
      <h3>Apply blocked</h3>
      <p>Workbench found a preflight risk before applying this session to the original repository.</p>
      {conflict.preflight.conflictFiles.length > 0 ? (
        <div className="conflict-files">
          <h4>Original repository conflicts</h4>
          {conflict.preflight.conflictFiles.map((file) => (
            <div key={file.path}>
              <strong>{file.path}</strong>
              <small>original: {file.originalStatus} · session: {file.sessionStatus}</small>
            </div>
          ))}
        </div>
      ) : null}
      {conflict.preflight.overlapFiles.length > 0 ? (
        <div className="conflict-files">
          <h4>Other session overlaps</h4>
          {conflict.preflight.overlapFiles.map((file) => (
            <div key={file.path}>
              <strong>{file.path}</strong>
              <small>{file.sessions.map((session) => `${session.title} (${session.status})`).join(", ")}</small>
            </div>
          ))}
        </div>
      ) : null}
      <div className="session-actions">
        <button className="secondary" onClick={onExportPatch} type="button">Export patch</button>
        <button className="secondary" onClick={onCreateBranch} type="button">Create branch</button>
        <button className="danger" onClick={onForceApply} type="button">Force apply</button>
      </div>
    </section>
  );
}

function BranchManager({ onTaskUpdated, task }: { onTaskUpdated: (task: Task) => void; task?: Task }): React.JSX.Element {
  const fallbackBranches = useMemo(() => sessionBranches(task), [task]);
  const [branches, setBranches] = useState<SessionBranch[]>(fallbackBranches);
  const sessionBranch = branches.find((branch) => branch.applySelected) ?? branches[0];
  const [draftName, setDraftName] = useState(sessionBranch?.name ?? task?.worktreeBranch ?? "");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setBranches(fallbackBranches);
  }, [fallbackBranches]);

  useEffect(() => {
    if (!task) {
      return;
    }
    let cancelled = false;
    void api<SessionBranchListResponse>(`/api/sessions/${task.id}/branches`)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBranches(result.branches);
        onTaskUpdated(result.task);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id]);

  useEffect(() => {
    setDraftName(sessionBranch?.name ?? task?.worktreeBranch ?? "");
    setError(undefined);
    setNotice(undefined);
  }, [sessionBranch?.id, sessionBranch?.name, task?.id, task?.worktreeBranch]);

  async function renameBranch(): Promise<void> {
    const nextName = draftName.trim();
    if (!task || !sessionBranch || !nextName || nextName === sessionBranch.name) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await api<SessionBranchListResponse>(`/api/sessions/${task.id}/branches/${encodeURIComponent(sessionBranch.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName }),
      });
      setBranches(result.branches);
      onTaskUpdated(result.task);
      setNotice(`Session branch renamed to ${nextName}.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setBusy(false);
    }
  }

  const changed = draftName.trim() !== (sessionBranch?.name ?? "");

  return (
    <section className="branch-manager">
      <header>
        <div>
          <h3>Session branch</h3>
          <p>This session owns one real branch checked out in one isolated worktree. Create another branch by creating another session.</p>
        </div>
      </header>
      {error ? <p className="branch-manager-error">{error}</p> : null}
      {notice ? <p className="branch-manager-notice">{notice}</p> : null}
      <div className="branch-table session-branch-summary" role="group" aria-label="Session branch">
        <label className="field">
          <span>Branch name</span>
          <div className="inline-field-action">
            <input
              className="branch-name-input"
              disabled={!task || !sessionBranch || busy}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              spellCheck={false}
              value={draftName}
            />
            <button className="secondary" disabled={!task || !sessionBranch || !changed || busy || !draftName.trim()} onClick={() => void renameBranch()} type="button">
              {busy ? "Renaming" : "Rename"}
            </button>
          </div>
        </label>
        <dl className="session-branch-meta">
          <div>
            <dt>Base</dt>
            <dd>{task?.baseBranch ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Worktree</dt>
            <dd title={task?.worktreePath}>{task?.worktreePath ? truncateMiddle(task.worktreePath, 96) : "No worktree"}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{sessionBranch?.createdAt ? formatDateTime(sessionBranch.createdAt) : "unknown"}</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function BranchManagerDialog({
  onCancel,
  onTaskUpdated,
  task,
}: {
  onCancel: () => void;
  onTaskUpdated: (task: Task) => void;
  task: Task;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        aria-labelledby="branch-manager-title"
        aria-modal="true"
        className="modal wide branch-manager-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="branch-manager-title">Session branch</h2>
          <p>One session maps to one branch and one isolated worktree.</p>
        </header>
        <BranchManager onTaskUpdated={onTaskUpdated} task={task} />
        <footer>
          <button className="secondary" onClick={onCancel} type="button">
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}

function DeliveryDialog({
  busyAction,
  items,
  onAction,
  onCancel,
  task,
}: {
  busyAction?: SessionUiAction;
  items: DeliveryItem[];
  onAction: (action: DiffPanelAction, input?: DeliveryActionInput) => void;
  onCancel: () => void;
  task: Task;
}): React.JSX.Element {
  const [target, setTarget] = useState<DeliveryTargetResponse>();
  const [targetError, setTargetError] = useState<string>();
  const [remote, setRemote] = useState("origin");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [addDialog, setAddDialog] = useState<{ files: ProjectStatusFile[]; page: number; selected: string[] }>();
  const [addError, setAddError] = useState<string>();
  const [addLoading, setAddLoading] = useState(false);
  const busy = busyAction !== undefined;

  useEffect(() => {
    let cancelled = false;
    void api<DeliveryTargetResponse>(`/api/sessions/${task.id}/delivery-target`)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setTarget(result);
        setRemote(result.remotes.includes("origin") ? "origin" : result.remotes[0] ?? "origin");
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTargetError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  function submitCommit(event: React.FormEvent): void {
    event.preventDefault();
    const message = commitMessage.trim();
    if (!message) {
      return;
    }
    onAction("repo_commit", { commitMessage: message });
    setCommitOpen(false);
    setCommitMessage("");
  }

  async function openAddDialog(): Promise<void> {
    setAddError(undefined);
    setAddLoading(true);
    try {
      const latest = await api<DeliveryTargetResponse>(`/api/sessions/${task.id}/delivery-target`);
      setTarget(latest);
      setRemote(latest.remotes.includes(remote) ? remote : latest.remotes.includes("origin") ? "origin" : latest.remotes[0] ?? "origin");
      if (latest.files.length === 0) {
        setAddError("No changed files to stage.");
        return;
      }
      setAddDialog({
        files: latest.files,
        page: 0,
        selected: latest.files.map((file) => file.path),
      });
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddLoading(false);
    }
  }

  function submitAddFiles(files: string[]): void {
    if (files.length === 0) {
      setAddError("Select at least one file to stage.");
      return;
    }
    onAction("repo_add", { files });
    setAddDialog(undefined);
  }

  return (
    <>
      <div className="modal-backdrop" onMouseDown={onCancel}>
        <section
          aria-labelledby="delivery-title"
          aria-modal="true"
          className="modal wide delivery-modal"
          onMouseDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <header>
            <h2 id="delivery-title">Delivery</h2>
            <p>Stage, commit, push, and open a draft PR from this session branch.</p>
          </header>
          <div className="delivery-modal-controls">
            <section className="delivery-target-panel">
              <div>
                <span>Worktree</span>
                <strong title={target?.projectPath}>{target?.projectPath ?? "Loading..."}</strong>
              </div>
              <div>
                <span>Active branch</span>
                <strong>{target?.currentBranch ?? "unknown"}</strong>
              </div>
              <label className="field">
                <span>Remote</span>
                <select value={remote} onChange={(event) => setRemote(event.currentTarget.value)}>
                  {(target?.remotes.length ? target.remotes : [remote]).map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
              {targetError ? <div className="error">{targetError}</div> : null}
              {addError ? <div className="error">{addError}</div> : null}
              {target?.status.trim() ? <pre>{target.status.trim()}</pre> : <small>Working tree clean.</small>}
            </section>
            <section className="session-actions" aria-label="Delivery actions">
              <button className="secondary" disabled={busy || addLoading} onClick={() => void openAddDialog()} type="button">
                {busyAction === "repo_add" ? "Adding" : addLoading ? "Loading" : "Add"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => setCommitOpen((value) => !value)} type="button">
                {busyAction === "repo_commit" ? "Committing" : "Commit"}
              </button>
              <button className="secondary" disabled={busy || !target?.currentBranch} onClick={() => onAction("push_branch", { remote })} type="button">
                {busyAction === "push_branch" ? "Pushing" : "Push"}
              </button>
              <button
                className="secondary"
                disabled={busy || !target?.currentBranch}
                onClick={() => onAction("create_pr", { remote })}
                title="Create a draft PR from this session branch. Workbench automatically stages, commits, pushes, then creates the draft PR."
                type="button"
              >
                {busyAction === "create_pr" ? "Creating" : "Draft PR"}
              </button>
            </section>
            {commitOpen ? (
              <form className="delivery-commit-form" onSubmit={submitCommit}>
                <label className="field">
                  <span>Commit message</span>
                  <textarea autoFocus placeholder="Describe the change" value={commitMessage} onChange={(event) => setCommitMessage(event.currentTarget.value)} />
                </label>
                <button disabled={busy || !commitMessage.trim()} type="submit">Commit</button>
              </form>
            ) : null}
          </div>
          <DeliveryPanel items={items} />
          <footer>
            <button className="secondary" onClick={onCancel} type="button">
              Close
            </button>
          </footer>
        </section>
      </div>
      {addDialog ? (
        <StageFilesDialog
          busy={busyAction === "repo_add"}
          files={addDialog.files}
          onCancel={() => setAddDialog(undefined)}
          onPageChange={(page) => setAddDialog((current) => (current ? { ...current, page } : current))}
          onSelectedChange={(selected) => setAddDialog((current) => (current ? { ...current, selected } : current))}
          onSubmit={submitAddFiles}
          page={addDialog.page}
          selected={addDialog.selected}
          target={target}
        />
      ) : null}
    </>
  );
}

function StageFilesDialog({
  busy,
  files,
  onCancel,
  onPageChange,
  onSelectedChange,
  onSubmit,
  page,
  selected,
  target,
}: {
  busy: boolean;
  files: ProjectStatusFile[];
  onCancel: () => void;
  onPageChange: (page: number) => void;
  onSelectedChange: (selected: string[]) => void;
  onSubmit: (files: string[]) => void;
  page: number;
  selected: string[];
  target?: DeliveryTargetResponse;
}): React.JSX.Element {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(files.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleFiles = files.slice(currentPage * pageSize, currentPage * pageSize + pageSize);
  const selectedSet = new Set(selected);

  function toggle(path: string): void {
    onSelectedChange(selectedSet.has(path) ? selected.filter((item) => item !== path) : [...selected, path]);
  }

  return (
    <div className="modal-backdrop nested" onMouseDown={onCancel}>
      <section
        aria-labelledby="stage-files-title"
        aria-modal="true"
        className="modal stage-files-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="stage-files-title">Stage files</h2>
          <p>Select which changed files should be added to this session branch index.</p>
        </header>
        <div className="stage-files-meta">
          <div>
            <span>Worktree</span>
            <strong title={target?.projectPath}>{target?.projectPath ?? "unknown"}</strong>
          </div>
          <div>
            <span>Branch</span>
            <strong>{target?.currentBranch ?? "unknown"}</strong>
          </div>
        </div>
        <div className="stage-files-toolbar">
          <button className="secondary compact-button" disabled={busy} onClick={() => onSelectedChange(files.map((file) => file.path))} type="button">
            Select all
          </button>
          <button className="secondary compact-button" disabled={busy} onClick={() => onSelectedChange([])} type="button">
            Clear
          </button>
          <span>{selected.length} / {files.length} selected</span>
        </div>
        <div className="stage-files-list">
          {visibleFiles.map((file) => (
            <label className="stage-file-row" key={`${file.status}-${file.path}`}>
              <input checked={selectedSet.has(file.path)} disabled={busy} onChange={() => toggle(file.path)} type="checkbox" />
              <span className="stage-file-status">{file.status}</span>
              <strong title={file.path}>{file.path}</strong>
            </label>
          ))}
        </div>
        {files.length > pageSize ? (
          <div className="branch-pagination">
            <button className="secondary compact-button" disabled={busy || currentPage === 0} onClick={() => onPageChange(Math.max(0, currentPage - 1))} type="button">
              Previous
            </button>
            <span>
              Page {currentPage + 1} / {pageCount}
            </span>
            <button className="secondary compact-button" disabled={busy || currentPage >= pageCount - 1} onClick={() => onPageChange(Math.min(pageCount - 1, currentPage + 1))} type="button">
              Next
            </button>
          </div>
        ) : null}
        <footer>
          <button className="secondary" disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={busy || selected.length === 0} onClick={() => onSubmit(selected)} type="button">
            {busy ? "Adding" : "Confirm add"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DeliveryPanel({ items }: { items: DeliveryItem[] }): React.JSX.Element {
  if (items.length === 0) {
    return (
      <section className="delivery-panel">
        <h3>Delivery history</h3>
        <p className="empty">No delivery actions yet. Stage, commit, push, or create a PR from the active project branch.</p>
      </section>
    );
  }

  return (
    <section className="delivery-panel">
      <h3>Delivery history</h3>
      <div className="delivery-list">
        {items.map((item, index) => (
          <article className={`delivery-item ${item.status}`} key={`${item.kind}-${item.timestamp}-${index}`}>
            <header>
              <div>
                <strong>{deliveryKindLabel(item.kind)}</strong>
                <small>{item.title}</small>
              </div>
              <span className={`delivery-status ${item.status}`}>{deliveryStatusLabel(item)}</span>
            </header>

            <div className="delivery-grid">
              <DeliveryField label="Branch" value={item.branch} />
              <DeliveryField label="Commit" value={item.commitSha} compact />
              <DeliveryField label="Patch" value={item.patchPath} />
              <DeliveryField label="Original repo" value={item.projectPath} />
              <DeliveryField label="Files" value={deliverySummaryText(item.summary)} />
              <DeliveryField label="Time" value={new Date(item.timestamp).toLocaleString()} />
            </div>

            {item.message || item.details ? <p className="delivery-message">{cleanEventText(item.message ?? item.details ?? "")}</p> : null}

            <div className="delivery-actions">
              {item.url ? <button className="secondary compact-button" onClick={() => openExternalUrl(item.url)} type="button">Open PR</button> : null}
              {item.compareUrl ? <button className="secondary compact-button" onClick={() => openExternalUrl(item.compareUrl)} type="button">Open compare</button> : null}
              {item.patchPath ? <button className="secondary compact-button" onClick={() => void copyText(item.patchPath ?? "")} type="button">Copy patch path</button> : null}
              {item.branch ? <button className="secondary compact-button" onClick={() => void copyText(item.branch ?? "")} type="button">Copy branch</button> : null}
              {item.commitSha ? <button className="secondary compact-button" onClick={() => void copyText(item.commitSha ?? "")} type="button">Copy commit</button> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeliveryField({
  compact = false,
  label,
  value,
}: {
  compact?: boolean;
  label: string;
  value?: string;
}): React.JSX.Element | null {
  if (!value) {
    return null;
  }
  return (
    <div className="delivery-field">
      <span>{label}</span>
      <strong title={value}>{compact ? shortSha(value) : value}</strong>
    </div>
  );
}

function sessionBranches(task?: Task): SessionBranch[] {
  if (!task) {
    return [];
  }
  if (task.branches?.length) {
    return task.branches;
  }
  const now = task.createdAt || new Date().toISOString();
  const branchName = task.worktreeBranch || `agent-workbench/${task.id}`;
  return [
    {
      id: `${task.id}:primary`,
      name: branchName,
      role: "primary",
      applySelected: true,
      createdAt: now,
      updatedAt: task.updatedAt || now,
    },
  ];
}

function AgentContextPanel({
  decision,
  task,
}: {
  decision: ContextDecision;
  task?: Task;
}): React.JSX.Element {
  return (
    <section className="agent-context-panel">
      <header>
        <div>
          <h3>Context</h3>
          <small>{contextStatusText(task)}</small>
        </div>
        <span className={`context-decision ${decision.status}`}>{contextDecisionLabel(decision)}</span>
      </header>
      <div className="agent-context-grid">
        <div>
          <span>Session context</span>
          <strong>{task?.agentContextStatus ?? "unknown"}</strong>
        </div>
        <div>
          <span>Resume mode</span>
          <strong>{task?.agentSessionResumeMode ?? "none"}</strong>
        </div>
        <div>
          <span>Transcript</span>
          <strong>{decision.attached === true ? "attached" : decision.attached === false ? "not attached" : "unknown"}</strong>
        </div>
        <div>
          <span>Reason</span>
          <strong>{decision.reason ?? "unknown"}</strong>
        </div>
      </div>
      {decision.timestamp ? <small className="context-time">Last decision: {new Date(decision.timestamp).toLocaleString()}</small> : null}
      {decision.details ? <p>{cleanEventText(decision.details)}</p> : null}
    </section>
  );
}

function SnapshotList({
  busy,
  currentDiff,
  onOpenChanges,
  onRollback,
  onSelect,
  onSnapshotsChange,
  selectedSnapshotId,
  snapshots,
  task,
}: {
  busy: boolean;
  currentDiff?: DiffSnapshot;
  onOpenChanges: () => void;
  onRollback: () => void;
  onSelect: (snapshotId: string) => void;
  onSnapshotsChange: (snapshots: SessionSnapshot[]) => void;
  selectedSnapshotId?: string;
  snapshots: SessionSnapshot[];
  task?: Task;
}): React.JSX.Element {
  const ordered = [...snapshots].reverse();
  const selected = snapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ?? snapshots.at(-1);
  const [editingId, setEditingId] = useState<string>();
  const [editDescription, setEditDescription] = useState("");
  const [editError, setEditError] = useState<string>();
  const [editLabel, setEditLabel] = useState("");
  const [mutatingId, setMutatingId] = useState<string>();
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();
  const [selectedPatch, setSelectedPatch] = useState<SessionSnapshotPatchResponse>();
  const [patchError, setPatchError] = useState<string>();
  const [isPatchLoading, setIsPatchLoading] = useState(false);

  useEffect(() => {
    if (!task || !selected) {
      setSelectedPatch(undefined);
      setPatchError(undefined);
      return;
    }
    let cancelled = false;
    setIsPatchLoading(true);
    setPatchError(undefined);
    void api<SessionSnapshotPatchResponse>(`/api/sessions/${task.id}/snapshots/${selected.id}/patch`)
      .then((response) => {
        if (!cancelled) {
          setSelectedPatch(response);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSelectedPatch(undefined);
          setPatchError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsPatchLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, task?.id]);

  function startEdit(snapshot: SessionSnapshot): void {
    setEditingId(snapshot.id);
    setEditLabel(snapshot.label);
    setEditDescription(snapshot.description ?? "");
    setEditError(undefined);
    setPendingDeleteId(undefined);
  }

  async function saveEdit(snapshot: SessionSnapshot): Promise<void> {
    if (!task) {
      return;
    }
    const label = editLabel.trim();
    if (!label) {
      setEditError("Snapshot title cannot be empty.");
      return;
    }
    setMutatingId(snapshot.id);
    setEditError(undefined);
    try {
      const updated = await api<SessionSnapshot>(`/api/sessions/${task.id}/snapshots/${snapshot.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: editDescription.trim() || undefined,
          label,
        } satisfies UpdateSessionSnapshotRequest),
      });
      onSnapshotsChange(snapshots.map((item) => (item.id === updated.id ? updated : item)));
      setEditingId(undefined);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setMutatingId(undefined);
    }
  }

  async function deleteSnapshot(snapshot: SessionSnapshot): Promise<void> {
    if (!task) {
      return;
    }
    setMutatingId(snapshot.id);
    setEditError(undefined);
    try {
      await api<{ ok: true }>(`/api/sessions/${task.id}/snapshots/${snapshot.id}`, { method: "DELETE" });
      const nextSnapshots = snapshots.filter((item) => item.id !== snapshot.id);
      onSnapshotsChange(nextSnapshots);
      if (selectedSnapshotId === snapshot.id) {
        const nextSelected = nextSnapshots.at(-1);
        if (nextSelected) {
          onSelect(nextSelected.id);
        }
      }
      setPendingDeleteId(undefined);
      setEditingId(undefined);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setMutatingId(undefined);
    }
  }

  return (
    <section className="snapshot-list">
      <header>
        <div>
          <h3>Snapshots</h3>
          <small>
            {selected
              ? `Selected: ${selected.label} · ${new Date(selected.createdAt).toLocaleString()}${selected.description ? ` · ${selected.description}` : ""}`
              : "Select a snapshot to roll back."}
          </small>
        </div>
        <button className="danger compact-button" disabled={!selected || busy} onClick={onRollback} type="button">
          {busy ? "Rolling back" : "Rollback selected"}
        </button>
      </header>
      <div className="snapshot-timeline">
        {ordered.map((snapshot) => {
          const editing = editingId === snapshot.id;
          const deleting = pendingDeleteId === snapshot.id;
          return (
            <article className={`snapshot-item ${snapshot.id === selected?.id ? "selected" : ""}`} key={snapshot.id}>
              {editing ? (
                <div className="snapshot-edit-form">
                  <label className="field">
                    <span>Title</span>
                    <input disabled={mutatingId === snapshot.id} value={editLabel} onChange={(event) => setEditLabel(event.currentTarget.value)} />
                  </label>
                  <label className="field">
                    <span>Description</span>
                    <textarea disabled={mutatingId === snapshot.id} value={editDescription} onChange={(event) => setEditDescription(event.currentTarget.value)} />
                  </label>
                  {editError ? <div className="changes-feedback error">{editError}</div> : null}
                  <div className="snapshot-item-actions">
                    <button className="secondary compact-button" disabled={mutatingId === snapshot.id} onClick={() => void saveEdit(snapshot)} type="button">
                      {mutatingId === snapshot.id ? "Saving" : "Save"}
                    </button>
                    <button className="secondary compact-button" disabled={mutatingId === snapshot.id} onClick={() => setEditingId(undefined)} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button className="snapshot-select-button" onClick={() => onSelect(snapshot.id)} type="button">
                    <span className={`snapshot-kind ${snapshot.kind}`}>{snapshotKindLabel(snapshot.kind)}</span>
                    <strong>{snapshot.label}</strong>
                    <small>{new Date(snapshot.createdAt).toLocaleString()}</small>
                    {snapshot.description ? <p className="snapshot-description">{snapshot.description}</p> : null}
                    <span>
                      {snapshot.summary.filesChanged} files · +{snapshot.summary.insertions} · -{snapshot.summary.deletions}
                    </span>
                    <code title={snapshot.patchPath}>{snapshot.patchPath}</code>
                  </button>
                  <div className="snapshot-item-actions">
                    <button className="secondary compact-button" disabled={busy || mutatingId === snapshot.id} onClick={() => startEdit(snapshot)} type="button">
                      Edit
                    </button>
                    {deleting ? (
                      <>
                        <button className="danger compact-button" disabled={mutatingId === snapshot.id} onClick={() => void deleteSnapshot(snapshot)} type="button">
                          Confirm delete
                        </button>
                        <button className="secondary compact-button" disabled={mutatingId === snapshot.id} onClick={() => setPendingDeleteId(undefined)} type="button">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button className="secondary compact-button" disabled={busy || mutatingId === snapshot.id} onClick={() => setPendingDeleteId(snapshot.id)} type="button">
                        Delete
                      </button>
                    )}
                  </div>
                  {editError && (editingId === snapshot.id || pendingDeleteId === snapshot.id) ? <div className="changes-feedback error">{editError}</div> : null}
                </>
              )}
            </article>
          );
        })}
      </div>
      <SnapshotComparePanel
        currentDiff={currentDiff}
        error={patchError}
        loading={isPatchLoading}
        onOpenChanges={onOpenChanges}
        onRollback={onRollback}
        rollbackBusy={busy}
        response={selectedPatch}
        selected={selected}
      />
    </section>
  );
}

function SnapshotComparePanel({
  currentDiff,
  error,
  loading,
  onOpenChanges,
  onRollback,
  rollbackBusy,
  response,
  selected,
}: {
  currentDiff?: DiffSnapshot;
  error?: string;
  loading: boolean;
  onOpenChanges: () => void;
  onRollback: () => void;
  rollbackBusy: boolean;
  response?: SessionSnapshotPatchResponse;
  selected?: SessionSnapshot;
}): React.JSX.Element | null {
  if (!selected) {
    return null;
  }

  const snapshotPatch = response?.patchText ?? "";
  const snapshotFiles = parseUnifiedDiff(snapshotPatch);
  const currentFiles = parseUnifiedDiff(currentDiff?.diffText ?? "");
  const compare = compareSnapshotDiffs(snapshotFiles, currentFiles);

  return (
    <section className="snapshot-compare">
      <header>
        <div>
          <h3>Compare to current worktree</h3>
          <small>{selected.label}</small>
        </div>
        <span className={`snapshot-compare-status ${compare.status}`}>{snapshotCompareStatusLabel(compare.status)}</span>
      </header>
      {loading ? <p className="empty">Loading snapshot patch...</p> : null}
      {error ? <div className="changes-feedback error">{error}</div> : null}
      {!loading && !error ? (
        <>
          <div className="snapshot-compare-grid">
            <div>
              <span>Snapshot files</span>
              <strong>{snapshotFiles.length || selected.summary.filesChanged}</strong>
            </div>
            <div>
              <span>Current files</span>
              <strong>{currentDiff?.summary.filesChanged ?? 0}</strong>
            </div>
            <div>
              <span>Snapshot-only</span>
              <strong>{compare.snapshotOnly.length}</strong>
            </div>
            <div>
              <span>Current-only</span>
              <strong>{compare.currentOnly.length}</strong>
            </div>
            <div>
              <span>Changed in both</span>
              <strong>{compare.changed.length}</strong>
            </div>
          </div>
          <p className="snapshot-compare-explanation">{snapshotCompareSummary(compare, Boolean(currentDiff?.diffText.trim()))}</p>
          <div className="snapshot-compare-actions">
            {(compare.status === "drifted" || compare.status === "matches") && currentFiles.length > 0 ? (
              <button className="secondary compact-button" onClick={onOpenChanges} type="button">
                Open Changes
              </button>
            ) : null}
            {compare.status !== "matches" ? (
              <button className="danger compact-button" disabled={rollbackBusy} onClick={onRollback} type="button">
                {rollbackBusy ? "Rolling back" : "Rollback to selected"}
              </button>
            ) : null}
          </div>
          <div className="snapshot-compare-lists">
            {compare.snapshotOnly.length > 0 ? <SnapshotCompareList label="Only in snapshot" paths={compare.snapshotOnly} /> : null}
            {compare.currentOnly.length > 0 ? <SnapshotCompareList label="Only in current" paths={compare.currentOnly} /> : null}
            {compare.changed.length > 0 ? <SnapshotCompareList label="Changed in both" paths={compare.changed} /> : null}
          </div>
          {response ? (
            <details className="changes-full-patch">
              <summary>Selected snapshot patch</summary>
              <DiffViewer
                diff={{
                  createdAt: response.snapshot.createdAt,
                  diffText: response.patchText,
                  id: response.snapshot.id,
                  summary: response.snapshot.summary,
                  taskId: response.snapshot.taskId,
                }}
                files={snapshotFiles}
              />
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function SnapshotCompareList({
  label,
  paths,
}: {
  label: string;
  paths: string[];
}): React.JSX.Element {
  return (
    <div className="snapshot-compare-list">
      <strong>{label}</strong>
      <ul>
        {paths.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function compareSnapshotDiffs(snapshotFiles: ParsedDiffFile[], currentFiles: ParsedDiffFile[]): {
  changed: string[];
  currentOnly: string[];
  snapshotOnly: string[];
  status: "drifted" | "matches" | "no_current_diff";
} {
  const snapshotMap = new Map(snapshotFiles.map((file) => [file.path, diffFileSignature(file)]));
  const currentMap = new Map(currentFiles.map((file) => [file.path, diffFileSignature(file)]));
  const snapshotOnly: string[] = [];
  const currentOnly: string[] = [];
  const changed: string[] = [];

  for (const [path, signature] of snapshotMap) {
    if (!currentMap.has(path)) {
      snapshotOnly.push(path);
      continue;
    }
    if (currentMap.get(path) !== signature) {
      changed.push(path);
    }
  }

  for (const path of currentMap.keys()) {
    if (!snapshotMap.has(path)) {
      currentOnly.push(path);
    }
  }

  if (currentFiles.length === 0) {
    return {
      changed,
      currentOnly,
      snapshotOnly,
      status: snapshotFiles.length === 0 ? "matches" : "no_current_diff",
    };
  }

  return {
    changed,
    currentOnly,
    snapshotOnly,
    status: snapshotOnly.length === 0 && currentOnly.length === 0 && changed.length === 0 ? "matches" : "drifted",
  };
}

function diffFileSignature(file: ParsedDiffFile): string {
  return [file.status, file.additions, file.deletions, file.hunks.length].join(":");
}

function snapshotCompareStatusLabel(status: "drifted" | "matches" | "no_current_diff"): string {
  switch (status) {
    case "matches":
      return "Matches current";
    case "no_current_diff":
      return "No current diff";
    case "drifted":
      return "Drifted";
  }
}

function snapshotCompareSummary(
  compare: {
    changed: string[];
    currentOnly: string[];
    snapshotOnly: string[];
    status: "drifted" | "matches" | "no_current_diff";
  },
  hasCurrentDiff: boolean,
): string {
  if (compare.status === "matches") {
    return "The selected snapshot and the current session diff touch the same files with the same patch summary.";
  }
  if (!hasCurrentDiff || compare.status === "no_current_diff") {
    return "The selected snapshot still captures changes, but the current session has no active diff snapshot to compare against.";
  }
  return "The current session has drifted from this restore point. Review the file lists below before deciding whether to keep editing or roll back.";
}

function snapshotKindLabel(kind: SessionSnapshot["kind"]): string {
  switch (kind) {
    case "before_apply":
      return "Before apply";
    case "manual":
      return "Manual";
    case "rollback":
      return "Safety";
  }
}

function AgentConsoleDialog({
  diagnostics,
  onClose,
}: {
  diagnostics: SessionDiagnostics;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby="agent-console-title"
        aria-modal="true"
        className="modal wide"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="agent-console-title">Agent console</h2>
          <p>{diagnostics.backend.name} · {diagnostics.backend.available ? "available" : "unavailable"}</p>
        </header>
        <div className="diagnostics-grid">
          <div>
            <span>Status</span>
            <strong>{diagnostics.session.status}</strong>
          </div>
          <div>
            <span>Events</span>
            <strong>{diagnostics.events.total}</strong>
          </div>
          <div>
            <span>Errors</span>
            <strong>{diagnostics.events.errors}</strong>
          </div>
          <div>
            <span>Pending approvals</span>
            <strong>{diagnostics.events.approvalsPending}</strong>
          </div>
          <div>
            <span>Active turn</span>
            <strong>{diagnostics.queue.activeTurn ? "yes" : "no"}</strong>
          </div>
          <div>
            <span>Queued turns</span>
            <strong>{diagnostics.queue.queuedTurns}</strong>
          </div>
        </div>
        <div className="modal-body">
          <strong>Worktree</strong>
          <code>{diagnostics.worktree.path ?? "No worktree"}</code>
          <p>Branch: {diagnostics.worktree.branch ?? "unknown"}</p>
          <p>Changed files: {diagnostics.worktree.changedFiles.length ? diagnostics.worktree.changedFiles.join(", ") : "none"}</p>
          {diagnostics.backend.details ? <p>{diagnostics.backend.details}</p> : null}
        </div>
        <div className="modal-body">
          <strong>Pending queue</strong>
          {diagnostics.queue.pending.length > 0 ? (
            <div className="queue-list">
              {diagnostics.queue.pending.map((item) => (
                <div key={`${item.position}-${item.queuedAt}`}>
                  <span>#{item.position} · {formatDateTime(item.queuedAt)}</span>
                  <p>{item.prompt}</p>
                </div>
              ))}
            </div>
          ) : (
            <p>No queued messages.</p>
          )}
        </div>
        <footer>
          <button className="secondary" onClick={onClose} type="button">Close</button>
        </footer>
      </section>
    </div>
  );
}

function ConfirmSessionActionDialog({
  action,
  applyTarget,
  busy,
  onCancel,
  onConfirm,
  task,
}: {
  action: ConfirmableAction;
  applyTarget?: ApplyTargetResponse;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (targetBranch?: string) => void;
  task: Task;
}): React.JSX.Element {
  const targetBranch = applyTarget?.originalBranch || "detached HEAD / unknown branch";
  const branchOptions = useMemo(
    () => (applyTarget?.branches || []).map((branch) => branch.name).filter(Boolean),
    [applyTarget?.branches],
  );
  const [targetBranchInput, setTargetBranchInput] = useState(applyTarget?.originalBranch || "");
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement | null>(null);
  const normalizedTargetBranch = targetBranchInput.trim();
  const targetBranchExists = normalizedTargetBranch ? branchOptions.includes(normalizedTargetBranch) : false;
  const title =
    action === "apply"
      ? "Confirm apply"
      : action === "sync_latest"
        ? "Confirm sync"
      : action === "push_branch"
        ? "Push git branch"
        : "Create draft PR";
  const body =
    action === "apply"
      ? "Choose the original repository branch that should receive this isolated session. If the branch does not exist, Workbench will create it before applying."
      : action === "sync_latest"
        ? `Reset the isolated Agent Workbench worktree to the current original repository branch ${targetBranch}?`
      : action === "push_branch"
        ? "This commits the isolated worktree branch if needed and pushes it to the origin remote with git."
        : "This commits and pushes the isolated worktree branch with git, then creates a draft pull request through the current GitHub PR connector. Today that connector uses gh.";
  const label = action === "apply" ? "Confirm" : action === "sync_latest" ? "Sync to latest" : action === "push_branch" ? "Push branch" : "Create draft PR";
  const confirmDisabled = busy || (action === "apply" && !normalizedTargetBranch);

  useEffect(() => {
    if (!branchMenuOpen) {
      return;
    }
    function closeOnOutsidePointer(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && branchPickerRef.current?.contains(target)) {
        return;
      }
      setBranchMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [branchMenuOpen]);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        aria-labelledby="confirm-action-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="confirm-action-title">{title}</h2>
          <p>{body}</p>
        </header>
        <div className="modal-body">
          <strong>{task.title}</strong>
          {action === "apply" || action === "sync_latest" ? (
            <>
              <div className="confirm-detail-row">
                <span>{action === "sync_latest" ? "Source branch" : "Source"}</span>
                <code>{action === "sync_latest" ? targetBranch : applyTarget?.worktreePath || task.worktreePath || "isolated session worktree"}</code>
              </div>
              <div className="confirm-detail-row">
                <span>{action === "sync_latest" ? "Target" : "Target branch"}</span>
                {action === "sync_latest" ? (
                  <code>{applyTarget?.worktreePath || task.worktreePath || "isolated session worktree"}</code>
                ) : (
                  <div className="confirm-branch-target">
                    <div className="branch-picker" ref={branchPickerRef}>
                      <input
                        aria-label="Target branch"
                        disabled={busy}
                        onChange={(event) => setTargetBranchInput(event.target.value)}
                        onFocus={() => setBranchMenuOpen(true)}
                        placeholder="feature/name"
                        value={targetBranchInput}
                      />
                      <button
                        aria-label="Show branches"
                        className="branch-picker-toggle"
                        disabled={busy || branchOptions.length === 0}
                        onClick={() => setBranchMenuOpen((open) => !open)}
                        type="button"
                      >
                        ▾
                      </button>
                      {branchMenuOpen ? (
                        <div className="branch-picker-menu">
                          {branchOptions.length > 0 ? (
                            branchOptions.map((branch) => (
                              <button
                                key={branch}
                                onClick={() => {
                                  setTargetBranchInput(branch);
                                  setBranchMenuOpen(false);
                                }}
                                type="button"
                              >
                                {branch}
                              </button>
                            ))
                          ) : (
                            <small>No branches found.</small>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <small>
                      {targetBranchExists
                        ? "Existing branch. Workbench will switch the original repo there before applying."
                        : normalizedTargetBranch
                          ? "New branch. Workbench will create it from the original repo HEAD before applying."
                          : "Enter or choose a branch name."}
                    </small>
                  </div>
                )}
              </div>
              <div className="confirm-detail-row">
                <span>Original HEAD</span>
                <code>{applyTarget?.originalHead ? shortSha(applyTarget.originalHead) : "unknown"}</code>
              </div>
              <div className="confirm-detail-row">
                <span>Original repo</span>
                <code>{applyTarget?.projectPath || "unknown"}</code>
              </div>
            </>
          ) : task.worktreePath ? (
            <code>{task.worktreePath}</code>
          ) : null}
        </div>
        <footer>
          <button className="secondary" disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger" disabled={confirmDisabled} onClick={() => onConfirm(normalizedTargetBranch)} type="button">
            {busy ? "Working" : label}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DeleteSessionDialog({
  isDeleting,
  onCancel,
  onConfirm,
  task,
}: {
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  task: Task;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        aria-labelledby="delete-session-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="delete-session-title">Remove session</h2>
          <p>This removes the session record, timeline, diffs, and isolated worktree.</p>
        </header>
        <div className="modal-body">
          <strong>{task.title}</strong>
          {task.worktreePath ? <code>{task.worktreePath}</code> : null}
        </div>
        <footer>
          <button className="secondary" disabled={isDeleting} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger" disabled={isDeleting} onClick={onConfirm} type="button">
            {isDeleting ? "Removing" : "Remove session"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DeleteProjectDialog({
  isDeleting,
  onCancel,
  onConfirm,
  project,
  sessionCount,
}: {
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  project: Project;
  sessionCount: number;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <section
        aria-labelledby="delete-project-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="delete-project-title">Remove project</h2>
          <p>This removes the project from Workbench and clears its sessions. It does not delete the repository on disk.</p>
        </header>
        <div className="modal-body">
          <strong>{project.name}</strong>
          <code>{project.path}</code>
          <small>{sessionCount} session{sessionCount === 1 ? "" : "s"} will be removed from Workbench.</small>
        </div>
        <footer>
          <button className="secondary" disabled={isDeleting} onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="danger" disabled={isDeleting} onClick={onConfirm} type="button">
            {isDeleting ? "Removing" : "Remove project"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ProjectManageDialog({
  isRenaming,
  name,
  onCancel,
  onRemove,
  onSubmit,
  project,
  setName,
}: {
  isRenaming: boolean;
  name: string;
  onCancel: () => void;
  onRemove: () => void;
  onSubmit: (event: React.FormEvent) => void;
  project: Project;
  setName: (name: string) => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        aria-labelledby="rename-project-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
      >
        <header>
          <h2 id="rename-project-title">Project settings</h2>
          <p>Update the Workbench display name or remove this project from Workbench. The repository on disk is not changed.</p>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>Project name</span>
            <input autoFocus maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <code>{project.path}</code>
        </div>
        <footer>
          <button className="danger" disabled={isRenaming} onClick={onRemove} type="button">
            Remove
          </button>
          <button className="secondary" disabled={isRenaming} onClick={onCancel} type="button">
            Close
          </button>
          <button disabled={isRenaming || !name.trim()} type="submit">
            {isRenaming ? "Updating" : "Update"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function RenameSessionDialog({
  isRenaming,
  onCancel,
  onSubmit,
  setTitle,
  task,
  title,
}: {
  isRenaming: boolean;
  onCancel: () => void;
  onSubmit: (event: React.FormEvent) => void;
  setTitle: (title: string) => void;
  task: Task;
  title: string;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        aria-labelledby="rename-session-title"
        aria-modal="true"
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
      >
        <header>
          <h2 id="rename-session-title">Rename session</h2>
          <p>Change the display name used in the sidebar, Overview, and session header.</p>
        </header>
        <div className="modal-body">
          <label className="field">
            <span>Session title</span>
            <input
              autoFocus
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
          </label>
          <small>{task.id}</small>
        </div>
        <footer>
          <button className="secondary" disabled={isRenaming} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={isRenaming || !title.trim()} type="submit">
            {isRenaming ? "Renaming" : "Rename"}
          </button>
        </footer>
      </form>
    </div>
  );
}

interface ParsedDiffFile {
  additions: number;
  deletions: number;
  hunks: ParsedDiffHunk[];
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
}

interface ParsedDiffHunk {
  header: string;
  lines: ParsedDiffLine[];
}

interface ParsedDiffLine {
  content: string;
  kind: "add" | "delete" | "context" | "meta";
  newLine?: number;
  oldLine?: number;
}

interface DiffLineView {
  content: string;
  marker: "+" | "-" | " ";
  newLine?: number;
  oldLine?: number;
  type: "add" | "delete" | "context" | "meta";
}

function DiffViewer({ diff, files }: { diff: DiffSnapshot; files: ParsedDiffFile[] }): React.JSX.Element {
  if (!diff.diffText.trim()) {
    return <p className="empty">No diff content.</p>;
  }

  return (
    <div className="diff-viewer">
      <div className="diff-summary">
        <strong>{files.length || diff.summary.filesChanged}</strong> files
        <strong>{diff.summary.insertions}</strong> additions
        <strong>{diff.summary.deletions}</strong> deletions
      </div>

      {files.length === 0 ? (
        <pre>{diff.diffText}</pre>
      ) : (
        <div className="diff-files">
          {files.map((file) => (
            <details className="diff-file" key={file.path}>
              <summary>
                <div>
                  <strong>{file.path}</strong>
                  <span className={`diff-status ${file.status}`}>{file.status}</span>
                </div>
                <small>
                  +{file.additions} -{file.deletions}
                </small>
              </summary>
              {file.hunks.map((hunk, hunkIndex) => (
                <div className="diff-hunk" key={`${file.path}-${hunkIndex}`}>
                  <div className="diff-hunk-header">{hunk.header}</div>
                  {hunk.lines.map((line, lineIndex) => (
                    <div className={`diff-line ${line.kind}`} key={`${file.path}-${hunkIndex}-${lineIndex}`}>
                      <span className="line-no">{line.oldLine ?? ""}</span>
                      <span className="line-no">{line.newLine ?? ""}</span>
                      <code>{line.content || " "}</code>
                    </div>
                  ))}
                </div>
              ))}
            </details>
          ))}
        </div>
      )}

      <details className="raw-diff">
        <summary>Raw patch</summary>
        <pre>{diff.diffText}</pre>
      </details>
    </div>
  );
}

type RichMessageBlock =
  | { kind: "code"; language?: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

function RichMessage({
  className,
  text,
}: {
  className?: string;
  text: string;
}): React.JSX.Element {
  const blocks = parseRichMessage(text);
  return (
    <div className={["rich-message", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => {
        if (block.kind === "code") {
          return (
            <pre className="rich-code" key={`code-${index}`}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === "list") {
          return (
            <ul className="rich-list" key={`list-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${index}-${itemIndex}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "heading") {
          const HeadingTag = block.level <= 2 ? "h3" : "h4";
          return (
            <HeadingTag className="rich-heading" key={`heading-${index}`}>
              {renderInlineText(block.text)}
            </HeadingTag>
          );
        }
        return <p key={`paragraph-${index}`}>{renderInlineText(block.text)}</p>;
      })}
    </div>
  );
}

function parseRichMessage(text: string): RichMessageBlock[] {
  const normalized = normalizeRichMessageText(text);
  const blocks: RichMessageBlock[] = [];
  const paragraph: string[] = [];
  let listItems: string[] = [];
  let code: string[] = [];
  let codeLanguage: string | undefined;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ").replace(/\s+/g, " ").trim() });
      paragraph.length = 0;
    }
  };
  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ kind: "list", items: listItems });
      listItems = [];
    }
  };
  const flushCode = () => {
    blocks.push({ kind: "code", language: codeLanguage, text: code.join("\n") });
    code = [];
    codeLanguage = undefined;
  };

  for (const line of normalized.split(/\r?\n/)) {
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      if (codeLanguage !== undefined) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeLanguage = fence[1] || "";
      }
      continue;
    }

    if (codeLanguage !== undefined) {
      code.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: headingMatch[1]?.length ?? 3, text: headingMatch[2]?.trim() ?? "" });
      continue;
    }

    const listMatch = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushParagraph();
      listItems.push((listMatch[1] ?? "").trim());
      continue;
    }

    if (listItems.length > 0 && /^\s{2,}\S/.test(line)) {
      listItems[listItems.length - 1] = `${listItems[listItems.length - 1]} ${line.trim()}`;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (codeLanguage !== undefined) {
    flushCode();
  }
  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks : [{ kind: "paragraph", text }];
}

function normalizeRichMessageText(text: string): string {
  return text
    .trim()
    .replace(/:\s+([-*]\s+)/g, ":\n$1")
    .replace(/([.!?])\s+([-*]\s+)/g, "$1\n$2")
    .replace(/(\S)\s+([-*]\s+`[^`]+`)/g, "$1\n$2")
    .replace(/([.!?])\s+(\d+\.\s+)/g, "$1\n$2");
}

function renderInlineText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const parts = text.split(/(`[^`]+`)/g);
  for (const [partIndex, part] of parts.entries()) {
    if (!part) {
      continue;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      nodes.push(<code key={`code-${partIndex}`}>{part.slice(1, -1)}</code>);
      continue;
    }
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    for (const [boldIndex, boldPart] of boldParts.entries()) {
      if (!boldPart) {
        continue;
      }
      if (boldPart.startsWith("**") && boldPart.endsWith("**")) {
        nodes.push(<strong key={`bold-${partIndex}-${boldIndex}`}>{boldPart.slice(2, -2)}</strong>);
      } else {
        nodes.push(boldPart);
      }
    }
  }
  return nodes;
}

function EventRow({
  approvalDecision,
  approvalPending,
  debug,
  event,
  onApproval,
}: {
  approvalDecision?: ApprovalDecision;
  approvalPending: boolean;
  debug: boolean;
  event: AgentEvent;
  onApproval: (taskId: string, approvalId: string, decision: ApprovalDecision) => Promise<void>;
}): React.JSX.Element {
  const shellThought = event.type === "shell.output" && event.data.startsWith("[thought]");
  const approvalLocked = approvalPending || approvalDecision !== undefined;
  const showActionDetails = debug || (event.type === "session.action" && event.status === "failed");
  return (
    <article className={`event-row ${eventRowClass(event)}`}>
      <span className="event-type">{eventLabel(event)}</span>
      <div>
        {event.type === "task.started" ? <p>Session started.</p> : null}
        {event.type === "user.message" ? <RichMessage className="user-message" text={event.text} /> : null}
        {event.type === "message.delta" ? <RichMessage className="agent-message" text={event.text} /> : null}
        {event.type === "shell.output" && shellThought ? (
          <details className="event-details">
            <summary>Thought</summary>
            <pre>{event.data.replace(/^\[thought\]\s*/, "")}</pre>
          </details>
        ) : null}
        {event.type === "shell.output" && !shellThought ? <pre>{event.data}</pre> : null}
        {event.type === "tool.started" ? (
          <>
            <p>{toolTitle(event.name, event.input)}</p>
            {isEmptyPayload(event.input) ? null : <PayloadDetails value={event.input} />}
          </>
        ) : null}
        {event.type === "tool.finished" ? (
          <>
            <p>
              {toolTitle(event.name ?? event.toolCallId, event.output)}: {event.status}
            </p>
            {toolSummary(event.output) ? <small>{toolSummary(event.output)}</small> : null}
            {isEmptyPayload(event.output) ? null : <PayloadDetails value={event.output} />}
          </>
        ) : null}
        {event.type === "diff.updated" ? (
          <p>
            {event.summary.filesChanged} files, {event.summary.insertions} additions, {event.summary.deletions} deletions
          </p>
        ) : null}
        {event.type === "session.action" ? (
          <>
            <p>{event.title}</p>
            {debug ? <span className={`action-state ${event.status}`}>{event.status}</span> : null}
            {showActionDetails && event.details ? <small>{cleanEventText(event.details)}</small> : null}
            {debug && !isEmptyPayload(event.data) ? <PayloadDetails value={event.data} /> : null}
          </>
        ) : null}
        {event.type === "approval.requested" ? (
          <>
            <p>{approvalActionTitle(event.request)}</p>
            {approvalPending ? <span className="approval-state pending">Decision sent</span> : null}
            {approvalDecision ? <span className="approval-state resolved">{approvalDecisionLabel(approvalDecision)}</span> : null}
            {event.request.body ? <pre>{event.request.body}</pre> : null}
            <div className="approval-actions">
              <button disabled={approvalLocked} type="button" onClick={() => void onApproval(event.taskId, event.approvalId, "allow_once")}>
                Allow once
              </button>
              <button disabled={approvalLocked} type="button" onClick={() => void onApproval(event.taskId, event.approvalId, "allow_for_task")}>
                Allow task
              </button>
              <button className="secondary" disabled={approvalLocked} type="button" onClick={() => void onApproval(event.taskId, event.approvalId, "deny")}>
                Deny
              </button>
              <button className="danger" disabled={approvalLocked} type="button" onClick={() => void onApproval(event.taskId, event.approvalId, "deny_and_stop")}>
                Stop
              </button>
            </div>
          </>
        ) : null}
        {event.type === "approval.resolved" ? <p>{event.decision}</p> : null}
        {event.type === "turn.finished" ? (
          <>
            <p>{event.status === "failed" ? "Turn failed" : event.status}</p>
            {debug && event.stopReason ? <pre>{event.stopReason}</pre> : null}
            {event.error ? <pre>{cleanEventText(event.error)}</pre> : null}
          </>
        ) : null}
        {event.type === "task.finished" ? (
          <>
            <p>{event.status === "failed" ? "Task failed" : event.status}</p>
            {event.error ? <pre>{cleanEventText(event.error)}</pre> : null}
          </>
        ) : null}
        {debug ? <small className="event-time">{event.timestamp}</small> : null}
      </div>
    </article>
  );
}

function eventLabel(event: AgentEvent): string {
  switch (event.type) {
    case "task.started":
      return "session";
    case "user.message":
      return "user";
    case "message.delta":
      return "agent";
    case "shell.output":
      return event.data.startsWith("[thought]") ? "thought" : "output";
    case "tool.started":
      return "tool start";
    case "tool.finished":
      return "tool result";
    case "approval.requested":
      return "approval";
    case "approval.resolved":
      return "decision";
    case "diff.updated":
      return "diff";
    case "session.action":
      if (event.action === "context") {
        return "context";
      }
      if (event.action === "resume") {
        return "reconnect";
      }
      if (event.action === "discard") {
        return "delete session";
      }
      return event.action.replace(/_/g, " ");
    case "task.finished":
      return "task";
    case "turn.finished":
      return "turn";
  }
}

function eventRowClass(event: AgentEvent): string {
  if (event.type === "user.message") {
    return "user";
  }
  if (event.type === "message.delta") {
    return "agent";
  }
  if (event.type === "approval.requested") {
    return "approval";
  }
  if (
    (event.type === "session.action" && event.status === "failed") ||
    (event.type === "turn.finished" && event.status === "failed") ||
    (event.type === "task.finished" && event.status === "failed")
  ) {
    return "error";
  }
  if (event.type === "diff.updated") {
    return "diff";
  }
  return "system";
}

function cleanEventText(value: string): string {
  const parsed = parseJsonObject(value);
  const details = valueAtPath(parsed, ["data", "details"]);
  const message = valueAtPath(parsed, ["message"]);
  const text = typeof details === "string" ? details : typeof message === "string" ? message : value;
  return simplifyKnownError(text);
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function simplifyKnownError(value: string): string {
  if (value.includes("Failed to initialize checkpointing") && value.includes("initial-branch=main")) {
    return "Gemini checkpointing failed because this machine has an older Git that does not support `git init --initial-branch`. Workbench now disables Gemini checkpointing for new sessions; restart the server and retry.";
  }
  return value
    .replace(/\nusage: git init[\s\S]*$/m, "")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function PayloadDetails({ value }: { value: unknown }): React.JSX.Element {
  return (
    <details className="event-details">
      <summary>Details</summary>
      <pre>{formatPayload(value)}</pre>
    </details>
  );
}

function approvalStateById(items: AgentEvent[]): Map<string, ApprovalDecision> {
  const states = new Map<string, ApprovalDecision>();
  for (const item of items) {
    if (item.type === "approval.resolved") {
      states.set(item.approvalId, item.decision);
    }
  }
  return states;
}

function approvalDecisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow_once":
      return "Approved once";
    case "allow_for_task":
      return "Approved for task";
    case "deny":
      return "Denied";
    case "deny_and_stop":
      return "Denied and stopped";
  }
}

function approvalActionTitle(request: ApprovalRequest): string {
  switch (request.kind) {
    case "file_write":
      return `Gemini wants to edit ${approvalTarget(request)}`;
    case "file_delete":
      return `Gemini wants to delete ${approvalTarget(request)}`;
    case "shell_command":
      return "Gemini wants to run a command";
    case "network_access":
      return "Gemini wants network access";
    default:
      return request.title;
  }
}

function approvalTarget(request: ApprovalRequest): string {
  const payload = request.payload;
  if (payload && typeof payload === "object" && "toolCall" in payload) {
    const toolCall = (payload as { toolCall?: { locations?: Array<{ path?: string }> } }).toolCall;
    const path = toolCall?.locations?.find((location) => location.path)?.path;
    if (path) {
      return path.split("/").at(-1) ?? path;
    }
  }
  return request.title;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let currentFile: ParsedDiffFile | undefined;
  let currentHunk: ParsedDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diffText.split(/\r?\n/)) {
    const fileMatch = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = {
        additions: 0,
        deletions: 0,
        hunks: [],
        path: fileMatch[2] ?? fileMatch[1] ?? "unknown",
        status: "modified",
      };
      files.push(currentFile);
      currentHunk = undefined;
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (rawLine.startsWith("new file mode")) {
      currentFile.status = "added";
      continue;
    }
    if (rawLine.startsWith("deleted file mode")) {
      currentFile.status = "deleted";
      continue;
    }
    if (rawLine.startsWith("similarity index") || rawLine.startsWith("rename from") || rawLine.startsWith("rename to")) {
      currentFile.status = "renamed";
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1] ?? "0", 10);
      newLine = Number.parseInt(hunkMatch[2] ?? "0", 10);
      currentHunk = {
        header: rawLine,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      currentFile.additions += 1;
      currentHunk.lines.push({
        content: rawLine.slice(1),
        kind: "add",
        newLine,
      });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      currentFile.deletions += 1;
      currentHunk.lines.push({
        content: rawLine.slice(1),
        kind: "delete",
        oldLine,
      });
      oldLine += 1;
      continue;
    }

    if (rawLine.startsWith("\\")) {
      currentHunk.lines.push({
        content: rawLine,
        kind: "meta",
      });
      continue;
    }

    currentHunk.lines.push({
      content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine,
      kind: "context",
      newLine,
      oldLine,
    });
    newLine += 1;
    oldLine += 1;
  }

  return files;
}

function isEmptyPayload(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

function toolTitle(name: string, payload: unknown): string {
  if (name === "gemini.acp") {
    return "Gemini session";
  }
  if (name === "gemini.commands") {
    return "Commands available";
  }
  if (name === "gemini.usage") {
    return "Usage update";
  }
  if (Array.isArray(payload)) {
    const diffPaths = payload
      .map((item) => {
        if (item && typeof item === "object" && "type" in item && item.type === "diff" && "path" in item) {
          return String(item.path).split("/").at(-1);
        }
        return undefined;
      })
      .filter(Boolean);
    if (diffPaths.length > 0) {
      return `Changed ${diffPaths.join(", ")}`;
    }
  }
  return name;
}

function toolSummary(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const diffPaths = value
      .map((item) => {
        if (item && typeof item === "object" && "type" in item && item.type === "diff" && "path" in item) {
          return String(item.path);
        }
        return undefined;
      })
      .filter(Boolean);
    if (diffPaths.length > 0) {
      return diffPaths.join(", ");
    }
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (value && typeof value === "object" && "models" in value) {
    const models = (value as { models?: { currentModelId?: string } }).models;
    return models?.currentModelId ? `Model: ${models.currentModelId}` : undefined;
  }
  return undefined;
}

function compactMessageDeltas(items: AgentEvent[]): AgentEvent[] {
  const compacted: AgentEvent[] = [];
  for (const item of items) {
    const previous = compacted.at(-1);
    if (item.type === "message.delta" && previous?.type === "message.delta" && previous.taskId === item.taskId) {
      compacted[compacted.length - 1] = {
        ...previous,
        text: `${previous.text}${item.text}`,
        timestamp: item.timestamp,
      };
      continue;
    }
    compacted.push(item);
  }
  return compacted;
}

function defaultTimelineEvents(items: AgentEvent[]): AgentEvent[] {
  const visibleAgentMessages = defaultAgentMessageIndices(items);
  return items.filter((item, index) => {
    switch (item.type) {
      case "user.message":
      case "approval.requested":
      case "diff.updated":
        return true;
      case "message.delta":
        return visibleAgentMessages.has(index);
      case "session.action":
        return item.status === "failed" || isDefaultWorkflowAction(item);
      case "turn.finished":
        return item.status === "failed" || Boolean(item.error);
      case "task.finished":
        return item.status === "failed" || item.status === "cancelled" || Boolean(item.error);
      case "approval.resolved":
      case "task.started":
      case "shell.output":
      case "tool.started":
      case "tool.finished":
        return false;
    }
  });
}

function defaultAgentMessageIndices(items: AgentEvent[]): Set<number> {
  const visible = new Set<number>();
  let latestMessageIndex: number | undefined;

  const flush = () => {
    if (latestMessageIndex !== undefined) {
      visible.add(latestMessageIndex);
      latestMessageIndex = undefined;
    }
  };

  for (const [index, item] of items.entries()) {
    if (item.type === "user.message") {
      flush();
      continue;
    }
    if (item.type === "message.delta") {
      latestMessageIndex = index;
      continue;
    }
    if (item.type === "turn.finished" || item.type === "task.finished") {
      flush();
    }
  }

  flush();
  return visible;
}

function isDefaultWorkflowAction(event: AgentEvent): boolean {
  if (event.type !== "session.action" || event.status !== "completed" || isTerminalActionData(event.data)) {
    return false;
  }
  return [
    "apply",
    "create_branch",
    "create_pr",
    "clear_queue",
    "enqueue",
    "context",
    "discard",
    "export_patch",
    "export_report",
    "push_branch",
    "recover",
    "rollback",
    "snapshot",
  ].includes(event.action);
}

function isTerminalActionData(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "kind" in data && data.kind === "terminal");
}

function latestContextDecision(items: AgentEvent[]): ContextDecision {
  const latest = [...items].reverse().find((item) => item.type === "session.action" && item.action === "context");
  if (!latest || latest.type !== "session.action") {
    return {
      status: "unknown",
      title: "No context decision recorded.",
    };
  }
  const data = objectData(latest.data);
  const attached = booleanData(data, "attached");
  return {
    attached,
    details: latest.details,
    reason: stringData(data, "reason"),
    status: latest.status === "failed" ? "failed" : attached === true ? "attached" : attached === false ? "skipped" : "unknown",
    timestamp: latest.timestamp,
    title: latest.title,
  };
}

function contextDecisionLabel(decision: ContextDecision): string {
  switch (decision.status) {
    case "attached":
      return "Memory attached";
    case "skipped":
      return "Memory skipped";
    case "failed":
      return "Context failed";
    case "unknown":
      return "No decision";
  }
}

function contextStatusText(task?: Task): string {
  if (!task) {
    return "No session selected.";
  }
  switch (task.agentContextStatus) {
    case "live":
      return "Backend process is live for this session.";
    case "restored":
      return "Backend restored native session state.";
    case "resumed":
      return "Backend resumed native session state.";
    case "new_process":
      return "A new backend process is attached; transcript fallback may be needed.";
    case "transcript_fallback":
      return "Native resume was unavailable; Workbench may attach visible transcript only for related prompts.";
    case "unknown":
    case undefined:
      return "Context status has not been established yet.";
  }
}

function summarizeDelivery(items: AgentEvent[]): DeliveryItem[] {
  const delivery: DeliveryItem[] = [];
  for (const item of items) {
    if (item.type !== "session.action") {
      continue;
    }
    const kind = deliveryKindFromAction(item.action);
    if (!kind) {
      continue;
    }
    const data = objectData(item.data);
    const details = item.details ? cleanEventText(item.details) : undefined;
    const patchPath = stringData(data, "patchPath") ?? (item.action === "export_patch" ? singleLine(details) : undefined);
    const projectPath = stringData(data, "projectPath") ?? (item.action === "apply" ? singleLine(details) : undefined);
    const message = stringData(data, "message");
    delivery.push({
      branch: stringData(data, "branch"),
      commitSha: stringData(data, "commitSha"),
      compareUrl: stringData(data, "compareUrl"),
      created: booleanData(data, "created"),
      details,
      kind,
      message,
      patchPath,
      projectPath,
      pushed: booleanData(data, "pushed"),
      status: item.status,
      summary: diffSummaryData(data.summary),
      timestamp: item.timestamp,
      title: item.title,
      url: stringData(data, "url"),
    });
  }
  return delivery.reverse();
}

function deliveryKindFromAction(action: SessionAction): DeliveryKind | undefined {
  switch (action) {
    case "apply":
      return "apply";
    case "repo_add":
      return "add";
    case "repo_commit":
      return "commit";
    case "export_patch":
      return "patch";
    case "create_branch":
      return undefined;
    case "push_branch":
      return "push";
    case "create_pr":
      return "pr";
    case "clear_queue":
    case "enqueue":
    case "sync_latest":
      return undefined;
    case "context":
    case "discard":
    case "export_report":
    case "recover":
    case "resume":
    case "rollback":
    case "set_mode":
    case "snapshot":
      return undefined;
  }
}

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringData(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanData(data: Record<string, unknown>, key: string): boolean | undefined {
  return typeof data[key] === "boolean" ? data[key] : undefined;
}

function diffSummaryData(value: unknown): DiffSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const summary = value as Partial<DiffSummary>;
  if (
    typeof summary.filesChanged === "number" &&
    typeof summary.insertions === "number" &&
    typeof summary.deletions === "number" &&
    Array.isArray(summary.files)
  ) {
    return summary as DiffSummary;
  }
  return undefined;
}

function singleLine(value?: string): string | undefined {
  if (!value || value.includes("\n")) {
    return undefined;
  }
  return value;
}

function deliveryKindLabel(kind: DeliveryKind): string {
  switch (kind) {
    case "apply":
      return "Apply";
    case "add":
      return "Add";
    case "commit":
      return "Commit";
    case "patch":
      return "Patch";
    case "branch":
      return "Branch";
    case "push":
      return "Push";
    case "pr":
      return "Pull request";
  }
}

function deliveryStatusLabel(item: DeliveryItem): string {
  if (item.kind === "pr" && item.status === "completed") {
    if (item.created) {
      return "PR ready";
    }
    if (item.pushed) {
      return "Compare ready";
    }
    return "Branch ready";
  }
  switch (item.status) {
    case "started":
      return "Running";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
  }
}

function deliverySummaryText(summary?: DiffSummary): string | undefined {
  if (!summary) {
    return undefined;
  }
  return `${summary.filesChanged} files, +${summary.insertions}, -${summary.deletions}`;
}

function shortSha(value: string): string {
  return /^[0-9a-f]{12,}$/i.test(value) ? value.slice(0, 12) : value;
}

function openExternalUrl(value?: string): void {
  if (!value) {
    return;
  }
  window.open(value, "_blank", "noopener,noreferrer");
}

function featureForBackend(backend: BackendStatus, id: AgentFeatureId): BackendCapabilityFeature | undefined {
  return backend.profile?.features.find((feature) => feature.id === id);
}

function capabilityTitle(feature: BackendCapabilityFeature): string {
  return [feature.description, feature.limitation].filter(Boolean).join("\n\n");
}

function capabilityClass(support: string): string {
  switch (support) {
    case "supported":
      return "supported";
    case "partial":
      return "partial";
    case "planned":
      return "planned";
    default:
      return "unsupported";
  }
}

function supportLabel(support: string): string {
  switch (support) {
    case "supported":
      return "Yes";
    case "partial":
      return "Partial";
    case "planned":
      return "Planned";
    case "unsupported":
      return "No";
    default:
      return support;
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "backend-native":
      return "Backend native";
    case "acp":
      return "ACP";
    case "workbench":
      return "Workbench";
    case "terminal":
      return "Terminal";
    case "external":
      return "External";
    default:
      return source;
  }
}

interface AvailableCommandView {
  aliases?: string[];
  description?: string;
  name: string;
  source?: string;
  usage?: string;
}

function availableCommandsFromEvents(items: AgentEvent[]): AvailableCommandView[] {
  const commandEvent = [...items]
    .reverse()
    .find((event) => event.type === "tool.finished" && (event.name === "gemini.commands" || event.toolCallId === "gemini.commands"));
  if (!commandEvent || commandEvent.type !== "tool.finished" || !Array.isArray(commandEvent.output)) {
    return [];
  }

  return commandEvent.output.flatMap((item): AvailableCommandView[] => {
      if (item && typeof item === "object" && "name" in item) {
        const command = item as { description?: unknown; name?: unknown };
        if (typeof command.name === "string") {
          return [
            {
              aliases: [],
              description: typeof command.description === "string" ? command.description : undefined,
              name: command.name,
              source: "acp",
              usage: `/${command.name}`,
            },
          ];
        }
      }
      return [];
    });
}

function mergeAvailableCommands(...groups: AvailableCommandView[][]): AvailableCommandView[] {
  const merged = new Map<string, AvailableCommandView>();
  for (const command of groups.flat()) {
    const key = command.name.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, command);
    }
  }
  return [...merged.values()];
}

function commandMatches(prompt: string, commands: AvailableCommandView[]): AvailableCommandView[] {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/") || commands.length === 0) {
    return [];
  }
  const query = trimmed.slice(1).toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().includes(query) || command.aliases?.some((alias) => alias.toLowerCase().includes(query)))
    .slice(0, 8);
}

function slashCommandError(prompt: string, commands: AvailableCommandView[], backend?: BackendStatus): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  if (commands.length === 0) {
    const slashFeature = backend ? featureForBackend(backend, "slash_commands") : undefined;
    if (slashFeature?.support === "unsupported") {
      return `${backend?.name ?? "This backend"} does not expose slash commands. Use Capability Center to choose an ACP or terminal fallback path.`;
    }
    return undefined;
  }

  const commandNames = new Set(commands.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase())));
  for (let length = parts.length; length >= 1; length -= 1) {
    if (commandNames.has(parts.slice(0, length).join(" ").toLowerCase())) {
      return undefined;
    }
  }

  const preview = commands.slice(0, 8).map((command) => `/${command.name}`).join(", ");
  const suffix = commands.length > 8 ? `, and ${commands.length - 8} more` : "";
  return `/${parts[0]} is not exposed by Gemini ACP for this session. Available commands: ${preview}${suffix}`;
}

function backendLabel(backends: BackendStatus[], backendId: string): string {
  return backends.find((backend) => backend.id === backendId)?.name ?? backendId;
}

function filterSessions(tasks: Task[], keyword: string, _backends: BackendStatus[]): Task[] {
  const query = keyword.trim().toLowerCase();
  if (!query) {
    return tasks;
  }
  return tasks.filter((task) => task.title.toLowerCase().includes(query));
}

function agentContextLabel(task: Task): string {
  switch (task.agentContextStatus) {
    case "live":
      return "Context live";
    case "restored":
      return "Context restored";
    case "resumed":
      return "Context resumed";
    case "transcript_fallback":
      return "Context from history";
    case "new_process":
      return "New agent process";
    case "unknown":
    case undefined:
      return "Context pending";
  }
}

function agentContextClass(task: Task): string {
  switch (task.agentContextStatus) {
    case "live":
    case "restored":
    case "resumed":
      return "ok";
    case "transcript_fallback":
      return "warning";
    case "new_process":
      return "danger";
    case "unknown":
    case undefined:
      return "";
  }
}

function modeLabel(modeId: string): string {
  return modeOptions.find((mode) => mode.id === modeId)?.label ?? modeId;
}

function isLinkedNativeSession(task?: Task): boolean {
  return Boolean(task?.agentSessionId && (task.backendId === "gemini" || task.backendId === "gemini-acp" || task.backendId === "codex" || task.backendId === "claude"));
}

function nativeSessionAgentName(task: Task): string {
  if (task.backendId === "codex") {
    return "Codex";
  }
  if (task.backendId === "claude") {
    return "Claude";
  }
  return "Gemini";
}

function isLinkedGeminiSession(task?: Task): boolean {
  return Boolean(task?.agentSessionId && (task.backendId === "gemini" || task.backendId === "gemini-acp"));
}

function isNativeCliSession(task?: Task): boolean {
  return Boolean(
    task?.agentSessionId &&
      (task.backendId === "gemini" || task.backendId === "gemini-acp" || task.backendId === "codex" || task.backendId === "claude") &&
      (task.agentSessionKind === "native-cli" || (task.agentSessionKind === undefined && task.agentSessionOrigin === "imported")),
  );
}

function nativeSessionBadgeLabel(task: Task): string {
  if (isAcpOnlyGeminiSession(task)) {
    return "Gemini ACP";
  }
  const agent = nativeSessionAgentName(task);
  if (task.agentSessionKind === "native-cli-pending") {
    return `${agent} pending`;
  }
  if (task.agentSessionOrigin === "imported") {
    return `${agent} imported`;
  }
  if (task.agentSessionResumeMode === "load") {
    return `${agent} loaded`;
  }
  if (task.agentSessionResumeMode === "resume") {
    return `${agent} resumed`;
  }
  return `${agent} linked`;
}

function nativeSessionDisplayLabel(task: Task): string {
  return `${nativeSessionBadgeLabel(task)} ${shortSessionIdentity(task)}`;
}

function displaySessionId(task: Task): string {
  return isNativeCliSession(task) ? task.agentSessionId! : task.id;
}

function shortSessionIdentity(task: Task): string {
  if (task.agentSessionKind === "native-cli-pending" && task.agentSessionId) {
    return truncateMiddle(task.agentSessionId, 18);
  }
  return truncateMiddle(displaySessionId(task), isLinkedNativeSession(task) ? 18 : 12);
}

function sessionIdentityTitle(task: Task): string {
  const publicId = displaySessionId(task);
  const agent = nativeSessionAgentName(task);
  const parts = [
    isLinkedNativeSession(task) ? `${agent} session ID: ${publicId}` : `Workbench session ID: ${publicId}`,
    isAcpOnlyGeminiSession(task) ? `ACP session ID: ${task.agentSessionId}` : undefined,
    publicId !== task.id ? `Workbench internal ID: ${task.id}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function sessionListSubtitle(task: Task, backend: string): string {
  return `${backend} · ${isLinkedNativeSession(task) ? nativeSessionAgentName(task) : "AW"} ${shortSessionIdentity(task)}`;
}

function nativeSessionSummary(task: Task): string {
  const parts = [
    `Session ID ${displaySessionId(task)}`,
    task.agentSessionKind === "native-cli-pending" ? `pending ${task.agentSessionId}` : undefined,
    isAcpOnlyGeminiSession(task) ? `ACP ${task.agentSessionId}` : undefined,
    task.agentSessionOrigin === "imported"
      ? `imported from ${nativeSessionAgentName(task)} history`
      : task.agentSessionOrigin === "new"
        ? "created by Workbench"
        : undefined,
    task.agentSessionResumeMode ? `ACP ${task.agentSessionResumeMode}` : undefined,
    task.agentContextStatus ? `context ${task.agentContextStatus}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function nativeSessionTitle(task: Task): string {
  const agent = nativeSessionAgentName(task);
  return [
    `Linked ${agent} native session.`,
    `${agent} session ID: ${displaySessionId(task)}.`,
    task.agentSessionKind === "native-cli-pending" ? `Pending ${agent} session ID: ${task.agentSessionId}. Workbench will not resume it until ${agent} confirms it is resumable.` : undefined,
    isAcpOnlyGeminiSession(task) ? `ACP session ID: ${task.agentSessionId}. Terminal will start Gemini without --resume until a native CLI session is detected.` : undefined,
    displaySessionId(task) !== task.id ? `Workbench internal ID: ${task.id}.` : undefined,
    task.agentSessionOrigin === "imported"
      ? `Imported from project ${agent} history.`
      : task.agentSessionOrigin === "new"
        ? "Created by Workbench for this session."
        : undefined,
    task.agentSessionResumeMode ? `ACP startup mode: ${task.agentSessionResumeMode}.` : undefined,
    task.agentContextStatus ? `Context status: ${task.agentContextStatus}.` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function isAcpOnlyGeminiSession(task: Task): boolean {
  return isLinkedGeminiSession(task) && !isNativeCliSession(task);
}

function linkedNativeTaskForSession(
  tasks: Task[],
  projectId: string,
  backendId: NativeCliBackendId,
  sessionId: string,
  currentTaskId?: string,
): LinkedNativeSessionState | undefined {
  const task = tasks.find(
    (item) =>
      item.projectId === projectId &&
      item.agentSessionId === sessionId &&
      (backendId === "gemini-acp" ? item.backendId === "gemini" || item.backendId === "gemini-acp" : item.backendId === backendId),
  );
  if (!task) {
    return undefined;
  }
  return {
    current: task.id === currentTaskId,
    task,
  };
}

function nativeSessionKey(backendId: NativeCliBackendId, sessionId: string): string {
  return `${backendId}:${sessionId}`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0m";
  }
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(timestamp);
}

function formatFileSize(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${value} B`;
}

function sessionCapableBackends(backends: BackendStatus[]): BackendStatus[] {
  const capable = backends.filter((backend) => backend.id === "gemini-acp" || backend.capabilities.includes("resume"));
  return capable.length > 0 ? capable : backends;
}

function nextSessionTitle(tasks: Task[], projectId: string): string {
  return uniqueSessionTitle(tasks, projectId, "New Session");
}

function nextWorkingBranchName(tasks: Task[], projectId: string, projectBranches: string[] = []): string {
  const existing = new Set(
    [
      ...projectBranches,
      ...tasks
        .filter((task) => task.projectId === projectId)
        .flatMap((task) => [task.baseBranch, ...(task.branches ?? []).map((branch) => branch.name)]),
    ].filter((name): name is string => Boolean(name)),
  );
  for (let index = 1; index < 1000; index += 1) {
    const name = `new-branch-${index}`;
    if (!existing.has(name)) {
      return name;
    }
  }
  return `new-branch-${Date.now()}`;
}

function uniqueSessionTitle(tasks: Task[], projectId: string, requestedTitle: string): string {
  const titles = new Set(tasks.filter((task) => task.projectId === projectId).map((task) => task.title));
  const baseTitle = requestedTitle.trim() || "New Session";
  if (!titles.has(baseTitle)) {
    return baseTitle;
  }
  for (let index = 2; index < 1000; index += 1) {
    const title = `${baseTitle} ${index}`;
    if (!titles.has(title)) {
      return title;
    }
  }
  return `${baseTitle} ${Date.now()}`;
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index === -1) {
    return [item, ...items];
  }
  const next = [...items];
  next[index] = item;
  return next;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

function patchDownloadName(task: Task): string {
  const safeTitle = task.title.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
  return `${safeTitle}-${task.id.slice(0, 8)}.patch`;
}

function reportDownloadName(task: Task): string {
  const safeTitle = task.title.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
  return `${safeTitle}-${task.id.slice(0, 8)}.md`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
