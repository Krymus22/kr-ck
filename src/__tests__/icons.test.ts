/**
 * icons.test.ts — Tests for the cross-platform terminal icons module.
 *
 * Covers:
 *   - All icons are non-empty strings
 *   - figures-powered Unicode icons are preferred (✔ ✘ → ●)
 *   - Category icons are single uppercase letters
 *   - getCategoryIcon returns correct letter per category
 *   - Unknown category returns "?"
 */

import { describe, it, expect } from "vitest";
import { icons, getCategoryIcon } from "../tui/icons.js";

describe("icons", () => {
  describe("status indicators", () => {
    it("check is a non-empty string", () => {
      expect(typeof icons.check).toBe("string");
      expect(icons.check.length).toBeGreaterThan(0);
    });

    it("cross is a non-empty string", () => {
      expect(typeof icons.cross).toBe("string");
      expect(icons.cross.length).toBeGreaterThan(0);
    });

    it("bullet is a non-empty string", () => {
      expect(typeof icons.bullet).toBe("string");
      expect(icons.bullet.length).toBeGreaterThan(0);
    });

    it("warning is a non-empty string", () => {
      expect(typeof icons.warning).toBe("string");
      expect(icons.warning.length).toBeGreaterThan(0);
    });

    it("info is a non-empty string", () => {
      expect(typeof icons.info).toBe("string");
      expect(icons.info.length).toBeGreaterThan(0);
    });

    it("check is either Unicode tick (✔) or ASCII fallback (v)", () => {
      // Either the figures Unicode tick, or the ASCII fallback if figures
      // doesn't have it (shouldn't happen but is a safety net)
      expect(["✔", "v", "✓"]).toContain(icons.check);
    });

    it("cross is either Unicode cross (✘) or ASCII fallback (x)", () => {
      expect(["✘", "x", "✗"]).toContain(icons.cross);
    });

    it("bullet is either Unicode (●) or ASCII fallback (*)", () => {
      expect(["●", "*", "•"]).toContain(icons.bullet);
    });

    it("arrowRight is either Unicode (→) or ASCII fallback (->)", () => {
      expect(["→", "->"]).toContain(icons.arrowRight);
    });

    it("arrowLeft is either Unicode (←) or ASCII fallback (<-)", () => {
      expect(["←", "<-"]).toContain(icons.arrowLeft);
    });
  });

  describe("category icons (single letters)", () => {
    it("skill is 'S'", () => {
      expect(icons.skill).toBe("S");
    });

    it("tool is 'T'", () => {
      expect(icons.tool).toBe("T");
    });

    it("mcp is 'M'", () => {
      expect(icons.mcp).toBe("M");
    });

    it("plugin is 'P'", () => {
      expect(icons.plugin).toBe("P");
    });

    it("feature is 'F'", () => {
      expect(icons.feature).toBe("F");
    });
  });

  describe("getCategoryIcon", () => {
    it("returns 'S' for skill", () => {
      expect(getCategoryIcon("skill")).toBe("S");
    });

    it("returns 'T' for tool", () => {
      expect(getCategoryIcon("tool")).toBe("T");
    });

    it("returns 'M' for mcp", () => {
      expect(getCategoryIcon("mcp")).toBe("M");
    });

    it("returns 'P' for plugin", () => {
      expect(getCategoryIcon("plugin")).toBe("P");
    });

    it("returns 'F' for feature", () => {
      expect(getCategoryIcon("feature")).toBe("F");
    });

    it("returns '?' for unknown category", () => {
      expect(getCategoryIcon("unknown")).toBe("?");
    });

    it("returns '?' for empty string", () => {
      expect(getCategoryIcon("")).toBe("?");
    });

    it("returns '?' for null-like input", () => {
      expect(getCategoryIcon("anything")).toBe("?");
    });
  });

  describe("checkbox icons", () => {
    it("checkboxOn is a non-empty string", () => {
      expect(typeof icons.checkboxOn).toBe("string");
      expect(icons.checkboxOn.length).toBeGreaterThan(0);
    });

    it("checkboxOff is a non-empty string", () => {
      expect(typeof icons.checkboxOff).toBe("string");
      expect(icons.checkboxOff.length).toBeGreaterThan(0);
    });
  });

  describe("navigation icons", () => {
    it("pointer is non-empty", () => {
      expect(typeof icons.pointer).toBe("string");
      expect(icons.pointer.length).toBeGreaterThan(0);
    });

    it("arrowUp is either Unicode (↑) or ASCII (^)", () => {
      expect(["↑", "^"]).toContain(icons.arrowUp);
    });

    it("arrowDown is either Unicode (↓) or ASCII (v)", () => {
      expect(["↓", "v"]).toContain(icons.arrowDown);
    });
  });
});
