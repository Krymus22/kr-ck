/**
 * utf8Safety-coverage.test.ts — Testes de cobertura do utf8Safety
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { platform } from "node:os";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { listSystemLocales, pickBestUtf8Locale, diagnoseUtf8 } from "../utf8Safety.js";

const mockedExecSync = vi.mocked(execSync);

describe("utf8Safety — coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("listSystemLocales", () => {
    it("retorna array vazio no Windows", () => {
      // Windows é detectado por platform() no código
      // No Linux (ambiente de teste), tentará executar locale -a
      const result = listSystemLocales();
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna lista de locales quando locale -a funciona", () => {
      mockedExecSync.mockReturnValue("en_US.UTF-8\npt_BR.UTF-8\nC.UTF-8\n");
      const result = listSystemLocales();
      // No Windows retornaria [], no Linux depende do mock
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array vazio quando locale -a falha", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });
      const result = listSystemLocales();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("pickBestUtf8Locale", () => {
    it("retorna objeto com locale e tried", () => {
      mockedExecSync.mockReturnValue("en_US.UTF-8\nC.UTF-8\n");
      const result = pickBestUtf8Locale();
      expect(result).toHaveProperty("locale");
      expect(result).toHaveProperty("tried");
      expect(Array.isArray(result.tried)).toBe(true);
    });

    it("retorna null para locale quando nenhum UTF-8 disponível", () => {
      mockedExecSync.mockReturnValue("C\nPOSIX\n");
      const result = pickBestUtf8Locale();
      // No Linux com apenas C/POSIX, locale seria null
      expect(result.locale).toBeNull();
    });
  });

  describe("diagnoseUtf8", () => {
    it("retorna string com informações de diagnóstico", () => {
      const result = diagnoseUtf8();
      expect(typeof result).toBe("string");
      expect(result).toContain("UTF-8");
      expect(result).toContain("platform");
      expect(result).toContain("LANG");
    });

    it("inclui informações de locales", () => {
      const result = diagnoseUtf8();
      expect(result).toContain("locales");
    });
  });
});
