import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface QwenProjectSession {
  cwd?: string;
  displayName: string;
  fileName: string;
  firstUserMessage: string;
  gitBranch?: string;
  id: string;
  lastUpdated: string;
  messageCount: number;
  startTime: string;
  summary?: string;
}

interface ResolvedQwenProjectSession {
  filePath: string;
  session: QwenProjectSession;
}

export async function listQwenProjectSessions(projectRoot: string, includeEmpty = false): Promise<QwenProjectSession[]> {
  const sessions: Array<QwenProjectSession | undefined> = [];
  for (const filePath of await qwenProjectSessionFiles(projectRoot)) {
    try {
      const session = await loadQwenProjectSession(filePath, includeEmpty);
      if (!session?.cwd || normalizePath(session.cwd) !== normalizePath(projectRoot)) {
        continue;
      }
      sessions.push(session);
    } catch {
      sessions.push(undefined);
    }
  }

  return sessions
    .filter((session): session is QwenProjectSession => Boolean(session))
    .filter((session, index, all) => all.findIndex((candidate) => candidate.id === session.id) === index)
    .sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
}

export async function findQwenProjectSession(projectRoot: string, sessionId: string): Promise<QwenProjectSession | undefined> {
  const direct = await loadQwenProjectSession(join(qwenChatsDir(projectRoot), `${sessionId}.jsonl`), true).catch(() => undefined);
  if (direct?.cwd && normalizePath(direct.cwd) === normalizePath(projectRoot)) {
    return direct;
  }

  const resolved = await resolveQwenProjectSession(projectRoot, sessionId).catch(() => undefined);
  return resolved?.session;
}

export async function bridgeQwenSessionToWorktree(projectRoot: string, worktreePath: string, sessionId: string): Promise<QwenProjectSession> {
  const resolved = await resolveQwenProjectSession(projectRoot, sessionId);
  const targetDir = qwenChatsDir(worktreePath);
  await mkdir(targetDir, { recursive: true });
  const targetPath = join(targetDir, basename(resolved.filePath));
  await copyQwenSessionForWorktree(resolved.filePath, targetPath, projectRoot, worktreePath);
  return resolved.session;
}

async function resolveQwenProjectSession(projectRoot: string, sessionId: string): Promise<ResolvedQwenProjectSession> {
  const expectedName = `${sessionId}.jsonl`;
  let sawDirectory = false;

  for (const chatsDir of await qwenCandidateChatsDirs(projectRoot)) {
    let entries;
    try {
      entries = await readdir(chatsDir, { encoding: "utf8", withFileTypes: true });
      sawDirectory = true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || entry.name !== expectedName) {
        continue;
      }
      const filePath = join(chatsDir, entry.name);
      const session = await loadQwenProjectSession(filePath, true).catch(() => undefined);
      if (session?.id === sessionId && session.cwd && normalizePath(session.cwd) === normalizePath(projectRoot)) {
        return { filePath, session };
      }
    }
  }

  if (!sawDirectory) {
    throw new Error("No Qwen Code sessions were found for this project.");
  }
  throw new Error(`Qwen Code session not found: ${sessionId}`);
}

async function qwenProjectSessionFiles(projectRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(qwenChatsDir(projectRoot), { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && isQwenSessionFile(entry.name))
    .map((entry) => join(qwenChatsDir(projectRoot), entry.name));
}

async function qwenCandidateChatsDirs(projectRoot: string): Promise<string[]> {
  const direct = qwenChatsDir(projectRoot);
  let projectDirs;
  try {
    projectDirs = await readdir(qwenProjectsDir(), { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [direct];
    }
    throw error;
  }
  const all = projectDirs.filter((entry) => entry.isDirectory()).map((entry) => join(qwenProjectsDir(), entry.name, "chats"));
  return [direct, ...all.filter((dir) => dir !== direct)];
}

async function loadQwenProjectSession(filePath: string, includeEmpty = false): Promise<QwenProjectSession | undefined> {
  const raw = await readFile(filePath, "utf8");
  const metadata = await stat(filePath).catch(() => undefined);
  return parseQwenSessionText(raw, basename(filePath), metadata?.mtime.toISOString(), includeEmpty);
}

function parseQwenSessionText(raw: string, fileName: string, fallbackTime: string | undefined, includeEmpty: boolean): QwenProjectSession | undefined {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let cwd: string | undefined;
  let displayName = "";
  let firstUserMessage = "";
  let gitBranch: string | undefined;
  let id = fileName.replace(/\.jsonl$/, "");
  let lastUpdated = "";
  let messageCount = 0;
  let startTime = "";

  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isObject(record)) {
      continue;
    }
    const timestamp = stringField(record, "timestamp");
    if (timestamp) {
      startTime ||= timestamp;
      lastUpdated = timestamp;
    }
    id = stringField(record, "sessionId") ?? id;
    cwd = stringField(record, "cwd") ?? cwd;
    gitBranch = stringField(record, "gitBranch") ?? gitBranch;
    const type = stringField(record, "type");
    if (type === "user" || type === "assistant") {
      messageCount += 1;
    }
    if (type === "user" && !firstUserMessage) {
      firstUserMessage = cleanQwenMessage(extractQwenText(record.message));
    }
    if (type === "system" && stringField(record, "subtype") === "custom_title") {
      const payload = isObject(record.systemPayload) ? record.systemPayload : undefined;
      displayName = stringField(payload, "customTitle") ?? displayName;
    }
  }

  if (!id || (!includeEmpty && messageCount === 0)) {
    return undefined;
  }

  const title = (displayName || firstUserMessage || id).trim();
  return {
    cwd,
    displayName: title,
    fileName,
    firstUserMessage: firstUserMessage || title,
    gitBranch,
    id,
    lastUpdated: lastUpdated || fallbackTime || new Date(0).toISOString(),
    messageCount,
    startTime: startTime || lastUpdated || fallbackTime || new Date(0).toISOString(),
    summary: gitBranch ? `Branch: ${gitBranch}` : undefined,
  };
}

async function copyQwenSessionForWorktree(sourcePath: string, targetPath: string, projectRoot: string, worktreePath: string): Promise<void> {
  const raw = await readFile(sourcePath, "utf8");
  const sourceRoot = normalizePath(projectRoot);
  const targetRoot = normalizePath(worktreePath);
  const rewritten = raw
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) {
        return line;
      }
      try {
        const record = JSON.parse(line) as unknown;
        if (isObject(record) && typeof record.cwd === "string" && normalizePath(record.cwd) === sourceRoot) {
          record.cwd = targetRoot;
        }
        return JSON.stringify(record);
      } catch {
        return line;
      }
    })
    .join("\n");
  await writeFile(targetPath, rewritten, "utf8");
}

function extractQwenText(message: unknown): string {
  if (!isObject(message) || !Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join(" ");
}

function cleanQwenMessage(content: string): string {
  return content.trim().replace(/\s+/g, " ").slice(0, 200);
}

function qwenChatsDir(projectRoot: string): string {
  return join(qwenProjectsDir(), sanitizeQwenCwd(projectRoot), "chats");
}

function qwenProjectsDir(): string {
  return join(process.env.QWEN_RUNTIME_DIR || join(homedir(), ".qwen"), "projects");
}

function sanitizeQwenCwd(cwd: string): string {
  const normalized = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

function isQwenSessionFile(fileName: string): boolean {
  return /^[0-9a-fA-F-]{32,36}\.jsonl$/.test(fileName);
}

function normalizePath(path: string): string {
  return resolve(path);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
