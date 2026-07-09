/**
 * selfValidation.test.ts — Tests for IDEIA 2 (self-validation before finish).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../history.js", () => ({
  addSystemMessage: vi.fn(),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn().mockReturnValue("medium"),
}));

import { shouldSelfValidate, injectSelfValidationPrompt, resetSelfValidation } from "../selfValidation.js";
import * as history from "../history.js";
import { getEffortLevel } from "../effortLevels.js";

const mockedAddSystem = history.addSystemMessage as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSelfValidation();
  mockedAddSystem.mockReset();
  mockedGetEffort.mockReturnValue("medium");
});

describe("selfValidation", () => {
  describe("shouldSelfValidate", () => {
    it("returns false when no files were touched", () => {
      expect(shouldSelfValidate(0)).toBe(false);
    });

    it("returns true when files were touched AND effort is medium+", () => {
      mockedGetEffort.mockReturnValue("medium");
      expect(shouldSelfValidate(3)).toBe(true);
      mockedGetEffort.mockReturnValue("high");
      expect(shouldSelfValidate(3)).toBe(true);
      mockedGetEffort.mockReturnValue("max");
      expect(shouldSelfValidate(3)).toBe(true);
    });

    it("returns false when effort is low", () => {
      mockedGetEffort.mockReturnValue("low");
      expect(shouldSelfValidate(3)).toBe(false);
    });

    it("returns true only once per turn (throttle)", () => {
      mockedGetEffort.mockReturnValue("medium");
      expect(shouldSelfValidate(3)).toBe(true);
      // After injectSelfValidationPrompt is called, should be blocked
      injectSelfValidationPrompt(["file1.ts"]);
      expect(shouldSelfValidate(3)).toBe(false);
    });
  });

  describe("injectSelfValidationPrompt", () => {
    it("injects a system message with the 4 mandatory questions", () => {
      const result = injectSelfValidationPrompt(["foo.ts", "bar.ts"]);
      expect(mockedAddSystem).toHaveBeenCalledTimes(1);
      expect(result).toContain("MANDATORY SELF-VALIDATION");
      expect(result).toContain("WHAT CHANGED");
      expect(result).toContain("VERIFICATION");
      expect(result).toContain("REMAINING ERRORS");
      expect(result).toContain("EDGE CASES");
    });

    it("lists touched files in the prompt", () => {
      const result = injectSelfValidationPrompt(["foo.ts", "bar.ts", "baz.ts"]);
      expect(result).toContain("foo.ts");
      expect(result).toContain("bar.ts");
      expect(result).toContain("baz.ts");
    });

    it("truncates file list when more than 5 files", () => {
      const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
      const result = injectSelfValidationPrompt(files);
      expect(result).toContain("a.ts");
      expect(result).toContain("e.ts");
      expect(result).toContain("and 2 more");
      // Should NOT list f.ts and g.ts explicitly
      expect(result).not.toMatch(/  - f\.ts\n/);
    });

    it("instructs the model to use pensar() for the validation", () => {
      const result = injectSelfValidationPrompt(["foo.ts"]);
      expect(result).toContain("pensar()");
    });

    it("instructs to fix issues if found during validation", () => {
      const result = injectSelfValidationPrompt(["foo.ts"]);
      expect(result).toContain("FIX");
    });
  });

  describe("resetSelfValidation", () => {
    it("allows validation again after reset", () => {
      mockedGetEffort.mockReturnValue("medium");
      expect(shouldSelfValidate(3)).toBe(true);
      injectSelfValidationPrompt(["foo.ts"]);
      expect(shouldSelfValidate(3)).toBe(false);
      resetSelfValidation();
      expect(shouldSelfValidate(3)).toBe(true);
    });
  });
});
