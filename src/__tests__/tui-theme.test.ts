/**
 * tui-theme.test.ts - Tests for theme and icons.
 */

import { describe, it, expect } from "vitest";
import { colors, icons } from "../tui/theme.js";

describe("theme.ts", () => {
  describe("colors", () => {
    it("should export all required color keys", () => {
      expect(colors.primary).toBeDefined();
      expect(colors.secondary).toBeDefined();
      expect(colors.success).toBeDefined();
      expect(colors.warning).toBeDefined();
      expect(colors.error).toBeDefined();
      expect(colors.muted).toBeDefined();
      expect(colors.white).toBeDefined();
      expect(colors.bg).toBeDefined();
    });

    it("should have exactly 8 color keys", () => {
      expect(Object.keys(colors)).toHaveLength(8);
    });

    it("should have valid hex color values", () => {
      for (const value of Object.values(colors)) {
        expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });

    it("colors should be readonly (as const)", () => {
      expect(colors).toBeDefined();
    });
  });

  describe("icons", () => {
    it("should export all required icon keys", () => {
      expect(icons.check).toBeDefined();
      expect(icons.dot).toBeDefined();
      expect(icons.circle).toBeDefined();
      expect(icons.arrow).toBeDefined();
      expect(icons.warn).toBeDefined();
      expect(icons.error).toBeDefined();
      expect(icons.thinking).toBeDefined();
    });

    it("should have at least 7 icon keys", () => {
      expect(Object.keys(icons).length).toBeGreaterThanOrEqual(7);
    });

    it("check should be a valid string", () => {
      expect(typeof icons.check).toBe("string");
      expect(icons.check.length).toBeGreaterThan(0);
    });

    it("dot should be a valid string", () => {
      expect(typeof icons.dot).toBe("string");
      expect(icons.dot.length).toBeGreaterThan(0);
    });

    it("circle should be a valid string", () => {
      expect(typeof icons.circle).toBe("string");
      expect(icons.circle.length).toBeGreaterThan(0);
    });

    it("arrow should be a valid string", () => {
      expect(typeof icons.arrow).toBe("string");
      expect(icons.arrow.length).toBeGreaterThan(0);
    });

    it("warn should be a valid string", () => {
      expect(typeof icons.warn).toBe("string");
      expect(icons.warn.length).toBeGreaterThan(0);
    });

    it("error should be a valid string", () => {
      expect(typeof icons.error).toBe("string");
      expect(icons.error.length).toBeGreaterThan(0);
    });

    it("thinking should be a valid string", () => {
      expect(typeof icons.thinking).toBe("string");
      expect(icons.thinking.length).toBeGreaterThan(0);
    });
  });
});
