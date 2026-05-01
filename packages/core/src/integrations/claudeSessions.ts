import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ClaudeProjectSession {
  cwd?: string;
  fileName?: string;
  firstUserMessage: string;
  id: string;
  lastUpdated: string;
  messageCount: number;
  startTime: string;
  version?: string;
}

export async function listClaudeProjectSessions(projectPath: string): Promise<ClaudeProjectSession[]> {
  const sessions: ClaudeProjectSession[] = [];
  for (const file of await findClaudeSessionFiles(claudeProjectDirectory(projectPath))) {
    const session = await readClaudeSessionFile(file);
    if (session?.cwd === projectPath) {
      sessions.push(session);
    }
  }
  return sessions
    .filter((session, index, all) => all.findIndex((candidate) => candidate.id === session.id) === index)
    .sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
}

export async function findClaudeProjectSession(projectPath: string, sessionId: string): Promise<ClaudeProjectSession | undefined> {
  const direct = await readClaudeSessionFile(join(claudeProjectDirectory(projectPath), `${sessionId}.jsonl`));
  if (direct) {
    return direct;
  }

  for (const file of await findClaudeSessionFiles()) {
    if (!file.endsWith(`${sessionId}.jsonl`)) {
      continue;
    }
    const session = await readClaudeSessionFile(file);
    if (session?.cwd === projectPath) {
      return session;
    }
  }
  return undefined;
}

export async function findLatestClaudeProjectSession(projectPath: string, createdAfter?: string): Promise<ClaudeProjectSession | undefined> {
  const createdAfterMs = createdAfter ? Date.parse(createdAfter) - 60_000 : 0;
  const sessions: ClaudeProjectSession[] = [];
  const directDir = claudeProjectDirectory(projectPath);
  for (const file of await findClaudeSessionFiles(directDir)) {
    const session = await readClaudeSessionFile(file);
    if (!session || session.cwd !== projectPath) {
      continue;
    }
    if (createdAfterMs && Date.parse(session.startTime) < createdAfterMs) {
      continue;
    }
    sessions.push(session);
  }
  sessions.sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
  return sessions[0];
}

function claudeProjectDirectory(projectPath: string): string {
  return join(claudeHome(), "projects", encodeClaudeProjectPath(projectPath));
}

function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replaceAll("/", "-");
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

async function findClaudeSessionFiles(root = join(claudeHome(), "projects")): Promise<string[]> {
  try {
    await access(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  await walk(root, files);
  return files.filter((file) => file.endsWith(".jsonl"));
}

async function walk(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
}

async function readClaudeSessionFile(filePath: string): Promise<ClaudeProjectSession | undefined> {
  try {
    await stat(filePath);
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const id = filePath.split("/").at(-1)?.replace(/\.jsonl$/, "");
  if (!id) {
    return undefined;
  }

  let cwd: string | undefined;
  let firstUserMessage = "";
  let lastUpdated = "";
  let messageCount = 0;
  let startTime = "";
  let version: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
    if (timestamp) {
      startTime ||= timestamp;
      lastUpdated = timestamp;
    }
    if (typeof parsed.cwd === "string") {
      cwd = parsed.cwd;
    }
    if (typeof parsed.version === "string") {
      version = parsed.version;
    }
    if (parsed.type === "user") {
      messageCount += 1;
      if (!firstUserMessage) {
        const message = parsed.message;
        if (message && typeof message === "object" && "content" in message) {
          const content = (message as { content?: unknown }).content;
          if (typeof content === "string" && !content.startsWith("<local-command-")) {
            firstUserMessage = content.slice(0, 200);
          }
        }
      }
    }
  }

  return {
    cwd,
    fileName: filePath.split("/").at(-1),
    firstUserMessage,
    id,
    lastUpdated: lastUpdated || startTime || new Date(0).toISOString(),
    messageCount,
    startTime: startTime || lastUpdated || new Date(0).toISOString(),
    version,
  };
}
