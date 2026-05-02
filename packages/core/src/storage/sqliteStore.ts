import Database from "better-sqlite3";
import { mkdir, readFile, stat } from "node:fs/promises";
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
import { defaultStorePath, type LocalStoreHealth, parseStore, type WorkbenchStore } from "./localStore.js";

export function defaultSqliteStorePath(): string {
  return join(homedir(), ".agent-workbench", "agent-workbench.sqlite");
}

export class SqliteStore implements WorkbenchStore {
  private db?: Database.Database;

  constructor(readonly path = defaultSqliteStorePath(), private readonly legacyJsonPath = defaultStorePath()) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const existed = (await fileExists(this.path));
    const db = this.open();
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task_id_id ON events(task_id, id);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diffs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diffs_task_id_created ON diffs(task_id, created_at);
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_task_id_created ON snapshots(task_id, created_at);
    `);
    this.ensureProjectsUpdatedAtColumn();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')").run();
    if (!existed) {
      await this.importLegacyJsonIfPresent();
    }
  }

  async listProjects(): Promise<Project[]> {
    const rows = this.open().prepare("SELECT json FROM projects ORDER BY updated_at DESC").all() as JsonRow[];
    return rows.map((row) => parseJson<Project>(row.json));
  }

  async upsertProject(project: Project): Promise<Project> {
    this.open().prepare("INSERT OR REPLACE INTO projects (id, path, updated_at, json) VALUES (?, ?, ?, ?)").run(
      project.id,
      project.path,
      project.updatedAt,
      JSON.stringify(project),
    );
    return project;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.open().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }

  async listTasks(): Promise<Task[]> {
    const rows = this.open().prepare("SELECT json FROM tasks ORDER BY updated_at DESC").all() as JsonRow[];
    return rows.map((row) => parseJson<Task>(row.json));
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const row = this.open().prepare("SELECT json FROM tasks WHERE id = ?").get(taskId) as JsonRow | undefined;
    return row ? parseJson<Task>(row.json) : undefined;
  }

  async upsertTask(task: Task): Promise<Task> {
    this.open().prepare("INSERT OR REPLACE INTO tasks (id, project_id, updated_at, json) VALUES (?, ?, ?, ?)").run(
      task.id,
      task.projectId,
      task.updatedAt,
      JSON.stringify(task),
    );
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    const db = this.open();
    const remove = db.transaction(() => {
      db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
      db.prepare("DELETE FROM events WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM diffs WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM snapshots WHERE task_id = ?").run(taskId);
    });
    remove();
  }

  async appendEvent(taskId: string, event: AgentEvent): Promise<void> {
    this.open().prepare("INSERT INTO events (task_id, timestamp, json) VALUES (?, ?, ?)").run(taskId, event.timestamp, JSON.stringify(event));
  }

  async listEvents(taskId: string): Promise<AgentEvent[]> {
    const rows = this.open().prepare("SELECT json FROM events WHERE task_id = ? ORDER BY id ASC").all(taskId) as JsonRow[];
    return rows.map((row) => parseJson<AgentEvent>(row.json));
  }

  async appendDiff(snapshot: DiffSnapshot): Promise<void> {
    this.open().prepare("INSERT OR REPLACE INTO diffs (id, task_id, created_at, json) VALUES (?, ?, ?, ?)").run(
      snapshot.id,
      snapshot.taskId,
      snapshot.createdAt,
      JSON.stringify(snapshot),
    );
  }

  async latestDiff(taskId: string): Promise<DiffSnapshot | undefined> {
    const row = this.open().prepare("SELECT json FROM diffs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId) as JsonRow | undefined;
    return row ? parseJson<DiffSnapshot>(row.json) : undefined;
  }

  async appendSnapshot(snapshot: SessionSnapshot): Promise<void> {
    this.open().prepare("INSERT OR REPLACE INTO snapshots (id, task_id, created_at, json) VALUES (?, ?, ?, ?)").run(
      snapshot.id,
      snapshot.taskId,
      snapshot.createdAt,
      JSON.stringify(snapshot),
    );
  }

  async getSnapshot(taskId: string, snapshotId: string): Promise<SessionSnapshot | undefined> {
    const row = this.open().prepare("SELECT json FROM snapshots WHERE task_id = ? AND id = ?").get(taskId, snapshotId) as JsonRow | undefined;
    return row ? parseJson<SessionSnapshot>(row.json) : undefined;
  }

  async listSnapshots(taskId: string): Promise<SessionSnapshot[]> {
    const rows = this.open().prepare("SELECT json FROM snapshots WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as JsonRow[];
    return rows.map((row) => parseJson<SessionSnapshot>(row.json));
  }

  async updateSnapshot(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
    const result = this.open().prepare("UPDATE snapshots SET json = ? WHERE task_id = ? AND id = ?").run(JSON.stringify(snapshot), snapshot.taskId, snapshot.id);
    if (result.changes === 0) {
      throw new Error("Snapshot not found.");
    }
    return snapshot;
  }

  async deleteSnapshot(taskId: string, snapshotId: string): Promise<void> {
    this.open().prepare("DELETE FROM snapshots WHERE task_id = ? AND id = ?").run(taskId, snapshotId);
  }

  async health(): Promise<LocalStoreHealth> {
    const primary = await fileStats(this.path);
    return {
      backupExists: false,
      backupPath: `${this.path}.bak`,
      exists: primary.exists,
      path: this.path,
      sizeBytes: primary.sizeBytes,
    };
  }

  private open(): Database.Database {
    this.db ??= new Database(this.path);
    return this.db;
  }

  private async importLegacyJsonIfPresent(): Promise<void> {
    try {
      const raw = await readFile(this.legacyJsonPath, "utf8");
      const { data } = parseStore(raw);
      const db = this.open();
      const importAll = db.transaction(() => {
        const projectStmt = db.prepare("INSERT OR IGNORE INTO projects (id, path, updated_at, json) VALUES (?, ?, ?, ?)");
        const taskStmt = db.prepare("INSERT OR IGNORE INTO tasks (id, project_id, updated_at, json) VALUES (?, ?, ?, ?)");
        const eventStmt = db.prepare("INSERT INTO events (task_id, timestamp, json) VALUES (?, ?, ?)");
        const approvalStmt = db.prepare("INSERT OR IGNORE INTO approvals (id, task_id, json) VALUES (?, ?, ?)");
        const diffStmt = db.prepare("INSERT OR IGNORE INTO diffs (id, task_id, created_at, json) VALUES (?, ?, ?, ?)");
        const snapshotStmt = db.prepare("INSERT OR IGNORE INTO snapshots (id, task_id, created_at, json) VALUES (?, ?, ?, ?)");
        for (const project of data.projects) {
          projectStmt.run(project.id, project.path, project.updatedAt, JSON.stringify(project));
        }
        for (const task of data.tasks) {
          taskStmt.run(task.id, task.projectId, task.updatedAt, JSON.stringify(task));
        }
        for (const [taskId, events] of Object.entries(data.events)) {
          for (const event of events) {
            eventStmt.run(taskId, event.timestamp, JSON.stringify(event));
          }
        }
        for (const approval of data.approvals) {
          approvalStmt.run(approval.id, approval.taskId, JSON.stringify(approval));
        }
        for (const diff of data.diffs) {
          diffStmt.run(diff.id, diff.taskId, diff.createdAt, JSON.stringify(diff));
        }
        for (const snapshot of data.snapshots) {
          snapshotStmt.run(snapshot.id, snapshot.taskId, snapshot.createdAt, JSON.stringify(snapshot));
        }
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_imported_from', ?)").run(this.legacyJsonPath);
      });
      importAll();
    } catch {
      // No legacy JSON store to import.
    }
  }

  private ensureProjectsUpdatedAtColumn(): void {
    const columns = this.open().prepare("PRAGMA table_info(projects)").all() as TableInfoRow[];
    if (columns.some((column) => column.name === "updated_at")) {
      return;
    }
    this.open().exec("ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    const rows = this.open().prepare("SELECT id, json FROM projects WHERE updated_at = ''").all() as ProjectRow[];
    const update = this.open().prepare("UPDATE projects SET updated_at = ? WHERE id = ?");
    for (const row of rows) {
      update.run(parseJson<Project>(row.json).updatedAt, row.id);
    }
  }
}

interface JsonRow {
  json: string;
}

interface ProjectRow extends JsonRow {
  id: string;
}

interface TableInfoRow {
  name: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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
