import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { GeminiProjectSession } from "@agent-workbench/protocol";

const GEMINI_SESSION_FILE_PREFIX = "session-";
const GEMINI_PROJECT_ROOT_MARKER = ".project_root";

interface GeminiSessionMetadataRecord {
  kind?: "main" | "subagent";
  lastUpdated?: string;
  projectHash?: string;
  sessionId?: string;
  startTime?: string;
  summary?: string;
}

interface ResolvedGeminiProjectSession {
  filePath: string;
  session: GeminiProjectSession;
}

interface GeminiProjectsRegistry {
  projects?: Record<string, string>;
}

export async function listGeminiProjectSessions(projectRoot: string): Promise<GeminiProjectSession[]> {
  return listGeminiProjectSessionRecords(projectRoot, false);
}

export async function listGeminiProjectSessionCandidates(projectRoot: string): Promise<GeminiProjectSession[]> {
  return listGeminiProjectSessionRecords(projectRoot, true);
}

async function listGeminiProjectSessionRecords(projectRoot: string, includeEmpty: boolean): Promise<GeminiProjectSession[]> {
  const chatsDirs = await geminiCandidateChatsDirs(projectRoot);
  const sessions: Array<GeminiProjectSession | undefined> = [];
  for (const chatsDir of chatsDirs) {
    let entries;
    try {
      entries = await readdir(chatsDir, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }

    sessions.push(
      ...(await Promise.all(
        entries
          .filter((entry) => entry.isFile() && isGeminiSessionFile(entry.name))
          .map(async (entry) => {
            const filePath = join(chatsDir, entry.name);
            try {
              return await loadGeminiProjectSession(filePath, includeEmpty);
            } catch {
              return undefined;
            }
          }),
      )),
    );
  }

  return sessions
    .filter((session): session is GeminiProjectSession => Boolean(session))
    .filter((session, index, all) => all.findIndex((candidate) => candidate?.id === session.id) === index)
    .sort((left, right) => Date.parse(right.lastUpdated) - Date.parse(left.lastUpdated));
}

export async function bridgeGeminiSessionToWorktree(
  projectRoot: string,
  worktreePath: string,
  sessionId: string,
): Promise<GeminiProjectSession> {
  const resolved = await resolveGeminiProjectSession(projectRoot, sessionId);
  const targetDir = await geminiChatsDir(worktreePath);
  await mkdir(targetDir, { recursive: true });
  await copyFile(resolved.filePath, join(targetDir, basename(resolved.filePath)));
  return resolved.session;
}

async function resolveGeminiProjectSession(projectRoot: string, sessionId: string): Promise<ResolvedGeminiProjectSession> {
  const chatsDirs = await geminiCandidateChatsDirs(projectRoot);
  let sawDirectory = false;

  for (const chatsDir of chatsDirs) {
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
      if (!entry.isFile() || !isGeminiSessionFile(entry.name)) {
        continue;
      }
      const filePath = join(chatsDir, entry.name);
      const session = await loadGeminiProjectSession(filePath).catch(() => undefined);
      if (session?.id === sessionId) {
        return { filePath, session };
      }
    }
  }

  if (!sawDirectory) {
    throw new Error("No Gemini sessions were found for this project.");
  }
  throw new Error(`Gemini session not found: ${sessionId}`);
}

async function loadGeminiProjectSession(filePath: string, includeEmpty = false): Promise<GeminiProjectSession | undefined> {
  const raw = await readFile(filePath, "utf8");
  return parseGeminiSessionText(raw, basename(filePath), includeEmpty);
}

function parseGeminiSessionText(raw: string, fileName: string, includeEmpty: boolean): GeminiProjectSession | undefined {
  const parsedLines = parseGeminiJsonLines(raw, fileName, includeEmpty);
  if (parsedLines) {
    return parsedLines.session;
  }

  return parseGeminiLegacyJson(raw, fileName);
}

