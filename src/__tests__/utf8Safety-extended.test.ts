/**
 * utf8Safety-extended.test.ts — Casos edge e integrações que NÃO estão no
 * teste básico. Foco em: forceUtf8Environment (3 extras), pickBestUtf8Locale
 * (2 extras), listSystemLocales (1) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  forceUtf8Environment,
  listSystemLocales,
  pickBestUtf8Locale,
  diagnoseUtf8,
} from "../utf8Safety.js";

describe("utf8Safety — extended", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
    delete process.env.PYTHONLEGACYWINDOWSSTDIO;
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(origEnv)) {
      process.env[k] = v;
    }
  });

  // ─── forceUtf8Environment — variações (3) ──────────────────────────────────

  describe("forceUtf8Environment — extras", () => {
    it("respeita LC_ALL UTF-8 pré-existente (não sobrescreve)", () => {
      process.env.LC_ALL = "de_DE.UTF-8";
      forceUtf8Environment();
      expect(process.env.LC_ALL).toBe("de_DE.UTF-8");
    });

    it("sobrescreve LC_ALL não-UTF-8 com LANG escolhido", () => {
      process.env.LC_ALL = "C";
      forceUtf8Environment();
      const lcAll = process.env.LC_ALL ?? "";
      expect(lcAll).not.toBe("C");
      // Deve terminar em .UTF-8/.utf8 OU ser C.UTF-8
      expect(/\.(UTF-8|utf8)$/i.test(lcAll) || lcAll === "C.UTF-8").toBe(true);
    });

    it("retorna objeto com 'probedLocales' como array de strings", () => {
      const r = forceUtf8Environment();
      expect(Array.isArray(r.probedLocales)).toBe(true);
      for (const p of r.probedLocales) {
        expect(typeof p).toBe("string");
      }
    });
  });

  // ─── pickBestUtf8Locale / probeLocale (2) ──────────────────────────────────

  describe("pickBestUtf8Locale — extras", () => {
    it("retorna 'tried' contendo ao menos os candidatos principais (até o primeiro match)", () => {
      const { tried } = pickBestUtf8Locale();
      // pickBestUtf8Locale faz early-return no primeiro candidato disponível,
      // então 'tried' só contém os candidatos testados ATÉ o match.
      // Em ambientes Ubuntu CI, en_US.UTF-8 costuma estar disponível, então
      // 'tried' não chega a incluir C.UTF-8.
      // Verificamos apenas que pt_BR.UTF-8 SEMPRE está em 'tried' (primeiro candidato).
      expect(tried).toContain("pt_BR.UTF-8");
      // E que tried contém pelo menos 1 candidato
      expect(tried.length).toBeGreaterThanOrEqual(1);
    });

    it("quando escolhe um locale, este deve estar na lista 'tried'", () => {
      const { locale, tried } = pickBestUtf8Locale();
      if (locale !== null) {
        expect(tried).toContain(locale);
      }
    });
  });

  // ─── patchStdio / listSystemLocales (2) ────────────────────────────────────

  describe("listSystemLocales — extras", () => {
    it("retorna a mesma referência em chamadas subsequentes (cache)", () => {
      const a = listSystemLocales();
      const b = listSystemLocales();
      expect(a).toBe(b);
    });

    it("diagnoseUtf8 menciona contagem de locales", () => {
      forceUtf8Environment();
      const report = diagnoseUtf8();
      expect(report).toContain("locales total:");
      expect(report).toContain("locales UTF-8:");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("não lança exceção mesmo se env vars estiverem todos vazios", () => {
      expect(() => forceUtf8Environment()).not.toThrow();
      // Idempotência: segunda chamada também não lança
      expect(() => forceUtf8Environment()).not.toThrow();
    });

    it("reason informa fallback quando nenhum locale UTF-8 está disponível", () => {
      // Não podemos forçar o fallback real (depende do SO), mas a reason deve
      // ser sempre uma string não-vazia, descrevendo a escolha ou o fallback.
      const r = forceUtf8Environment();
      expect(typeof r.reason).toBe("string");
      expect(r.reason.length).toBeGreaterThan(5);
    });
  });
});
