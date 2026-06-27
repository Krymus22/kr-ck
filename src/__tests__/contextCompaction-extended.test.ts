/**
 * contextCompaction-extended.test.ts — Casos edge que NÃO estão no teste
 * básico. Foco em: compactIntelligently (3 extras), smartCompact + shouldCompact
 * (2 extras), estratégias individuais (2) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mocks minimums para isolar contextCompaction das dependências externas
// (apiClient, effortLevels, logger, history). Mantemos compactIntelligently
// e strategies testáveis sem rede.
vi.mock("../apiClient.js", () => ({
  chat: vi.fn().mockResolvedValue({
    choices: [{ message: { content: "Resumo de compação simulado".repeat(3) } }],
  }),
}));

vi.mock("../effortLevels.js", () => ({
  shouldUseIntelligentCompaction: vi.fn().mockReturnValue(false),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn().mockReturnValue(() => {}),
}));

// history: usamos mock com métodos necessários para smartCompact
const historyMock = vi.hoisted(() => ({
  estimateTokens: vi.fn().mockReturnValue(0),
  getHistory: vi.fn().mockReturnValue([]),
  compactHistory: vi.fn().mockReturnValue(null),
  replaceHistory: vi.fn(),
  resetHistory: vi.fn(),
}));

vi.mock("../history.js", () => ({
  estimateTokens: (...a: any[]) => historyMock.estimateTokens(...a),
  getHistory: (...a: any[]) => historyMock.getHistory(...a),
  compactHistory: (...a: any[]) => historyMock.compactHistory(...a),
  replaceHistory: (...a: any[]) => historyMock.replaceHistory(...a),
  resetHistory: (...a: any[]) => historyMock.resetHistory(...a),
}));

import { compactIntelligently, smartCompact, strategies } from "../contextCompaction.js";

describe("contextCompaction — extended", () => {
  beforeEach(() => {
    historyMock.estimateTokens.mockReturnValue(0);
    historyMock.getHistory.mockReturnValue([]);
    historyMock.compactHistory.mockReturnValue(null);
    historyMock.replaceHistory.mockReset();
    historyMock.resetHistory.mockReset();
  });

  // ─── compactIntelligently — extras (3) ─────────────────────────────────────

  describe("compactIntelligently — extras", () => {
    it("não aplica estratégias quando só há system + user", () => {
      const r = compactIntelligently([
        { role: "system", content: "p" },
        { role: "user", content: "oi" },
      ]);
      expect(r.appliedStrategies).toHaveLength(0);
      expect(r.messages).toHaveLength(2);
    });

    it("preserva o system prompt mesmo quando tudo é tool/assistant", () => {
      const msgs = [
        { role: "system", content: "PROMPT_SISTEMA" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
        { role: "tool", content: "t1", tool_call_id: "1" },
      ];
      const { messages } = compactIntelligently(msgs);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toBe("PROMPT_SISTEMA");
    });

    it("aplica 'compress-long-tool-results' mantendo cabeçalho e rodapé do conteúdo", () => {
      const longContent = "HEAD" + "x".repeat(3000) + "TAIL";
      const { messages, appliedStrategies } = compactIntelligently([
        { role: "system", content: "p" },
        { role: "tool", content: longContent, tool_call_id: "1" },
      ]);
      expect(appliedStrategies).toContain("compress-long-tool-results");
      const compacted = messages.find((m: any) => m.tool_call_id === "1");
      expect(compacted?.content).toContain("HEAD");
      expect(compacted?.content).toContain("TAIL");
      expect(compacted?.content).toContain("[COMPACTED]");
    });
  });

  // ─── smartCompact / shouldCompact (2) ──────────────────────────────────────

  describe("smartCompact — extras", () => {
    it("retorna {compacted:false, savedTokens:0} quando abaixo do limite", async () => {
      historyMock.estimateTokens.mockReturnValue(100);
      const r = await smartCompact(50_000);
      expect(r.compacted).toBe(false);
      expect(r.savedTokens).toBe(0);
    });

    it("retorna resultado booleano/numérico válido mesmo com histórico vazio", async () => {
      historyMock.estimateTokens.mockReturnValue(0);
      const r = await smartCompact(1);
      expect(typeof r.compacted).toBe("boolean");
      expect(typeof r.savedTokens).toBe("number");
    });
  });

  // ─── Estratégias individuais (2) ───────────────────────────────────────────

  describe("estratégias individuais — extras", () => {
    it("'remove-old-error-messages' não dispara com exatamente 5 erros", () => {
      const msgs: any[] = [
        { role: "system", content: "p" },
      ];
      for (let i = 0; i < 5; i++) {
        msgs.push({ role: "tool", content: "[ERROR] err", tool_call_id: String(i) });
      }
      const { appliedStrategies } = compactIntelligently(msgs);
      // 5 erros NÃO devem disparar (limite é >5)
      expect(appliedStrategies).not.toContain("remove-old-error-messages");
    });

    it("'merge-adjacent-tool-results' shouldApply dispara com 3+ consecutivos", () => {
      const strat = strategies.find((s) => s.name === "merge-adjacent-tool-results")!;
      const msgs: any[] = [
        { role: "system", content: "p" },
        { role: "tool", content: "a", tool_call_id: "1" },
        { role: "tool", content: "b", tool_call_id: "2" },
        { role: "tool", content: "c", tool_call_id: "3" },
        { role: "tool", content: "d", tool_call_id: "4" },
      ];
      expect(strat.shouldApply(msgs)).toBe(true);
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("compactIntelligently lida com array vazio sem lançar", () => {
      const { messages, appliedStrategies } = compactIntelligently([]);
      expect(Array.isArray(messages)).toBe(true);
      expect(appliedStrategies).toHaveLength(0);
    });

    it("compactIntelligently retorna novo array (não a mesma referência de entrada)", () => {
      const original: any[] = [
        { role: "system", content: "p" },
        { role: "user", content: "u" },
      ];
      const { messages } = compactIntelligently(original);
      expect(messages).not.toBe(original); // referência diferente
      expect(messages.length).toBeLessThanOrEqual(original.length);
    });
  });
});
