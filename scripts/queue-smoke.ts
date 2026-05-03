import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  EventBus,
  GitClient,
  LocalStore,
  WorkbenchOrchestrator,
  type AgentBackend,
} from "@agent-workbench/core";
import type { AgentEvent, BackendStatus, Project, Task } from "@agent-workbench/protocol";

class SlowSessionBackend implements AgentBackend {
  readonly id = "slow-session";
  readonly name = "Slow Session Test Backend";
  readonly prompts: string[] = [];
  private readonly sessions = new Set<string>();

  async detect(): Promise<BackendStatus> {
    return {
      available: true,
      capabilities: ["structured_stream", "worktree"],
      id: this.id,
      kind: "external",
      name: this.name,
    };
  }

  async startTask(): Promise<void> {
    throw new Error("Not used by queue smoke.");
  }

  async startSession(input: {
    agentSessionId?: string;
    task: Task;
    project: Project;
    worktreePath: string;
    modeId?: string;
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<{ agentSessionId: string; resumeMode: "new" }> {
    this.sessions.add(input.task.id);
    return {
      agentSessionId: `slow-${input.task.id}`,
      resumeMode: "new",
    };
  }

  async sendMessage(input: {
    task: Task;
    project: Project;
    worktreePath: string;
    prompt: string;
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<void> {
    this.prompts.push(input.prompt);
    await delay(250);
    await input.emit({
      taskId: input.task.id,
      text: `done: ${input.prompt}`,
      timestamp: new Date().toISOString(),
      type: "message.delta",
    });
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId);
  }
}

async function main(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-queue-"));
  const repo = join(tempDir, "repo");
  const storePath = join(tempDir, "store.json");
  try {
    await prepareRepo(repo);
    const backend = new SlowSessionBackend();
    const store = new LocalStore(storePath);
    const orchestrator = new WorkbenchOrchestrator({
      backends: [backend],
      eventBus: new EventBus(),
      git: new GitClient(),
      store,
      worktreeRoot: join(tempDir, "worktrees"),
    });
    await orchestrator.init();
    const project = await orchestrator.addProject(repo);
    const session = await orchestrator.createSession({
      backendId: backend.id,
      projectId: project.id,
      title: "Queue smoke",
    });

    await delay(20);
    await orchestrator.sendSessionMessage(session.id, "first");
    await orchestrator.sendSessionMessage(session.id, "second");
    const queuedOverview = await orchestrator.listSessionOverviews();
    const queuedSession = queuedOverview.find((item) => item.task.id === session.id);
    assert(queuedSession?.queuedTurns === 1, `expected one queued turn, got ${queuedSession?.queuedTurns}`);
    const queuedDiagnostics = await orchestrator.sessionDiagnostics(session.id);
    assert(queuedDiagnostics.queue.activeTurn === true, "diagnostics should report active turn");
    assert(queuedDiagnostics.queue.queuedTurns === 1, `expected diagnostics queuedTurns 1, got ${queuedDiagnostics.queue.queuedTurns}`);
    assert(queuedDiagnostics.queue.pending[0]?.prompt === "second", `expected pending prompt second, got ${queuedDiagnostics.queue.pending[0]?.prompt}`);
    await waitFor(() => backend.prompts.length === 2, "queued prompt did not start");
    await waitFor(async () => {
      const events = await orchestrator.listEvents(session.id);
      return events.filter((event) => event.type === "turn.finished" && event.status === "completed").length === 2;
    }, "queued turn did not finish");

    const events = await orchestrator.listEvents(session.id);
    assert(events.some((event) => event.type === "session.action" && event.action === "enqueue" && event.status === "completed"), "enqueue event missing");
    assert(backend.prompts.join(",") === "first,second", `queued prompts ran out of order: ${backend.prompts.join(",")}`);

    const clearSession = await orchestrator.createSession({
      backendId: backend.id,
      projectId: project.id,
      title: "Queue clear smoke",
    });
    await delay(20);
    await orchestrator.sendSessionMessage(clearSession.id, "keep-running");
    await orchestrator.sendSessionMessage(clearSession.id, "drop-one");
    await orchestrator.sendSessionMessage(clearSession.id, "drop-two");
    const cleared = await orchestrator.clearSessionQueue(clearSession.id);
    assert(cleared.cleared === 2, `expected to clear 2 queued turns, got ${cleared.cleared}`);
    const clearedOverview = (await orchestrator.listSessionOverviews()).find((item) => item.task.id === clearSession.id);
    assert(clearedOverview?.queuedTurns === 0, `expected cleared overview queue, got ${clearedOverview?.queuedTurns}`);
    await waitFor(() => backend.prompts.includes("keep-running"), "active prompt did not start");
    await delay(500);
    assert(!backend.prompts.includes("drop-one") && !backend.prompts.includes("drop-two"), `cleared queued prompts still ran: ${backend.prompts.join(",")}`);

    const cancelSession = await orchestrator.createSession({
      backendId: backend.id,
      projectId: project.id,
      title: "Queue cancel smoke",
    });
    await delay(20);
    await orchestrator.sendSessionMessage(cancelSession.id, "cancel-running");
    await orchestrator.sendSessionMessage(cancelSession.id, "cancel-drop");
    await orchestrator.stopTask(cancelSession.id);
    const cancelledOverview = (await orchestrator.listSessionOverviews()).find((item) => item.task.id === cancelSession.id);
    assert(cancelledOverview?.queuedTurns === 0, `expected cancel to clear queue, got ${cancelledOverview?.queuedTurns}`);

    const old = new Date(Date.now() - 60_000).toISOString();
    await store.upsertTask({
      backendId: backend.id,
      createdAt: old,
      id: "orphan-running",
      projectId: project.id,
      prompt: "orphan",
      startedAt: old,
      status: "running",
      title: "Orphan running",
      updatedAt: old,
      worktreeBranch: "agent-workbench/orphan-running",
      worktreePath: repo,
    });
    const orphanOverview = (await orchestrator.listSessionOverviews()).find((item) => item.task.id === "orphan-running");
    assert(orphanOverview?.health === "failed", `expected orphan running health failed, got ${orphanOverview?.health}`);
    assert(orphanOverview.stuck === true, "expected orphan running stuck flag");
    assert(orphanOverview.nextAction.includes("stop or reconnect"), `unexpected orphan next action: ${orphanOverview.nextAction}`);

    await store.upsertTask({
      backendId: backend.id,
      createdAt: old,
      id: "stale-terminal",
      projectId: project.id,
      prompt: "terminal",
      startedAt: old,
      status: "review_ready",
      title: "Stale terminal",
      updatedAt: old,
      worktreeBranch: "agent-workbench/stale-terminal",
      worktreePath: repo,
    });
    await store.appendEvent("stale-terminal", {
      action: "resume",
      data: {
        command: "bash",
        cwd: repo,
        kind: "terminal",
        status: "running",
      },
      details: `Running bash in ${repo}.`,
      status: "started",
      taskId: "stale-terminal",
      timestamp: old,
      title: "Terminal started.",
      type: "session.action",
    });
    const staleTerminalOverview = (await orchestrator.listSessionOverviews()).find((item) => item.task.id === "stale-terminal");
    assert(staleTerminalOverview?.health !== "running", `stale terminal should not look live, got ${staleTerminalOverview?.health}`);
    assert(staleTerminalOverview?.terminal?.status === "exited", `expected stale terminal to be normalized to exited, got ${staleTerminalOverview?.terminal?.status}`);

    const overlapWorktreeA = join(tempDir, "overlap-a");
    const overlapWorktreeB = join(tempDir, "overlap-b");
    await git(repo, ["worktree", "add", "-q", "-b", "agent-workbench/overlap-a", overlapWorktreeA]);
    await git(repo, ["worktree", "add", "-q", "-b", "agent-workbench/overlap-b", overlapWorktreeB]);
    await writeFile(join(overlapWorktreeA, "shared.ts"), "new a\n", "utf8");
    await writeFile(join(overlapWorktreeB, "shared.ts"), "new b\n", "utf8");

    await store.upsertTask({
      backendId: backend.id,
      createdAt: old,
      id: "overlap-a",
      projectId: project.id,
      prompt: "overlap a",
      startedAt: old,
      status: "review_ready",
      title: "Overlap A",
      updatedAt: old,
      worktreeBranch: "agent-workbench/overlap-a",
      worktreePath: overlapWorktreeA,
    });
    await store.upsertTask({
      backendId: backend.id,
      createdAt: old,
      id: "overlap-b",
      projectId: project.id,
      prompt: "overlap b",
      startedAt: old,
      status: "review_ready",
      title: "Overlap B",
      updatedAt: old,
      worktreeBranch: "agent-workbench/overlap-b",
      worktreePath: overlapWorktreeB,
    });
    await store.appendDiff({
      createdAt: old,
      diffText: "diff --git a/shared.ts b/shared.ts\n--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1 @@\n-old\n+new a\n",
      id: "diff-overlap-a",
      summary: {
        deletions: 1,
        files: [{ deletions: 1, insertions: 1, path: "shared.ts", status: "modified" }],
        filesChanged: 1,
        insertions: 1,
      },
      taskId: "overlap-a",
    });
    await store.appendDiff({
      createdAt: old,
      diffText: "diff --git a/shared.ts b/shared.ts\n--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1 @@\n-old\n+new b\n",
      id: "diff-overlap-b",
      summary: {
        deletions: 1,
        files: [{ deletions: 1, insertions: 1, path: "shared.ts", status: "modified" }],
        filesChanged: 1,
        insertions: 1,
      },
      taskId: "overlap-b",
    });
    const overlapOverview = await orchestrator.listSessionOverviews();
    const overlapA = overlapOverview.find((item) => item.task.id === "overlap-a");
    const overlapB = overlapOverview.find((item) => item.task.id === "overlap-b");
    assert(overlapA?.overlapFiles[0]?.path === "shared.ts", "expected overlap A to report shared.ts");
    assert(overlapB?.overlapFiles[0]?.path === "shared.ts", "expected overlap B to report shared.ts");
    assert(overlapA.riskReasons.includes("file overlap"), "expected overlap A risk reason");
    assert(overlapA.nextAction.startsWith("Review overlapping files"), `unexpected overlap next action: ${overlapA.nextAction}`);
    const blockedApply = await orchestrator.applySession("overlap-a");
    assert(blockedApply.preflight?.canApply === false, "expected overlapping apply to be blocked");
    assert(blockedApply.preflight.overlapFiles[0]?.path === "shared.ts", "expected apply preflight overlap on shared.ts");

    console.log("queue smoke ok: sequential session turn queue, clear queue, cancel clears queue, orphan running detection, stale terminal normalization, overlap detection, apply overlap preflight");
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function prepareRepo(repo: string): Promise<void> {
  await git(undefined, ["init", "-q", repo]);
  await git(repo, ["config", "user.email", "smoke@example.com"]);
  await git(repo, ["config", "user.name", "Agent Workbench Smoke"]);
  await writeFile(join(repo, "readme.md"), "base\n", "utf8");
  await writeFile(join(repo, "shared.ts"), "old\n", "utf8");
  await git(repo, ["add", "readme.md", "shared.ts"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
}

async function git(cwd: string | undefined, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

async function waitFor(check: (() => boolean) | (() => Promise<boolean>), message: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await check()) {
      return;
    }
    await delay(50);
  }
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
