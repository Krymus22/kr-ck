/**
 * failureMemory.test.ts - Tests for the failure memory system.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

describe("failureMemory", () => {
  beforeEach(async () => {
    const { clearFailures } = await import("./../failureMemory.js");
    clearFailures();
  });

  describe("recordFailure", () => {
    it("should store a failure", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("aplicar_diff", "SEARCH not found", "/test/file.ts");
      const failures = getFailures();
      expect(failures.length).toBe(1);
      expect(failures[0]!.tool).toBe("aplicar_diff");
      expect(failures[0]!.error).toBe("SEARCH not found");
      expect(failures[0]!.filePath).toBe("/test/file.ts");
    });

    it("should keep only last 5 failures", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      for (let i = 0; i < 7; i++) {
        recordFailure("tool", `error ${i}`);
      }
      const failures = getFailures();
      expect(failures.length).toBe(5);
      // Should keep the LAST 5 (errors 2-6)
      expect(failures[0]!.error).toBe("error 2");
      expect(failures[4]!.error).toBe("error 6");
    });

    it("should truncate long error messages to 200 chars", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      const longError = "x".repeat(500);
      recordFailure("tool", longError);
      expect(getFailures()[0]!.error.length).toBe(200);
    });

    it("should handle missing filePath", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("executar_comando", "Command failed");
      expect(getFailures()[0]!.filePath).toBeUndefined();
    });
  });

  describe("getRecentFailures", () => {
    it("should return empty string when no failures", async () => {
      const { getRecentFailures } = await import("./../failureMemory.js");
      expect(getRecentFailures()).toBe("");
    });

    it("should return formatted string with failures", async () => {
      const { recordFailure, getRecentFailures } = await import("./../failureMemory.js");
      recordFailure("aplicar_diff", "SEARCH not found", "/test/file.ts");
      recordFailure("editar_arquivo", "File not found", "/test/file.luau");

      const result = getRecentFailures();
      expect(result).toContain("[FAILURES]");
      expect(result).toContain("aplicar_diff");
      expect(result).toContain("SEARCH not found");
      expect(result).toContain("editar_arquivo");
      expect(result).toContain("File not found");
    });

    it("should include file basename and time", async () => {
      const { recordFailure, getRecentFailures } = await import("./../failureMemory.js");
      recordFailure("aplicar_diff", "error", "/project/src/Service.luau");
      const result = getRecentFailures();
      expect(result).toContain("Service.luau");
      // Should include time indicator ("ago" for >1min, "just now" for <1min)
      expect(result.match(/ago|just now/)).not.toBeNull();
    });

    it("should truncate error to first line and 80 chars", async () => {
      const { recordFailure, getRecentFailures } = await import("./../failureMemory.js");
      recordFailure("tool", "first line\nsecond line\nthird line");
      const result = getRecentFailures();
      expect(result).toContain("first line");
      expect(result).not.toContain("second line");
    });
  });

  describe("hasRecentFailures", () => {
    it("should return false when no failures", async () => {
      const { hasRecentFailures } = await import("./../failureMemory.js");
      expect(hasRecentFailures()).toBe(false);
    });

    it("should return true when failures exist", async () => {
      const { recordFailure, hasRecentFailures } = await import("./../failureMemory.js");
      recordFailure("tool", "error");
      expect(hasRecentFailures()).toBe(true);
    });
  });

  describe("getMostRecentFailure", () => {
    it("should return null when no failures", async () => {
      const { getMostRecentFailure } = await import("./../failureMemory.js");
      expect(getMostRecentFailure()).toBeNull();
    });

    it("should return the most recent failure", async () => {
      const { recordFailure, getMostRecentFailure } = await import("./../failureMemory.js");
      recordFailure("tool1", "error1");
      recordFailure("tool2", "error2");
      const recent = getMostRecentFailure();
      expect(recent).not.toBeNull();
      expect(recent!.tool).toBe("tool2");
      expect(recent!.error).toBe("error2");
    });
  });

  describe("clearFailures", () => {
    it("should clear all failures", async () => {
      const { recordFailure, clearFailures, getFailures } = await import("./../failureMemory.js");
      recordFailure("tool", "error");
      recordFailure("tool", "error2");
      clearFailures();
      expect(getFailures().length).toBe(0);
    });
  });
});
