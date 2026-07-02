/**
 * i18n-coverage.test.ts — Testes de cobertura do i18n
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectLanguage, setLanguage, resetLanguageCache, t, getCommandI18n, getLocalizedSlashCommands, resetAllLanguageState } from "../i18n.js";

describe("i18n — coverage", () => {
  beforeEach(() => {
    resetAllLanguageState();
  });

  afterEach(() => {
    resetAllLanguageState();
  });

  describe("detectLanguage", () => {
    it("retorna pt-BR ou en", () => {
      const lang = detectLanguage();
      expect(["pt-BR", "en"]).toContain(lang);
    });
  });

  describe("setLanguage", () => {
    it("muda idioma para en", () => {
      setLanguage("en");
      expect(detectLanguage()).toBe("en");
    });

    it("muda idioma para pt-BR", () => {
      setLanguage("pt-BR");
      expect(detectLanguage()).toBe("pt-BR");
    });
  });

  describe("resetLanguageCache", () => {
    it("não lança exceção", () => {
      expect(() => resetLanguageCache()).not.toThrow();
    });
  });

  describe("t (translation)", () => {
    it("retorna string para chave conhecida", () => {
      setLanguage("en");
      const result = t("ui.untitled");
      expect(typeof result).toBe("string");
    });

    it("retorna string para chave com argumentos", () => {
      setLanguage("en");
      const result = t("tool.web_results", 5, "test query");
      expect(typeof result).toBe("string");
      expect(result).toContain("5");
    });

    it("retorna chave original para chave desconhecida", () => {
      const result = t("nonexistent.key.12345");
      expect(result).toContain("nonexistent");
    });
  });

  describe("getCommandI18n", () => {
    it("retorna desc para comando conhecido", () => {
      setLanguage("en");
      const result = getCommandI18n("/help");
      expect(result).toHaveProperty("desc");
      expect(typeof result.desc).toBe("string");
    });

    it("retorna desc vazio para comando desconhecido", () => {
      const result = getCommandI18n("/nonexistent");
      expect(result.desc).toBe("");
    });
  });

  describe("getLocalizedSlashCommands", () => {
    it("retorna array com /help", () => {
      const cmds = getLocalizedSlashCommands();
      expect(Array.isArray(cmds)).toBe(true);
      expect(cmds.some(c => c.cmd === "/help")).toBe(true);
    });

    it("retorna array com /searx", () => {
      const cmds = getLocalizedSlashCommands();
      expect(cmds.some(c => c.cmd === "/searx")).toBe(true);
    });

    it("retorna 22 comandos", () => {
      const cmds = getLocalizedSlashCommands();
      expect(cmds.length).toBe(22);
    });
  });
});
