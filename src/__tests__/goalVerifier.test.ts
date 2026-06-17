/**
 * goalVerifier.test.ts - Tests for independent task completion verifier.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("./../apiClient.js", () => ({
  chat: vi.fn(),
}));

describe("goalVerifier", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("verifyGoalCompletion", () => {
    it("should return done=true when LLM says done", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [{ message: { content: '{"done": true, "missing": [], "reasoning": "All good"}' } }],
      });

      const result = await verifyGoalCompletion("fix the bug", ["src/fix.ts"], "I fixed the bug");
      expect(result.done).toBe(true);
      expect(result.missingItems).toEqual([]);
      expect(result.verified).toBe(true);
    });

    it("should return done=false with missing items", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [{ message: { content: '{"done": false, "missing": ["run tests", "fix edge case"], "reasoning": "Tests not run"}' } }],
      });

      const result = await verifyGoalCompletion("fix the bug and add tests", ["src/fix.ts"], "I fixed it");
      expect(result.done).toBe(false);
      expect(result.missingItems.length).toBe(2);
      expect(result.missingItems).toContain("run tests");
    });

    it("should handle LLM failure gracefully (return done=true)", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockRejectedValue(new Error("API down"));

      const result = await verifyGoalCompletion("task", ["file.ts"], "done");
      expect(result.done).toBe(true);
      expect(result.verified).toBe(false);
    });

    it("should handle non-JSON response with keyword fallback", async () => {
      const { verifyGoalCompletion } = await import("./../goalVerifier.js");
      const { chat } = await import("./../apiClient.js");
      (chat as any).mockResolvedValue({
        choices: [{ message: { content: "The task is NOT done because tests were not run." } }],
      });

      const result = await verifyGoalCompletion("task", ["f.ts"], "done");
      expect(result.done).toBe(false);
    });
  });

  describe("formatGoalVerification", () => {
    it("should format done=true as verified message", async () => {
      const { formatGoalVerification } = await import("./../goalVerifier.js");
      const msg = formatGoalVerification({ done: true, missingItems: [], reasoning: "ok", verified: true });
      expect(msg).toContain("GOAL VERIFIED");
    });

    it("should format done=false with missing items and blocking message", async () => {
      const { formatGoalVerification } = await import("./../goalVerifier.js");
      const msg = formatGoalVerification({
        done: false,
        missingItems: ["run tests", "fix lint"],
        reasoning: "Not complete",
        verified: true,
      });
      expect(msg).toContain("GOAL NOT VERIFIED");
      expect(msg).toContain("run tests");
      expect(msg).toContain("fix lint");
      expect(msg).toContain("NÃO finalize");
    });
  });
});
