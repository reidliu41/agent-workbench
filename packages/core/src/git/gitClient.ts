import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommitResult {
  commitSha: string;
  committed: boolean;
}

export interface PullRequestCreationResult {
  created: boolean;
  fallbackReason?: string;
  message?: string;
  url: string;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface GitBranch {
  active: boolean;
  checkedOutHere?: boolean;
  checkedOutPath?: string;
  name: string;
  updatedAt?: string;
}

export interface GitWorktree {
  bare?: boolean;
  branch?: string;
  detached?: boolean;
  path: string;
}

export class GitClient {
  async run(args: string[], cwd?: string): Promise<CommandResult> {
    return this.runCommand("git", args, cwd);
  }

  private async runCommand(command: string, args: string[], cwd?: string, input?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdin.end(input ?? "");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });
    });
  }

  async requireRepo(path: string): Promise<{ root: string; name: string; defaultBranch?: string }> {
    const rootResult = await this.run(["rev-parse", "--show-toplevel"], path);
    if (rootResult.exitCode !== 0) {
      throw new Error(rootResult.stderr.trim() || "Path is not a git repository.");
    }

    const root = rootResult.stdout.trim();
    const branchResult = await this.run(["branch", "--show-current"], root);
    return {
      root,
      name: basename(root),
      defaultBranch: branchResult.stdout.trim() || undefined,
    };
  }

  async createWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch?: string): Promise<void> {
    const args = ["worktree", "add", "-b", branch, worktreePath];
    if (baseBranch) {
      args.push(baseBranch);
    }

    const result = await this.run(args, repoPath);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to create git worktree.");
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    const result = await this.run(["worktree", "remove", "--force", worktreePath], repoPath);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to remove git worktree.");
    }
  }

  async statusPorcelain(cwd: string): Promise<string> {
    const result = await this.run(["status", "--porcelain"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read git status.");
    }
    return result.stdout;
  }

  async statusFiles(cwd: string): Promise<FileStatus[]> {
    return parseStatusPorcelain(await this.statusPorcelain(cwd));
  }

  async diff(cwd: string): Promise<string> {
    return this.patch(cwd);
  }

  async patch(cwd: string): Promise<string> {
    const result = await this.run(["diff", "--patch"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read git diff.");
    }

    return [result.stdout, ...(await this.untrackedDiffs(cwd))].filter((part) => part.trim()).join("\n");
  }

  async patchFromBase(cwd: string, baseRef: string): Promise<string> {
    const result = await this.run(["diff", "--patch", baseRef], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to read git diff from ${baseRef}.`);
    }

    return [result.stdout, ...(await this.untrackedDiffs(cwd))].filter((part) => part.trim()).join("\n");
  }

  async reversePatch(cwd: string): Promise<string> {
    const result = await this.run(["diff", "--patch", "--binary", "-R"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read reverse git diff.");
    }
    return result.stdout;
  }

  private async untrackedDiffs(cwd: string): Promise<string[]> {
    const untrackedResult = await this.run(["ls-files", "--others", "--exclude-standard"], cwd);
    if (untrackedResult.exitCode !== 0) {
      throw new Error(untrackedResult.stderr.trim() || "Failed to read untracked files.");
    }

    const untrackedDiffs: string[] = [];
    for (const file of untrackedResult.stdout.split(/\r?\n/).filter(Boolean)) {
      const fileDiff = await this.run(["diff", "--no-index", "--", "/dev/null", file], cwd);
      if (fileDiff.exitCode !== 0 && fileDiff.exitCode !== 1) {
        throw new Error(fileDiff.stderr.trim() || `Failed to read diff for ${file}.`);
      }
      if (fileDiff.stdout.trim()) {
        untrackedDiffs.push(fileDiff.stdout);
      }
    }

    return untrackedDiffs;
  }

  async applyPatch(cwd: string, patchText: string): Promise<void> {
    if (!patchText.trim()) {
      throw new Error("No patch content to apply.");
    }

    const result = await this.runCommand("git", ["apply", "--3way", "--whitespace=nowarn"], cwd, patchText);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to apply patch.");
    }
  }

  async applyPatchUnsafe(cwd: string, patchText: string): Promise<void> {
    if (!patchText.trim()) {
      throw new Error("No patch content to apply.");
    }

    const result = await this.runCommand("git", ["apply", "--3way", "--whitespace=nowarn", "--reject"], cwd, patchText);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to force apply patch.");
    }
  }

  async applyPatchReverse(cwd: string, patchText: string): Promise<void> {
    if (!patchText.trim()) {
      throw new Error("No patch content to reverse apply.");
    }

    const result = await this.runCommand("git", ["apply", "-R", "--3way", "--whitespace=nowarn"], cwd, patchText);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to reverse apply patch.");
    }
  }

  async checkApplyPatch(cwd: string, patchText: string): Promise<void> {
    if (!patchText.trim()) {
      throw new Error("No patch content to apply.");
    }

    const result = await this.runCommand("git", ["apply", "--check", "--3way", "--whitespace=nowarn"], cwd, patchText);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Patch does not apply cleanly.");
    }
  }

  async currentCommit(cwd: string): Promise<string> {
    const result = await this.run(["rev-parse", "HEAD"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read current commit.");
    }
    return result.stdout.trim();
  }

  async currentBranch(cwd: string): Promise<string> {
    const result = await this.run(["branch", "--show-current"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read current branch.");
    }
    return result.stdout.trim();
  }

  async fileAtRef(cwd: string, ref: string, path: string): Promise<string | undefined> {
    const result = await this.run(["show", `${ref}:${path}`], cwd);
    if (result.exitCode !== 0) {
      return undefined;
    }
    return result.stdout;
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return result.exitCode === 0;
  }

  async listBranches(cwd: string): Promise<GitBranch[]> {
    const [currentBranch, currentRoot, worktrees, result] = await Promise.all([
      this.currentBranch(cwd).catch(() => ""),
      this.repoRoot(cwd).catch(() => cwd),
      this.listWorktrees(cwd).catch(() => []),
      this.run(["branch", "--format=%(refname:short)%00%(committerdate:iso-strict)"], cwd),
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list branches.");
    }
    const worktreeByBranch = new Map(
      worktrees
        .filter((worktree): worktree is GitWorktree & { branch: string } => Boolean(worktree.branch))
        .map((worktree) => [worktree.branch, worktree.path]),
    );
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .flatMap((line): GitBranch[] => {
        const [name, updatedAt] = line.split("\0");
        if (!name) {
          return [];
        }
        return [
          {
            active: name === currentBranch,
            checkedOutHere: worktreeByBranch.get(name) === currentRoot,
            checkedOutPath: worktreeByBranch.get(name),
            name,
            updatedAt: updatedAt || undefined,
          },
        ];
      });
  }

  async listWorktrees(cwd: string): Promise<GitWorktree[]> {
    const result = await this.run(["worktree", "list", "--porcelain"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list git worktrees.");
    }
    return parseWorktreePorcelain(result.stdout);
  }

  async repoRoot(cwd: string): Promise<string> {
    const result = await this.run(["rev-parse", "--show-toplevel"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to read git repository root.");
    }
    return result.stdout.trim();
  }

  async createBranch(cwd: string, branch: string, startPoint = "HEAD"): Promise<void> {
    const result = await this.run(["branch", branch, startPoint], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to create branch ${branch}.`);
    }
  }

  async switchBranch(cwd: string, branch: string): Promise<void> {
    const result = await this.run(["switch", branch], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to switch to branch ${branch}.`);
    }
  }

  async renameBranch(cwd: string, oldBranch: string, newBranch: string): Promise<void> {
    const result = await this.run(["branch", "-m", oldBranch, newBranch], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to rename branch ${oldBranch}.`);
    }
  }

  async deleteBranch(cwd: string, branch: string): Promise<void> {
    const result = await this.run(["branch", "-D", branch], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to delete branch ${branch}.`);
    }
  }

  async addAll(cwd: string): Promise<void> {
    const result = await this.run(["add", "--all"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to stage changes.");
    }
  }

  async addPaths(cwd: string, paths: string[]): Promise<void> {
    const selectedPaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
    if (selectedPaths.length === 0) {
      throw new Error("Select at least one file to stage.");
    }
    const result = await this.run(["add", "--all", "--", ...selectedPaths], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to stage selected changes.");
    }
  }

  async commitStaged(cwd: string, message: string): Promise<CommitResult> {
    const commit = await this.run([
      "-c",
      "user.name=Agent Workbench",
      "-c",
      "user.email=agent-workbench@local",
      "commit",
      "-m",
      message,
    ], cwd);
    if (commit.exitCode !== 0) {
      throw new Error(commit.stderr.trim() || "Failed to commit staged changes.");
    }

    return {
      commitSha: await this.currentCommit(cwd),
      committed: true,
    };
  }

  async commitAll(cwd: string, message: string): Promise<CommitResult> {
    const status = await this.statusPorcelain(cwd);
    if (!status.trim()) {
      return {
        commitSha: await this.currentCommit(cwd),
        committed: false,
      };
    }

    const add = await this.run(["add", "--all"], cwd);
    if (add.exitCode !== 0) {
      throw new Error(add.stderr.trim() || "Failed to stage changes.");
    }

    const commit = await this.run([
      "-c",
      "user.name=Agent Workbench",
      "-c",
      "user.email=agent-workbench@local",
      "commit",
      "-m",
      message,
    ], cwd);
    if (commit.exitCode !== 0) {
      throw new Error(commit.stderr.trim() || "Failed to commit changes.");
    }

    return {
      commitSha: await this.currentCommit(cwd),
      committed: true,
    };
  }

  async pushBranch(cwd: string, branch: string, remote = "origin"): Promise<void> {
    const result = await this.run(["push", "-u", remote, branch], cwd);
    if (result.exitCode !== 0) {
      throw new Error(formatGitHubWorkflowError(result.stderr.trim() || `Failed to push branch ${branch}.`, "push"));
    }
  }

  async defaultRemoteBranch(cwd: string, remote = "origin"): Promise<string | undefined> {
    const result = await this.run(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], cwd);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const ref = result.stdout.trim();
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref || undefined;
  }

  async branchHasCommitsAhead(cwd: string, base: string, head: string): Promise<boolean> {
    const result = await this.run(["rev-list", "--count", `${base}..${head}`], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Failed to compare ${head} against ${base}.`);
    }
    return Number.parseInt(result.stdout.trim(), 10) > 0;
  }

  async listRemotes(cwd: string): Promise<string[]> {
    const result = await this.run(["remote"], cwd);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list git remotes.");
    }
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async createPullRequest(
    cwd: string,
    input: {
      base?: string;
      body: string;
      draft: boolean;
      head: string;
      remote?: string;
      title: string;
    },
  ): Promise<PullRequestCreationResult> {
    const repository = await this.githubRepositorySlug(cwd, input.remote);
    const repositoryOwner = repository.split("/")[0];
    const compareUrl = githubCompareUrl(repository, input.base ?? "main", `${repositoryOwner}:${input.head}`);
    const args = [
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      input.base ?? "main",
      "--head",
      `${repositoryOwner}:${input.head}`,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) {
      args.push("--draft");
    }

    let result: CommandResult;
    try {
      result = await this.runCommand("gh", args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        created: false,
        fallbackReason: message,
        message: "Compare URL ready.",
        url: compareUrl,
      };
    }
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || "Failed to create pull request with gh.";
      return {
        created: false,
        fallbackReason: message,
        message: "Compare URL ready.",
        url: compareUrl,
      };
    }

    const output = `${result.stdout}\n${result.stderr}`.trim();
    const url = output.match(/https?:\/\/\S+/)?.[0];
    return {
      created: true,
      url: url ?? output,
    };
  }

  private async githubRepositorySlug(cwd: string, remote = "origin"): Promise<string> {
    const result = await this.run(["remote", "get-url", remote], cwd);
    if (result.exitCode !== 0) {
      throw new Error(formatGitHubWorkflowError(result.stderr.trim() || "Failed to read origin remote.", "pr"));
    }

    const slug = parseGitHubRepositorySlug(result.stdout.trim());
    if (!slug) {
      throw new Error(
        [
          `Draft PR creation currently supports GitHub origin remotes only. Found: ${result.stdout.trim() || "none"}`,
          "Use Push branch / Export patch, or set `origin` to a GitHub remote.",
        ].join("\n"),
      );
    }
    return slug;
  }
}

