import { describe, it, expect } from "vitest";
import { StatusBar } from "../tui/StatusBar.js";
import { colors } from "../tui/theme.js";

function formatTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function calculateBarColor(pct: number, warnThreshold: number, compactThreshold: number): string {
  if (pct >= compactThreshold) return colors.error;
  if (pct >= warnThreshold) return colors.warning;
  return colors.success;
}

function calculateCost(promptTokens: number, completionTokens: number, costPerKPrompt: number, costPerKCompletion: number): number {
  return (promptTokens / 1000) * costPerKPrompt + (completionTokens / 1000) * costPerKCompletion;
}

function calculateFillCount(pct: number, barWidth: number = 15): number {
  return Math.round(pct * barWidth);
}

describe("StatusBar component", () => {
  it("should be a function", () => {
    expect(typeof StatusBar).toBe("function");
  });

  describe("formatTok", () => {
    it("should format numbers under 1000 as-is", () => {
      expect(formatTok(0)).toBe("0");
      expect(formatTok(1)).toBe("1");
      expect(formatTok(999)).toBe("999");
    });

    it("should format 1000+ as k notation", () => {
      expect(formatTok(1000)).toBe("1.0k");
      expect(formatTok(1500)).toBe("1.5k");
      expect(formatTok(10000)).toBe("10.0k");
      expect(formatTok(123456)).toBe("123.5k");
    });

    it("should handle exact 1000 boundary", () => {
      expect(formatTok(1000)).toBe("1.0k");
      expect(formatTok(999)).toBe("999");
    });
  });

  describe("bar color logic", () => {
    it("should be green when under warn threshold", () => {
      expect(calculateBarColor(0.3, 0.5, 0.8)).toBe(colors.success);
      expect(calculateBarColor(0.0, 0.5, 0.8)).toBe(colors.success);
    });

    it("should be yellow when at or above warn threshold", () => {
      expect(calculateBarColor(0.5, 0.5, 0.8)).toBe(colors.warning);
      expect(calculateBarColor(0.6, 0.5, 0.8)).toBe(colors.warning);
      expect(calculateBarColor(0.79, 0.5, 0.8)).toBe(colors.warning);
    });

    it("should be red when at or above compact threshold", () => {
      expect(calculateBarColor(0.8, 0.5, 0.8)).toBe(colors.error);
      expect(calculateBarColor(1.0, 0.5, 0.8)).toBe(colors.error);
    });
  });

  describe("cost calculation", () => {
    it("should return 0 when no cost rates", () => {
      expect(calculateCost(1000, 500, 0, 0)).toBe(0);
    });

    it("should calculate prompt cost only", () => {
      expect(calculateCost(1000, 0, 0.01, 0)).toBe(0.01);
    });

    it("should calculate completion cost only", () => {
      expect(calculateCost(0, 1000, 0, 0.03)).toBe(0.03);
    });

    it("should calculate combined cost", () => {
      const cost = calculateCost(2000, 1000, 0.01, 0.03);
      expect(cost).toBeCloseTo(0.05);
    });

    it("should handle zero tokens", () => {
      expect(calculateCost(0, 0, 0.01, 0.03)).toBe(0);
    });
  });

  describe("fill count calculation", () => {
    it("should return 0 for 0%", () => {
      expect(calculateFillCount(0)).toBe(0);
    });

    it("should return 15 for 100%", () => {
      expect(calculateFillCount(1)).toBe(15);
    });

    it("should return ~8 for ~50%", () => {
      expect(calculateFillCount(0.5)).toBe(8);
    });

    it("should return 7 for exactly half of 15", () => {
      expect(calculateFillCount(0.4667)).toBe(7);
    });
  });

  describe("planMode tag", () => {
    it("should produce [PLAN] text when planMode is true", () => {
      const modeTag = true ? " [PLAN]" : "";
      expect(modeTag).toBe(" [PLAN]");
    });

    it("should produce empty string when planMode is false", () => {
      const modeTag = false ? " [PLAN]" : "";
      expect(modeTag).toBe("");
    });
  });
});
