#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { WebSocket } from "ws";

const token = "smoke-token";
const taskId = "task-smoke";
const terminalTaskId = "task-terminal-smoke";

const checks = [];

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-smoke-"));
  const repo = join(tempDir, "repo");
  const worktree = join(tempDir, "worktree");
  const worktreeRoot = join(tempDir, "server-worktrees");
  const store = join(tempDir, "store.json");
  const port = await freePort();
  let server;

  try {
    await prepareRepo(repo, worktree);
    const branch = await git(repo, ["branch", "--show-current"]);
    await writeSmokeStore(store, repo, worktree, branch.trim() || "master");

    server = startServer(port, store, { AGENT_WORKBENCH_WORKTREE_ROOT: worktreeRoot });
    let logs = collectProcessLogs(server);

    await waitForHealth(port, logs);
    pass("server health");

    const html = await fetchText(port, `/?token=${encodeURIComponent(token)}`);
    assert(html.includes("Agent Workbench") || html.includes("/assets/index-"), "expected HTML shell");
    pass("web shell");

    const overview = await fetchJson(port, `/api/sessions/overview?token=${encodeURIComponent(token)}`);
    assert(Array.isArray(overview), "overview must be an array");
    const session = overview.find((item) => item.task?.id === taskId);
    assert(session, "recovered session missing from overview");
    assert(session.task.status === "review_ready", `expected review_ready, got ${session.task.status}`);
    assert(session.task.agentContextStatus === "transcript_fallback", `expected transcript_fallback, got ${session.task.agentContextStatus}`);
    assert(session.health === "attention", `expected attention, got ${session.health}`);
    assert(session.filesChanged === 1, `expected one changed file, got ${session.filesChanged}`);
    assert(typeof session.nextAction === "string" && session.nextAction.length > 0, "nextAction missing");
    pass("restart recovery overview");

    const events = await fetchJson(port, `/api/tasks/${taskId}/events?token=${encodeURIComponent(token)}`);
    assert(events.some((event) => event.type === "session.action" && event.action === "recover"), "recover event missing");
    pass("recover event");

    const doctor = await fetchJson(port, `/api/system/doctor?token=${encodeURIComponent(token)}`);
    assert(Array.isArray(doctor.checks) && doctor.checks.some((check) => check.name === "node" && check.ok), "doctor node check missing");
    assert(doctor.checks.some((check) => check.name === "git" && check.ok), "doctor git check missing");
    assert(doctor.storage?.exists === true, "doctor storage status missing");
    pass("system doctor");

    const runtimeConfig = await fetchJson(port, `/api/runtime/config?token=${encodeURIComponent(token)}`);
    assert(runtimeConfig.host === "127.0.0.1", `runtime config host mismatch: ${runtimeConfig.host}`);
    assert(runtimeConfig.port === port, `runtime config port mismatch: ${runtimeConfig.port}`);
    assert(runtimeConfig.storage?.path === store, "runtime config storage path mismatch");
    assert(runtimeConfig.storage?.type === "json", "runtime config storage type mismatch");
    assert(runtimeConfig.worktrees?.root === worktreeRoot, "runtime config worktree root mismatch");
    assert(runtimeConfig.backendCommands?.some((backend) => backend.id === "gemini-acp" && backend.command), "runtime config backend commands missing");
    pass("runtime config");

    const slashCommands = await fetchJson(port, `/api/slash-commands?token=${encodeURIComponent(token)}`);
    assert(slashCommands.some((command) => command.name === "memory list" && command.source === "workbench"), "memory list command metadata missing");
    assert(slashCommands.some((command) => command.name === "help" && command.aliases.length === 0), "help command metadata missing");
    pass("slash command metadata");

    const worktreeTask = await fetchJson(port, `/api/tasks?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({
        backendId: "generic-pty",
        projectId: "project-smoke",
        prompt: "printf worktree-root-smoke",
        title: "worktree root smoke",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert(worktreeTask.worktreePath?.startsWith(worktreeRoot), `task worktree root mismatch: ${worktreeTask.worktreePath}`);
    pass("configured worktree root");

    await fetchJson(port, `/api/sessions/${taskId}/messages?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ prompt: "/memory list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const slashEvents = await fetchJson(port, `/api/tasks/${taskId}/events?token=${encodeURIComponent(token)}`);
    assert(slashEvents.some((event) => event.type === "tool.started" && event.name === "/memory list"), "native slash command did not start");
    assert(slashEvents.some((event) => event.type === "message.delta" && event.text.includes("GEMINI.md file")), "native slash command output missing");
    pass("native slash commands");

    const beforeUnsupportedSlash = slashEvents.length;
    await fetchJson(port, `/api/sessions/${taskId}/messages?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ prompt: "/not-a-real-command" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const unsupportedSlashEvents = await fetchJson(port, `/api/tasks/${taskId}/events?token=${encodeURIComponent(token)}`);
    const newUnsupportedEvents = unsupportedSlashEvents.slice(beforeUnsupportedSlash);
    assert(newUnsupportedEvents.some((event) => event.type === "message.delta" && event.text.includes("Unsupported slash command")), "unsupported slash command message missing");
    assert(!newUnsupportedEvents.some((event) => event.type === "session.action" && event.action === "resume"), "unsupported slash command should not attach backend");
    pass("unsupported slash command guard");

    const renamed = await fetchJson(port, `/api/sessions/${taskId}?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ title: "Renamed smoke session" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
    assert(renamed.title === "Renamed smoke session", `expected renamed session title, got ${renamed.title}`);
    const renamedOverview = await fetchJson(port, `/api/sessions/overview?token=${encodeURIComponent(token)}`);
    assert(renamedOverview.some((item) => item.task?.id === taskId && item.task.title === "Renamed smoke session"), "overview did not reflect renamed session");
    pass("session rename");

    const emptyJsonError = await fetchJson(port, `/api/sessions/${taskId}/branch?token=${encodeURIComponent(token)}`, {
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert(emptyJsonError.code === "FST_ERR_CTP_EMPTY_JSON_BODY", "empty JSON body code missing");
    assert(typeof emptyJsonError.hint === "string" && emptyJsonError.hint.includes("{}"), "empty JSON body hint missing");
    pass("normalized API error");

    const prFallback = await fetchJson(port, `/api/sessions/${taskId}/pr?token=${encodeURIComponent(token)}`, {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert(prFallback.created === false, "PR fallback should not create a PR without a remote");
    assert(prFallback.pushed === false, "PR fallback should report pushed=false without a remote");
    assert(typeof prFallback.patchPath === "string" && prFallback.patchPath.endsWith(".patch"), "PR fallback patchPath missing");
    assert(prFallback.task?.status === "branch_ready", `expected branch_ready after PR fallback, got ${prFallback.task?.status}`);
    pass("PR patch fallback");

    const deliveryEvents = await fetchJson(port, `/api/tasks/${taskId}/events?token=${encodeURIComponent(token)}`);
    const deliveryEvent = [...deliveryEvents].reverse().find((event) => event.type === "session.action" && event.action === "create_pr" && event.status === "completed");
    assert(deliveryEvent, "delivery create_pr event missing");
    assert(deliveryEvent.data?.created === false, "delivery event should record created=false");
    assert(deliveryEvent.data?.pushed === false, "delivery event should record pushed=false");
    assert(typeof deliveryEvent.data?.patchPath === "string", "delivery event patch path missing");
    assert(typeof deliveryEvent.data?.branch === "string", "delivery event branch missing");
    pass("delivery event data");

    const deliveryOverview = await fetchJson(port, `/api/sessions/overview?token=${encodeURIComponent(token)}`);
    const deliverySession = deliveryOverview.find((item) => item.task?.id === taskId);
    assert(deliverySession?.latestDelivery?.status === "branch_ready", `expected overview delivery branch_ready, got ${deliverySession?.latestDelivery?.status}`);
    assert(deliverySession.latestDelivery.branch === deliveryEvent.data.branch, "overview delivery branch mismatch");
    assert(deliverySession.latestDelivery.patchPath === deliveryEvent.data.patchPath, "overview delivery patch mismatch");
    pass("overview delivery status");

    const report = await fetchJson(port, `/api/sessions/${taskId}/report?token=${encodeURIComponent(token)}`, {
      method: "POST",
    });
    assert(typeof report.reportPath === "string" && report.reportPath.endsWith(".md"), "report path missing");
    assert(report.markdown.includes("# Agent Workbench Session Report"), "report heading missing");
    assert(report.markdown.includes("Renamed smoke session"), "report should include renamed session title");
    assert(report.summary.events > 0, "report summary events missing");
    pass("session report export");

    await writeFile(join(worktree, "readme.md"), "base\nsnapshot-one\n", "utf8");
    const snapshotOne = await fetchJson(port, `/api/sessions/${taskId}/snapshots?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ label: "Snapshot one" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await writeFile(join(worktree, "readme.md"), "base\nsnapshot-two\n", "utf8");
    const snapshotTwo = await fetchJson(port, `/api/sessions/${taskId}/snapshots?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ label: "Snapshot two" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert(snapshotOne.id !== snapshotTwo.id, "snapshots should have distinct ids");
    const rollbackMarker = await fetchJson(port, `/api/sessions/${taskId}/rollback?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ snapshotId: snapshotOne.id }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const rolledBackContent = await readFile(join(worktree, "readme.md"), "utf8");
    assert(rolledBackContent.includes("snapshot-one"), "selected snapshot rollback did not apply snapshot-one");
    assert(!rolledBackContent.includes("snapshot-two"), "selected snapshot rollback incorrectly applied latest snapshot");
    assert(rollbackMarker.rollbackSnapshot?.kind === "rollback", "rollback should create a marker snapshot");
    pass("selected snapshot rollback");

    await terminalSmoke(port);
    pass("terminal websocket");
    await terminalCancelSmoke(port);
    pass("terminal cancel via session stop");

    const storageStatus = await fetchJson(port, `/api/storage/status?token=${encodeURIComponent(token)}`);
    assert(storageStatus.exists === true, "store status must report primary store");
    assert(storageStatus.backupExists === true, "store backup must exist after writes");
    pass("storage status");

    await stopProcessTree(server);
    server = undefined;
    await writeFile(store, "{ broken json", "utf8");
    server = startServer(port, store, { AGENT_WORKBENCH_WORKTREE_ROOT: worktreeRoot });
    logs = collectProcessLogs(server);
    await waitForHealth(port, logs);
    const recoveredStatus = await fetchJson(port, `/api/storage/status?token=${encodeURIComponent(token)}`);
    assert(recoveredStatus.lastRecovery?.source === "backup", `expected backup recovery, got ${JSON.stringify(recoveredStatus.lastRecovery)}`);
    const recoveredOverview = await fetchJson(port, `/api/sessions/overview?token=${encodeURIComponent(token)}`);
    assert(recoveredOverview.some((item) => item.task?.id === taskId), "overview missing after backup recovery");
    pass("backup recovery");

    await stopProcessTree(server);
    server = undefined;
    const sqliteStore = join(tempDir, "store.sqlite");
    server = startServer(port, sqliteStore, { AGENT_WORKBENCH_WORKTREE_ROOT: worktreeRoot });
    logs = collectProcessLogs(server);
    await waitForHealth(port, logs);
    const sqliteProject = await fetchJson(port, `/api/projects?token=${encodeURIComponent(token)}`, {
      body: JSON.stringify({ path: repo }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert(sqliteProject.path === repo, "sqlite project add failed");
    await stopProcessTree(server);
    server = undefined;
    server = startServer(port, sqliteStore, { AGENT_WORKBENCH_WORKTREE_ROOT: worktreeRoot });
    logs = collectProcessLogs(server);
    await waitForHealth(port, logs);
    const sqliteProjects = await fetchJson(port, `/api/projects?token=${encodeURIComponent(token)}`);
    assert(sqliteProjects.some((project) => project.path === repo), "sqlite project did not persist after restart");
    const sqliteDoctor = await fetchJson(port, `/api/system/doctor?token=${encodeURIComponent(token)}`);
    assert(sqliteDoctor.storage.path === sqliteStore, "sqlite doctor storage path mismatch");
    pass("sqlite store persistence");

    console.log(`smoke ok: ${checks.join(", ")}`);
  } finally {
    await stopProcessTree(server);
    await rm(tempDir, { force: true, recursive: true });
  }
}

function startServer(port, store, extraEnv = {}) {
  return spawn("npm", ["run", "serve", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      AGENT_WORKBENCH_STORE_PATH: store,
      AGENT_WORKBENCH_TOKEN: token,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function prepareRepo(repo, worktree) {
  await git(undefined, ["init", "-q", repo]);
  await git(repo, ["config", "user.email", "smoke@example.com"]);
  await git(repo, ["config", "user.name", "Agent Workbench Smoke"]);
  await writeFile(join(repo, "readme.md"), "base\n", "utf8");
  await writeFile(join(repo, "GEMINI.md"), "Smoke memory\n", "utf8");
  await git(repo, ["add", "readme.md", "GEMINI.md"]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  await git(repo, ["worktree", "add", "-q", "-b", "agent-workbench/smoke", worktree]);
  await writeFile(join(worktree, "readme.md"), "base\nchange\n", "utf8");
}

async function writeSmokeStore(store, repo, worktree, branch) {
  const now = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await writeFile(store, `${JSON.stringify({
    approvals: [],
    diffs: [],
    events: {
      [taskId]: [
        {
          taskId,
          timestamp: now,
          type: "task.started",
        },
        {
          text: "Please update the file.",
          taskId,
          timestamp: new Date(Date.parse(now) + 1000).toISOString(),
          type: "user.message",
        },
        {
          text: "I updated readme.md.",
          taskId,
          timestamp: new Date(Date.parse(now) + 2000).toISOString(),
          type: "message.delta",
        },
      ],
    },
    projects: [
      {
        createdAt: now,
        defaultBranch: branch,
        id: "project-smoke",
        name: "repo",
        path: repo,
        updatedAt: now,
      },
    ],
    snapshots: [],
    tasks: [
      {
        backendId: "gemini-acp",
        baseBranch: branch,
        createdAt: now,
        id: taskId,
        projectId: "project-smoke",
        prompt: "smoke",
        startedAt: now,
        status: "running",
        title: "stale running smoke",
        updatedAt: now,
        worktreeBranch: "agent-workbench/smoke",
        worktreePath: worktree,
      },
      {
        backendId: "generic-pty",
        baseBranch: branch,
        createdAt: now,
        id: terminalTaskId,
        projectId: "project-smoke",
        prompt: "terminal smoke",
        startedAt: now,
        status: "review_ready",
        title: "terminal smoke",
        updatedAt: now,
        worktreeBranch: "agent-workbench/smoke",
        worktreePath: worktree,
      },
    ],
  }, null, 2)}\n`, "utf8");
}

async function waitForHealth(port, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await fetchJson(port, `/api/health?token=${encodeURIComponent(token)}`);
      if (health.ok) {
        return;
      }
    } catch {
      // Retry until the server is listening.
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy\n${logs()}`);
}

async function terminalSmoke(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  let output = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`terminal smoke timed out: ${JSON.stringify(output)}`));
    }, 8000);

    socket.on("open", () => {
      socket.send(JSON.stringify({
        cols: 80,
        command: "printf terminal-smoke",
        rows: 24,
        taskId: terminalTaskId,
        type: "terminal.restart",
      }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "terminal.output" && message.taskId === terminalTaskId) {
        output += message.data || "";
      }
      if (message.type === "terminal.status" && message.taskId === terminalTaskId && message.terminal?.status === "exited") {
        clearTimeout(timeout);
        socket.close();
        if (!output.includes("terminal-smoke")) {
          reject(new Error(`terminal output missing: ${JSON.stringify(output)}`));
          return;
        }
        resolve();
      }
      if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(message.error || "terminal websocket error"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function terminalCancelSmoke(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  let sawRunning = false;
  let sawExited = false;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`terminal cancel timed out: running=${sawRunning} exited=${sawExited}`));
    }, 10000);

    socket.on("open", () => {
      socket.send(JSON.stringify({
        cols: 80,
        command: "sleep 20",
        rows: 24,
        taskId: terminalTaskId,
        type: "terminal.restart",
      }));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "terminal.status" && message.terminal?.status === "running" && !sawRunning) {
        sawRunning = true;
        await fetchJson(port, `/api/sessions/${terminalTaskId}/cancel?token=${encodeURIComponent(token)}`, {
          method: "POST",
        });
      }
      if (message.type === "terminal.status" && message.terminal?.status === "exited") {
        sawExited = true;
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
      if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(message.error || "terminal websocket error"));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function fetchJson(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return response.json();
}

async function fetchText(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a free port");
  }
  return address.port;
}

function collectProcessLogs(child) {
  const chunks = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  return () => chunks.join("");
}

async function stopProcessTree(child) {
  if (!child || child.killed || child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  await delay(300);
  try {
    process.kill(-child.pid, 0);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Process group already exited.
  }
}

function pass(name) {
  checks.push(name);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main();
