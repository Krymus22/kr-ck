/**
 * useTerminal.test.ts — Tests for terminal width hooks and layout helpers.
 *
 * Covers:
 *   - calculateCardWidth for various terminal widths and column counts
 *   - truncateStr preserves short strings and ellipsizes long ones
 *   - truncateMiddle preserves both start and end of long paths
 *   - Constants MIN_TERMINAL_WIDTH, DEFAULT_TERMINAL_WIDTH have sane values
 *   - Edge cases: very narrow terminal, 0 columns, single column grid
 */

import { describe, it, expect } from "vitest";
import {
  MIN_TERMINAL_WIDTH,
  DEFAULT_TERMINAL_WIDTH,
  calculateCardWidth,
  truncateStr,
  truncateMiddle,
} from "../tui/useTerminal.js";

describe("useTerminal", () => {
  describe("constants", () => {
    it("MIN_TERMINAL_WIDTH is at least 60 (below that, layout degrades)", () => {
      expect(MIN_TERMINAL_WIDTH).toBeGreaterThanOrEqual(60);
    });

    it("DEFAULT_TERMINAL_WIDTH is between 80 and 200 (typical terminal)", () => {
      expect(DEFAULT_TERMINAL_WIDTH).toBeGreaterThanOrEqual(80);
      expect(DEFAULT_TERMINAL_WIDTH).toBeLessThanOrEqual(200);
    });
  });

  describe("calculateCardWidth", () => {
    it("returns 10 (minimum) for very narrow terminals", () => {
      // terminalWidth=50, cols=3 → available = 50 - 2 - 2 = 46 → 46/3 = 15
      // But min is 10, so anything below 30+2+2*1=34 will clamp differently.
      // We test that the function never returns less than 10.
      const width = calculateCardWidth(40, 3);
      expect(width).toBeGreaterThanOrEqual(10);
    });

    it("returns increasing card width for wider terminals (3 cols)", () => {
      const narrow = calculateCardWidth(80, 3);
      const wide = calculateCardWidth(160, 3);
      expect(wide).toBeGreaterThan(narrow);
    });

    it("returns smaller cards for more columns (same terminal width)", () => {
      const cols2 = calculateCardWidth(100, 2);
      const cols3 = calculateCardWidth(100, 3);
      const cols4 = calculateCardWidth(100, 4);
      expect(cols2).toBeGreaterThan(cols3);
      expect(cols3).toBeGreaterThan(cols4);
    });

    it("on 100-col terminal with 3 cols, gap 1, pad 2 → 31 cards", () => {
      // available = 100 - 2 - 2*1 = 96 → 96/3 = 32
      const width = calculateCardWidth(100, 3, 1, 2);
      expect(width).toBe(32);
    });

    it("on 60-col terminal with 3 cols → still >= 10 (minimum)", () => {
      const width = calculateCardWidth(60, 3);
      expect(width).toBeGreaterThanOrEqual(10);
    });

    it("single column returns (almost) full terminal width", () => {
      const width = calculateCardWidth(100, 1, 0, 2);
      // available = 100 - 2 - 0 = 98
      expect(width).toBe(98);
    });

    it("default gap and padding work correctly", () => {
      // Default: gap=1, padding=2
      const width = calculateCardWidth(100, 3);
      // available = 100 - 2 - 2*1 = 96 → 96/3 = 32
      expect(width).toBe(32);
    });
  });

  describe("truncateStr", () => {
    it("returns short strings unchanged", () => {
      expect(truncateStr("hello", 10)).toBe("hello");
    });

    it("returns string unchanged when length equals maxChars", () => {
      expect(truncateStr("12345", 5)).toBe("12345");
    });

    it("truncates with ellipsis when longer than maxChars", () => {
      // "Hello, World!" has 13 chars; truncated to 10 chars = first 7 chars + "..."
      // = "Hello, " + "..." = "Hello, ..." (10 chars total, including the space)
      expect(truncateStr("Hello, World!", 10)).toBe("Hello, ...");
    });

    it("preserves first chars when truncating", () => {
      // "very-long-path-to-file.luau" has 27 chars; max 15 → keep 12 + "..."
      // = "very-long-pa" + "..." = "very-long-pa..." (15 chars total)
      expect(truncateStr("very-long-path-to-file.luau", 15)).toBe("very-long-pa...");
    });

    it("handles maxChars <= 3 (just returns first slice)", () => {
      expect(truncateStr("hello", 3)).toBe("hel");
      expect(truncateStr("hello", 2)).toBe("he");
      expect(truncateStr("hello", 1)).toBe("h");
    });

    it("handles empty string", () => {
      expect(truncateStr("", 10)).toBe("");
    });

    it("handles exact boundary correctly", () => {
      // 8 chars, max 10 → no truncation
      expect(truncateStr("12345678", 10)).toBe("12345678");
      // 11 chars, max 10 → truncated to 7 + "..."
      expect(truncateStr("12345678901", 10)).toBe("1234567...");
    });
  });

  describe("truncateMiddle", () => {
    it("returns short strings unchanged", () => {
      expect(truncateMiddle("hello", 10)).toBe("hello");
    });

    it("truncates middle of long paths, preserving start and end", () => {
      const result = truncateMiddle("/very/long/path/to/file.luau", 20);
      // Should start with "/" and end with "file.luau" (or similar)
      expect(result.startsWith("/")).toBe(true);
      expect(result.endsWith("file.luau")).toBe(true);
      // Should be exactly 20 chars
      expect(result.length).toBe(20);
      // Should contain "..."
      expect(result).toContain("...");
    });

    it("preserves more of the end (filename) than start (root)", () => {
      const result = truncateMiddle("/home/user/projects/myapp/src/components/Button.tsx", 30);
      // 60% of (30-3) = 16.2 → 16 chars at the end
      // 40% of (30-3) = 10.8 → 10 chars at the start
      expect(result.endsWith(".tsx")).toBe(true);
      expect(result.startsWith("/home/us")).toBe(true);
    });

    it("handles very small maxChars", () => {
      expect(truncateMiddle("hello", 3)).toBe("hel");
      expect(truncateMiddle("hello", 2)).toBe("he");
    });

    it("preserves Windows paths", () => {
      const result = truncateMiddle("C:\\Users\\kryst\\Projects\\MyGame\\tools\\rojo.exe", 30);
      expect(result.endsWith("rojo.exe")).toBe(true);
      expect(result.startsWith("C:")).toBe(true);
    });

    it("returns string unchanged when length equals maxChars", () => {
      expect(truncateMiddle("12345", 5)).toBe("12345");
    });
  });
});
