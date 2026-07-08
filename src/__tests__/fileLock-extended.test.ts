/**
 * fileLock-extended.test.ts — Extended tests for fileLock.ts
 *
 * Covers 30+ tests across:
 *   - tryAcquireLock (basic acquire, reject, re-entrant, expired TTL)
 *   - acquireLock (blocking: immediate, with-wait, timeout)
 *   - getLockHolder (when free, when held, when expired)
 *   - forceReleaseLock (when held, when not held)
 *   - listLocks (empty, with multiple locks, with expired)
 *   - getCurrentAgentId (default, env var)
 *   - clearAllLocks (resets state)
 *   - edge cases: very short TTL, multiple files, double-release
 *
 * Mocks logger; resets lock state between tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import {
  tryAcquireLock,
  acquireLock,
  getLockHolder,
  forceReleaseLock,
  listLocks,
  clearAllLocks,
  getCurrentAgentId,
} from "../fileLock.js";

describe("tryAcquireLock (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("returns a function when lock is free", () => {
    const release = tryAcquireLock("/test/file1.luau", "main");
    expect(release).not.toBeNull();
    expect(typeof release).toBe("function");
  });

  it("returns null when a different holder holds the lock", () => {
    tryAcquireLock("/test/file2.luau", "main");
    const release = tryAcquireLock("/test/file2.luau", "sub-1");
    expect(release).toBeNull();
  });

  it("BLOCKS same holder from re-acquiring while lock is held (Concurrency Audit Part 2 — Race #5)", () => {
    // FIX: previously this test asserted "re-entrant" behavior where the
    // same holderId could re-acquire its own lock and get a no-op release.
    // That was unsafe (see fileLock.ts docstring for Race #5). Parallel
    // sub-agents sharing process.env.CLAUDE_KILLER_AGENT_ID would bypass
    // each other's locks. Now same-holderId re-acquire returns null.
    const r1 = tryAcquireLock("/test/file3.luau", "main");
    const r2 = tryAcquireLock("/test/file3.luau", "main");
    expect(r1).not.toBeNull();
    expect(r2).toBeNull(); // blocked — same holderId cannot re-acquire
    r1!();
  });

  it("same holder can re-acquire only AFTER releasing (no re-entrant shortcut)", () => {
    const r1 = tryAcquireLock("/test/file4.luau", "main");
    expect(r1).not.toBeNull();
    // While held: blocked
    expect(tryAcquireLock("/test/file4.luau", "main")).toBeNull();
    // After release: can re-acquire
    r1!();
    const r2 = tryAcquireLock("/test/file4.luau", "main");
    expect(r2).not.toBeNull();
    r2!();
  });

  it("calling the release function makes the lock available", () => {
    const r1 = tryAcquireLock("/test/file5.luau", "main");
    r1!();
    const r2 = tryAcquireLock("/test/file5.luau", "sub-1");
    expect(r2).not.toBeNull();
  });

  it("calling release twice is a no-op", () => {
    const r1 = tryAcquireLock("/test/file6.luau", "main");
    r1!();
    expect(() => r1!()).not.toThrow();
    expect(getLockHolder("/test/file6.luau")).toBeNull();
  });

  it("supports custom TTL", () => {
    const r1 = tryAcquireLock("/test/file7.luau", "main", 5000);
    expect(r1).not.toBeNull();
    const holder = getLockHolder("/test/file7.luau");
    expect(holder).not.toBeNull();
  });

  it("allows stealing an expired lock", async () => {
    const r1 = tryAcquireLock("/test/file8.luau", "main", 1);
    expect(r1).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const r2 = tryAcquireLock("/test/file8.luau", "sub-1");
    expect(r2).not.toBeNull();
    const holder = getLockHolder("/test/file8.luau");
    expect(holder!.holderId).toBe("sub-1");
  });

  it("handles different file paths independently", () => {
    const r1 = tryAcquireLock("/test/fileA.luau", "main");
    const r2 = tryAcquireLock("/test/fileB.luau", "main");
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
  });

  it("does not affect other locks when releasing one", () => {
    const r1 = tryAcquireLock("/test/fileC.luau", "main");
    const r2 = tryAcquireLock("/test/fileD.luau", "main");
    r1!();
    expect(getLockHolder("/test/fileC.luau")).toBeNull();
    expect(getLockHolder("/test/fileD.luau")).not.toBeNull();
    r2!();
  });
});

describe("acquireLock (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("acquires immediately when lock is free", async () => {
    const release = await acquireLock("/test/async1.luau", "main", 30_000, 5000);
    expect(typeof release).toBe("function");
    expect(getLockHolder("/test/async1.luau")!.holderId).toBe("main");
    release();
  });

  it("acquires after the previous holder releases", async () => {
    const r1 = tryAcquireLock("/test/async2.luau", "main");
    const acquirePromise = acquireLock("/test/async2.luau", "sub-1", 30_000, 5000);
    setTimeout(() => r1!(), 100);
    const r2 = await acquirePromise;
    expect(typeof r2).toBe("function");
    r2();
  });

  it("throws on timeout", async () => {
    tryAcquireLock("/test/async3.luau", "main");
    await expect(
      acquireLock("/test/async3.luau", "sub-1", 30_000, 200)
    ).rejects.toThrow(/Timeout acquiring lock/);
  });

  it("timeout error message includes holder info", async () => {
    tryAcquireLock("/test/async4.luau", "main");
    try {
      await acquireLock("/test/async4.luau", "sub-1", 30_000, 200);
      fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("main");
      expect((err as Error).message).toContain("/test/async4.luau");
    }
  });

  it("uses default TTL when not specified", async () => {
    const release = await acquireLock("/test/async5.luau", "main", undefined as any, 5000);
    expect(typeof release).toBe("function");
    release();
  });

  it("uses default timeout when not specified", async () => {
    const release = await acquireLock("/test/async6.luau", "main", 30_000);
    expect(typeof release).toBe("function");
    release();
  });

  it("can be awaited in parallel for different files", async () => {
    const p1 = acquireLock("/test/parallel1.luau", "main", 30_000, 5000);
    const p2 = acquireLock("/test/parallel2.luau", "main", 30_000, 5000);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(typeof r1).toBe("function");
    expect(typeof r2).toBe("function");
    r1();
    r2();
  });
});

describe("getLockHolder (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
  });

  afterEach(() => {
    clearAllLocks();
  });

  it("returns null when no lock held", () => {
    expect(getLockHolder("/test/unheld.luau")).toBeNull();
  });

  it("returns holder info when lock is held", () => {
    tryAcquireLock("/test/held.luau", "main");
    const holder = getLockHolder("/test/held.luau");
    expect(holder).not.toBeNull();
    expect(holder!.holderId).toBe("main");
  });

  it("returns acquiredAt as a positive number", () => {
    tryAcquireLock("/test/held2.luau", "main");
    const holder = getLockHolder("/test/held2.luau");
    expect(holder!.acquiredAt).toBeGreaterThan(0);
  });

  it("returns ageMs as non-negative", () => {
    tryAcquireLock("/test/held3.luau", "main");
    const holder = getLockHolder("/test/held3.luau");
    expect(holder!.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("returns null for an expired lock", async () => {
    tryAcquireLock("/test/expiring.luau", "main", 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(getLockHolder("/test/expiring.luau")).toBeNull();
  });
});

describe("forceReleaseLock (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
  });

  afterEach(() => {
    clearAllLocks();
  });

  it("returns true when a lock was held", () => {
    tryAcquireLock("/test/force1.luau", "main");
    expect(forceReleaseLock("/test/force1.luau")).toBe(true);
  });

  it("returns false when no lock was held", () => {
    expect(forceReleaseLock("/test/unforced.luau")).toBe(false);
  });

  it("makes the lock available to other holders", () => {
    tryAcquireLock("/test/force2.luau", "main");
    forceReleaseLock("/test/force2.luau");
    const r = tryAcquireLock("/test/force2.luau", "sub-1");
    expect(r).not.toBeNull();
  });

  it("does not affect other locks", () => {
    tryAcquireLock("/test/force3.luau", "main");
    tryAcquireLock("/test/force4.luau", "main");
    forceReleaseLock("/test/force3.luau");
    expect(getLockHolder("/test/force4.luau")).not.toBeNull();
  });
});

describe("listLocks (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
  });

  afterEach(() => {
    clearAllLocks();
  });

  it("returns empty array when no locks held", () => {
    expect(listLocks()).toEqual([]);
  });

  it("returns one entry for a single held lock", () => {
    tryAcquireLock("/test/list1.luau", "main");
    const locks = listLocks();
    expect(locks.length).toBe(1);
    expect(locks[0].filePath).toBe("/test/list1.luau");
    expect(locks[0].holderId).toBe("main");
  });

  it("returns multiple entries for multiple held locks", () => {
    tryAcquireLock("/test/list2.luau", "main");
    tryAcquireLock("/test/list3.luau", "sub-1");
    tryAcquireLock("/test/list4.luau", "sub-2");
    const locks = listLocks();
    expect(locks.length).toBe(3);
  });

  it("each entry has all required fields", () => {
    tryAcquireLock("/test/list5.luau", "main");
    const locks = listLocks();
    expect(locks[0]).toHaveProperty("filePath");
    expect(locks[0]).toHaveProperty("holderId");
    expect(locks[0]).toHaveProperty("ageMs");
    expect(locks[0]).toHaveProperty("expiresMs");
    expect(typeof locks[0].filePath).toBe("string");
    expect(typeof locks[0].holderId).toBe("string");
    expect(typeof locks[0].ageMs).toBe("number");
    expect(typeof locks[0].expiresMs).toBe("number");
  });

  it("ageMs is non-negative", () => {
    tryAcquireLock("/test/list6.luau", "main");
    expect(listLocks()[0].ageMs).toBeGreaterThanOrEqual(0);
  });

  it("expiresMs is non-negative", () => {
    tryAcquireLock("/test/list7.luau", "main");
    expect(listLocks()[0].expiresMs).toBeGreaterThanOrEqual(0);
  });

  it("does not include expired locks", async () => {
    tryAcquireLock("/test/list8.luau", "main", 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(listLocks().length).toBe(0);
  });

  it("updates after releasing a lock", () => {
    const r = tryAcquireLock("/test/list9.luau", "main");
    expect(listLocks().length).toBe(1);
    r!();
    expect(listLocks().length).toBe(0);
  });
});

describe("getCurrentAgentId (extended)", () => {
  beforeEach(() => {
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("returns 'main' when env var not set", () => {
    expect(getCurrentAgentId()).toBe("main");
  });

  it("returns the env var value when set", () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-agent-42";
    expect(getCurrentAgentId()).toBe("sub-agent-42");
  });

  it("returns 'main' after env var is deleted", () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-1";
    delete process.env.CLAUDE_KILLER_AGENT_ID;
    expect(getCurrentAgentId()).toBe("main");
  });

  it("returns the latest value when env var changes", () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-1";
    expect(getCurrentAgentId()).toBe("sub-1");
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-2";
    expect(getCurrentAgentId()).toBe("sub-2");
  });

  it("returns empty string when env var is empty", () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "";
    expect(getCurrentAgentId()).toBe("");
  });
});

describe("clearAllLocks (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
  });

  afterEach(() => {
    clearAllLocks();
  });

  it("does not throw when called with no locks", () => {
    expect(() => clearAllLocks()).not.toThrow();
  });

  it("clears all held locks", () => {
    tryAcquireLock("/test/clear1.luau", "main");
    tryAcquireLock("/test/clear2.luau", "main");
    tryAcquireLock("/test/clear3.luau", "main");
    clearAllLocks();
    expect(listLocks().length).toBe(0);
  });

  it("makes all locks available again after clearing", () => {
    tryAcquireLock("/test/clear4.luau", "main");
    clearAllLocks();
    const r = tryAcquireLock("/test/clear4.luau", "sub-1");
    expect(r).not.toBeNull();
  });

  it("can be called multiple times", () => {
    expect(() => {
      clearAllLocks();
      clearAllLocks();
      clearAllLocks();
    }).not.toThrow();
  });
});

describe("fileLock edge cases (extended)", () => {
  beforeEach(() => {
    clearAllLocks();
  });

  afterEach(() => {
    clearAllLocks();
  });

  it("handles very short TTL (1ms)", async () => {
    const r = tryAcquireLock("/test/short-ttl.luau", "main", 1);
    expect(r).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Lock should be expired (stealable)
    const r2 = tryAcquireLock("/test/short-ttl.luau", "sub-1");
    expect(r2).not.toBeNull();
  });

  it("handles very long TTL (1 hour)", () => {
    const r = tryAcquireLock("/test/long-ttl.luau", "main", 3_600_000);
    expect(r).not.toBeNull();
    expect(getLockHolder("/test/long-ttl.luau")).not.toBeNull();
  });

  it("handles many concurrent locks (10+)", () => {
    const releases: (() => void) | null[] = [];
    for (let i = 0; i < 15; i++) {
      releases.push(tryAcquireLock(`/test/many-${i}.luau`, "main"));
    }
    expect(listLocks().length).toBe(15);
    for (const r of releases) r!();
    expect(listLocks().length).toBe(0);
  });

  it("handles empty string as filePath", () => {
    const r = tryAcquireLock("", "main");
    expect(r).not.toBeNull();
    r!();
  });

  it("handles empty string as holderId", () => {
    const r = tryAcquireLock("/test/empty-holder.luau", "");
    expect(r).not.toBeNull();
    const holder = getLockHolder("/test/empty-holder.luau");
    expect(holder!.holderId).toBe("");
    r!();
  });

  it("release function from same-holderId re-acquire attempt is null (no no-op release to call)", () => {
    // Concurrency Audit Part 2 — Race #5:
    // Previously, a same-holderId re-acquire returned a no-op release
    // function. Now it returns null (blocked), so there's nothing to call.
    // The original holder's release function (r1) is the only one that
    // can free the lock.
    const r1 = tryAcquireLock("/test/reentrant.luau", "main");
    const r2 = tryAcquireLock("/test/reentrant.luau", "main");
    expect(r2).toBeNull(); // blocked — no no-op release to call
    // Lock still held by r1
    expect(getLockHolder("/test/reentrant.luau")).not.toBeNull();
    r1!();
    expect(getLockHolder("/test/reentrant.luau")).toBeNull();
  });

  it("lock acquired with tryAcquireLock is visible to listLocks immediately", () => {
    tryAcquireLock("/test/immediate.luau", "main");
    const locks = listLocks();
    expect(locks.some((l) => l.filePath === "/test/immediate.luau")).toBe(true);
  });

  it("multiple holders can hold locks on different files concurrently", () => {
    const r1 = tryAcquireLock("/test/concurrent1.luau", "main");
    const r2 = tryAcquireLock("/test/concurrent2.luau", "sub-1");
    const r3 = tryAcquireLock("/test/concurrent3.luau", "sub-2");
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).not.toBeNull();
    expect(listLocks().length).toBe(3);
  });
});
