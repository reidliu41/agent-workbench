import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CodexProjectSession {
  cwd?: string;
  displayName: string;
  fileName: string;
  firstUserMessage: string;
  id: string;
  lastUpdated: string;
  messageCount: number;
  startTime: string;
}

interface CodexSessionRecord {
  fileName: string;
  session: CodexProjectSession;
}

export async function listCodexProjectSessions(projectRoot: string, includeEmpty = false): Promise<CodexProjectSession[]> {
  const root = normalizePath(projectRoot);
  const files = await findCodexRolloutFiles(codexSessionsDir());
  const sessions: Array<CodexProjectSession | undefined> = await Promise.all(
    files.map(async (filePath) => {
      try {
        const record = await loadCodexProjectSession(filePath, includeEmpty);
        if (!record.session.cwd || normalizePath(record.session.cwd) !== root) {
          return undefined;
        }
        return record.session;
      } catch {
        return undefined;
      }
    }),
  );

  return sessions
    .filter((session): session is CodexProjectSession => Boolean(session))
    .filter((session, index, all) => all.findIndex((candidate) => candidate.id === session.id) === index)
    .sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
}

export async function findLatestCodexProjectSession(projectRoot: string, since?: string): Promise<CodexProjectSession | undefined> {
  const sessions = await listCodexProjectSessions(projectRoot, true);
  const sinceMs = since ? Date.parse(since) : 0;
  return sessions.find((session) => Date.parse(session.startTime || session.lastUpdated) >= sinceMs - 3000) ?? sessions[0];
}

async function findCodexRolloutFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return findCodexRolloutFiles(path);
      }
      return entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function loadCodexProjectSession(filePath: string, includeEmpty: boolean): Promise<CodexSessionRecord> {
  const raw = await readFile(filePath, "utf8");
  const session = parseCodexSessionText(raw, filePath, includeEmpty);
  if (!session) {
    throw new Error(`Codex session not found in ${filePath}`);
  }
  return {
    fileName: filePath.split("/").at(-1) ?? filePath,
    session,
  };
}

function parseCodexSessionText(raw: string, filePath: string, includeEmpty: boolean): CodexProjectSession | undefined {
  const fileName = filePath.split("/").at(-1) ?? filePath;
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let cwd: string | undefined;
  let id = "";
  let timestamp = "";
  let firstUserMessage = "";
  let messageCount = 0;

  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (isObject(record) && typeof record.id === "string" && !id) {
      id = record.id;
      timestamp = typeof record.timestamp === "string" ? record.timestamp : timestamp;
      continue;
    }

    if (!isObject(record)) {
      continue;
    }
    const type = typeof record.type === "string" ? record.type : "";
    const payload = isObject(record.payload) ? record.payload : undefined;
    if (type === "session_meta" && payload) {
      id = typeof payload.id === "string" ? payload.id : id;
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      timestamp = typeof payload.timestamp === "string" ? payload.timestamp : timestamp;
      continue;
    }
    if (type === "turn_context" && payload && typeof payload.cwd === "string") {
      cwd = payload.cwd;
      continue;
    }
    if (type === "message" && typeof record.role === "string") {
      messageCount += 1;
      if (record.role === "user" && !firstUserMessage) {
        firstUserMessage = cleanCodexMessage(record.content);
      }
    }
  }

  if (!id || (!includeEmpty && messageCount === 0)) {
    return undefined;
  }

  const lastUpdated = timestamp || timestampFromRolloutFileName(fileName) || new Date(0).toISOString();
  const title = firstUserMessage || id;
  return {
    cwd,
    displayName: title,
    fileName,
    firstUserMessage: firstUserMessage || title,
    id,
    lastUpdated,
    messageCount,
    startTime: timestamp || lastUpdated,
  };
}

function cleanCodexMessage(content: unknown): string {
  if (typeof content === "string") {
    return content.trim().replace(/\s+/g, " ").slice(0, 180);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!isObject(item)) {
        return "";
      }
      return typeof item.text === "string" ? item.text : "";
    })
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function timestampFromRolloutFileName(fileName: string): string | undefined {
  const match = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/.exec(fileName);
  if (!match) {
    return undefined;
  }
  const stamp = match[1];
  if (!stamp) {
    return undefined;
  }
  const iso = `${stamp.replaceAll("-", ":").replace(/^(\d{4}):(\d{2}):(\d{2})T/, "$1-$2-$3T")}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
