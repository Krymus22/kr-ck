import { describe, it, expect, vi } from "vitest";
import { computeUnifiedDiff, renderColoredDiff, previewAndApprove } from "../diffPreview.js";

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
    expect(diff.length).toBeLessThan(50000);
  });

  it("truncates diff when output exceeds MAX_DIFF_LINES_PER_HUNK * 4", () => {
    const bigBefore = Array(1000).fill("old line").join("\n");
    const bigAfter = Array(1000).fill("new line").join("\n");
    const diff = computeUnifiedDiff(bigBefore, bigAfter, "huge.txt");
    expect(diff).toContain("diff truncated for preview");
  });

  it("handles multiline content", () => {
    const diff = computeUnifiedDiff("a\nb\nc", "a\nx\nc", "multi.txt");
    expect(diff).toContain("-");
    expect(diff).toContain("+");
  });

  it("handles trailing newlines", () => {
    const diff = computeUnifiedDiff("line1\n", "line1\nline2\n", "trailing.txt");
    expect(diff).toContain("+line2");
  });
});

describe("renderColoredDiff", () => {
  it("adds ANSI color codes", () => {
    const input = "--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new";
    const colored = renderColoredDiff(input);
    expect(colored).toContain("\x1b[");
    expect(colored).toContain("old");
    expect(colored).toContain("new");
  });

  it("handles empty diff", () => {
    const colored = renderColoredDiff("");
    expect(typeof colored).toBe("string");
  });

  it("colors context lines grey", () => {
    const input = " context line";
    const colored = renderColoredDiff(input);
    expect(colored).toContain("\x1b[");
  });

  it("handles hunk headers", () => {
    const input = "@@ -1,3 +1,3 @@";
    const colored = renderColoredDiff(input);
    expect(colored).toContain("\x1b[");
  });
});

describe("previewAndApprove", () => {
  it("auto-approves when no changes", async () => {
    const result = await previewAndApprove("/tmp/same.txt", "content", "content");
    expect(result).toBe(true);
  });

  it("auto-approves in non-TTY mode", async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const result = await previewAndApprove("/tmp/test.txt", "old", "new");
    expect(result).toBe(true);
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
  });

  it("auto-approves when diffPreview is false", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: { diffPreview: false },
    }));
    const { previewAndApprove: paa } = await import("../diffPreview.js");
    const result = await paa("/tmp/test.txt", "old content", "new content");
    expect(result).toBe(true);
    vi.doUnmock("../config.js");
  });

  it("auto-approves in TTY mode when user types 'y'", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: { diffPreview: true },
    }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn().mockReturnValue({
          question: vi.fn().mockImplementation((_prompt: string, cb: (a: string) => void) => {
            cb("y");
          }),
          close: vi.fn(),
        }),
      },
    }));
    const { previewAndApprove: paa } = await import("../diffPreview.js");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const result = await paa("/tmp/tty_test.txt", "old content", "new content here");
      expect(result).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      vi.doUnmock("../config.js");
      vi.doUnmock("node:readline");
    }
  });

  it("rejects in TTY mode when user types 'n'", async () => {
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: { diffPreview: true },
    }));
    vi.doMock("node:readline", () => ({
      default: {
        createInterface: vi.fn().mockReturnValue({
          question: vi.fn().mockImplementation((_prompt: string, cb: (a: string) => void) => {
            cb("n");
          }),
          close: vi.fn(),
        }),
      },
    }));
    const { previewAndApprove: paa } = await import("../diffPreview.js");
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const result = await paa("/tmp/tty_reject.txt", "old content", "new content here");
      expect(result).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      vi.doUnmock("../config.js");
      vi.doUnmock("node:readline");
    }
  });
});
