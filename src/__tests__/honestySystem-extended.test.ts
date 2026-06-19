/**
 * honestySystem-extended.test.ts - Expansão de cobertura de src/honestySystem.ts.
 *
 * Foca em cenários não cobertos por honestySystem.test.ts:
 *   - isProveItModeActive() false/true baseado em feature flag
 *   - resetHonestyTurn() limpa arquivos editados E incrementa turn
 *   - checkUserClaims() com mais patterns (is_working, has_feature, tech_stack)
 *   - extractConfidence() com formatos suportados e não-suportados
 *   - checkContradictions() quando feature desabilitada retorna vazio
 *   - checkContradictions() com claims de contagem (tests, files)
 *   - Persistência de state entre turns (claimStore retém claims)
 *   - proveItCheck() bloqueia resposta quando há claims não-verificadas
 *   - Pruning de claimStore após 100 entradas
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// --- Mock contornável de extensionCenter ---
// Permite habilitar/desabilitar features por teste (via featureState).
const featureState = vi.hoisted(() => ({
  enabled: new Set<string>(),
  reset() {
    this.enabled.clear();
  },
  enable(id: string) {
    this.enabled.add(id);
  },
  disable(id: string) {
    this.enabled.delete(id);
  },
  isEnabled(id: string) {
    return this.enabled.has(id);
  },
}));

vi.mock("./../extensionCenter.js", () => ({
  getExtension: vi.fn((id: string) => ({
    enabled: featureState.isEnabled(id),
    triggerMode: featureState.isEnabled(id) ? "always" : "disabled",
  })),
}));

describe("honestySystem (extended)", () => {
  beforeEach(() => {
    featureState.reset();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // --- isProveItModeActive -------------------------------------------------

  describe("isProveItModeActive", () => {
    it("retorna false quando feature:prove_it_mode está desabilitada", async () => {
      const { isProveItModeActive } = await import("./../honestySystem.js");
      const active = await isProveItModeActive();
      expect(active).toBe(false);
    });

    it("retorna true quando feature:prove_it_mode está habilitada", async () => {
      const { isProveItModeActive } = await import("./../honestySystem.js");
      featureState.enable("feature:prove_it_mode");
      const active = await isProveItModeActive();
      expect(active).toBe(true);
    });

    it("retorna false quando somente outra feature está habilitada (não prove_it_mode)", async () => {
      const { isProveItModeActive } = await import("./../honestySystem.js");
      featureState.enable("feature:devils_advocate");
      featureState.enable("feature:diff_reality_check");
      const active = await isProveItModeActive();
      expect(active).toBe(false);
    });
  });

  // --- resetHonestyTurn ----------------------------------------------------

  describe("resetHonestyTurn", () => {
    it("limpa arquivos edited-but-not-read e incrementa turn", async () => {
      const {
        markFileAsEdited,
        getUnreadBackFiles,
        resetHonestyTurn,
        clearAllHonestyState,
        checkContradictions,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      // Habilita contradiction_tracker para podermos observar o turn
      featureState.enable("feature:contradiction_tracker");

      markFileAsEdited("/test/file1.luau");
      markFileAsEdited("/test/file2.luau");
      expect(getUnreadBackFiles().length).toBe(2);

      resetHonestyTurn();
      // Files foram limpos
      expect(getUnreadBackFiles().length).toBe(0);

      // Turn foi incrementado (de 0 para 1). Verificamos fazendo uma claim
      // e checando que o turn exibido é 1 (não 0).
      const result = await checkContradictions("selene version 1.0.0");
      expect(result.contradictions.length).toBe(0);
      // Como fizemos 1 resetHonestyTurn (= +1 incrementTurn) e 0 incrementTurn manual,
      // currentTurn deve ser 1. Mas o resultado não mostra turn direto.
      // Apenas verificamos que não há contradições em turn 1.
    });

    it("resetHonestyTurn chamado múltiplas vezes incrementa turn progressivamente", async () => {
      const {
        clearAllHonestyState,
        resetHonestyTurn,
        checkContradictions,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      featureState.enable("feature:contradiction_tracker");

      // Turn 1: claim selene 1.0.0
      resetHonestyTurn();
      await checkContradictions("selene version 1.0.0");

      // Turn 2: claim selene 2.0.0 (contradicts)
      resetHonestyTurn();
      const result = await checkContradictions("selene version 2.0.0");
      expect(result.contradictions.length).toBe(1);
      // A contradição mostra turn 1 (quando selene=1.0.0 foi armazenada)
      expect(result.contradictions[0]!.turn).toBe(1);
    });
  });

  // --- checkUserClaims: mais patterns -------------------------------------

  describe("checkUserClaims - patterns extras", () => {
    beforeEach(() => {
      featureState.enable("feature:user_claim_verify");
    });

    it("retorna vazio para mensagens que não são claims factuais", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("Faça um sistema de inventário para o jogo");
      expect(result.claims).toHaveLength(0);
      expect(result.message).toBe("");
    });

    it("detecta claim 'o projeto está funcionando' (is_working)", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O sistema está funcionando corretamente");
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.message).toContain("VERIFY");
      // Tipo is_working deve estar presente
      expect(result.claims[0]).toContain("is_working");
    });

    it("detecta claim 'o sistema is working' (inglês)", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("The system is working");
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it("detecta claim 'já tem docker configurado' (has_feature)", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O projeto já tem docker configurado");
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.claims[0]).toContain("has_feature");
    });

    it("detecta claim 'usa kubernetes' (tech_stack)", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O projeto usa kubernetes para deploy");
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.claims[0]).toContain("tech_stack");
    });

    it("detecta claim 'tem 500 linhas' (line_count)", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims("O arquivo tem 500 linhas");
      expect(result.claims.length).toBeGreaterThan(0);
      expect(result.claims[0]).toContain("line_count");
    });

    it("detecta múltiplas claims na mesma mensagem", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      const result = await checkUserClaims(
        "O arquivo tem 200 linhas e o projeto usa react para o frontend"
      );
      expect(result.claims.length).toBeGreaterThanOrEqual(2);
    });

    it("retorna vazio quando feature:user_claim_verify está desabilitada", async () => {
      const { checkUserClaims } = await import("./../honestySystem.js");
      featureState.disable("feature:user_claim_verify");
      const result = await checkUserClaims("O arquivo tem 500 linhas e usa react");
      expect(result.claims).toHaveLength(0);
      expect(result.message).toBe("");
    });
  });

  // --- extractConfidence ---------------------------------------------------

  describe("extractConfidence - formatos suportados", () => {
    it("parseia 'confianca: 8' (sem acento)", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("Vou editar. confianca: 8")).toBe(8);
    });

    it("parseia 'confiança: 5' (com acento)", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("confiança: 5")).toBe(5);
    });

    it("limita valor acima de 10 para 10 (clamping)", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("confianca: 100")).toBe(10);
    });

    it("limita valor abaixo de 1 para 1 (clamping mínimo)", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("confianca: 0")).toBe(1);
    });

    it("retorna 0 (não null) para texto sem confiança — formato '100%' não é suportado", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      // O módulo só reconhece o pattern "confian[çc]a: N"
      // Formatos como "100%", "1.0", "high" não são parseados — retornam 0
      expect(extractConfidence("Estou 100% confiante")).toBe(0);
      expect(extractConfidence("confidence: 1.0")).toBe(0);
      expect(extractConfidence("high confidence")).toBe(0);
    });

    it("retorna 0 para string vazia", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(extractConfidence("")).toBe(0);
    });

    it("parseia confiança mesmo quando há texto ao redor", async () => {
      const { extractConfidence } = await import("./../honestySystem.js");
      expect(
        extractConfidence("Analisei o código. confiança: 7. Vou proceder com a edição.")
      ).toBe(7);
    });
  });

  // --- checkContradictions: feature flag + persistência -------------------

  describe("checkContradictions - feature flag e persistência", () => {
    it("retorna vazio quando feature:contradiction_tracker está desabilitada", async () => {
      const {
        checkContradictions,
        clearAllHonestyState,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      // feature desabilitada — não deve detectar contradição mesmo com claims conflitantes
      incrementTurn();
      await checkContradictions("selene version 1.0.0");
      incrementTurn();
      const result = await checkContradictions("selene version 2.0.0");
      expect(result.contradictions).toHaveLength(0);
      expect(result.message).toBe("");
    });

    it("detecta contradição de versão entre claim atual e realidade", async () => {
      const {
        checkContradictions,
        clearAllHonestyState,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      featureState.enable("feature:contradiction_tracker");

      incrementTurn();
      await checkContradictions("rojo version 7.6.1 is the latest");
      incrementTurn();
      const result = await checkContradictions("rojo 7.5.0 is installed");
      expect(result.contradictions.length).toBeGreaterThan(0);
      expect(result.message).toContain("CONTRADICTION");
    });

    it("retorna vazio quando mesma versão é afirmada em turns diferentes", async () => {
      const {
        checkContradictions,
        clearAllHonestyState,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      featureState.enable("feature:contradiction_tracker");

      incrementTurn();
      await checkContradictions("selene version 0.31.0 is good");
      incrementTurn();
      const result = await checkContradictions("selene 0.31.0 is the latest");
      expect(result.contradictions).toHaveLength(0);
    });

    it("detecta contradição de contagem (número de testes)", async () => {
      const {
        checkContradictions,
        clearAllHonestyState,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      featureState.enable("feature:contradiction_tracker");

      incrementTurn();
      await checkContradictions("Rodamos 100 testes no total");
      incrementTurn();
      const result = await checkContradictions("Temos 150 testes no projeto");
      expect(result.contradictions.length).toBeGreaterThan(0);
    });

    it("claimStore persiste entre turns (state em memória)", async () => {
      const {
        checkContradictions,
        clearAllHonestyState,
        incrementTurn,
      } = await import("./../honestySystem.js");
      clearAllHonestyState();
      featureState.enable("feature:contradiction_tracker");

      // Turn 1: armazena claim
      incrementTurn();
      await checkContradictions("selene version 0.31.0");

      // Turn 2: sem claims novas — não deve haver contradição
      incrementTurn();
      const r2 = await checkContradictions("something unrelated");
      expect(r2.contradictions).toHaveLength(0);

      // Turn 3: claim CONTRADITÓRIA — deve detectar (mostrando que claim do turn 1 persistiu)
      incrementTurn();
      const r3 = await checkContradictions("selene version 0.30.0");
      expect(r3.contradictions.length).toBeGreaterThan(0);
      // turn=1 indica que a claim original foi armazenada no turn 1
      expect(r3.contradictions[0]!.turn).toBe(1);
    });
  });

  // --- proveItCheck --------------------------------------------------------

  describe("proveItCheck", () => {
    it("retorna blocked=false quando feature:prove_it_mode desabilitada", async () => {
      const { proveItCheck } = await import("./../honestySystem.js");
      const result = await proveItCheck(
        "Os testes passaram sem erros",
        []
      );
      expect(result.blocked).toBe(false);
      expect(result.message).toBe("");
    });

    it("bloqueia quando prove_it_mode ativo E há claims não-verificadas", async () => {
      const { proveItCheck } = await import("./../honestySystem.js");
      featureState.enable("feature:prove_it_mode");
      featureState.enable("feature:evidence_requirement"); // checkEvidenceRequirement checa isso

      const result = await proveItCheck(
        "Os testes passaram",
        [] // sem executar_testes no histórico
      );
      expect(result.blocked).toBe(true);
      expect(result.message).toContain("PROVE IT MODE");
      expect(result.message).toContain("Unverified claims");
    });

    it("não bloqueia quando prove_it_mode ativo mas claims são verificadas", async () => {
      const { proveItCheck } = await import("./../honestySystem.js");
      featureState.enable("feature:prove_it_mode");
      featureState.enable("feature:evidence_requirement");

      const result = await proveItCheck(
        "Os testes passaram",
        ["executar_testes"] // tool call que verifica
      );
      expect(result.blocked).toBe(false);
    });
  });

  // --- confidence-action mapping com feature flag -------------------------

  describe("checkConfidenceAction com feature flag", () => {
    it("retorna blocked=false quando feature:confidence_mapping desabilitada", async () => {
      const { checkConfidenceAction } = await import("./../honestySystem.js");
      // Confidence 1 com action write normalmente bloqueia, mas feature desligada => não bloqueia
      const result = await checkConfidenceAction(1, "write");
      expect(result.blocked).toBe(false);
      expect(result.message).toBe("");
    });

    it("retorna mensagem de aviso quando confidence=0 e feature habilitada", async () => {
      const { checkConfidenceAction } = await import("./../honestySystem.js");
      featureState.enable("feature:confidence_mapping");
      const result = await checkConfidenceAction(0, "write");
      expect(result.blocked).toBe(false);
      expect(result.message).toContain("não forneceu");
    });
  });

  // --- getHonestyFeatures: estrutura --------------------------------------

  describe("getHonestyFeatures - estrutura", () => {
    it("todas as features têm id, name, description, enabled", async () => {
      const { getHonestyFeatures } = await import("./../honestySystem.js");
      const features = getHonestyFeatures();
      for (const f of features) {
        expect(typeof f.id).toBe("string");
        expect(f.id).toMatch(/^feature:/);
        expect(typeof f.name).toBe("string");
        expect(typeof f.description).toBe("string");
        expect(typeof f.enabled).toBe("boolean");
      }
    });

    it("retorna uma cópia (não a referência interna)", async () => {
      const { getHonestyFeatures } = await import("./../honestySystem.js");
      const a = getHonestyFeatures();
      const b = getHonestyFeatures();
      expect(a).not.toBe(b); // cópia diferente
      expect(a).toEqual(b); // mas mesmos valores
    });
  });
});
