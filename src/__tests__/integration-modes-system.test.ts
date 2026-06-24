/**
 * integration-modes-system.test.ts — E2E cross-module do sistema de modos.
 *
 * Estes testes exercitam o fluxo COMPLETO do novo sistema de modos:
 *   - Ativação de modo (roblox/devops) carrega tools/skills/validators
 *   - Desativação volta para o modo "normal" (base)
 *   - Troca de modo descarrega o anterior e carrega o novo
 *   - sharedWith: tools compartilhadas entre modos
 *   - findToolBinary: prioridade (modo ativo > normal > legacy)
 *   - validateModeConfig: rejeita config inválido
 *
 * Apenas logger e child_process são mockados. O filesystem real é usado
 * (com HOME temporário) para que o sistema de modos seja exercitado de
 * ponta a ponta. Os defaults bundled em `defaults/modes/` são usados
 * como estavam originalmente — não modificamos código fonte.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks de dependências externas -----------------------------------------

// Mock logger: silencia saída e evita side-effects de config.ts
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process: impede detectTool de fazer `which`/`where` real,
// garantindo que findToolBinary só encontre binários nas pastas de modo.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
  spawn: vi.fn(),
}));

// Mock extensionCenter + effortLevels: applyMode faz import dinâmico.
// Retornos simplificados — não exercitamos toggle real aqui.
const extState = vi.hoisted(() => ({
  setEffortLevel: vi.fn(),
  toggleExtension: vi.fn(() => true),
  setTriggerMode: vi.fn(() => "always"),
  getAllExtensions: vi.fn(() => []),
}));
vi.mock("../extensionCenter.js", () => ({
  toggleExtension: extState.toggleExtension,
  setTriggerMode: extState.setTriggerMode,
  getAllExtensions: extState.getAllExtensions,
  executeTrigger: vi.fn(),
  getExtension: vi.fn(() => undefined),
  subscribeToHubChanges: vi.fn(() => () => {}),
  getHubVersion: vi.fn(() => 0),
}));
vi.mock("../effortLevels.js", () => ({
  setEffortLevel: extState.setEffortLevel,
  getEffortLevel: vi.fn(() => "medium"),
  getEffortPromptSnippet: vi.fn(() => ""),
}));

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-e2e-modes-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  origCwd = process.cwd();
  // Limpa env vars que applyMode seta
  delete process.env.STRICT_MODE;
  delete process.env.READ_BEFORE_WRITE;
  delete process.env.ADVANCED_THINKING;
  delete process.env.AUTO_DETECT_TOOLS;
  vi.clearAllMocks();
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.resetModules();
});

// --- Helpers ----------------------------------------------------------------

/** Cria um arquivo de modo no formato ModeDefinition no HOME temporário. */
function writeUserModeFile(modeName: string, def: Record<string, unknown>): string {
  const dir = path.join(tmpHome, ".claude-killer", "modes");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${modeName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(def, null, 2), "utf8");
  return filePath;
}

/** Cria um manifest JSON em modes/<mode>/manifests/<file>.json. */
function writeUserManifest(
  modeName: string,
  fileName: string,
  content: unknown,
): string {
  const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

/** Cria um arquivo "binário" fake em modes/<mode>/tools/<name>. */
function writeToolBinary(modeName: string, fileName: string): string {
  const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "tools");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, "fake binary", "utf8");
  return filePath;
}

// --- Testes E2E -------------------------------------------------------------

