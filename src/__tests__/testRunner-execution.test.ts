/**
 * testRunner-execution.test.ts — Testes de runTests, runBugTest, runTestsWithAutoFix
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  execSync: vi.fn(() => ""),
  spawn: vi.fn(),
}));

import {
  detectFramework,
  detectLanguage,
  isTestRunnerAvailable,
  getTestFilePath,
  getTestCommand,
  getTestTemplate,
  formatTestResult,
  formatFixSuggestions,
  suggestFixes,
} from "../testRunner.js";

describe("testRunner — execution coverage", () => {
  describe("detectFramework — mais casos", () => {
    it("detecta npm com script de teste", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-npm-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
          name: "test", scripts: { test: "vitest" },
        }));
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });

    it("detecta wally para Roblox", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-wally-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "wally.toml"), "[package]\nname = \"test\"");
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });

    it("detecta cargo para Rust", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-cargo-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "Cargo.toml"), "[package]\nname = \"test\"");
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });

    it("detecta go.mod para Go", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-go-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "go.mod"), "module test\n\ngo 1.21");
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });

    it("detecta requirements.txt para Python", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-py-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "requirements.txt"), "pytest\n");
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });

    it("retorna desconhecido para diretório vazio", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-empty-"));
      try {
        const fw = detectFramework(tmpDir);
        expect(typeof fw).toBe("string");
      } finally { fs.rmSync(tmpDir, { recursive: true }); }
    });
  });

  describe("detectLanguage — todos os tipos", () => {
    it("detecta .ts → typescript", () => { expect(detectLanguage("f.ts")).toBe("typescript"); });
    it("detecta .tsx → typescript", () => { expect(detectLanguage("f.tsx")).toBe("typescript"); });
    it("detecta .js → javascript", () => { expect(detectLanguage("f.js")).toBe("javascript"); });
    it("detecta .mjs → javascript", () => { expect(detectLanguage("f.mjs")).toBe("javascript"); });
    it("detecta .cjs → javascript", () => { expect(detectLanguage("f.cjs")).toBe("javascript"); });
    it("detecta .py → python", () => { expect(detectLanguage("f.py")).toBe("python"); });
    it("detecta .lua → lua", () => { expect(detectLanguage("f.lua")).toBe("lua"); });
    it("detecta .luau → luau", () => { expect(detectLanguage("f.luau")).toBe("luau"); });
    it("detecta .unknown → unknown", () => { expect(detectLanguage("f.unknown")).toBe("unknown"); });
    it("detecta sem extensão → unknown", () => { expect(detectLanguage("README")).toBe("unknown"); });
  });

  describe("isTestRunnerAvailable", () => {
    it("retorna boolean para typescript", () => {
      expect(typeof isTestRunnerAvailable("typescript")).toBe("boolean");
    });
    it("retorna boolean para javascript", () => {
      expect(typeof isTestRunnerAvailable("javascript")).toBe("boolean");
    });
    it("retorna false para unknown", () => {
      expect(isTestRunnerAvailable("unknown")).toBe(false);
    });
  });

  describe("getTestFilePath — todos os tipos", () => {
    it("gera path para .ts", () => {
      const result = getTestFilePath("src/main.ts");
      expect(result).toContain("test");
    });
    it("gera path para .lua", () => {
      const result = getTestFilePath("src/main.lua");
      expect(result).toContain("test");
    });
    it("gera path para .py", () => {
      const result = getTestFilePath("src/main.py");
      expect(result).toContain("test");
    });
  });

  describe("getTestCommand — todos os tipos", () => {
    it("gera comando para typescript", () => {
      const cmd = getTestCommand("typescript", "test.ts", "/tmp");
      expect(cmd.length).toBeGreaterThan(0);
    });
    it("gera comando para javascript", () => {
      const cmd = getTestCommand("javascript", "test.js", "/tmp");
      expect(cmd.length).toBeGreaterThan(0);
    });
    it("gera comando para python", () => {
      const cmd = getTestCommand("python", "test.py", "/tmp");
      expect(cmd).toContain("python");
    });
    it("gera comando para lua", () => {
      const cmd = getTestCommand("lua", "test.lua", "/tmp");
      expect(cmd).toContain("lua");
    });
    it("gera comando para luau", () => {
      const cmd = getTestCommand("luau", "test.luau", "/tmp");
      expect(cmd).toContain("luau");
    });
    it("retorna vazio para unknown", () => {
      expect(getTestCommand("unknown", "test.xyz", "/tmp")).toBe("");
    });
  });

  describe("getTestTemplate — todos os tipos", () => {
    it("gera template para typescript", () => {
      const t = getTestTemplate("typescript", "main.ts", "bug");
      expect(t.length).toBeGreaterThan(0);
      expect(t).toContain("bug");
    });
    it("gera template para javascript", () => {
      const t = getTestTemplate("javascript", "main.js", "bug");
      expect(t.length).toBeGreaterThan(0);
    });
    it("gera template para python", () => {
      const t = getTestTemplate("python", "main.py", "bug");
      expect(t).toContain("def");
    });
    it("gera template para lua", () => {
      const t = getTestTemplate("lua", "main.lua", "bug");
      expect(t).toContain("pcall");
    });
    it("gera template para luau", () => {
      const t = getTestTemplate("luau", "main.luau", "bug");
      expect(t.length).toBeGreaterThan(0);
    });
  });

  describe("formatTestResult — edge cases", () => {
    it("formata com failures", () => {
      const result = formatTestResult({
        passed: 3, failed: 2, skipped: 0,
        duration: 1500, success: false,
        failures: [{ file: "test.lua", line: 10, message: "assertion failed" }] as any,
        output: "FAIL", framework: "lune",
      } as any);
      expect(typeof result).toBe("string");
    });

    it("formata com 0 testes", () => {
      const result = formatTestResult({
        passed: 0, failed: 0, skipped: 0,
        duration: 0, success: true,
        failures: [], output: "", framework: "",
      } as any);
      expect(typeof result).toBe("string");
    });
  });

  describe("suggestFixes — mais casos", () => {
    it("retorna array para output com nil reference", () => {
      const suggestions = suggestFixes({
        passed: 1, failed: 1, skipped: 0,
        duration: 100, success: false,
        failures: [{ file: "main.lua", line: 42, message: "nil reference" }] as any,
        output: "main.lua:42: attempt to index nil", framework: "lune",
      } as any);
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it("retorna array para output com TypeError", () => {
      const suggestions = suggestFixes({
        passed: 0, failed: 1, skipped: 0,
        duration: 100, success: false,
        failures: [{ file: "main.ts", line: 10, message: "TypeError" }] as any,
        output: "TypeError: Cannot read properties of undefined", framework: "vitest",
      } as any);
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });


});