function parseGeminiJsonLines(
  raw: string,
  fileName: string,
  includeEmpty: boolean,
): { session: GeminiProjectSession } | undefined {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }

  let metadata: GeminiSessionMetadataRecord = {};
  let firstUserMessage = "";
  let hasConversation = false;
  let messageCount = 0;

  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    if (isMetadataUpdateRecord(record)) {
      metadata = { ...metadata, ...record.$set };
      continue;
    }
    if (isMetadataRecord(record)) {
      metadata = { ...metadata, ...record };
      continue;
    }
    if (!isMessageRecord(record)) {
      continue;
    }
    if (record.type !== "user" && record.type !== "gemini") {
      continue;
    }
    hasConversation = true;
    messageCount += 1;
    if (!firstUserMessage && record.type === "user") {
      firstUserMessage = cleanMessage(extractTextFromContent(record.content));
    }
  }

  if (!metadata.sessionId || metadata.kind === "subagent" || (!hasConversation && !includeEmpty)) {
    return undefined;
  }

  const title = (metadata.summary?.trim() || firstUserMessage || metadata.sessionId).trim();
  const timestamp = metadata.lastUpdated || metadata.startTime || new Date(0).toISOString();
  return {
    session: {
      displayName: title,
      fileName,
      firstUserMessage: firstUserMessage || title,
      id: metadata.sessionId,
      lastUpdated: timestamp,
      messageCount,
      startTime: metadata.startTime || timestamp,
      summary: metadata.summary?.trim() || undefined,
    },
  };
}

function parseGeminiLegacyJson(raw: string, fileName: string): GeminiProjectSession | undefined {
  let record: unknown;
  try {
    record = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const sessionId = stringField(record, "sessionId");
  if (!sessionId || stringField(record, "kind") === "subagent") {
    return undefined;
  }

  const messages = Array.isArray((record as { messages?: unknown }).messages)
    ? ((record as { messages: unknown[] }).messages)
    : [];
  const conversationMessages = messages.filter(
    (message) =>
      message &&
      typeof message === "object" &&
      "type" in message &&
      (((message as { type?: unknown }).type === "user") || (message as { type?: unknown }).type === "gemini"),
  );
  if (conversationMessages.length === 0) {
    return undefined;
  }

  const firstUser = conversationMessages.find(
    (message) => message && typeof message === "object" && (message as { type?: unknown }).type === "user",
  ) as { content?: unknown } | undefined;
  const firstUserMessage = cleanMessage(extractTextFromContent(firstUser?.content));
  const summary = stringField(record, "summary")?.trim() || undefined;
  const title = summary || firstUserMessage || sessionId;
  const lastUpdated = stringField(record, "lastUpdated") || stringField(record, "startTime") || new Date(0).toISOString();
  return {
    displayName: title,
    fileName,
    firstUserMessage: firstUserMessage || title,
    id: sessionId,
    lastUpdated,
    messageCount: conversationMessages.length,
    startTime: stringField(record, "startTime") || lastUpdated,
    summary,
  };
}

async function geminiCandidateChatsDirs(projectRoot: string): Promise<string[]> {
  const current = await geminiChatsDir(projectRoot);
  const legacy = legacyGeminiChatsDir(projectRoot);
  return current === legacy ? [current] : [current, legacy];
}

async function geminiChatsDir(projectRoot: string): Promise<string> {
  return join(geminiTmpDir(), await geminiProjectIdentifier(projectRoot), "chats");
}

async function geminiProjectIdentifier(projectRoot: string): Promise<string> {
  const normalized = normalizeGeminiProjectPath(projectRoot);
  const registryPath = join(geminiHomeDir(), "projects.json");
  const registry = await readGeminiProjectsRegistry(registryPath);
  const existing = registry.projects?.[normalized];
  if (existing && (await geminiSlugBelongsToProject(existing, normalized))) {
    await ensureGeminiOwnershipMarkers(existing, normalized);
    return existing;
  }

  const projects = { ...(registry.projects ?? {}) };
  delete projects[normalized];
  const slug = await claimGeminiProjectSlug(normalized, projects);
  projects[normalized] = slug;
  await mkdir(geminiHomeDir(), { recursive: true });
  await writeFile(registryPath, JSON.stringify({ projects }, null, 2), "utf8");
  return slug;
}

async function readGeminiProjectsRegistry(registryPath: string): Promise<Required<GeminiProjectsRegistry>> {
  try {
    const raw = await readFile(registryPath, "utf8");
    const parsed = JSON.parse(raw) as GeminiProjectsRegistry;
    return { projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {} };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { projects: {} };
    }
    throw error;
  }
}

