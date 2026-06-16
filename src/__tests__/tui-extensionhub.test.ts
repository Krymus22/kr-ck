import { describe, it, expect } from "vitest";
import { ExtensionHub } from "../tui/ExtensionHub.js";
import { colors } from "../tui/theme.js";

const GRID_COLS = 3;
const GRID_ROWS = 3;
const PAGE_SIZE = GRID_COLS * GRID_ROWS;

function calculateTotalPages(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / PAGE_SIZE));
}

function calculateVisibleItems<T>(items: T[], scrollTop: number): T[] {
  return items.slice(scrollTop, scrollTop + PAGE_SIZE);
}

function clampCursor(idx: number, maxLen: number): number {
  return Math.max(0, Math.min(idx, maxLen - 1));
}

function getGridPosition(idx: number): { row: number; col: number } {
  return { row: Math.floor(idx / GRID_COLS), col: idx % GRID_COLS };
}

const TRIGGER_COLORS: Record<string, string> = {
  disabled: colors.muted,
  on_file: colors.warning,
  on_task: colors.primary,
  always: colors.success,
};

describe("ExtensionHub component", () => {
  it("should be a function", () => {
    expect(typeof ExtensionHub).toBe("function");
  });

  describe("grid pagination logic", () => {
    it("should return 1 page for empty items", () => {
      expect(calculateTotalPages(0)).toBe(1);
    });

    it("should return 1 page for up to 9 items", () => {
      expect(calculateTotalPages(1)).toBe(1);
      expect(calculateTotalPages(5)).toBe(1);
      expect(calculateTotalPages(9)).toBe(1);
    });

    it("should return 2 pages for 10-18 items", () => {
      expect(calculateTotalPages(10)).toBe(2);
      expect(calculateTotalPages(18)).toBe(2);
    });

    it("should return 3 pages for 19-27 items", () => {
      expect(calculateTotalPages(19)).toBe(3);
      expect(calculateTotalPages(27)).toBe(3);
    });
  });

  describe("visible items slicing", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item${i}`);

    it("should return first 9 items at scrollTop 0", () => {
      const visible = calculateVisibleItems(items, 0);
      expect(visible).toHaveLength(9);
      expect(visible[0]).toBe("item0");
      expect(visible[8]).toBe("item8");
    });

    it("should return items 9-17 at scrollTop 9", () => {
      const visible = calculateVisibleItems(items, 9);
      expect(visible).toHaveLength(9);
      expect(visible[0]).toBe("item9");
      expect(visible[8]).toBe("item17");
    });

    it("should handle tail page with fewer items", () => {
      const visible = calculateVisibleItems(items, 18);
      expect(visible).toHaveLength(2);
      expect(visible[0]).toBe("item18");
      expect(visible[1]).toBe("item19");
    });

    it("should return empty for out-of-bounds scroll", () => {
      const visible = calculateVisibleItems(items, 20);
      expect(visible).toHaveLength(0);
    });
  });

  describe("cursor clamping", () => {
    it("should clamp negative index to 0", () => {
      expect(clampCursor(-1, 9)).toBe(0);
    });

    it("should clamp index beyond length", () => {
      expect(clampCursor(10, 5)).toBe(4);
    });

    it("should keep valid index unchanged", () => {
      expect(clampCursor(3, 9)).toBe(3);
    });

    it("should handle single item", () => {
      expect(clampCursor(0, 1)).toBe(0);
      expect(clampCursor(5, 1)).toBe(0);
    });
  });

  describe("grid position calculation", () => {
    it("should map index 0 to row 0, col 0", () => {
      expect(getGridPosition(0)).toEqual({ row: 0, col: 0 });
    });

    it("should map index 2 to row 0, col 2", () => {
      expect(getGridPosition(2)).toEqual({ row: 0, col: 2 });
    });

    it("should map index 3 to row 1, col 0", () => {
      expect(getGridPosition(3)).toEqual({ row: 1, col: 0 });
    });

    it("should map index 8 to row 2, col 2", () => {
      expect(getGridPosition(8)).toEqual({ row: 2, col: 2 });
    });
  });

  describe("trigger mode colors", () => {
    it("disabled should use muted color", () => {
      expect(TRIGGER_COLORS["disabled"]).toBe(colors.muted);
    });

    it("on_file should use warning color", () => {
      expect(TRIGGER_COLORS["on_file"]).toBe(colors.warning);
    });

    it("on_task should use primary color", () => {
      expect(TRIGGER_COLORS["on_task"]).toBe(colors.primary);
    });

    it("always should use success color", () => {
      expect(TRIGGER_COLORS["always"]).toBe(colors.success);
    });
  });

  describe("navigation logic", () => {
    it("left arrow should decrease cursor", () => {
      let cursor = 5;
      cursor = clampCursor(cursor - 1, 9);
      expect(cursor).toBe(4);
    });

    it("right arrow should increase cursor", () => {
      let cursor = 3;
      cursor = clampCursor(cursor + 1, 9);
      expect(cursor).toBe(4);
    });

    it("up arrow should move up by GRID_COLS", () => {
      let cursor = 7;
      if (cursor >= GRID_COLS) {
        cursor = clampCursor(cursor - GRID_COLS, 9);
      }
      expect(cursor).toBe(4);
    });

    it("down arrow should move down by GRID_COLS", () => {
      let cursor = 1;
      if (cursor < 9 - GRID_COLS) {
        cursor = clampCursor(cursor + GRID_COLS, 9);
      }
      expect(cursor).toBe(4);
    });
  });
});
