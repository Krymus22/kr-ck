/**
 * promiseDetector-extended.test.ts — Casos edge e integrações que NÃO estão
 * no teste básico. Foco em: detectFalsePromise (variações extras),
 * buildFalsePromiseRejectionMessage (variações), shouldBlockForFalsePromise
 * (loops e contagem), e edge cases (mensagens longas, frases mistas).
 *
 * PT-BR nos comentários, conforme convenção do projeto.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  detectFalsePromise,
  buildFalsePromiseRejectionMessage,
  shouldBlockForFalsePromise,
  resetFalsePromiseCounter,
  getFalsePromiseCount,
  MAX_FALSE_PROMISE_RETRIES,
} from "../promiseDetector.js";

describe("promiseDetector — extended", () => {
  beforeEach(() => {
    resetFalsePromiseCounter();
  });

  // ─── detectFalsePromise — variações extras (3) ─────────────────────────────

  describe("detectFalsePromise — variações extras", () => {
    it("detecta 'vou pesquisar' (PT) sem colisão com outras frases", () => {
      const r = detectFalsePromise("Beleza, vou pesquisar mais a fundo.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("vou pesquisar");
    });

    it("detecta 'let me run' (EN) mesmo cercado por pontuação", () => {
      const r = detectFalsePromise("Sure — let me run the tests now!", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("let me run");
    });

    it("não detecta quando toolsCalled e filesTouched são ambos > 0", () => {
      const r = detectFalsePromise("Vou investigar mais.", 2, 3);
      expect(r.detected).toBe(false);
      expect(r.reason).toMatch(/actions were taken/);
    });
  });

  // ─── shouldBlockForFalsePromise — contagem e bloqueio (2) ──────────────────

  describe("shouldBlockForFalsePromise — contagem", () => {
    it("incrementa o contador exatamente uma vez por chamada detectada", () => {
      expect(getFalsePromiseCount()).toBe(0);
      shouldBlockForFalsePromise("Vou verificar isso.", 0, 0);
      expect(getFalsePromiseCount()).toBe(1);
      shouldBlockForFalsePromise("Vou checar agora.", 0, 0);
      expect(getFalsePromiseCount()).toBe(2);
    });

    it(" após atingir MAX_FALSE_PROMISE_RETRIES, terceira chamada não bloqueia", () => {
      // Duas primeiras bloqueiam
      shouldBlockForFalsePromise("Vou investigar.", 0, 0);
      shouldBlockForFalsePromise("Vou verificar.", 0, 0);
      // Terceira: ainda detecta a frase mas NÃO bloqueia
      const r = shouldBlockForFalsePromise("Vou olhar.", 0, 0);
      expect(r.block).toBe(false);
      expect(r.reason).toContain("max false-promise retries");
    });
  });

  // ─── buildFalsePromiseRejectionMessage — variações (2) ─────────────────────

  describe("buildFalsePromiseRejectionMessage — variações", () => {
    it("marca '[FALSE_PROMISE_DETECTED]' como prefixo na primeira tentativa", () => {
      const msg = buildFalsePromiseRejectionMessage("vou ver", 1);
      expect(msg.startsWith("[FALSE_PROMISE_DETECTED]")).toBe(true);
    });

    it("adiciona sufixo '(tentativa N de 2)' apenas quando attempt > 1", () => {
      const m1 = buildFalsePromiseRejectionMessage("vou ver", 1);
      const m2 = buildFalsePromiseRejectionMessage("vou ver", 2);
      expect(m1).not.toContain("tentativa 1");
      expect(m2).toContain("(tentativa 2 de 2)");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("lida com mensagem enorme contendo frase de promessa sem travar", () => {
      const giant = "x".repeat(50_000) + " vou investigar mais " + "y".repeat(50_000);
      const start = Date.now();
      const r = detectFalsePromise(giant, 0, 0);
      const elapsed = Date.now() - start;
      expect(r.detected).toBe(true);
      expect(elapsed).toBeLessThan(500); // deve ser rápido mesmo com string grande
    });

    it("frase de recusa em inglês 'unfortunately' desativa a detecção", () => {
      const r = detectFalsePromise("Unfortunately I can't access that right now.", 0, 0);
      expect(r.detected).toBe(false);
      expect(r.reason).toContain("refusal phrase");
    });

    it("MAX_FALSE_PROMISE_RETRIES permanece estável entre resets", () => {
      const original = MAX_FALSE_PROMISE_RETRIES;
      resetFalsePromiseCounter();
      expect(MAX_FALSE_PROMISE_RETRIES).toBe(original);
    });
  });

  // ─── BUGFIX: falsos positivos em substrings (4) ────────────────────────────
  //
  // Antes do fix, frases genéricas como "eu vou " e "i'll try" eram matcheadas
  // como substring, disparando o detector em respostas explicativas ("eu vou
  // explicar X", "i'll try to think"). Agora só disparam quando seguidas de
  // verbo de ação específico (via lista de frases) e com word boundaries `\b`.

  describe("BUGFIX — falsos positivos em substrings não disparam mais", () => {
    it("'eu vou explicar' NÃO dispara (vou + verbo não-ação)", () => {
      const r = detectFalsePromise("Eu vou explicar como isso funciona.", 0, 0);
      expect(r.detected).toBe(false);
      expect(r.reason).toContain("no promise phrase");
    });

    it("'i'll try to think' NÃO dispara (i'll try era muito genérico)", () => {
      const r = detectFalsePromise("I'll try to think about this for a moment.", 0, 0);
      expect(r.detected).toBe(false);
      expect(r.reason).toContain("no promise phrase");
    });

    it("'vou pensar' NÃO dispara (não é verbo de ação concreta)", () => {
      const r = detectFalsePromise("Vou pensar um pouco antes de responder.", 0, 0);
      expect(r.detected).toBe(false);
      expect(r.reason).toContain("no promise phrase");
    });

    it("'eu vou analisar a situação' dispara via 'vou analisar' (não depende de 'eu vou')", () => {
      // "eu vou" foi removido; mas "vou analisar" continua na lista e matcheia
      const r = detectFalsePromise("Eu vou analisar a situação agora.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("vou analisar");
    });
  });

  describe("BUGFIX — true positives preservados após refinar regex", () => {
    it("'eu vou criar' dispara (via 'vou criar')", () => {
      const r = detectFalsePromise("Eu vou criar um arquivo novo.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("vou criar");
    });

    it("'vou fazer X' dispara (via 'vou fazer')", () => {
      const r = detectFalsePromise("Vou fazer a alteração agora.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("vou fazer");
    });

    it("'i'll implement' dispara (nova frase adicionada)", () => {
      const r = detectFalsePromise("I'll implement that feature for you.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("i'll implement");
    });

    it("'i will implement' dispara (variante com 'will')", () => {
      const r = detectFalsePromise("I will implement the fix right away.", 0, 0);
      expect(r.detected).toBe(true);
      expect(r.matchedPhrase).toBe("i will implement");
    });

    it("word boundary impede match no meio de palavra (ex.: 'abcvouinvestigar' não dispara)", () => {
      // Sem \b, "vou investigar" matcheava como substring de "abcvouinvestigar".
      // Com \b, exige fronteira de palavra antes de "vou" e depois de "investigar".
      const r = detectFalsePromise("abcvouinvestigarxyz mais texto", 0, 0);
      expect(r.detected).toBe(false);
    });
  });
});
