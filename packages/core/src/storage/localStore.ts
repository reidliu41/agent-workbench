import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentEvent,
  ApprovalRequest,
  DiffSnapshot,
  Project,
  SessionSnapshot,
  Task,
} from "@agent-workbench/protocol";

export interface StoreData {
  projects: Project[];
  tasks: Task[];
  events: Record<string, AgentEvent[]>;
  approvals: ApprovalRequest[];
  diffs: DiffSnapshot[];
  snapshots: SessionSnapshot[];
}

export interface LocalStoreHealth {
  backupExists: boolean;
  backupPath: string;
  backupSizeBytes?: number;
  exists: boolean;
  lastRecovery?: {
    at: string;
    source: "backup" | "primary_trailing_data";
  };
  path: string;
  sizeBytes?: number;
}

export interface WorkbenchStore {
  readonly path: string;
  init(): Promise<void>;
  listProjects(): Promise<Project[]>;
  upsertProject(project: Project): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  listTasks(): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | undefined>;
  upsertTask(task: Task): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  appendEvent(taskId: string, event: AgentEvent): Promise<void>;
  listEvents(taskId: string): Promise<AgentEvent[]>;
  appendDiff(snapshot: DiffSnapshot): Promise<void>;
  latestDiff(taskId: string): Promise<DiffSnapshot | undefined>;
  appendSnapshot(snapshot: SessionSnapshot): Promise<void>;
  getSnapshot(taskId: string, snapshotId: string): Promise<SessionSnapshot | undefined>;
  listSnapshots(taskId: string): Promise<SessionSnapshot[]>;
  updateSnapshot(snapshot: SessionSnapshot): Promise<SessionSnapshot>;
  deleteSnapshot(taskId: string, snapshotId: string): Promise<void>;
  health(): Promise<LocalStoreHealth>;
}

export function emptyStore(): StoreData {
  return {
    projects: [],
    tasks: [],
    events: {},
    approvals: [],
    diffs: [],
    snapshots: [],
  };
}

export function defaultStorePath(): string {
  return join(homedir(), ".agent-workbench", "store.json");
}

