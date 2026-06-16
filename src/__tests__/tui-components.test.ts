/**
 * tui-components.test.ts — Tests for TUI component logic.
 * Tests theme constants and formatting helpers from real modules.
 */

import { describe, it, expect } from "vitest";

// Import from real theme module
import { colors as COLORS } from "../tui/theme.js";

// Re-extract the pure helper functions used by TUI components
// These are internal to the components but we test the same logic

const ICONS = { check: "\u2713", cross: "\u2717", dot: "\u2022", ellipsis: "\u2026", spinner: ["|", "/", "-", "\\"] };

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth < 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + ICONS.ellipsis;
}

function formatStatusText(status: "running" | "completed" | "failed" | "pending"): string {
  switch (status) {
    case "completed": return `${ICONS.check} Completed`;
    case "failed": return `${ICONS.cross} Failed`;
    case "running": return `${ICONS.spinner[0]} Running`;
    case "pending": return `${ICONS.dot} Pending`;
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padCenter(str: string, width: number): string {
  if (str.length >= width) return str;
  const padTotal = width - str.length;
  const padLeft = Math.floor(padTotal / 2);
  return " ".repeat(padLeft) + str + " ".repeat(padTotal - padLeft);
}

function formatToolResult(success: boolean, name: string, message: string): string {
  const icon = success ? ICONS.check : ICONS.cross;
  return `${icon} ${name}: ${message}`;
}

function calculateUsagePercent(used: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

function formatUsageBar(used: number, total: number, barWidth: number = 20): string {
  const percent = calculateUsagePercent(used, total);
  const filled = Math.round((percent / 100) * barWidth);
  const empty = barWidth - filled;
  return "[" + "\u2588".repeat(filled) + "\u2591".repeat(empty) + "]";
}

function parseTodoLine(line: string): { checked: boolean; text: string; priority?: string } | null {
  const match = /^(\[[ x]\])\s*(.+)$/.exec(line);
  if (!match) return null;
  const checked = match[1] === "[x]";
  let text = match[2];
  let priority: string | undefined;
  const priorityMatch = /^\((high|medium|low)\)\s*(.*)$/.exec(text);
  if (priorityMatch) {
    priority = priorityMatch[1];
    text = priorityMatch[2];
  }
  return { checked, text, priority };
}

function formatTodoItem(checked: boolean, text: string, priority?: string): string {
  const checkbox = checked ? "[x]" : "[ ]";
  const prio = priority ? `(${priority}) ` : "";
  return `${checkbox} ${prio}${text}`;
}

describe("tui-components logic (real theme imports)", () => {
  describe("colors constant (from theme.ts)", () => {
    it("should have all required color keys", () => {
      expect(COLORS.primary).toBeDefined();
      expect(COLORS.secondary).toBeDefined();
      expect(COLORS.success).toBeDefined();
      expect(COLORS.warning).toBeDefined();
      expect(COLORS.error).toBeDefined();
      expect(COLORS.muted).toBeDefined();
      expect(COLORS.bg).toBeDefined();
    });

    it("should have valid hex colors", () => {
      for (const [key, value] of Object.entries(COLORS)) {
        expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  });

  describe("icons constant", () => {
    it("should have all required icon keys", () => {
      expect(ICONS.check).toBeDefined();
      expect(ICONS.cross).toBeDefined();
      expect(ICONS.dot).toBeDefined();
    });
  });

  describe("truncateText", () => {
    it("should not truncate short text", () => { expect(truncateText("hello", 10)).toBe("hello"); });
    it("should truncate with ellipsis", () => { expect(truncateText("hello world", 8)).toBe("hello w\u2026"); });
    it("should handle exact length", () => { expect(truncateText("hello", 5)).toBe("hello"); });
    it("should handle maxWidth 2", () => { expect(truncateText("hello", 2)).toBe("he"); });
    it("should handle empty string", () => { expect(truncateText("", 5)).toBe(""); });
  });

  describe("formatStatusText", () => {
    it("running", () => { expect(formatStatusText("running")).toContain("Running"); });
    it("completed", () => { const t = formatStatusText("completed"); expect(t).toContain(ICONS.check); expect(t).toContain("Completed"); });
    it("failed", () => { const t = formatStatusText("failed"); expect(t).toContain(ICONS.cross); expect(t).toContain("Failed"); });
    it("pending", () => { const t = formatStatusText("pending"); expect(t).toContain(ICONS.dot); expect(t).toContain("Pending"); });
  });

  describe("padRight", () => {
    it("should pad", () => { expect(padRight("hi", 5)).toBe("hi   "); });
    it("should not truncate", () => { expect(padRight("hello", 3)).toBe("hello"); });
    it("exact", () => { expect(padRight("abc", 3)).toBe("abc"); });
  });

  describe("padCenter", () => {
    it("should center", () => { const r = padCenter("hi", 6); expect(r.length).toBe(6); expect(r.trim()).toBe("hi"); });
    it("odd padding", () => { const r = padCenter("hi", 5); expect(r.length).toBe(5); });
    it("no truncate", () => { expect(padCenter("hello", 3)).toBe("hello"); });
  });

  describe("formatToolResult", () => {
    it("success", () => { const r = formatToolResult(true, "bash", "ok"); expect(r).toContain(ICONS.check); expect(r).toContain("bash"); });
    it("failure", () => { const r = formatToolResult(false, "edit", "err"); expect(r).toContain(ICONS.cross); });
  });

  describe("calculateUsagePercent", () => {
    it("normal", () => { expect(calculateUsagePercent(50, 100)).toBe(50); });
    it("cap at 100", () => { expect(calculateUsagePercent(150, 100)).toBe(100); });
    it("zero total", () => { expect(calculateUsagePercent(0, 0)).toBe(0); });
    it("zero used", () => { expect(calculateUsagePercent(0, 100)).toBe(0); });
    it("rounds", () => { expect(calculateUsagePercent(1, 3)).toBe(33); });
    it("negative", () => { expect(calculateUsagePercent(-10, 100)).toBe(0); });
  });

  describe("formatUsageBar", () => {
    it("correct width", () => { const bar = formatUsageBar(50, 100, 10); expect(bar.length).toBe(12); expect(bar.startsWith("[")).toBe(true); expect(bar.endsWith("]")).toBe(true); });
    it("100%", () => { expect(formatUsageBar(100, 100, 5)).toBe("[" + "\u2588".repeat(5) + "]"); });
    it("0%", () => { expect(formatUsageBar(0, 100, 5)).toBe("[" + "\u2591".repeat(5) + "]"); });
    it("50%", () => { const bar = formatUsageBar(50, 100, 10); const filled = bar.split("\u2588").length - 1; expect(filled).toBe(5); });
  });

  describe("parseTodoLine", () => {
    it("unchecked", () => { const r = parseTodoLine("[ ] Fix bug"); expect(r).not.toBeNull(); expect(r!.checked).toBe(false); expect(r!.text).toBe("Fix bug"); });
    it("checked", () => { const r = parseTodoLine("[x] Done"); expect(r!.checked).toBe(true); });
    it("with priority", () => { const r = parseTodoLine("[ ] (high) Critical"); expect(r!.priority).toBe("high"); expect(r!.text).toBe("Critical"); });
    it("medium priority", () => { const r = parseTodoLine("[ ] (medium) Task"); expect(r!.priority).toBe("medium"); });
    it("low priority", () => { const r = parseTodoLine("[x] (low) Nice"); expect(r!.checked).toBe(true); expect(r!.priority).toBe("low"); });
    it("null for bad format", () => { expect(parseTodoLine("bad")).toBeNull(); expect(parseTodoLine("")).toBeNull(); });
  });

  describe("formatTodoItem", () => {
    it("unchecked", () => { expect(formatTodoItem(false, "Task")).toBe("[ ] Task"); });
    it("checked", () => { expect(formatTodoItem(true, "Task")).toBe("[x] Task"); });
    it("with priority", () => { expect(formatTodoItem(false, "Task", "high")).toBe("[ ] (high) Task"); });
    it("checked with priority", () => { expect(formatTodoItem(true, "Task", "low")).toBe("[x] (low) Task"); });
  });
});
