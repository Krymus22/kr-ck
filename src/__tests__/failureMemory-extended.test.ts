/**
 * failureMemory-extended.test.ts — Casos edge / integração p/ failureMemory.ts.
 * Foco: recordFailure (3), getFailures (2), dedup (2), edge cases (1).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

describe("failureMemory (extended)", () => {
  beforeEach(async () => {
    const { clearFailures } = await import("./../failureMemory.js");
    clearFailures();
  });

  describe("recordFailure", () => {
    it("registra timestamp próximo de Date.now()", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      const before = Date.now();
      recordFailure("aplicar_diff", "err", "/f.ts");
      const after = Date.now();
      const ts = getFailures()[0]!.timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("preserva filePath com path completo (não trunca path)", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      const deep = "/a/b/c/d/e/f/g/h/i/j/file.luau";
      recordFailure("editar_arquivo", "err", deep);
      expect(getFailures()[0]!.filePath).toBe(deep);
    });

    it("registra error vazio como string vazia (não rejeita)", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("executar_comando", "");
      expect(getFailures()[0]!.error).toBe("");
    });
  });

  describe("getFailures", () => {
    it("retorna CÓPIA — mutar o array retornado não afeta o estado interno", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("t1", "e1");
      const arr1 = getFailures();
      arr1.pop();
      arr1.push({ tool: "x", error: "y", timestamp: 0 });
      const arr2 = getFailures();
      expect(arr2.length).toBe(1);
      expect(arr2[0]!.tool).toBe("t1");
    });

    it("após clearFailures retorna array vazio (não null)", async () => {
      const { recordFailure, clearFailures, getFailures } = await import("./../failureMemory.js");
      recordFailure("t", "e");
      clearFailures();
      const arr = getFailures();
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toEqual([]);
    });
  });

  describe("dedup", () => {
    it("mesmo tool+error repetido cria 2 entries (sem dedup automático)", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("aplicar_diff", "SEARCH not found");
      recordFailure("aplicar_diff", "SEARCH not found");
      const arr = getFailures();
      expect(arr.length).toBe(2);
      // Ambas devem ter mesmo tool e error
      expect(arr[0]!.tool).toBe("aplicar_diff");
      expect(arr[1]!.tool).toBe("aplicar_diff");
      expect(arr[0]!.error).toBe("SEARCH not found");
    });

    it("tools diferentes coexistem no array (sem sobrescrever)", async () => {
      const { recordFailure, getFailures } = await import("./../failureMemory.js");
      recordFailure("aplicar_diff", "err1");
      recordFailure("editar_arquivo", "err2");
      recordFailure("executar_comando", "err3");
      const arr = getFailures();
      expect(arr.map((f) => f.tool)).toEqual([
        "aplicar_diff",
        "editar_arquivo",
        "executar_comando",
      ]);
    });
  });

  describe("edge cases", () => {
    it("getMostRecentFailure retorna o último inserido após rotação (FIFO)", async () => {
      const { recordFailure, getMostRecentFailure, getFailures } = await import("./../failureMemory.js");
      // Insere 7 (max 5); failures 0 e 1 caem, último deve ser o 6
      for (let i = 0; i < 7; i++) {
        recordFailure(`tool_${i}`, `err_${i}`);
      }
      const arr = getFailures();
      expect(arr.length).toBe(5);
      expect(arr[0]!.tool).toBe("tool_2"); // primeiro que sobrou
      const recent = getMostRecentFailure();
      expect(recent).not.toBeNull();
      expect(recent!.tool).toBe("tool_6");
    });
  });
});
