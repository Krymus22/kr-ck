/**
 * selfValidation-extended.test.ts — Extended tests for selfValidation.ts
 *
 * Covers:
 *   - shouldSelfValidate: 0 files, >0 files, low/medium/high/max effort, throttle
 *   - injectSelfValidationPrompt: returns a non-empty prompt; lists files; truncates >5
 *   - injectSelfValidationPrompt: calls history.addSystemMessage exactly once
 *   - resetSelfValidation: counter behavior
 *   - Type contracts and edge cases
 *
 * Mocks: logger, history.addSystemMessage, effortLevels.getEffortLevel, i18n.t
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
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

import {
  shouldSelfValidate,
  injectSelfValidationPrompt,
  resetSelfValidation,
} from "../selfValidation.js";
import * as history from "../history.js";
import { getEffortLevel } from "../effortLevels.js";

const mockedAddSystem = history.addSystemMessage as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSelfValidation();
  mockedAddSystem.mockReset();
  mockedGetEffort.mockReturnValue("medium");
});

describe("shouldSelfValidate — basic conditions", () => {
  it("returns false when touchedFilesCount is 0", () => {
    expect(shouldSelfValidate(0)).toBe(false);
  });

  it("returns true when touchedFilesCount > 0 and effort=medium", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(shouldSelfValidate(1)).toBe(true);
    expect(shouldSelfValidate(5)).toBe(true);
  });

  it("returns true when effort=high", () => {
    mockedGetEffort.mockReturnValue("high");
    expect(shouldSelfValidate(1)).toBe(true);
  });

  it("returns true when effort=max", () => {
    mockedGetEffort.mockReturnValue("max");
    expect(shouldSelfValidate(1)).toBe(true);
  });

  it("returns false when effort=low (user opted for speed)", () => {
    mockedGetEffort.mockReturnValue("low");
    expect(shouldSelfValidate(1)).toBe(false);
    expect(shouldSelfValidate(100)).toBe(false);
  });
});

describe("shouldSelfValidate — throttle (max 1 per turn)", () => {
  it("returns true the first time, false after injectSelfValidationPrompt", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(shouldSelfValidate(2)).toBe(true);
    injectSelfValidationPrompt(["f.ts"]);
    expect(shouldSelfValidate(2)).toBe(false);
  });

  it("after resetSelfValidation, can self-validate again", () => {
    mockedGetEffort.mockReturnValue("medium");
    injectSelfValidationPrompt(["f.ts"]);
    expect(shouldSelfValidate(2)).toBe(false);
    resetSelfValidation();
    expect(shouldSelfValidate(2)).toBe(true);
  });

  it("does not block self-validation when 0 files (regardless of prior injection)", () => {
    mockedGetEffort.mockReturnValue("medium");
    injectSelfValidationPrompt(["f.ts"]);
    // 0 files → never validate
    expect(shouldSelfValidate(0)).toBe(false);
  });
});

describe("shouldSelfValidate — large touched counts", () => {
  it("handles a very large touchedFilesCount without crashing", () => {
    mockedGetEffort.mockReturnValue("high");
    expect(shouldSelfValidate(1_000_000)).toBe(true);
  });
});

describe("injectSelfValidationPrompt — return value", () => {
  it("returns a non-empty string", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("calls history.addSystemMessage exactly once with the prompt", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(mockedAddSystem).toHaveBeenCalledTimes(1);
    expect(mockedAddSystem).toHaveBeenCalledWith(prompt);
  });

  it("includes a header marker (SELF-VALIDATION or SELF_VALIDATION)", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    // English mode active in tests; either [MANDATORY SELF-VALIDATION] or similar
    expect(prompt).toMatch(/SELF.VALIDATION/i);
  });

  it("includes the touched file paths in the prompt", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts", "bar.ts", "baz.ts"]);
    expect(prompt).toContain("foo.ts");
    expect(prompt).toContain("bar.ts");
    expect(prompt).toContain("baz.ts");
  });

  it("truncates file list when more than 5 files are passed", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const prompt = injectSelfValidationPrompt(files);
    // First 5 should be present
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("e.ts");
    // Should mention "and N more"
    expect(prompt).toMatch(/and \d+ more/);
  });

  it("does NOT truncate when 5 or fewer files", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const prompt = injectSelfValidationPrompt(files);
    expect(prompt).not.toMatch(/and \d+ more/);
  });

  it("includes the mandatory questions", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(prompt).toMatch(/WHAT CHANGED|O QUE MUDOU/i);
    expect(prompt).toMatch(/VERIFICATION|VERIFICAÇÃO/i);
    expect(prompt).toMatch(/REMAINING ERRORS|ERROS RESTANTES/i);
    expect(prompt).toMatch(/EDGE CASES/i);
  });

  it("references pensar() tool", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(prompt).toContain("pensar()");
  });

  it("instructs the model to FIX issues if found", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(prompt).toMatch(/FIX/i);
  });
});

describe("injectSelfValidationPrompt — edge cases", () => {
  it("handles a single file", () => {
    const prompt = injectSelfValidationPrompt(["only.ts"]);
    expect(prompt).toContain("only.ts");
  });

  it("handles an empty file list (still returns a prompt)", () => {
    const prompt = injectSelfValidationPrompt([]);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("handles file paths with special characters", () => {
    const prompt = injectSelfValidationPrompt(["/tmp/my file (1).ts"]);
    expect(prompt).toContain("/tmp/my file (1).ts");
  });

  it("handles file paths with unicode", () => {
    const prompt = injectSelfValidationPrompt(["/tmp/日本語.lua"]);
    expect(prompt).toContain("/tmp/日本語.lua");
  });

  it("can be called multiple times in the same turn (each call injects)", () => {
    injectSelfValidationPrompt(["a.ts"]);
    injectSelfValidationPrompt(["b.ts"]);
    injectSelfValidationPrompt(["c.ts"]);
    expect(mockedAddSystem).toHaveBeenCalledTimes(3);
  });
});

describe("resetSelfValidation", () => {
  it("does not throw", () => {
    expect(() => resetSelfValidation()).not.toThrow();
  });

  it("can be called multiple times safely", () => {
    resetSelfValidation();
    resetSelfValidation();
    resetSelfValidation();
    expect(true).toBe(true);
  });

  it("allows shouldSelfValidate to return true again after injection", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(shouldSelfValidate(3)).toBe(true);
    injectSelfValidationPrompt(["x.ts"]);
    expect(shouldSelfValidate(3)).toBe(false);
    resetSelfValidation();
    expect(shouldSelfValidate(3)).toBe(true);
  });
});

describe("Integration: shouldSelfValidate + injectSelfValidationPrompt", () => {
  it("typical turn flow: validate → inject → cannot validate again", () => {
    mockedGetEffort.mockReturnValue("high");
    // Step 1: should validate (3 files touched)
    expect(shouldSelfValidate(3)).toBe(true);
    // Step 2: inject
    const prompt = injectSelfValidationPrompt(["a.ts", "b.ts", "c.ts"]);
    expect(mockedAddSystem).toHaveBeenCalledWith(prompt);
    // Step 3: cannot validate again
    expect(shouldSelfValidate(3)).toBe(false);
  });

  it("does not inject when shouldSelfValidate returns false (low effort)", () => {
    mockedGetEffort.mockReturnValue("low");
    expect(shouldSelfValidate(3)).toBe(false);
    // We can still call inject directly, but shouldSelfValidate would not have allowed it
    injectSelfValidationPrompt(["x.ts"]);
    expect(mockedAddSystem).toHaveBeenCalledTimes(1);
  });
});
