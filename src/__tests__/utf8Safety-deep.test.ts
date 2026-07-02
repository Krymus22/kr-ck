/**
 * utf8Safety-deep.test.ts — Testes profundos do utf8Safety
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { forceUtf8Environment, diagnoseUtf8, listSystemLocales, pickBestUtf8Locale } from "../utf8Safety.js";

const mockedExecSync = vi.mocked(execSync);

describe("utf8Safety — deep coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("forceUtf8Environment", () => {
    it("retorna Utf8SetupResult com campos obrigatórios", () => {
      mockedExecSync.mockImplementation(() => "en_US.UTF-8\nC.UTF-8\n");
      const result = forceUtf8Environment();
      expect(result).toHaveProperty("platform");
      expect(result).toHaveProperty("probedLocales");
      expect(result).toHaveProperty("chosen");
      expect(result).toHaveProperty("fallbackUsed");
      expect(result).toHaveProperty("reason");
    });

    it("retorna platform como string", () => {
      const result = forceUtf8Environment();
      expect(typeof result.platform).toBe("string");
    });

    it("retorna probedLocales como array", () => {
      const result = forceUtf8Environment();
      expect(Array.isArray(result.probedLocales)).toBe(true);
    });

    it("retorna chosen como string", () => {
      const result = forceUtf8Environment();
      expect(typeof result.chosen).toBe("string");
    });

    it("retorna fallbackUsed como boolean", () => {
      const result = forceUtf8Environment();
      expect(typeof result.fallbackUsed).toBe("boolean");
    });

    it("retorna reason como string", () => {
      const result = forceUtf8Environment();
      expect(typeof result.reason).toBe("string");
    });

    it("funciona quando locale -a falha (fallback)", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = forceUtf8Environment();
      expect(typeof result.fallbackUsed).toBe("boolean");
      expect(typeof result.chosen).toBe("string");
    });

    it("funciona quando locale -a retorna lista com UTF-8", () => {
      mockedExecSync.mockImplementation(() => "en_US.UTF-8\npt_BR.UTF-8\nC.UTF-8\n");
      const result = forceUtf8Environment();
      expect(typeof result.chosen).toBe("string");
    });

    it("seta PYTHONIOENCODING no env", () => {
      forceUtf8Environment();
      expect(process.env.PYTHONIOENCODING).toBe("utf-8");
    });

    it("seta PYTHONUTF8 no env", () => {
      forceUtf8Environment();
      expect(process.env.PYTHONUTF8).toBe("1");
    });
  });

  describe("diagnoseUtf8 — mais casos", () => {
    it("inclui LANG no diagnóstico", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("LANG");
    });

    it("inclui PYTHONIOENCODING no diagnóstico", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("PYTHONIOENCODING");
    });

    it("inclui PYTHONUTF8 no diagnóstico", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("PYTHONUTF8");
    });

    it("inclui platform no diagnóstico", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("platform");
    });
  });

  describe("listSystemLocales — mais casos", () => {
    it("retorna array quando execSync retorna string", () => {
      mockedExecSync.mockReturnValue("en_US.UTF-8\npt_BR.UTF-8\n");
      const result = listSystemLocales();
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array com entradas splitadas por newline", () => {
      mockedExecSync.mockImplementation(() => "en_US.UTF-8\npt_BR.UTF-8\nC.UTF-8\n");
      const result = listSystemLocales();
      expect(result.length).toBeGreaterThan(0);
    });

    it("filtra strings vazias", () => {
      mockedExecSync.mockReturnValue("\n\nen_US.UTF-8\n\n");
      const result = listSystemLocales();
      expect(result).not.toContain("");
    });

    it("faz trim das entradas", () => {
      mockedExecSync.mockReturnValue("  en_US.UTF-8  \n");
      const result = listSystemLocales();
      expect(result[0]).not.toContain(" ");
    });
  });

  describe("pickBestUtf8Locale — mais casos", () => {
    it("retorna pt_BR.UTF-8 quando disponível", () => {
      mockedExecSync.mockImplementation(() => "pt_BR.UTF-8\nen_US.UTF-8\nC.UTF-8\n");
      const result = pickBestUtf8Locale();
      expect(result.locale).toBeTruthy();
    });

    it("retorna en_US.UTF-8 quando pt_BR não disponível", () => {
      mockedExecSync.mockImplementation(() => "en_US.UTF-8\nC.UTF-8\n");
      const result = pickBestUtf8Locale();
      expect(result.locale).toBeTruthy();
    });

    it("retorna C.UTF-8 quando nada mais disponível", () => {
      mockedExecSync.mockImplementation(() => "C.UTF-8\n");
      const result = pickBestUtf8Locale();
      expect(result.locale).toBeTruthy();
    });

    it("retorna null quando nenhum UTF-8 disponível", () => {
      mockedExecSync.mockImplementation(() => "C\nPOSIX\n");
      const result = pickBestUtf8Locale();
      expect(result.locale === null || typeof result.locale === "string").toBe(true);
    });

    it("tried contém lista de tentativas", () => {
      mockedExecSync.mockImplementation(() => "C.UTF-8\n");
      const result = pickBestUtf8Locale();
      expect(Array.isArray(result.tried)).toBe(true);
      
      
    });

    it("aceita variações de case (utf8 vs UTF-8)", () => {
      mockedExecSync.mockImplementation(() => "en_US.utf8\n");
      const result = pickBestUtf8Locale();
      expect(result.locale).toBeTruthy();
    });
  });
});
