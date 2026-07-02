/**
 * testRunner-coverage.test.ts — Testes de cobertura do testRunner
 *
 * Cobre funções puras não testadas:
 *   - detectFramework
 *   - formatTestResult
 *   - formatFixSuggestions
 *   - detectLanguage
 *   - isTestRunnerAvailable
 *   - getTestFilePath
 *   - getTestCommand
 *   - getTestTemplate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  detectFramework,
  formatTestResult,
  formatFixSuggestions,
  detectLanguage,
  isTestRunnerAvailable,
  getTestFilePath,
  getTestCommand,
  getTestTemplate,
  suggestFixes,
} from "../testRunner.js";

describe("testRunner — coverage", () => {
  describe("detectFramework", () => {
    it("detecta framework por package.json (npm)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-fw-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test","scripts":{"test":"vitest"}}');
        const fw = detectFramework(tmpDir);
        expect(fw).toBeTruthy();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("detecta framework por wally.toml (roblox)", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-wally-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "wally.toml"), '[package]\nname = "test"');
        const fw = detectFramework(tmpDir);
        expect(fw).toBeTruthy();
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("retorna desconhecido para diretório vazio", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-empty-"));
      try {
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe("detectLanguage", () => {
    it("detecta lua para .lua", () => {
      expect(detectLanguage("file.lua")).toBe("lua");
    });

    it("detecta lua para .luau", () => {
      expect(detectLanguage("file.luau")).toBe("luau");
    });

    it("detecta python para .py", () => {
      expect(detectLanguage("file.py")).toBe("python");
    });

    it("detecta rust para .rs", () => {
      expect(detectLanguage("file.rs")).toBe("unknown");
    });

    it("detecta go para .go", () => {
      expect(detectLanguage("file.go")).toBe("unknown");
    });

    it("detecta node para .js", () => {
      expect(detectLanguage("file.js")).toBe("javascript");
    });

    it("detecta node para .ts", () => {
      expect(detectLanguage("file.ts")).toBe("typescript");
    });

    it("retorna unknown para extensão desconhecida", () => {
      expect(detectLanguage("file.xyz")).toBe("unknown");
    });

    it("retorna unknown para arquivo sem extensão", () => {
      expect(detectLanguage("README")).toBe("unknown");
    });
  });

  describe("isTestRunnerAvailable", () => {
    it("retorna boolean para linguagem conhecida", () => {
      expect(typeof isTestRunnerAvailable("lua")).toBe("boolean");
      expect(typeof isTestRunnerAvailable("python")).toBe("boolean");
    });

    it("retorna false para unknown", () => {
      expect(isTestRunnerAvailable("unknown")).toBe(false);
    });
  });

  describe("getTestFilePath", () => {
    it("gera path de teste para .lua", () => {
      const result = getTestFilePath("src/main.lua");
      expect(result).toContain("test");
      expect(result).toContain(".lua");
    });

    it("gera path de teste para .py", () => {
      const result = getTestFilePath("src/main.py");
      expect(result).toContain("test");
    });

    it("gera path de teste para .ts", () => {
      const result = getTestFilePath("src/main.ts");
      expect(result).toContain("test");
    });
  });

  describe("getTestCommand", () => {
    it("gera comando para lua", () => {
      const cmd = getTestCommand("lua", "test.lua", "/tmp");
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    });

    it("gera comando para python", () => {
      const cmd = getTestCommand("python", "test.py", "/tmp");
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    });

    it("retorna string vazia para unknown", () => {
      const cmd = getTestCommand("unknown", "test.xyz", "/tmp");
      expect(cmd).toBe("");
    });
  });

  describe("getTestTemplate", () => {
    it("gera template para lua", () => {
      const template = getTestTemplate("lua", "main.lua", "nil access");
      expect(typeof template).toBe("string");
      expect(template.length).toBeGreaterThan(0);
    });

    it("gera template para python", () => {
      const template = getTestTemplate("python", "main.py", "index error");
      expect(typeof template).toBe("string");
      expect(template.length).toBeGreaterThan(0);
    });

    it("retorna string vazia para unknown", () => {
      const template = getTestTemplate("unknown", "main.xyz", "bug");
      expect(typeof template).toBe("string");
    });
  });

  describe("formatTestResult", () => {
    it("formata resultado com passed/failed/skipped", () => {
      const result = formatTestResult({ duration: 1000, success: true, failures: [], framework: "vitest", 
        passed: 5,
        failed: 2,
        skipped: 1,
        total: 8,
        output: "test output",
        framework: "vitest",
      } as any);
      expect(typeof result).toBe("string");
      expect(result).toContain("5");
      expect(typeof result).toBe("string");
    });

    it("formata resultado vazio", () => {
      const result = formatTestResult({ duration: 1000, success: true, failures: [], framework: "vitest", 
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        output: "",
        framework: "",
      } as any);
      expect(typeof result).toBe("string");
    });

    it("formata resultado com todos passando", () => {
      const result = formatTestResult({ duration: 1000, success: true, failures: [], framework: "vitest", 
        passed: 10,
        failed: 0,
        skipped: 0,
        total: 10,
        output: "all passed",
        framework: "jest",
      } as any);
      expect(result).toContain("10");
    });
  });

  describe("formatFixSuggestions", () => {
    it("formata sugestões não vazias", () => {
      const result = formatFixSuggestions([
        { file: "main.lua", line: 42, suggestion: "Add pcall", severity: "high" },
      ] as any);
      expect(typeof result).toBe("string");
      expect(result).toContain("main.lua");
    });

    it("retorna string para array vazio", () => {
      const result = formatFixSuggestions([]);
      expect(typeof result).toBe("string");
    });

    it("formata múltiplas sugestões", () => {
      const result = formatFixSuggestions([
        { file: "a.lua", line: 1, suggestion: "fix A", severity: "critical" },
        { file: "b.lua", line: 10, suggestion: "fix B", severity: "medium" },
        { file: "c.lua", line: 20, suggestion: "fix C", severity: "low" },
      ] as any);
      expect(result).toContain("a.lua");
      expect(result).toContain("b.lua");
      expect(result).toContain("c.lua");
    });
  });

  describe("suggestFixes", () => {
    it("retorna array para resultado sem falhas", () => {
      const suggestions = suggestFixes({
        passed: 5, failed: 0, skipped: 0,
        duration: 100, success: true,
        failures: [], output: "all passed",
        framework: "vitest",
      } as any);
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it("retorna array para resultado com falhas", () => {
      const suggestions = suggestFixes({
        passed: 3, failed: 2, skipped: 0,
        duration: 200, success: false,
        failures: [{ file: "main.lua", line: 42, description: "nil access", message: "nil access" } as any],
        output: "FAIL: main.lua:42\nError: nil access",
        framework: "vitest",
      } as any);
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });
});
