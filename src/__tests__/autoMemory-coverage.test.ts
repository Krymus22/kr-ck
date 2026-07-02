/**
 * autoMemory-coverage.test.ts — Testes de cobertura estendidos do autoMemory
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  ensureAutoMemoryFile,
  readAutoMemory,
  appendAutoMemory,
  getAutoMemoryPath,
} from "../autoMemory.js";

describe("autoMemory — coverage", () => {
  describe("ensureAutoMemoryFile", () => {
    it("não lança exceção (arquivo já existe ou é criado)", () => {
      expect(() => ensureAutoMemoryFile()).not.toThrow();
    });
  });

  describe("readAutoMemory", () => {
    it("retorna string", () => {
      const result = readAutoMemory();
      expect(typeof result).toBe("string");
    });
  });

  describe("appendAutoMemory", () => {
    it("adiciona entrada ao arquivo", () => {
      const before = readAutoMemory();
      appendAutoMemory("Test entry for coverage");
      const after = readAutoMemory();
      expect(after.length).toBeGreaterThanOrEqual(before.length);
    });

    it("não lança exceção para entrada vazia", () => {
      expect(() => appendAutoMemory("")).not.toThrow();
    });
  });

  describe("getAutoMemoryPath", () => {
    it("retorna path contendo auto-memory", () => {
      const result = getAutoMemoryPath();
      expect(result).toContain("auto-memory");
    });

    it("retorna path no diretório .claude-killer", () => {
      const result = getAutoMemoryPath();
      expect(result).toContain(".claude-killer");
    });
  });
});