async function claimGeminiProjectSlug(projectRoot: string, existingMappings: Record<string, string>): Promise<string> {
  const baseSlug = slugifyGeminiProject(basename(projectRoot) || "project");
  const existing = new Set(Object.values(existingMappings));
  for (let index = 0; ; index += 1) {
    const candidate = index === 0 ? baseSlug : `${baseSlug}-${index}`;
    if (existing.has(candidate)) {
      continue;
    }
    if (!(await geminiSlugBelongsToAnotherProject(candidate, projectRoot))) {
      await ensureGeminiOwnershipMarkers(candidate, projectRoot);
      return candidate;
    }
  }
}

async function geminiSlugBelongsToProject(slug: string, projectRoot: string): Promise<boolean> {
  for (const baseDir of geminiProjectBaseDirs()) {
    const markerPath = join(baseDir, slug, GEMINI_PROJECT_ROOT_MARKER);
    try {
      const owner = (await readFile(markerPath, "utf8")).trim();
      if (normalizeGeminiProjectPath(owner) !== normalizeGeminiProjectPath(projectRoot)) {
        return false;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      return false;
    }
  }
  return true;
}

async function geminiSlugBelongsToAnotherProject(slug: string, projectRoot: string): Promise<boolean> {
  for (const baseDir of geminiProjectBaseDirs()) {
    const markerPath = join(baseDir, slug, GEMINI_PROJECT_ROOT_MARKER);
    try {
      const owner = (await readFile(markerPath, "utf8")).trim();
      if (normalizeGeminiProjectPath(owner) !== normalizeGeminiProjectPath(projectRoot)) {
        return true;
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function ensureGeminiOwnershipMarkers(slug: string, projectRoot: string): Promise<void> {
  const normalized = normalizeGeminiProjectPath(projectRoot);
  for (const baseDir of geminiProjectBaseDirs()) {
    const slugDir = join(baseDir, slug);
    const markerPath = join(slugDir, GEMINI_PROJECT_ROOT_MARKER);
    await mkdir(slugDir, { recursive: true });
    try {
      await writeFile(markerPath, normalized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
      const owner = (await readFile(markerPath, "utf8")).trim();
      if (normalizeGeminiProjectPath(owner) !== normalized) {
        throw new Error(`Gemini project id ${slug} is already owned by ${owner}`);
      }
    }
  }
}

function legacyGeminiChatsDir(projectRoot: string): string {
  return join(geminiTmpDir(), geminiProjectHash(projectRoot), "chats");
}

function geminiProjectHash(projectRoot: string): string {
  return createHash("sha256").update(normalizeGeminiProjectPath(projectRoot)).digest("hex");
}

function geminiProjectBaseDirs(): string[] {
  return [geminiTmpDir(), join(geminiHomeDir(), "history")];
}

function geminiTmpDir(): string {
  return join(geminiHomeDir(), "tmp");
}

function geminiHomeDir(): string {
  return join(homedir(), ".gemini");
}

function normalizeGeminiProjectPath(projectRoot: string): string {
  return resolve(projectRoot);
}

function slugifyGeminiProject(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "project"
  );
}

function isGeminiSessionFile(name: string): boolean {
  return name.startsWith(GEMINI_SESSION_FILE_PREFIX) && (name.endsWith(".json") || name.endsWith(".jsonl"));
}

function isMetadataRecord(value: unknown): value is GeminiSessionMetadataRecord {
  return Boolean(value && typeof value === "object" && stringField(value, "sessionId") && stringField(value, "projectHash"));
}

function isMetadataUpdateRecord(value: unknown): value is { $set: GeminiSessionMetadataRecord } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "$set" in value &&
      value.$set &&
      typeof value.$set === "object",
  );
}

function isMessageRecord(value: unknown): value is { content?: unknown; id: string; type: string } {
  return Boolean(value && typeof value === "object" && stringField(value, "id") && stringField(value, "type"));
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function cleanMessage(message: string): string {
  return message
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]+/g, "")
    .trim();
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
