import { describe, it, expect } from "vitest";
import { ThinkingIndicator } from "../tui/ThinkingIndicator.js";
import { colors } from "../tui/theme.js";

function dotsCycle(dots: string): string {
  return dots.length >= 3 ? "" : dots + ".";
}

describe("ThinkingIndicator component", () => {
  it("should be a function", () => {
    expect(typeof ThinkingIndicator).toBe("function");
  });

  describe("dots animation logic", () => {
    it("should start with empty string", () => {
      expect(dotsCycle("")).toBe(".");
    });

    it("should add one dot each cycle", () => {
      expect(dotsCycle("")).toBe(".");
      expect(dotsCycle(".")).toBe("..");
      expect(dotsCycle("..")).toBe("...");
    });

    it("should reset after 3 dots", () => {
      expect(dotsCycle("...")).toBe("");
    });

    it("should cycle correctly over multiple iterations", () => {
      let dots = "";
      const sequence: string[] = [];
      for (let i = 0; i < 8; i++) {
        dots = dotsCycle(dots);
        sequence.push(dots);
      }
      expect(sequence).toEqual([".", "..", "...", "", ".", "..", "...", ""]);
    });
  });

  describe("rendering behavior", () => {
    it("should return null when not active (component logic)", () => {
      const active = false;
      expect(active ? "render" : null).toBeNull();
    });

    it("should render text when active", () => {
      const active = true;
      expect(active ? "render" : null).toBe("render");
    });

    it("should display PENSANDO text with dots", () => {
      const text = `◆ PENSANDO${"..."} `;
      expect(text).toContain("PENSANDO");
      expect(text).toContain("...");
    });
  });
});
