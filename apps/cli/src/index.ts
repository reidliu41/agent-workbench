#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { defaultStorePath } from "@agent-workbench/core";
import { createWorkbenchServer, type StartedServer } from "@agent-workbench/server";

const program = new Command();

program
  .name("agent-workbench")
  .description("Local-first web workbench for Gemini CLI and coding agents.")
  .version(packageVersion())
  .helpOption("--help", "display help");

program
  .command("serve")
  .description("Start the local web gateway.")
  .helpOption("--help", "display help for command")
  .option("-h, --host <host>", "Host to bind", process.env.AGENT_WORKBENCH_HOST ?? "127.0.0.1")
  .option("-p, --port <port>", "Port to bind", process.env.AGENT_WORKBENCH_PORT ?? "3030")
  .action(async (options: { host: string; port: string }) => {
    const port = Number.parseInt(options.port, 10);
    try {
      const started = await createWorkbenchServer({
        host: options.host,
        port,
        logger: false,
      });
      if (started.host === "0.0.0.0") {
        console.warn("Warning: Agent Workbench is listening on all interfaces. Keep the token private and prefer SSH port forwarding when possible.");
      }
      printServerUrls(started);
    } catch (error) {
      if (isListenInUseError(error)) {
        console.error(`Port ${options.host}:${port} is already in use.`);
        console.error(`Use another port: npm run serve -- -h ${options.host} -p ${port + 1}`);
        console.error("Or stop the existing agent-workbench process.");
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

program.command("doctor").description("Check local prerequisites.").action(async () => {
  const host = process.env.AGENT_WORKBENCH_HOST ?? "127.0.0.1";
  const port = process.env.AGENT_WORKBENCH_PORT ?? "3030";
  const storePath = process.env.AGENT_WORKBENCH_STORE_PATH ?? defaultStorePath();
  const checks = await Promise.all([
    checkCommand("node", ["-v"]),
    checkCommand("git", ["--version"]),
    checkCommand(process.env.GEMINI_CLI_COMMAND ?? "gemini", ["--version"]),
    checkCommand(process.env.CODEX_CLI_COMMAND ?? "codex", ["--version"]),
    checkCommand(process.env.CLAUDE_CODE_COMMAND ?? "claude", ["--version"]),
    checkStore(storePath),
  ]);

  for (const check of checks) {
    const marker = check.ok ? "ok" : "missing";
    console.log(`${marker.padEnd(8)} ${check.name.padEnd(8)} ${check.output}`);
  }
  console.log(`info     bind     ${host}:${port}`);
  if (host === "0.0.0.0") {
    console.log("warning  network  listening on all interfaces requires a private token and network controls");
  }
});

program.parseAsync(process.argv);

function packageVersion(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === "@agent-workbench/cli" && typeof parsed.version === "string") {
          return parsed.version;
        }
      } catch {
        return "0.0.0";
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return "0.0.0";
}

async function checkCommand(name: string, args: string[]): Promise<{ name: string; ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ name, ok: false, output: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({ name, ok: exitCode === 0, output: output.trim() });
    });
  });
}

async function checkStore(path: string): Promise<{ name: string; ok: boolean; output: string }> {
  try {
    const info = await stat(path);
    return {
      name: "storage",
      ok: true,
      output: `${path} (${info.size} bytes)`,
    };
  } catch {
    return {
      name: "storage",
      ok: false,
      output: `${path} does not exist yet; it will be created when the server starts`,
    };
  }
}

function isListenInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}

function printServerUrls(started: StartedServer): void {
  console.log("Agent Workbench is running.");
  console.log("");
  printUrlGroup("Local", started.urls.local);
  printUrlGroup("Network", started.urls.network);
  console.log(`Bound address: ${started.host}:${started.port}`);
}

function printUrlGroup(label: string, urls: string[]): void {
  if (urls.length === 0) {
    return;
  }
  for (const url of urls) {
    console.log(`${label.padEnd(8)} ${url}`);
  }
}
