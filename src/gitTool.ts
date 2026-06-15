/**
 * gitTool.ts — Git integration: status, diff, log, commit, branch, blame.
 */

import { runShell } from "./shell.js";
import * as log from "./logger.js";

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

export async function gitStatus(cwd?: string): Promise<GitStatus> {
  log.toolCall("git_status", { cwd });

  const branch = await gitCommand("rev-parse --abbrev-ref HEAD", cwd);
  const statusOutput = await gitCommand("status --porcelain=v1", cwd);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  for (const line of statusOutput.split("\n").filter(Boolean)) {
    const indexStatus = line[0];
    const workStatus = line[1];
    const file = line.slice(3);

    if (indexStatus === "?" && workStatus === "?") {
      untracked.push(file);
    } else if (indexStatus === "U" || workStatus === "U" || (indexStatus === "A" && workStatus === "A")) {
      conflicted.push(file);
    } else if (indexStatus !== " " && indexStatus !== "?") {
      staged.push(file);
    } else if (workStatus !== " " && workStatus !== "?") {
      modified.push(file);
    }
  }

  // Get ahead/behind
  let ahead = 0;
  let behind = 0;
  try {
    const ab = await gitCommand("rev-list --left-right --count @{upstream}...HEAD 2>/dev/null || echo '0 0'", cwd);
    const parts = ab.trim().split(/\s+/);
    behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
  } catch {
    // No upstream set
  }

  return { branch: branch.trim(), ahead, behind, staged, modified, untracked, conflicted };
}

export async function gitDiff(cwd?: string, file?: string, staged?: boolean): Promise<string> {
  const args = ["diff"];
  if (staged) args.push("--cached");
  if (file) args.push("--", file);
  log.toolCall("git_diff", { file, staged });
  return gitCommand(args.join(" "), cwd);
}

export async function gitLog(cwd?: string, count: number = 10, file?: string): Promise<string> {
  const args = [`log --oneline -${count}`];
  if (file) args.push(`-- "${file}"`);
  log.toolCall("git_log", { count, file });
  return gitCommand(args.join(" "), cwd);
}

export async function gitCommit(message: string, cwd?: string, files?: string[]): Promise<string> {
  if (files && files.length > 0) {
    const fileList = files.map((f) => `"${f}"`).join(" ");
    await gitCommand(`add ${fileList}`, cwd);
  }
  log.toolCall("git_commit", { message, files });
  const escapedMessage = message.replaceAll('"', String.raw`\"`);
  return gitCommand(`commit -m "${escapedMessage}"`, cwd);
}

export async function gitBlame(filePath: string, cwd?: string, startLine?: number, endLine?: number): Promise<string> {
  let args = `blame -L ${startLine ?? 1},${endLine ?? "99999"} "${filePath}"`;
  log.toolCall("git_blame", { filePath, startLine, endLine });
  return gitCommand(args, cwd);
}

export async function gitShow(commitHash: string, cwd?: string): Promise<string> {
  log.toolCall("git_show", { commitHash });
  return gitCommand(`show ${commitHash}`, cwd);
}

export async function gitBranch(cwd?: string): Promise<string> {
  log.toolCall("git_branch", {});
  return gitCommand("branch -a", cwd);
}

export async function gitStash(cwd?: string, message?: string): Promise<string> {
  const escapedQuote = String.raw`\"`;
  const args = message ? `stash push -m "${message.replaceAll('"', escapedQuote)}"` : "stash push";
  log.toolCall("git_stash", { message });
  return gitCommand(args, cwd);
}

export async function gitStashPop(cwd?: string): Promise<string> {
  log.toolCall("git_stash_pop", {});
  return gitCommand("stash pop", cwd);
}

export async function gitCheckout(branch: string, cwd?: string): Promise<string> {
  log.toolCall("git_checkout", { branch });
  return gitCommand(`checkout "${branch}"`, cwd);
}

export async function gitPull(cwd?: string): Promise<string> {
  log.toolCall("git_pull", {});
  return gitCommand("pull --ff-only", cwd);
}

export async function gitPush(cwd?: string, remote: string = "origin", branch?: string): Promise<string> {
  const args = branch ? `push ${remote} ${branch}` : `push ${remote}`;
  log.toolCall("git_push", { remote, branch });
  return gitCommand(args, cwd);
}

async function gitCommand(args: string, cwd?: string): Promise<string> {
  const result = await runShell({ command: `git ${args}`, cwd });
  if (result.exitCode !== 0 && result.stderr) {
    return `[GIT ERROR] ${result.stderr}`;
  }
  return result.stdout.trim();
}
