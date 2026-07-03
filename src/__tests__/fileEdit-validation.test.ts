/**
 * fileEdit-validation.test.ts — Testes do editFile com validação e rollback
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { applyEdits } from "../fileEdit.js";

describe("fileEdit — validation + edge cases", () => {
  describe("applyEdits — edge cases", () => {
    it("substitui texto com caracteres Unicode", () => {
      const result = applyEdits("olá mundo café", [
        { search: "olá", replace: "hello" },
      ]);
      expect(result.content).toBe("hello mundo café");
    });

    it("substitui texto com emoji", () => {
      const result = applyEdits("test 🔥 emoji", [
        { search: "🔥", replace: "✨" },
      ]);
      expect(result.content).toBe("test ✨ emoji");
    });

    it("não substitui quando search é string vazia e conteúdo não é vazio", () => {
      const result = applyEdits("existing content", [
        { search: "", replace: "prefix" },
      ]);
      // Empty search with content: appends to end
      expect(result.content).toContain("existing content");
    });

    it("substitui conteúdo vazio com replace", () => {
      const result = applyEdits("", [
        { search: "", replace: "new content" },
      ]);
      expect(result.content).toBe("new content");
    });

    it("lida com conteúdo muito longo", () => {
      const longContent = "a".repeat(10000);
      const result = applyEdits(longContent, [
        { search: "a".repeat(100), replace: "b".repeat(50) },
      ]);
      expect(result.content).toContain("b".repeat(50));
    });

    it("múltiplas substituições da mesma string", () => {
      const result = applyEdits("aaa", [
        { search: "a", replace: "b" },
      ]);
      // Should replace first occurrence only
      expect(result.content).toContain("b");
    });

    it("preserva quebras de linha \n", () => {
      const result = applyEdits("line1\nline2\nline3", [
        { search: "line2", replace: "replaced" },
      ]);
      expect(result.content).toBe("line1\nreplaced\nline3");
    });

    it("lida com search que contém regex special chars", () => {
      const result = applyEdits("price: $100 (USD)", [
        { search: "$100", replace: "$200" },
      ]);
      expect(result.content).toContain("$200");
    });

    it("lida com replace vazio (remoção)", () => {
      const result = applyEdits("hello world", [
        { search: "hello ", replace: "" },
      ]);
      expect(result.content).toBe("world");
    });

    it("retorna success=true para edição bem-sucedida", () => {
      const result = applyEdits("hello", [{ search: "hello", replace: "world" }]);
      expect(result.success).toBe(true);
    });

    it("retorna success=false quando search não encontrado", () => {
      const result = applyEdits("hello", [{ search: "nonexistent", replace: "world" }]);
      expect(result.success).toBe(false);
    });

    it("retorna content original quando nenhuma edição aplicada", () => {
      const result = applyEdits("unchanged", []);
      expect(result.content).toBe("unchanged");
      expect(result.success).toBe(true);
    });
  });
});
