/**
 * i18n.test.ts - Tests for slash command internationalization.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("i18n", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset language-related env vars
    delete process.env.CLAUDE_KILLER_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    delete process.env.LANGUAGE;
    vi.resetModules();
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
  });

  describe("detectLanguage", () => {
    it("should return pt-BR when LANG=pt_BR.UTF-8", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("pt-BR");
    });

    it("should return pt-BR when LC_ALL=pt_BR.UTF-8", async () => {
      process.env.LC_ALL = "pt_BR.UTF-8";
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("pt-BR");
    });

    it("should return en when LANG=en_US.UTF-8", async () => {
      process.env.LANG = "en_US.UTF-8";
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("en");
    });

    it("should return en when no env vars set (default)", async () => {
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("en");
    });

    it("should respect CLAUDE_KILLER_LANG=pt-BR override", async () => {
      process.env.CLAUDE_KILLER_LANG = "pt-BR";
      process.env.LANG = "en_US.UTF-8";  // would normally return en
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("pt-BR");
    });

    it("should respect CLAUDE_KILLER_LANG=en override", async () => {
      process.env.CLAUDE_KILLER_LANG = "en";
      process.env.LANG = "pt_BR.UTF-8";  // would normally return pt-BR
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("en");
    });

    it("should detect pt from LANGUAGE env var", async () => {
      process.env.LANGUAGE = "pt_BR:pt:en";
      const { detectLanguage } = await import("./../i18n.js");
      expect(detectLanguage()).toBe("pt-BR");
    });
  });

  describe("getCommandI18n", () => {
    it("should return English description by default", async () => {
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/help");
      expect(i18n.desc).toBe("Show help");
    });

    it("should return Portuguese description when LANG=pt_BR", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/help");
      expect(i18n.desc).toBe("Mostrar ajuda");
    });

    it("should return subcommands for /effort", async () => {
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/effort");
      expect(i18n.subcommands).toEqual(["low", "medium", "high", "max"]);
    });

    it("should return subcommands for /mode", async () => {
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/mode");
      expect(i18n.subcommands).toEqual(["roblox", "devops", "off", "create", "confirm", "new", "keep"]);
    });

    it("should return empty desc for unknown command", async () => {
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/nonexistent");
      expect(i18n.desc).toBe("");
    });

    it("should return PT-BR description for /effort", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/effort");
      expect(i18n.desc).toContain("esforço");
    });

    it("should return PT-BR description for /hub", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { getCommandI18n } = await import("./../i18n.js");
      const i18n = getCommandI18n("/hub");
      expect(i18n.desc).toContain("Hub");
    });
  });

  describe("getLocalizedSlashCommands", () => {
    it("should return all 19 commands", async () => {
      const { getLocalizedSlashCommands } = await import("./../i18n.js");
      const cmds = getLocalizedSlashCommands();
      expect(cmds.length).toBe(19);
      expect(cmds.some((c) => c.cmd === "/help")).toBe(true);
      expect(cmds.some((c) => c.cmd === "/effort")).toBe(true);
      expect(cmds.some((c) => c.cmd === "/mode")).toBe(true);
      expect(cmds.some((c) => c.cmd === "/exit")).toBe(true);
    });

    it("should include subcommands for commands that have them", async () => {
      const { getLocalizedSlashCommands } = await import("./../i18n.js");
      const cmds = getLocalizedSlashCommands();
      const effort = cmds.find((c) => c.cmd === "/effort");
      expect(effort?.subcommands).toEqual(["low", "medium", "high", "max"]);
      const mode = cmds.find((c) => c.cmd === "/mode");
      expect(mode?.subcommands).toEqual(["roblox", "devops", "off", "create", "confirm", "new", "keep"]);
    });

    it("should not include subcommands for commands without them", async () => {
      const { getLocalizedSlashCommands } = await import("./../i18n.js");
      const cmds = getLocalizedSlashCommands();
      const help = cmds.find((c) => c.cmd === "/help");
      expect(help?.subcommands).toBeUndefined();
    });

    it("should return PT-BR descriptions when language is pt-BR", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { getLocalizedSlashCommands } = await import("./../i18n.js");
      const cmds = getLocalizedSlashCommands();
      const help = cmds.find((c) => c.cmd === "/help");
      expect(help?.desc).toBe("Mostrar ajuda");
      const exit = cmds.find((c) => c.cmd === "/exit");
      expect(exit?.desc).toBe("Sair");
    });
  });

  describe("setLanguage", () => {
    it("should override detected language", async () => {
      process.env.LANG = "pt_BR.UTF-8";
      const { setLanguage, getCommandI18n } = await import("./../i18n.js");
      setLanguage("en");
      const i18n = getCommandI18n("/help");
      expect(i18n.desc).toBe("Show help");  // English, not PT-BR
    });
  });
});
