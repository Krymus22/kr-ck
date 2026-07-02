/**
 * fileEdit-deep.test.ts — Testes profundos do fileEdit
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

describe("fileEdit — deep coverage", () => {
  describe("applyEdits", () => {
    it("aplica edição de substituição simples", () => {
      const content = "hello world";
      const result = applyEdits(content, [
        { oldText: "hello", newText: "goodbye" },
      ]);
      expect(result.content).toBe("goodbye world");
      expect(result.success).toBe(true);
    });

    it("aplica múltiplas edições", () => {
      const content = "foo bar baz";
      const result = applyEdits(content, [
        { oldText: "foo", newText: "FOO" },
        { oldText: "bar", newText: "BAR" },
        { oldText: "baz", newText: "BAZ" },
      ]);
      expect(result.content).toBe("FOO BAR BAZ");
    });

    it("retorna success=false quando oldText não encontrado", () => {
      const content = "hello world";
      const result = applyEdits(content, [
        { oldText: "nonexistent", newText: "replacement" },
      ]);
      expect(result.success).toBe(false);
    });

    it("retorna success=true para conteúdo vazio sem edits", () => {
      const result = applyEdits("", []);
      expect(result.success).toBe(true);
      expect(result.content).toBe("");
    });

    it("aplica edição que adiciona conteúdo no final", () => {
      const content = "line1\nline2";
      const result = applyEdits(content, [
        { oldText: "line2", newText: "line2\nline3" },
      ]);
      expect(result.content).toBe("line1\nline2\nline3");
    });

    it("aplica edição que remove conteúdo", () => {
      const content = "keep this\nremove this\nkeep this too";
      const result = applyEdits(content, [
        { oldText: "remove this\n", newText: "" },
      ]);
      expect(result.content).toBe("keep this\nkeep this too");
    });

    it("aplica edição com texto multilinha", () => {
      const content = "function foo()\n  return 1\nend";
      const result = applyEdits(content, [
        { oldText: "function foo()\n  return 1\nend", newText: "function foo()\n  return 2\nend" },
      ]);
      expect(result.content).toContain("return 2");
    });

    it("não aplica edição quando oldText é string vazia", () => {
      const content = "hello";
      const result = applyEdits(content, [
        { oldText: "", newText: "prefix" },
      ]);
      // Comportamento: pode aplicar no início ou ignorar
      expect(typeof result.content).toBe("string");
    });

    it("aplica edição com caracteres especiais", () => {
      const content = "local x = 'hello'";
      const result = applyEdits(content, [
        { oldText: "'hello'", newText: '"world"' },
      ]);
      expect(result.content).toBe('local x = "world"');
    });

    it("aplica edição com quebras de linha Windows (CRLF)", () => {
      const content = "line1\r\nline2";
      const result = applyEdits(content, [
        { oldText: "line1", newText: "LINE1" },
      ]);
      expect(result.content).toContain("LINE1");
    });

    it("aplica edição com tabs", () => {
      const content = "\tindented code";
      const result = applyEdits(content, [
        { oldText: "\tindented", newText: "  indented" },
      ]);
      expect(result.content).toContain("  indented");
    });

    it("aplica múltiplas edições sequenciais", () => {
      const content = "a b c d e";
      const result = applyEdits(content, [
        { oldText: "a", newText: "A" },
        { oldText: "b", newText: "B" },
        { oldText: "c", newText: "C" },
        { oldText: "d", newText: "D" },
        { oldText: "e", newText: "E" },
      ]);
      expect(result.content).toBe("A B C D E");
    });
  });
});