export class LocalStore implements WorkbenchStore {
  private lastRecovery: LocalStoreHealth["lastRecovery"];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly path = defaultStorePath()) {}

  get backupPath(): string {
    return `${this.path}.bak`;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, "utf8");
      parseStore(raw);
      await this.ensureBackupIfMissing();
    } catch (error) {
      if (isNotFoundError(error)) {
        await this.write(emptyStore(), { backupExisting: false });
      }
    }
  }

  async listProjects(): Promise<Project[]> {
    await this.writeQueue;
    return (await this.read()).projects;
  }

  async upsertProject(project: Project): Promise<Project> {
    return this.mutate((data) => {
      const index = data.projects.findIndex((item) => item.id === project.id || item.path === project.path);
      if (index >= 0) {
        data.projects[index] = project;
      } else {
        data.projects.push(project);
      }
      return project;
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.mutate((data) => {
      data.projects = data.projects.filter((project) => project.id !== projectId);
    });
  }

  async listTasks(): Promise<Task[]> {
    await this.writeQueue;
    return (await this.read()).tasks;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    await this.writeQueue;
    return (await this.read()).tasks.find((task) => task.id === taskId);
  }

  async upsertTask(task: Task): Promise<Task> {
    return this.mutate((data) => {
      const index = data.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) {
        data.tasks[index] = task;
      } else {
        data.tasks.push(task);
      }
      return task;
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.mutate((data) => {
      data.tasks = data.tasks.filter((task) => task.id !== taskId);
      delete data.events[taskId];
      data.diffs = data.diffs.filter((diff) => diff.taskId !== taskId);
      data.approvals = data.approvals.filter((approval) => approval.taskId !== taskId);
      data.snapshots = (data.snapshots ?? []).filter((snapshot) => snapshot.taskId !== taskId);
    });
  }

  async appendEvent(taskId: string, event: AgentEvent): Promise<void> {
    await this.mutate((data) => {
      data.events[taskId] ??= [];
      data.events[taskId].push(event);
    });
  }

  async listEvents(taskId: string): Promise<AgentEvent[]> {
    await this.writeQueue;
    return (await this.read()).events[taskId] ?? [];
  }

  async appendDiff(snapshot: DiffSnapshot): Promise<void> {
    await this.mutate((data) => {
      data.diffs.push(snapshot);
    });
  }

  async latestDiff(taskId: string): Promise<DiffSnapshot | undefined> {
    await this.writeQueue;
    const data = await this.read();
    return data.diffs.filter((snapshot) => snapshot.taskId === taskId).at(-1);
  }

  async appendSnapshot(snapshot: SessionSnapshot): Promise<void> {
    await this.mutate((data) => {
      data.snapshots ??= [];
      data.snapshots.push(snapshot);
    });
  }

  async getSnapshot(taskId: string, snapshotId: string): Promise<SessionSnapshot | undefined> {
    await this.writeQueue;
    const data = await this.read();
    return (data.snapshots ?? []).find((snapshot) => snapshot.taskId === taskId && snapshot.id === snapshotId);
  }

  async listSnapshots(taskId: string): Promise<SessionSnapshot[]> {
    await this.writeQueue;
    const data = await this.read();
    return (data.snapshots ?? []).filter((snapshot) => snapshot.taskId === taskId);
  }

  async updateSnapshot(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
    await this.mutate((data) => {
      data.snapshots ??= [];
      const index = data.snapshots.findIndex((item) => item.taskId === snapshot.taskId && item.id === snapshot.id);
      if (index < 0) {
        throw new Error("Snapshot not found.");
      }
      data.snapshots[index] = snapshot;
    });
    return snapshot;
  }

  async deleteSnapshot(taskId: string, snapshotId: string): Promise<void> {
    await this.mutate((data) => {
      data.snapshots ??= [];
      data.snapshots = data.snapshots.filter((snapshot) => snapshot.taskId !== taskId || snapshot.id !== snapshotId);
    });
  }

  async health(): Promise<LocalStoreHealth> {
    await this.writeQueue;
    const [primary, backup] = await Promise.all([
      fileStats(this.path),
      fileStats(this.backupPath),
    ]);
    return {
      backupExists: backup.exists,
      backupPath: this.backupPath,
      backupSizeBytes: backup.sizeBytes,
      exists: primary.exists,
      lastRecovery: this.lastRecovery,
      path: this.path,
      sizeBytes: primary.sizeBytes,
    };
  }

  private async read(): Promise<StoreData> {
    await this.initIfNeeded();
    const raw = await readFile(this.path, "utf8");
    try {
      const parsed = parseStore(raw);
      if (parsed.recovered) {
        this.lastRecovery = { at: new Date().toISOString(), source: "primary_trailing_data" };
        await this.write(parsed.data, { backupExisting: false });
      }
      return parsed.data;
    } catch (error) {
      const backup = await this.readBackup();
      if (backup) {
        this.lastRecovery = { at: new Date().toISOString(), source: "backup" };
        await this.write(backup, { backupExisting: false });
        return backup;
      }
      throw error;
    }
  }

  private async write(data: StoreData, options: { backupExisting?: boolean } = {}): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(normalizeStore(data), null, 2)}\n`, "utf8");
    if (options.backupExisting !== false) {
      await copyFile(this.path, this.backupPath).catch(() => undefined);
    }
    await rename(tempPath, this.path);
  }

  private async readBackup(): Promise<StoreData | undefined> {
    try {
      const raw = await readFile(this.backupPath, "utf8");
      return parseStore(raw).data;
    } catch {
      return undefined;
    }
  }

  private async ensureBackupIfMissing(): Promise<void> {
    const backup = await fileStats(this.backupPath);
    if (backup.exists) {
      return;
    }
    await copyFile(this.path, this.backupPath).catch(() => undefined);
  }

  private async initIfNeeded(): Promise<void> {
    try {
      await readFile(this.path, "utf8");
    } catch {
      await this.init();
    }
  }

  private async mutate<T>(mutator: (data: StoreData) => T | Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await this.write(data);
      return result;
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export function parseStore(raw: string): { data: StoreData; recovered: boolean } {
  try {
    const data = normalizeStore(JSON.parse(raw) as Partial<StoreData>);
    return {
      data,
      recovered: false,
    };
  } catch (error) {
    const end = firstJsonObjectEnd(raw);
    if (end > 0) {
      const data = normalizeStore(JSON.parse(raw.slice(0, end)) as Partial<StoreData>);
      return {
        data,
        recovered: true,
      };
    }
    throw error;
  }
}

export function normalizeStore(data: Partial<StoreData>): StoreData {
  return {
    approvals: Array.isArray(data.approvals) ? data.approvals : [],
    diffs: Array.isArray(data.diffs) ? data.diffs : [],
    events: data.events && typeof data.events === "object" && !Array.isArray(data.events) ? data.events : {},
    projects: Array.isArray(data.projects) ? data.projects : [],
    snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
  };
}

async function fileStats(path: string): Promise<{ exists: boolean; sizeBytes?: number }> {
  try {
    const value = await stat(path);
    return {
      exists: true,
      sizeBytes: value.size,
    };
  } catch {
    return {
      exists: false,
    };
  }
}

function firstJsonObjectEnd(raw: string): number {
  let depth = 0;
  let escaped = false;
  let inString = false;
  let started = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      started = true;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (started && depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}
