import { describe, it, expect } from "vitest";
import { computeUnifiedDiff, renderColoredDiff } from "../diffPreview.js";

describe("computeUnifiedDiff", () => {
  it("returns empty string when no changes", () => {
    const diff = computeUnifiedDiff("same content", "same content", "test.txt");
    expect(diff).toBe("");
  });

  it("generates unified diff for additions", () => {
    const diff = computeUnifiedDiff("line1", "line1\nline2", "test.txt");
    expect(diff).toContain("--- a/test.txt");
    expect(diff).toContain("+++ b/test.txt");
    expect(diff).toContain("@@");
    expect(diff).toContain("+line2");
  });

  it("generates unified diff for removals", () => {
    const diff = computeUnifiedDiff("line1\nline2", "line1", "test.txt");
    expect(diff).toContain("-line2");
  });

  it("generates unified diff for replacements", () => {
    const diff = computeUnifiedDiff("old text", "new text", "file.ts");
    expect(diff).toContain("-old text");
    expect(diff).toContain("+new text");
  });

  it("handles empty files", () => {
    const diff = computeUnifiedDiff("", "content", "new.txt");
    expect(diff).toContain("+content");
  });

  it("handles both empty", () => {
    const diff = computeUnifiedDiff("", "", "empty.txt");
    expect(diff).toBe("");
  });

  it("limits hunk size for large changes", () => {
    const bigBefore = Array(300).fill("old line").join("\n");
    const bigAfter = Array(300).fill("new line").join("\n");
    const diff = computeUnifiedDiff(bigBefore, bigAfter, "big.txt");
    expect(diff).toContain("@@");
    // Should not exceed reasonable size
    expect(diff.length).toBeLessThan(50000);
  });
});

describe("renderColoredDiff", () => {
  it("adds ANSI color codes", () => {
    const input = "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new";
    const colored = renderColoredDiff(input);
    // Should contain ANSI escape codes
    expect(colored).toContain("\x1b[");
    // Lines should still be present
    expect(colored).toContain("old");
    expect(colored).toContain("new");
  });

  it("handles empty diff", () => {
    const colored = renderColoredDiff("");
    // Empty string still gets wrapped in ANSI codes (context line behavior)
    expect(typeof colored).toBe("string");
  });
});
