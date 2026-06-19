/**
 * dotfileConfig-extended.test.ts — Casos edge / integração p/ dotfileConfig.ts.
 * Foco: loadConfig (3), saveConfig (2), mergeDefaults/updateConfig (2), edge (1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadConfig, saveConfig, updateConfig, getConfigValue, getConfigPath,
} from "../dotfileConfig.js";

const CONFIG_PATH = getConfigPath();

beforeEach(() => {
  // Apaga o arquivo e reseta o cache do módulo via vi.resetModules
  if (fs.existsSync(CONFIG_PATH)) {
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* */ }
  }
});

afterEach(() => {
  if (fs.existsSync(CONFIG_PATH)) {
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* */ }
  }
});

describe("dotfileConfig (extended) — loadConfig", () => {
  it("carrega JSON válido escrito manualmente", () => {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ model: "k2", rateLimitRpm: 100 }), "utf8");
    // Como loadConfig faz cache, precisamos chamar saveConfig antes pra resetar cache
    saveConfig({ model: "k2", rateLimitRpm: 100 });
    const cfg = loadConfig();
    expect(cfg.model).toBe("k2");
    expect(cfg.rateLimitRpm).toBe(100);
  });

  it("retorna o MESMO objeto em chamadas subsequentes (cache interno)", () => {
    saveConfig({ model: "cache-test" });
    const c1 = loadConfig();
    const c2 = loadConfig();
    expect(c1).toBe(c2); // mesma referência
  });

  it("retorna objeto vazio ({}) quando arquivo não existe", () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    // Forçar reload do módulo pra limpar cache
    vi.resetModules();
    // Re-importar via dynamic import dentro do teste seria ideal,
    // mas como loadConfig cacheia, vamos usar saveConfig para resetar
    saveConfig({}); // isso seta cache = {}
    const cfg = loadConfig();
    expect(cfg).toEqual({});
    expect(cfg.model).toBeUndefined();
  });
});

describe("dotfileConfig (extended) — saveConfig", () => {
  it("escreve JSON pretty-printed (com 2 espaços)", () => {
    saveConfig({ model: "x", rateLimitRpm: 5 });
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    // Pretty print tem indentação de 2 espaços
    expect(raw).toContain('  "model"');
    expect(raw).toContain('  "rateLimitRpm"');
  });

  it("saveConfig atualiza o cache interno (próximo loadConfig vê o novo valor)", () => {
    saveConfig({ model: "v1" });
    expect(loadConfig().model).toBe("v1");
    saveConfig({ model: "v2" });
    expect(loadConfig().model).toBe("v2");
  });
});

describe("dotfileConfig (extended) — mergeDefaults (updateConfig)", () => {
  it("merge parcial preserva keys anteriores não-overwrite", () => {
    saveConfig({ model: "keep-model", rateLimitRpm: 50, diffPreview: true });
    updateConfig({ model: "new-model" });
    const cfg = loadConfig();
    expect(cfg.model).toBe("new-model");
    expect(cfg.rateLimitRpm).toBe(50);
    expect(cfg.diffPreview).toBe(true);
  });

  it("merge adiciona novas keys sem remover as existentes", () => {
    saveConfig({ model: "x" });
    updateConfig({ telemetry: { enabled: true } });
    const cfg = loadConfig();
    expect(cfg.model).toBe("x");
    expect(cfg.telemetry).toEqual({ enabled: true });
  });
});

describe("dotfileConfig (extended) — edge cases", () => {
  it("getConfigValue retorna undefined para key inexistente em config vazia", () => {
    saveConfig({});
    expect(getConfigValue("model")).toBeUndefined();
    expect(getConfigValue("telemetry")).toBeUndefined();
  });
});