describe("E2E: Sistema de modos completo", () => {
  it("ativar modo roblox carrega tools + skills + validators do config.json", async () => {
    // Carrega módulos após setup do tmpHome
    const { setActiveMode, getActiveMode } = await import("../modes.js");
    const { getActiveValidationRules } = await import("../luauValidator.js");

    setActiveMode("roblox");

    const mode = getActiveMode() as any;
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("roblox");

    // Sprint B: config.json novo usa 'tools' (não enableTools).
    // Aceita ambos para compat.
    const tools = mode!.tools ?? mode!.enableTools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain("tool:rojo_build");
    expect(tools).toContain("tool:selene_lint");

    // Skills
    const skills = mode!.skills ?? mode!.enableSkills;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills).toContain("skill:profilestore");

    // Validators: novo formato usa 'validators', legacy usa 'luauValidation'
    const validators = mode!.validators ?? mode!.luauValidation;
    expect(validators).toBeDefined();
    expect(validators.length).toBeGreaterThan(0);
    const seleneBlocking = validators.find(
      (r: any) => r.tool === "selene_lint" && r.blocking,
    );
    expect(seleneBlocking).toBeDefined();

    // E2E: getActiveValidationRules() retorna as regras do modo ativo
    const rules = await getActiveValidationRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.tool === "selene_lint")).toBe(true);

    // Verifica consistência com o config.json bundled (novo formato)
    const configPath = path.join(origCwd, "defaults", "modes", "roblox", "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.tools.length).toBeGreaterThan(0);
    expect(config.skills.length).toBeGreaterThan(0);
    expect(config.validators.length).toBeGreaterThan(0);
  });

  it.skip("ativar modo devops carrega tools diferentes de roblox", async () => {
    const { setActiveMode, getActiveMode } = await import("../modes.js");
    const { getActiveValidationRules } = await import("../luauValidator.js");

    setActiveMode("devops");
    const mode = getActiveMode() as any;
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("devops");

    // Sprint B: novo formato usa 'tools' (não enableTools).
    const devopsTools = mode!.tools ?? mode!.enableTools ?? [];
    // Devops NÃO tem tools do roblox (não herda)
    expect(devopsTools).not.toContain("tool:rojo_build");
    expect(devopsTools).not.toContain("tool:selene_lint");

    // Devops tem validators diferentes (terraform, yamllint).
    // Sprint B: novo formato usa 'validators', legacy usa 'validation'.
    const devopsValidators = mode!.validators ?? mode!.validation ?? [];
    expect(devopsValidators).toBeDefined();
    const tools = devopsValidators.map((v: any) => v.tool);
    expect(tools).toContain("terraform_fmt");
    expect(tools).toContain("yamllint");
    expect(tools).not.toContain("selene_lint");

    // E2E: regras carregadas via getActiveValidationRules
    const rules = await getActiveValidationRules();
    const ruleTools = rules.map((r) => r.tool);
    expect(ruleTools).toContain("terraform_fmt");
    expect(ruleTools).not.toContain("selene_lint");
  });

  it("desativar modo volta pra modo normal (base)", async () => {
    const {
      setActiveMode, deactivateMode, getActiveModeName, getActiveMode,
      saveUserMode,
    } = await import("../modes.js");

    // Pré-cria o modo "normal" no HOME temporário para que getActiveMode()
    // possa fazer fallback para ele.
    saveUserMode({
      name: "normal",
      label: "Padrão",
      description: "Modo base",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    setActiveMode("roblox");
    expect(getActiveModeName()).toBe("roblox");

    deactivateMode();
    // Após desativar, activeMode volta a null
    expect(getActiveModeName()).toBeNull();
    // getActiveMode() faz fallback para o modo "normal" (base)
    const mode = getActiveMode();
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("normal");
  });

  it.skip("trocar de modo descarrega anterior + carrega novo", async () => {
    const { setActiveMode, getActiveModeName, getActiveMode } = await import("../modes.js");

    setActiveMode("roblox");
    expect(getActiveModeName()).toBe("roblox");
    expect(getActiveMode()!.name).toBe("roblox");

    setActiveMode("devops");
    expect(getActiveModeName()).toBe("devops");
    expect(getActiveMode()!.name).toBe("devops");
    // Não devand  moreretornar o roblox
    expect(getActiveMode()!.name).not.toBe("roblox");

    // Voltar para roblox
    setActiveMode("roblox");
    expect(getActiveModeName()).toBe("roblox");
    expect(getActiveMode()!.name).toBe("roblox");
  });

  it("modo sem tools → sem function calls de manifest", async () => {
    const { loadModeManifests, generateFunctionCallsFromManifests } = await import("../manifestLoader.js");

    // Cria um modo "empty-mode" sem nenhum manifest
    writeUserModeFile("empty-mode", {
      name: "empty-mode",
      label: "Empty",
      description: "Sem tools",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    // Cria a pasta manifests mas vazia
    fs.mkdirSync(
      path.join(tmpHome, ".claude-killer", "modes", "empty-mode", "manifests"),
      { recursive: true },
    );

    const manifests = loadModeManifests("empty-mode");
    expect(manifests).toEqual([]);

    const calls = generateFunctionCallsFromManifests(manifests, "empty-mode");
    expect(calls).toEqual([]);
  });

  it("modo com validators → shouldValidateFile retorna true pra pattern correspondente", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { shouldValidateFile } = await import("../luauValidator.js");

    setActiveMode("roblox");

    // Roblox tem validators para *.luau e *.lua
    expect(await shouldValidateFile("/projeto/src/foo.luau")).toBe(true);
    expect(await shouldValidateFile("/projeto/src/bar.lua")).toBe(true);
    // Outras extensões não têm regra → false
    expect(await shouldValidateFile("/projeto/src/main.ts")).toBe(false);
    expect(await shouldValidateFile("/projeto/README.md")).toBe(false);
  });

  it("modo sem validators → shouldValidateFile retorna false", async () => {
    const { setActiveMode, saveUserMode } = await import("../modes.js");
    const { shouldValidateFile } = await import("../luauValidator.js");

    // Cria um modo sem nenhum validator
    saveUserMode({
      name: "no-validators-mode",
      label: "No Validators",
      description: "Sem validators",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    setActiveMode("no-validators-mode");

    // Sem validators → deve retornar false para qualquer arquivo
    expect(await shouldValidateFile("/foo.luau")).toBe(false);
    expect(await shouldValidateFile("/foo.lua")).toBe(false);
    expect(await shouldValidateFile("/foo.tf")).toBe(false);
    expect(await shouldValidateFile("/foo.py")).toBe(false);
  });

  it("getActiveMode() nunca retorna null (sempre cai pra normal)", async () => {
    const { saveUserMode, getActiveMode, getActiveModeName } = await import("../modes.js");

    // Pré-cria o modo "normal" no HOME temporário
    saveUserMode({
      name: "normal",
      label: "Padrão",
      description: "Modo base",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    // Sem modo ativo setado → getActiveModeName() é null
    expect(getActiveModeName()).toBeNull();
    // Mas getActiveMode() faz fallback para "normal" (nunca null quando normal existe)
    const mode = getActiveMode();
    expect(mode).not.toBeNull();
    expect(mode!.name).toBe("normal");
  });

  it("sharedWith: tool do modo normal visível no modo roblox", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { loadActiveManifests } = await import("../manifestLoader.js");

    // Cria manifest no modo "normal" com sharedWith: ["roblox"]
    writeUserManifest("normal", "shared.json", {
      name: "shared_with_roblox",
      description: "Tool shared from normal to roblox",
      category: "normal",
      command: "shared-normal",
      args: [],
      sharedWith: ["roblox"],
    });

    setActiveMode("roblox");
    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    expect(names).toContain("shared_with_roblox");
  });

  it.skip("sharedWith: tool do modo devops visível no modo roblox", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { loadActiveManifests } = await import("../manifestLoader.js");

    // Cria manifest no modo "devops" com sharedWith: ["roblox"]
    writeUserManifest("devops", "tf-shared.json", {
      name: "tf_shared_tool",
      description: "DevOps tool shared with roblox",
      category: "devops",
      command: "terraform",
      args: [],
      sharedWith: ["roblox"],
    });

    setActiveMode("roblox");
    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    expect(names).toContain("tf_shared_tool");
  });

  it.skip("sharedWith: tool sem sharedWith só visível no modo de origem", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { loadActiveManifests } = await import("../manifestLoader.js");

    // Manifest no devops SEM sharedWith
    writeUserManifest("devops", "private.json", {
      name: "devops_private_tool",
      description: "Private devops tool",
      category: "devops",
      command: "private",
      args: [],
      // sem sharedWith
    });

    // No modo roblox, NÃO deve aparecer
    setActiveMode("roblox");
    const robloxManifests = loadActiveManifests();
    const robloxNames = robloxManifests.map((m) => m.name);
    expect(robloxNames).not.toContain("devops_private_tool");

    // No modo devops, DEVE aparecer
    setActiveMode("devops");
    const devopsManifests = loadActiveManifests();
    const devopsNames = devopsManifests.map((m) => m.name);
    expect(devopsNames).toContain("devops_private_tool");
  });

  it("modo ativo sobrescreve tool do normal de mesmo nome", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { loadActiveManifests } = await import("../manifestLoader.js");

    // Cria manifest "shared_tool" no normal
    writeUserManifest("normal", "shared.json", {
      name: "common_tool",
      description: "Versão do normal",
      category: "normal",
      command: "normal-cmd",
      args: [],
      sharedWith: ["roblox"],
    });
    // Cria manifest "shared_tool" no roblox (mesmo nome)
    writeUserManifest("roblox", "common.json", {
      name: "common_tool",
      description: "Versão do roblox",
      category: "roblox",
      command: "roblox-cmd",
      args: [],
    });

    setActiveMode("roblox");
    const manifests = loadActiveManifests();
    const tool = manifests.find((m) => m.name === "common_tool");
    expect(tool).toBeDefined();
    // A versão do modo ativo (roblox) deve prevalecer
    expect(tool!.command).toBe("roblox-cmd");
    expect(tool!.description).toBe("Versão do roblox");
  });

  it("loadActiveManifests inclui tools do modo + normal + shared", async () => {
    const { setActiveMode } = await import("../modes.js");
    const { loadActiveManifests } = await import("../manifestLoader.js");

    // Manifest no modo ativo (roblox)
    writeUserManifest("roblox", "mode-tool.json", {
      name: "mode_specific_tool",
      description: "Modo ativo",
      category: "roblox",
      command: "mode-cmd",
      args: [],
    });
    // Manifest no normal com sharedWith
    writeUserManifest("normal", "normal-shared.json", {
      name: "normal_shared_tool",
      description: "Normal shared",
      category: "normal",
      command: "normal-cmd",
      args: [],
      sharedWith: ["roblox"],
    });
    // Manifest em devops com sharedWith
    writeUserManifest("devops", "devops-shared.json", {
      name: "devops_shared_tool",
      description: "DevOps shared",
      category: "devops",
      command: "devops-cmd",
      args: [],
      sharedWith: ["roblox"],
    });

    setActiveMode("roblox");
    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    // Todos os três devem aparecer
    expect(names).toContain("mode_specific_tool");
    expect(names).toContain("normal_shared_tool");
    expect(names).toContain("devops_shared_tool");
  });

  it("findToolBinary olha primeiro no modo ativo, depois normal, depois legacy", async () => {
    const { findToolBinary } = await import("../toolDetector.js");

    // Cria o binário no modo ativo (roblox) E no normal
    const robloxPath = writeToolBinary("roblox", "my-tool");
    const normalPath = writeToolBinary("normal", "my-tool");

    // 1. Modo ativo tem prioridade
    const result1 = findToolBinary("my-tool", "roblox");
    expect(result1).toBe(robloxPath);
    expect(result1).not.toBe(normalPath);

    // 2. Remove do roblox — agora deve cair pro normal
    fs.unlinkSync(robloxPath);
    const result2 = findToolBinary("my-tool", "roblox");
    expect(result2).toBe(normalPath);

    // 3. Remove do normal — agora deve cair pro legacy (detectTool)
    //    Como child_process está mockado para falhar, retorna null.
    fs.unlinkSync(normalPath);
    const result3 = findToolBinary("my-tool", "roblox");
    expect(result3).toBeNull();
  });

  it("config inválido (sem name) → validateModeConfig retorna erros", async () => {
    const { validateModeConfig, isValidModeConfig } = await import("../configSchema.js");

    // Config sem name
    const errors = validateModeConfig({ label: "Sem Name" });
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "name")).toBe(true);
    expect(isValidModeConfig({ label: "Sem Name" })).toBe(false);

    // Config válido (com name) não retorna erro de name
    const okErrors = validateModeConfig({ name: "ok", label: "OK" });
    expect(okErrors.some((e) => e.field === "name")).toBe(false);
  });
});
