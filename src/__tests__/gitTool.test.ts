/**
 * gitTool.test.ts — Tests for git integration module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runShellSync } from "../shell.js";
import { gitStatus, gitDiff, gitLog, gitCommit, gitBranch } from "../gitTool.js";

const TEST_DIR = path.join(process.cwd(), "__test_gitdir__");

function git(args: string): string {
  return runShellSync({ command: `git ${args}`, cwd: TEST_DIR }).stdout.trim();
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  git("init");
  git("config user.email \"test@test.com\"");
  git("config user.name \"Test\"");
  fs.writeFileSync(path.join(TEST_DIR, "file1.txt"), "initial\n", "utf8");
  git("add .");
  git('commit -m "initial commit"');
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("gitStatus", () => {
  it("should return branch info", async () => {
    const status = await gitStatus(TEST_DIR);
    expect(status.branch).toBeDefined();
    expect(typeof status.branch).toBe("string");
  });

  it("should detect clean working tree", async () => {
    const status = await gitStatus(TEST_DIR);
    expect(status.modified.length).toBe(0);
    expect(status.untracked.length).toBe(0);
  });

  it("should detect modified files", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "file1.txt"), "modified\n", "utf8");
    const status = await gitStatus(TEST_DIR);
    // On some Windows setups the file may appear as staged or modified
    const hasChanges = status.modified.length > 0 || status.staged.length > 0;
    expect(hasChanges).toBe(true);
    // Reset
    git("checkout -- file1.txt");
  });

  it("should detect untracked files", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "new.txt"), "new\n", "utf8");
    const status = await gitStatus(TEST_DIR);
    expect(status.untracked.length).toBeGreaterThanOrEqual(1);
    fs.unlinkSync(path.join(TEST_DIR, "new.txt"));
  });
});

describe("gitDiff", () => {
  it("should show diff for modified files", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "file1.txt"), "changed\n", "utf8");
    const diff = await gitDiff(TEST_DIR);
    expect(diff).toContain("changed");
    git("checkout -- file1.txt");
  });
});

describe("gitLog", () => {
  it("should return commit history", async () => {
    const log = await gitLog(TEST_DIR, 5);
    expect(log).toContain("initial commit");
  });

  it("should respect count parameter", async () => {
    const log = await gitLog(TEST_DIR, 1);
    const lines = log.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(1);
  });
});

describe("gitCommit", () => {
  it("should create a commit", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "commit_test.txt"), "committed\n", "utf8");
    git("add commit_test.txt");
    const result = await gitCommit("test commit", TEST_DIR);
    expect(result).toBeDefined();
    // Clean up
    git("reset HEAD~1");
    fs.unlinkSync(path.join(TEST_DIR, "commit_test.txt"));
  });
});

describe("gitBranch", () => {
  it("should list branches", async () => {
    const branches = await gitBranch(TEST_DIR);
    expect(branches).toBeDefined();
    expect(typeof branches).toBe("string");
  });
});
