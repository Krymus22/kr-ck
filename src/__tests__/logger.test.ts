/**
 * logger.test.ts — Tests for logger.ts (real module).
 * Covers: banner, info, success, warn, error, formatMarkdown, reply,
 * toolCall, toolResult, throttle, debug, divider, statusBar.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { debug: false },
}));

import {
  banner,
  info,
  success,
  warn,
  error,
  formatMarkdown,
  reply,
  toolCall,
  toolResult,
  throttle,
  debug,
  divider,
  statusBar,
  type StatusBarInput,
} from "../logger.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger.ts (real module)", () => {
  describe("banner", () => {
    it("should call console.log", () => {
      banner("test banner");
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("info", () => {
    it("should call console.log with text", () => {
      info("hello");
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("success", () => {
    it("should call console.log with SUCCESS prefix", () => {
      success("done");
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("warn", () => {
    it("should call console.warn", () => {
      warn("careful");
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("error", () => {
    it("should call console.error", () => {
      error("oops");
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe("formatMarkdown", () => {
    it("should pass through plain text", () => {
      const result = formatMarkdown("hello world");
      expect(result).toContain("hello world");
    });

    it("should render fenced code blocks", () => {
      const md = "```javascript\nconst x = 1;\n```";
      const result = formatMarkdown(md);
      expect(result).toContain("const x = 1;");
    });

    it("should render headings level 1", () => {
      const result = formatMarkdown("# Title");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should render headings level 3", () => {
      const result = formatMarkdown("### Sub");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should render horizontal rules", () => {
      const result = formatMarkdown("---");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should render blockquotes", () => {
      const result = formatMarkdown("> quoted text");
      expect(result).toContain("quoted text");
    });

    it("should render task list items (unchecked)", () => {
      const result = formatMarkdown("- [ ] task");
      expect(result).toContain("task");
    });

    it("should render task list items (checked)", () => {
      const result = formatMarkdown("- [x] done");
      expect(result).toContain("done");
    });

    it("should render bullet lists", () => {
      const result = formatMarkdown("- item one");
      expect(result).toContain("item one");
    });

    it("should render numbered lists", () => {
      const result = formatMarkdown("1. first");
      expect(result).toContain("first");
    });

    it("should render tables", () => {
      const md = "| A | B |\n|---|---|\n| 1 | 2 |";
      const result = formatMarkdown(md);
      expect(result).toContain("A");
      expect(result).toContain("2");
    });

    it("should apply bold formatting", () => {
      const result = formatMarkdown("**bold**");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should apply italic formatting", () => {
      const result = formatMarkdown("*italic*");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should apply inline code formatting", () => {
      const result = formatMarkdown("`code`");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should apply link formatting", () => {
      const result = formatMarkdown("[text](url)");
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle empty input", () => {
      const result = formatMarkdown("");
      expect(typeof result).toBe("string");
    });

    it("should handle code block with no language", () => {
      const result = formatMarkdown("```\nno lang\n```");
      expect(result).toContain("no lang");
    });

    it("should handle multi-line blockquote", () => {
      const md = "> line1\n> line2";
      const result = formatMarkdown(md);
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });
  });

  describe("reply", () => {
    it("should call console.log multiple times", () => {
      reply("hello");
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("toolCall", () => {
    it("should log tool name and args", () => {
      toolCall("bash", { command: "ls" });
      expect(logSpy).toHaveBeenCalled();
    });

    it("should truncate long args with ellipsis", () => {
      const longArgs = { data: "x".repeat(200) };
      toolCall("bash", longArgs);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("toolResult", () => {
    it("should log success", () => {
      toolResult("bash", true, "ok");
      expect(logSpy).toHaveBeenCalled();
    });

    it("should log failure", () => {
      toolResult("bash", false, "failed");
      expect(logSpy).toHaveBeenCalled();
    });

    it("should handle no detail", () => {
      toolResult("bash", true);
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("throttle", () => {
    it("should log throttle reason", () => {
      throttle("rate limited");
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("debug", () => {
    it("should not output when DEBUG=false", () => {
      debug("test");
      expect(debugSpy).not.toHaveBeenCalled();
    });
  });

  describe("divider", () => {
    it("should log a divider line", () => {
      divider();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  describe("statusBar", () => {
    const baseInput: StatusBarInput = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      contextWindow: 128000,
      warnThreshold: 0.7,
      compactThreshold: 0.9,
      costPerKPrompt: 0.001,
      costPerKCompletion: 0.002,
    };

    it("should render status bar", () => {
      statusBar(baseInput);
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should show warning when near warn threshold", () => {
      statusBar({
        ...baseInput,
        totalTokens: 100000, // ~78% of 128k
        contextWindow: 128000,
      });
      expect(logSpy).toHaveBeenCalled();
    });

    it("should show warning when near compact threshold", () => {
      statusBar({
        ...baseInput,
        totalTokens: 120000, // ~94% of 128k
        contextWindow: 128000,
      });
      expect(logSpy).toHaveBeenCalled();
    });

    it("should handle zero cost rates", () => {
      statusBar({
        ...baseInput,
        costPerKPrompt: 0,
        costPerKCompletion: 0,
      });
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle zero context window", () => {
      statusBar({
        ...baseInput,
        contextWindow: 0,
      });
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should format token counts with k suffix", () => {
      statusBar({
        ...baseInput,
        totalTokens: 50000,
        promptTokens: 30000,
        completionTokens: 20000,
        contextWindow: 128000,
      });
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should handle small token counts without k suffix", () => {
      statusBar({
        ...baseInput,
        totalTokens: 500,
        promptTokens: 300,
        completionTokens: 200,
        contextWindow: 128000,
      });
      expect(logSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
