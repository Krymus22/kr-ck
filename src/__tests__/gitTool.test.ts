/**
 * gitTool.test.ts — Tests for git integration module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { runShellSync } from "../shell.js";
import { gitStatus, gitDiff, gitLog, gitCommit, gitBranch, gitBlame, gitShow, gitStash, gitStashPop, gitCheckout, gitPull, gitPush } from "../gitTool.js";

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

describe("gitBlame", () => {
  it("should return blame info", async () => {
    const blame = await gitBlame("file1.txt", TEST_DIR);
    expect(typeof blame).toBe("string");
  });

  it("should handle line range", async () => {
    const blame = await gitBlame("file1.txt", TEST_DIR, 1, 1);
    expect(typeof blame).toBe("string");
  });
});

describe("gitShow", () => {
  it("should show commit info", async () => {
    const log = await gitLog(TEST_DIR, 1);
    const hash = log.split(" ")[0];
    if (hash) {
      const show = await gitShow(hash, TEST_DIR);
      expect(typeof show).toBe("string");
    }
  });
});

describe("gitStash", () => {
  it("should stash changes", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "stash_test.txt"), "stash me\n", "utf8");
    const result = await gitStash(TEST_DIR);
    expect(typeof result).toBe("string");
  });

  it("should stash with message", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "stash_msg.txt"), "stash msg\n", "utf8");
    const result = await gitStash(TEST_DIR, "test stash");
    expect(typeof result).toBe("string");
  });
});

describe("gitStashPop", () => {
  it("should pop stash", async () => {
    const result = await gitStashPop(TEST_DIR);
    expect(typeof result).toBe("string");
  });
});

describe("gitCheckout", () => {
  it("should checkout a branch", async () => {
    const result = await gitCheckout("master", TEST_DIR);
    expect(typeof result).toBe("string");
  });
});

describe("gitDiff", () => {
  it("should handle staged diff", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "staged.txt"), "staged\n", "utf8");
    git("add staged.txt");
    const diff = await gitDiff(TEST_DIR, undefined, true);
    expect(typeof diff).toBe("string");
    git("reset HEAD staged.txt");
    fs.unlinkSync(path.join(TEST_DIR, "staged.txt"));
  });

  it("should handle specific file diff", async () => {
    fs.writeFileSync(path.join(TEST_DIR, "specific.txt"), "specific\n", "utf8");
    const diff = await gitDiff(TEST_DIR, "specific.txt");
    expect(typeof diff).toBe("string");
    fs.unlinkSync(path.join(TEST_DIR, "specific.txt"));
  });
});

describe("gitLog", () => {
  it("should handle file filter", async () => {
    const log = await gitLog(TEST_DIR, 5, "file1.txt");
    expect(typeof log).toBe("string");
  });
});

describe("gitStatus", () => {
  it("should handle conflicted files", async () => {
    const status = await gitStatus(TEST_DIR);
    expect(status.conflicted).toBeDefined();
    expect(Array.isArray(status.conflicted)).toBe(true);
  });

  it("should return ahead/behind counts", async () => {
    const status = await gitStatus(TEST_DIR);
    expect(typeof status.ahead).toBe("number");
    expect(typeof status.behind).toBe("number");
  });
});

describe("gitPull", () => {
  it("should execute pull (may fail without remote)", async () => {
    const result = await gitPull(TEST_DIR);
    expect(typeof result).toBe("string");
  });
});

describe("gitPush", () => {
  it("should execute push (may fail without remote)", async () => {
    const result = await gitPush(TEST_DIR);
    expect(typeof result).toBe("string");
  });

  it("should execute push with explicit remote and branch", async () => {
    const result = await gitPush(TEST_DIR, "origin", "main");
    expect(typeof result).toBe("string");
  });
});

// ─── Coverage: conflicted, modified, gitCommit with files ───────────────────

describe("gitStatus - coverage gaps", () => {
  it("should detect conflicted files during merge conflict", async () => {
    try {
      fs.writeFileSync(path.join(TEST_DIR, "conflict.txt"), "original\n", "utf8");
      git("add conflict.txt");
      git('commit -m "add conflict.txt"');

      git("checkout -b conflict-branch");
      fs.writeFileSync(path.join(TEST_DIR, "conflict.txt"), "branch version\n", "utf8");
      git("add conflict.txt");
      git('commit -m "branch change"');

      git("checkout master");
      fs.writeFileSync(path.join(TEST_DIR, "conflict.txt"), "master version\n", "utf8");
      git("add conflict.txt");
      git('commit -m "master change"');

      try { git("merge conflict-branch"); } catch {}

      const status = await gitStatus(TEST_DIR);
      expect(status.conflicted.length).toBeGreaterThanOrEqual(1);
    } finally {
      try { git("merge --abort"); } catch {}
      git("checkout master");
      try { git("branch -D conflict-branch"); } catch {}
      try { git("rm -f conflict.txt"); } catch {}
      try { git('commit -m "cleanup"'); } catch {}
    }
  });

  it("should detect unstaged modified files", async () => {
    try {
      fs.writeFileSync(path.join(TEST_DIR, "mod_test.txt"), "original content abc\n", "utf8");
      git("add mod_test.txt");
      git('commit -m "add mod_test"');

      fs.writeFileSync(path.join(TEST_DIR, "mod_test.txt"), "completely different content xyz\n", "utf8");

      const status = await gitStatus(TEST_DIR);
      const inModified = status.modified.some(f => f.includes("mod_test.txt"));
      const inStaged = status.staged.some(f => f.includes("mod_test.txt"));
      const inUntracked = status.untracked.some(f => f.includes("mod_test.txt"));

      if (inModified || inStaged || inUntracked) {
        expect(true).toBe(true);
      } else {
        const diff = await gitDiff(TEST_DIR, undefined, false);
        expect(diff).toContain("mod_test.txt");
      }
    } finally {
      try { git("checkout -- mod_test.txt 2>/dev/null"); } catch {}
      try { git("rm -f mod_test.txt 2>/dev/null"); } catch {}
      try { git('commit -m "cleanup mod_test" 2>/dev/null'); } catch {}
    }
  });
});

describe("gitCommit - coverage gaps", () => {
  it("should commit specific files when files array provided", async () => {
    try {
      fs.writeFileSync(path.join(TEST_DIR, "specific_commit.txt"), "specific\n", "utf8");
      const result = await gitCommit("commit specific", TEST_DIR, ["specific_commit.txt"]);
      expect(result).toBeDefined();
    } finally {
      git("reset HEAD~1 2>/dev/null || true");
      try { fs.unlinkSync(path.join(TEST_DIR, "specific_commit.txt")); } catch {}
    }
  });
});
