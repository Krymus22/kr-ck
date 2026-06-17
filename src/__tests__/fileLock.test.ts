/**
 * fileLock.test.ts - Tests for the per-file mutex used by sub-agents and main agent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("fileLock", () => {
  beforeEach(async () => {
    const { clearAllLocks } = await import("./../fileLock.js");
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(async () => {
    const { clearAllLocks } = await import("./../fileLock.js");
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  describe("tryAcquireLock", () => {
    it("should acquire a lock that is free", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      const release = tryAcquireLock("/test/file.luau", "main");
      expect(release).not.toBeNull();
      expect(typeof release).toBe("function");

      const holder = getLockHolder("/test/file.luau");
      expect(holder).not.toBeNull();
      expect(holder!.holderId).toBe("main");
    });

    it("should reject if a different holder tries to acquire", async () => {
      const { tryAcquireLock } = await import("./../fileLock.js");
      const release1 = tryAcquireLock("/test/file.luau", "main");
      expect(release1).not.toBeNull();

      const release2 = tryAcquireLock("/test/file.luau", "sub-1");
      expect(release2).toBeNull();
    });

    it("should allow same holder to re-acquire (re-entrant)", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      const release1 = tryAcquireLock("/test/file.luau", "main");
      expect(release1).not.toBeNull();

      // Same holder can re-acquire (extends TTL)
      const release2 = tryAcquireLock("/test/file.luau", "main");
      expect(release2).not.toBeNull();

      // Lock is still held by main
      const holder = getLockHolder("/test/file.luau");
      expect(holder!.holderId).toBe("main");
    });

    it("should release the lock when release function is called", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      const release = tryAcquireLock("/test/file.luau", "main");
      expect(getLockHolder("/test/file.luau")).not.toBeNull();

      release!();
      expect(getLockHolder("/test/file.luau")).toBeNull();
    });

    it("should allow another holder to acquire after release", async () => {
      const { tryAcquireLock } = await import("./../fileLock.js");
      const release1 = tryAcquireLock("/test/file.luau", "main");
      release1!();

      const release2 = tryAcquireLock("/test/file.luau", "sub-1");
      expect(release2).not.toBeNull();
    });

    it("should not release on second call to release function", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      const release = tryAcquireLock("/test/file.luau", "main");
      release!();
      release!();  // should be no-op

      expect(getLockHolder("/test/file.luau")).toBeNull();
    });
  });

  describe("acquireLock (blocking)", () => {
    it("should acquire immediately if lock is free", async () => {
      const { acquireLock, getLockHolder } = await import("./../fileLock.js");
      const release = await acquireLock("/test/file.luau", "main", 30_000, 5000);
      expect(typeof release).toBe("function");
      expect(getLockHolder("/test/file.luau")!.holderId).toBe("main");
      release();
    });

    it("should wait and acquire when lock is released by another holder", async () => {
      const { acquireLock, tryAcquireLock } = await import("./../fileLock.js");
      // main holds the lock
      const release1 = tryAcquireLock("/test/file.luau", "main");
      expect(release1).not.toBeNull();

      // sub-1 tries to acquire (will wait)
      const acquirePromise = acquireLock("/test/file.luau", "sub-1", 30_000, 5000);

      // Release after 200ms
      setTimeout(() => release1!(), 200);

      const release2 = await acquirePromise;
      expect(typeof release2).toBe("function");
      release2();
    });

    it("should throw on timeout if lock never released", async () => {
      const { acquireLock, tryAcquireLock } = await import("./../fileLock.js");
      // main holds the lock
      const release1 = tryAcquireLock("/test/file.luau", "main");

      // sub-1 tries with short timeout
      await expect(
        acquireLock("/test/file.luau", "sub-1", 30_000, 500)
      ).rejects.toThrow(/Timeout acquiring lock/);

      release1!();
    });
  });

  describe("getLockHolder", () => {
    it("should return null when no lock held", async () => {
      const { getLockHolder } = await import("./../fileLock.js");
      expect(getLockHolder("/test/file.luau")).toBeNull();
    });

    it("should return holder info when lock is held", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      tryAcquireLock("/test/file.luau", "sub-2");

      const holder = getLockHolder("/test/file.luau");
      expect(holder).not.toBeNull();
      expect(holder!.holderId).toBe("sub-2");
      expect(holder!.acquiredAt).toBeGreaterThan(0);
      expect(holder!.ageMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("forceReleaseLock", () => {
    it("should release a lock regardless of holder", async () => {
      const { tryAcquireLock, forceReleaseLock, getLockHolder } = await import("./../fileLock.js");
      tryAcquireLock("/test/file.luau", "main");

      const released = forceReleaseLock("/test/file.luau");
      expect(released).toBe(true);
      expect(getLockHolder("/test/file.luau")).toBeNull();
    });

    it("should return false when no lock exists", async () => {
      const { forceReleaseLock } = await import("./../fileLock.js");
      const released = forceReleaseLock("/nonexistent/file.luau");
      expect(released).toBe(false);
    });
  });

  describe("listLocks", () => {
    it("should return empty array when no locks held", async () => {
      const { listLocks } = await import("./../fileLock.js");
      expect(listLocks()).toEqual([]);
    });

    it("should list all currently held locks", async () => {
      const { tryAcquireLock, listLocks } = await import("./../fileLock.js");
      tryAcquireLock("/test/file1.luau", "main");
      tryAcquireLock("/test/file2.luau", "sub-1");

      const locks = listLocks();
      expect(locks.length).toBe(2);
      expect(locks.some((l) => l.filePath === "/test/file1.luau" && l.holderId === "main")).toBe(true);
      expect(locks.some((l) => l.filePath === "/test/file2.luau" && l.holderId === "sub-1")).toBe(true);
    });
  });

  describe("getCurrentAgentId", () => {
    it("should return 'main' when no env var set", async () => {
      const { getCurrentAgentId } = await import("./../fileLock.js");
      delete process.env.CLAUDE_KILLER_AGENT_ID;
      expect(getCurrentAgentId()).toBe("main");
    });

    it("should return the env var value when set", async () => {
      const { getCurrentAgentId } = await import("./../fileLock.js");
      process.env.CLAUDE_KILLER_AGENT_ID = "sub-3";
      expect(getCurrentAgentId()).toBe("sub-3");
    });
  });

  describe("TTL expiration", () => {
    it("should let a stale lock be stolen by another holder", async () => {
      const { tryAcquireLock, getLockHolder } = await import("./../fileLock.js");
      // Acquire with very short TTL (1ms)
      const release1 = tryAcquireLock("/test/file.luau", "main", 1);
      expect(release1).not.toBeNull();

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 50));

      // sub-1 should be able to steal the expired lock
      const release2 = tryAcquireLock("/test/file.luau", "sub-1");
      expect(release2).not.toBeNull();

      const holder = getLockHolder("/test/file.luau");
      expect(holder!.holderId).toBe("sub-1");
    });
  });
});
