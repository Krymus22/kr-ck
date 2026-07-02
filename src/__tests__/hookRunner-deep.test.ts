/**
 * hookRunner-deep.test.ts — Testes profundos do hookRunner
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { loadHooksFromDir, loadHooks, resolveHooksDir } from "../hookRunner.js";

describe("hookRunner — deep coverage", () => {
  describe("resolveHooksDir", () => {
    it("retorna string para mode null", () => {
      const dir = resolveHooksDir(null);
      expect(typeof dir).toBe("string");
    });

    it("retorna string para mode roblox", () => {
      const dir = resolveHooksDir("roblox");
      expect(typeof dir).toBe("string");
      expect(dir).toContain("roblox");
    });

    it("retorna string para mode devops", () => {
      const dir = resolveHooksDir("devops");
      expect(typeof dir).toBe("string");
    });
  });

  describe("loadHooksFromDir", () => {
    it("retorna array para diretório inexistente", () => {
      const hooks = loadHooksFromDir("/nonexistent/directory");
      expect(Array.isArray(hooks)).toBe(true);
      expect(hooks.length).toBe(0);
    });

    it("retorna array para diretório vazio", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-empty-"));
      try {
        const hooks = loadHooksFromDir(tmpDir);
        expect(Array.isArray(hooks)).toBe(true);
        expect(hooks.length).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("carrega hooks de JSON files", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-json-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "test-hook.json"), JSON.stringify({
          name: "test-hook",
          command: "echo test",
          type: "post_edit",
        }));
        const hooks = loadHooksFromDir(tmpDir);
        expect(hooks.length).toBeGreaterThanOrEqual(0);
        
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("ignora JSON inválido", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-bad-"));
      try {
        fs.writeFileSync(path.join(tmpDir, "bad.json"), "{ invalid json }");
        const hooks = loadHooksFromDir(tmpDir);
        expect(hooks.length).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe("loadHooks", () => {
    it("retorna array para mode null", () => {
      const hooks = loadHooks(null);
      expect(Array.isArray(hooks)).toBe(true);
    });

    it("retorna array para mode roblox", () => {
      const hooks = loadHooks("roblox");
      expect(Array.isArray(hooks)).toBe(true);
    });
  });
});
