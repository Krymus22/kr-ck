/**
 * fileValidator-coverage.test.ts — Testes de cobertura do fileValidator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { matchesPattern } from "../fileValidator.js";

describe("fileValidator — coverage", () => {
  describe("matchesPattern", () => {
    it("matches *.lua para arquivo .lua", () => {
      expect(matchesPattern("src/main.lua", "*.lua")).toBe(true);
    });

    it("matches *.luau para arquivo .luau", () => {
      expect(matchesPattern("src/main.luau", "*.luau")).toBe(true);
    });

    it("NÃO matches *.lua para arquivo .py", () => {
      expect(matchesPattern("src/main.py", "*.lua")).toBe(false);
    });

    it("matches * para qualquer arquivo", () => {
      expect(matchesPattern("src/main.lua", "*")).toBe(true);
      expect(matchesPattern("src/main.py", "*")).toBe(true);
      expect(matchesPattern("README.md", "*")).toBe(true);
    });

    it("matches nome exato", () => {
      expect(matchesPattern("src/main.lua", "main.lua")).toBe(true);
    });

    it("NÃO matches nome diferente", () => {
      expect(matchesPattern("src/other.lua", "main.lua")).toBe(false);
    });

    it("usa basename para matching", () => {
      expect(matchesPattern("/home/user/project/main.lua", "main.lua")).toBe(true);
    });

    it("matches *.py para arquivo Python", () => {
      expect(matchesPattern("src/app.py", "*.py")).toBe(true);
    });

    it("matches *.ts para arquivo TypeScript", () => {
      expect(matchesPattern("src/index.ts", "*.ts")).toBe(true);
    });

    it("NÃO matches extensão diferente", () => {
      expect(matchesPattern("src/main.lua", "*.ts")).toBe(false);
    });

    it("matches *.tf para Terraform", () => {
      expect(matchesPattern("infra/main.tf", "*.tf")).toBe(true);
    });
  });
});
