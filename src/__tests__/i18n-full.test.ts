/**
 * i18n-full.test.ts — Cobertura completa do i18n
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectLanguage, setLanguage, resetLanguageCache, resetAllLanguageState,
  t, getCommandI18n, getLocalizedSlashCommands,
} from "../i18n.js";

describe("i18n — full coverage", () => {
  beforeEach(() => { resetAllLanguageState(); });
  afterEach(() => { resetAllLanguageState(); });

  describe("detectLanguage", () => {
    it("retorna pt-BR ou en", () => {
      const lang = detectLanguage();
      expect(["pt-BR", "en"]).toContain(lang);
    });
  });

  describe("setLanguage", () => {
    it("muda para en", () => {
      setLanguage("en");
      expect(detectLanguage()).toBe("en");
    });
    it("muda para pt-BR", () => {
      setLanguage("pt-BR");
      expect(detectLanguage()).toBe("pt-BR");
    });
  });

  describe("resetLanguageCache", () => {
    it("não lança exceção", () => {
      expect(() => resetLanguageCache()).not.toThrow();
    });
  });

  describe("t (translation) — mais chaves", () => {
    it("traduz tool.web_results em en", () => {
      setLanguage("en");
      const result = t("tool.web_results", 5, "query");
      expect(typeof result).toBe("string");
      expect(result).toContain("5");
    });
    it("traduz tool.web_results em pt-BR", () => {
      setLanguage("pt-BR");
      const result = t("tool.web_results", 3, "query");
      expect(typeof result).toBe("string");
    });
    it("traduz ui.untitled", () => {
      const result = t("ui.untitled");
      expect(typeof result).toBe("string");
    });
    it("retorna chave para chave inexistente", () => {
      const result = t("nonexistent.key.999");
      expect(result).toContain("nonexistent");
    });
  });

  describe("getCommandI18n — mais comandos", () => {
    it("retorna desc para /help", () => {
      setLanguage("en");
      const result = getCommandI18n("/help");
      expect(result.desc.length).toBeGreaterThan(0);
    });
    it("retorna desc para /mode com subcommands", () => {
      setLanguage("en");
      const result = getCommandI18n("/mode");
      expect(result.subcommands).toBeDefined();
      expect(result.subcommands!.length).toBeGreaterThan(0);
    });
    it("retorna desc para /effort com subcommands", () => {
      setLanguage("en");
      const result = getCommandI18n("/effort");
      expect(result.subcommands).toBeDefined();
    });
    it("retorna desc para /searx", () => {
      setLanguage("en");
      const result = getCommandI18n("/searx");
      expect(result.desc.length).toBeGreaterThan(0);
    });
    it("retorna desc vazio para comando inexistente", () => {
      const result = getCommandI18n("/nonexistent");
      expect(result.desc).toBe("");
    });
  });

  describe("getLocalizedSlashCommands — completa", () => {
    it("retorna 22 comandos", () => {
      const cmds = getLocalizedSlashCommands();
      expect(cmds.length).toBe(22);
    });
    it("inclui /help, /mode, /compact, /searx, /exit", () => {
      const cmds = getLocalizedSlashCommands();
      const names = cmds.map(c => c.cmd);
      expect(names).toContain("/help");
      expect(names).toContain("/mode");
      expect(names).toContain("/compact");
      expect(names).toContain("/searx");
      expect(names).toContain("/exit");
    });
    it("cada comando tem desc não vazia", () => {
      const cmds = getLocalizedSlashCommands();
      for (const cmd of cmds) {
        expect(cmd.desc.length).toBeGreaterThan(0);
      }
    });
    it("/mode tem subcommands", () => {
      const cmds = getLocalizedSlashCommands();
      const mode = cmds.find(c => c.cmd === "/mode");
      expect(mode?.subcommands).toBeDefined();
      expect(mode!.subcommands!.length).toBeGreaterThan(0);
    });
  });
});
