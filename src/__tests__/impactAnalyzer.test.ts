/**
 * impactAnalyzer.test.ts - Tests for pre-edit dependency analysis.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("impactAnalyzer", () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-impact-"));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("extractSymbols - Luau", () => {
    it("should extract M.Foo style functions", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
local M = {}
function M.GetCoins(player: Player): number
    return player.Coins
end
function M.SetCoins(player: Player, amount: number): nil
    player.Coins = amount
end
return M
`;
      const symbols = extractSymbols("test.luau", content);
      // Note: heuristic also picks up "Coins" from `player.Coins = amount` (false positive)
      // This is acceptable - the impact analyzer is intentionally permissive to avoid missing real exports.
      expect(symbols.some((s) => s.name === "GetCoins")).toBe(true);
      expect(symbols.some((s) => s.name === "SetCoins")).toBe(true);
    });

    it("should extract local function definitions", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
local function helper(x)
    return x * 2
end
local function main()
    return helper(5)
end
`;
      const symbols = extractSymbols("test.luau", content);
      expect(symbols.some((s) => s.name === "helper")).toBe(true);
      expect(symbols.some((s) => s.name === "main")).toBe(true);
    });

    it("should extract M.Bar = function style", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
local M = {}
M.Initialize = function()
    print("init")
end
return M
`;
      const symbols = extractSymbols("test.luau", content);
      expect(symbols.some((s) => s.name === "Initialize")).toBe(true);
    });

    it("should skip reserved words and very short names", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
local function do()
    -- "do" should be skipped
end
local function x()
    -- single letter should be skipped
end
local function ValidName()
    -- should be kept
end
`;
      const symbols = extractSymbols("test.luau", content);
      expect(symbols.some((s) => s.name === "do")).toBe(false);
      expect(symbols.some((s) => s.name === "x")).toBe(false);
      expect(symbols.some((s) => s.name === "ValidName")).toBe(true);
    });
  });

  describe("extractSymbols - TypeScript", () => {
    it("should extract export function", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
export function GetCoins(player: Player): number {
    return player.Coins;
}
export const MAX_PLAYERS = 100;
export class GameService {
    constructor() {}
}
export type GameState = "running" | "paused";
`;
      const symbols = extractSymbols("test.ts", content);
      expect(symbols.some((s) => s.name === "GetCoins")).toBe(true);
      expect(symbols.some((s) => s.name === "MAX_PLAYERS")).toBe(true);
      expect(symbols.some((s) => s.name === "GameService")).toBe(true);
      expect(symbols.some((s) => s.name === "GameState")).toBe(true);
    });
  });

  describe("extractSymbols - Python", () => {
    it("should extract top-level def and class", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `
def get_coins(player):
    return player.coins

class GameService:
    def __init__(self):
        pass

    def helper(self):  # indented - should be skipped
        pass
`;
      const symbols = extractSymbols("test.py", content);
      expect(symbols.some((s) => s.name === "get_coins")).toBe(true);
      expect(symbols.some((s) => s.name === "GameService")).toBe(true);
      // helper is indented, should not be extracted
      expect(symbols.some((s) => s.name === "helper")).toBe(false);
    });
  });

  describe("extractSymbols - unknown extension", () => {
    it("should return empty array for unknown file types", async () => {
      const { extractSymbols } = await import("./../impactAnalyzer.js");
      const content = `function foo() { return 1; }`;
      const symbols = extractSymbols("test.txt", content);
      expect(symbols).toEqual([]);
    });
  });

  describe("analyzeImpact - integration", () => {
    it("should return empty report for non-existent file", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");
      const report = await analyzeImpact("/nonexistent/file.luau", tmpProject);
      expect(report.symbols).toEqual([]);
      expect(report.usages).toEqual([]);
      expect(report.affectedFiles).toEqual([]);
    });

    it("should return empty report for unknown file extension", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");
      const filePath = path.join(tmpProject, "test.txt");
      fs.writeFileSync(filePath, "some text", "utf8");
      const report = await analyzeImpact(filePath, tmpProject);
      expect(report.symbols).toEqual([]);
    });

    it("should find symbols and usages across files (Luau)", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");

      // Create target file with symbols
      const target = path.join(tmpProject, "InventoryService.luau");
      fs.writeFileSync(target, `
local InventoryService = {}
function InventoryService.GetCoins(player)
    return player.Coins
end
function InventoryService.AddCoins(player, amount)
    player.Coins = (player.Coins or 0) + amount
end
return InventoryService
`, "utf8");

      // Create another file that uses the symbols
      const consumer = path.join(tmpProject, "ShopController.luau");
      fs.writeFileSync(consumer, `
local InventoryService = require(game.ReplicatedStorage.InventoryService)
local function buyItem(player, item)
    if InventoryService.GetCoins(player) >= item.Price then
        InventoryService.AddCoins(player, -item.Price)
    end
end
`, "utf8");

      const report = await analyzeImpact(target, tmpProject);

      // Should find both symbols
      expect(report.symbols.length).toBeGreaterThanOrEqual(2);
      expect(report.symbols.some((s) => s.name === "GetCoins")).toBe(true);
      expect(report.symbols.some((s) => s.name === "AddCoins")).toBe(true);

      // Should find usages in ShopController.luau
      expect(report.usages.length).toBeGreaterThan(0);
      expect(report.affectedFiles).toContain("ShopController.luau");

      // Verify usage details
      const getCoinsUsages = report.usages.filter((u) => u.symbol === "GetCoins");
      expect(getCoinsUsages.length).toBeGreaterThan(0);
      expect(getCoinsUsages[0]!.lineContent).toContain("GetCoins");
    });

    it("should exclude the target file from usages", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");

      const target = path.join(tmpProject, "Service.luau");
      fs.writeFileSync(target, `
local M = {}
function M.Foo()
    M.Foo()  -- recursive call - should NOT be reported as external usage
end
return M
`, "utf8");

      const report = await analyzeImpact(target, tmpProject);
      expect(report.usages.length).toBe(0);
    });

    it("should skip node_modules and dist directories", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");

      const target = path.join(tmpProject, "Service.luau");
      fs.writeFileSync(target, `
local M = {}
function M.Important()
    return 42
end
return M
`, "utf8");

      // Create a usage in node_modules - should be skipped
      fs.mkdirSync(path.join(tmpProject, "node_modules", "lib"), { recursive: true });
      fs.writeFileSync(path.join(tmpProject, "node_modules", "lib", "foo.luau"), `
require(M.Important())
`, "utf8");

      // Create a usage in dist - should be skipped
      fs.mkdirSync(path.join(tmpProject, "dist"), { recursive: true });
      fs.writeFileSync(path.join(tmpProject, "dist", "build.luau"), `
require(M.Important())
`, "utf8");

      const report = await analyzeImpact(target, tmpProject);
      expect(report.usages.length).toBe(0);
      expect(report.affectedFiles.length).toBe(0);
    });

    it("should respect MAX_TOTAL_USAGES cap", async () => {
      const { analyzeImpact } = await import("./../impactAnalyzer.js");

      const target = path.join(tmpProject, "Service.luau");
      fs.writeFileSync(target, `
local M = {}
function M.Popular()
    return 42
end
return M
`, "utf8");

      // Create 200 files that use M.Popular (more than MAX_TOTAL_USAGES=100)
      for (let i = 0; i < 200; i++) {
        fs.writeFileSync(
          path.join(tmpProject, `consumer_${i}.luau`),
          `local x = M.Popular()\n`,
          "utf8"
        );
      }

      const report = await analyzeImpact(target, tmpProject);
      expect(report.usages.length).toBeLessThanOrEqual(100);
    });
  });

  describe("formatImpactHint", () => {
    it("should return empty string when no usages", async () => {
      const { formatImpactHint } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/test/foo.luau",
        symbols: [{ name: "Foo", exportedAs: "Foo", definitionLine: 1 }],
        affectedFiles: [],
        usages: [],
        durationMs: 10,
      };
      const hint = formatImpactHint(report);
      expect(hint).toBe("");
    });

    it("should include affected files and usages in the hint", async () => {
      const { formatImpactHint } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/test/InventoryService.luau",
        symbols: [
          { name: "GetCoins", exportedAs: "GetCoins", definitionLine: 3 },
          { name: "AddCoins", exportedAs: "AddCoins", definitionLine: 6 },
        ],
        affectedFiles: ["ShopController.luau", "PlayerHUD.luau"],
        usages: [
          { file: "ShopController.luau", line: 12, symbol: "GetCoins", lineContent: "if InventoryService.GetCoins(player) >= price then" },
          { file: "PlayerHUD.luau", line: 45, symbol: "GetCoins", lineContent: "local coins = InventoryService.GetCoins(player)" },
        ],
        durationMs: 50,
      };
      const hint = formatImpactHint(report);
      expect(hint).toContain("IMPACT ANALYSIS");
      expect(hint).toContain("InventoryService.luau");
      expect(hint).toContain("ShopController.luau");
      expect(hint).toContain("PlayerHUD.luau");
      expect(hint).toContain("GetCoins");
      expect(hint).toContain("RENAME or REMOVE");
    });

    it("should limit to 5 usages per file", async () => {
      const { formatImpactHint } = await import("./../impactAnalyzer.js");
      const usages = Array.from({ length: 10 }, (_, i) => ({
        file: "consumer.luau",
        line: i + 1,
        symbol: "Foo",
        lineContent: `local x${i} = Foo()`,
      }));
      const report = {
        targetFile: "/test/foo.luau",
        symbols: [{ name: "Foo", exportedAs: "Foo", definitionLine: 1 }],
        affectedFiles: ["consumer.luau"],
        usages,
        durationMs: 10,
      };
      const hint = formatImpactHint(report);
      expect(hint).toContain("and 5 more usage(s)");
    });
  });

  describe("formatImpactSummary", () => {
    it("should return 'no dependencies' when no usages", async () => {
      const { formatImpactSummary } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/test/foo.luau",
        symbols: [],
        affectedFiles: [],
        usages: [],
        durationMs: 10,
      };
      expect(formatImpactSummary(report)).toBe("no dependencies");
    });

    it("should include counts when usages exist", async () => {
      const { formatImpactSummary } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/test/foo.luau",
        symbols: [],
        affectedFiles: ["a.luau", "b.luau"],
        usages: [
          { file: "a.luau", line: 1, symbol: "X", lineContent: "" },
          { file: "b.luau", line: 1, symbol: "X", lineContent: "" },
          { file: "b.luau", line: 2, symbol: "X", lineContent: "" },
        ],
        durationMs: 10,
      };
      expect(formatImpactSummary(report)).toBe("3 usage(s) in 2 file(s)");
    });
  });

  describe("clearCache", () => {
    it("should not throw when called", async () => {
      const { clearCache } = await import("./../impactAnalyzer.js");
      expect(() => clearCache()).not.toThrow();
    });
  });
});
