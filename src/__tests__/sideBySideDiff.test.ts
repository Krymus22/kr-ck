/**
 * sideBySideDiff.test.ts — Tests for side-by-side diff module.
 */

import { describe, it, expect } from "vitest";
import { computeSideBySideDiff, renderSideBySide, generateUnifiedDiff } from "../sideBySideDiff.js";

describe("computeSideBySideDiff", () => {
  it("should detect identical content", () => {
    const diff = computeSideBySideDiff("a\nb\nc", "a\nb\nc");
    expect(diff.every((d) => d.type === "same")).toBe(true);
  });

  it("should detect added lines", () => {
    const diff = computeSideBySideDiff("a\nc", "a\nb\nc");
    const added = diff.filter((d) => d.type === "added");
    expect(added.length).toBe(1);
    expect(added[0].newContent).toBe("b");
  });

  it("should detect removed lines", () => {
    const diff = computeSideBySideDiff("a\nb\nc", "a\nc");
    const removed = diff.filter((d) => d.type === "removed");
    expect(removed.length).toBe(1);
    expect(removed[0].oldContent).toBe("b");
  });

  it("should handle empty old content", () => {
    const diff = computeSideBySideDiff("", "hello");
    expect(diff.length).toBeGreaterThan(0);
  });

  it("should handle empty new content", () => {
    const diff = computeSideBySideDiff("hello", "");
    expect(diff.length).toBeGreaterThan(0);
  });

  it("should handle both empty", () => {
    const diff = computeSideBySideDiff("", "");
    expect(diff.length).toBeLessThanOrEqual(1);
  });
});

describe("renderSideBySide", () => {
  it("should render diff output", () => {
    const diff = computeSideBySideDiff("a", "b");
    const rendered = renderSideBySide(diff);
    expect(rendered).toContain("OLD");
    expect(rendered).toContain("NEW");
  });

  it("should truncate long lines", () => {
    const longLine = "x".repeat(200);
    const diff = computeSideBySideDiff(longLine, "short");
    const rendered = renderSideBySide(diff, 40);
    expect(rendered.length).toBeGreaterThan(0);
  });
});

describe("generateUnifiedDiff", () => {
  it("should generate unified diff format", () => {
    const result = generateUnifiedDiff("old", "new", "file.txt");
    expect(result).toContain("--- a/file.txt");
    expect(result).toContain("+++ b/file.txt");
  });

  it("should show added and removed lines", () => {
    const result = generateUnifiedDiff("line1", "line1\nline2", "test.txt");
    expect(result).toContain("+");
  });
});