function formatGitHubWorkflowError(message: string, phase: "push" | "pr"): string {
  const hints: string[] = [];
  const localGitAccessDenied = /failed to run git|error opening .*\.git.*Permission denied|fatal:.*\.git.*Permission denied/i.test(message);
  if (localGitAccessDenied) {
    hints.push(
      phase === "pr"
        ? "GitHub CLI could not read local worktree git metadata. Workbench now passes `--repo` to avoid relying on gh's worktree detection; restart the server and retry."
        : "Git could not read this session worktree metadata. Check the session `.git` file and the original repository `.git/worktrees` permissions.",
    );
  }
  if (/could not read Username|Authentication failed|not logged|authentication required|gh auth/i.test(message)) {
    hints.push(phase === "push" ? "Check your git credentials for the `origin` remote." : "Run `gh auth status` and `gh auth login` on this machine.");
  }
  if (/Repository not found|not found|403|protected branch|Permission denied \(publickey\)/i.test(message)) {
    hints.push("Check that the repository has an `origin` remote and that your git account can push branches.");
  }
  if (/src refspec|does not appear to be a git repository|No configured push destination/i.test(message)) {
    hints.push("Check `git remote -v` and make sure `origin` is configured.");
  }
  if (/ENOENT|not found|executable file/i.test(message) && phase === "pr") {
    hints.push("Install the GitHub CLI or use Push branch / Export patch until GitHub API PR creation is configured.");
  }
  if (phase === "pr") {
    hints.push("Workbench uses git for branch commits and push; GitHub PR creation currently uses the `gh` CLI until provider API support is wired.");
  }
  return [message, ...hints].join("\n");
}

function parseGitHubRepositorySlug(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/, "");
  const match =
    normalized.match(/^git@github\.com:([^/]+)\/(.+)$/) ??
    normalized.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/) ??
    normalized.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return `${match[1]}/${match[2]}`;
}

function githubCompareUrl(repository: string, base: string, head: string): string {
  return `https://github.com/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`;
}

function parseWorktreePorcelain(output: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) {
        worktrees.push(current);
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length) };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
}

function parseStatusPorcelain(status: string): FileStatus[] {
  return status
    .split(/\r?\n/)
    .flatMap((line): FileStatus[] => {
      if (!line.trim()) {
        return [];
      }
      const code = line.slice(0, 2).trim() || "modified";
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(" -> ");
      const path = renameParts.at(-1) ?? rawPath;
      return [
        {
          path: path.replace(/^"|"$/g, ""),
          status: code,
        },
      ];
    });
}
