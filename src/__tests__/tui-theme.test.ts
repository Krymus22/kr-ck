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
      for (const [key, value] of Object.entries(colors)) {
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

    it("should have exactly 7 icon keys", () => {
      expect(Object.keys(icons)).toHaveLength(7);
    });

    it("check should be a checkmark", () => {
      expect(icons.check).toBe("\u2713");
    });

    it("dot should be a bullet", () => {
      expect(icons.dot).toBe("\u25CF");
    });

    it("circle should be empty circle", () => {
      expect(icons.circle).toBe("\u25CB");
    });

    it("arrow should be right arrow", () => {
      expect(icons.arrow).toBe("\u2192");
    });

    it("warn should be warning sign", () => {
      expect(icons.warn).toBe("\u26A0");
    });

    it("error should be cross mark", () => {
      expect(icons.error).toBe("\u2716");
    });

    it("thinking should be diamond", () => {
      expect(icons.thinking).toBe("\u25C6");
    });
  });
});
