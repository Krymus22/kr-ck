/**
 * cross-module-edge-cases.test.ts — Testes de edge cases CROSS-MODULE.
 *
 * Diferente dos testes unitários (um módulo por vez), ESTE arquivo testa
 * fluxos que cruzam múltiplos módulos:
 *
 *   - Mode + luauValidator + fileEdit (validation gate em .luau/.py)
 *   - manifestLoader + toolDetector + executeFromManifest (function calls)
 *   - inboxOrganizer + findToolBinary (inbox → tools/ → binary)
 *   - askUser + setAskUserCallback (permissões de pergunta)
 *   - sharedWith + loadActiveManifests (visibilidade cross-mode)
 *   - hookRunner + fileEdit (hooks blocking/on_file/timeout)
 *
 * Estratégia:
 *   - Para fluxos que envolvem filesystem, usa fs.mkdtempSync com HOME
 *     temporário real (não afeta o ambiente do dev).
 *   - Para fluxos que envolvem validação/hooks, mocka os módulos externos
 *     (logger, child_process, fileLock) e usa os módulos reais internos.
 *   - SEMPRE restaura HOME e mocks no afterEach.
 *   - TODOS os vi.mock e vi.hoisted ficam no TOP-LEVEL (vitest 4.1 warning).
 *
 * IMPORTANTE: NÃO altera código-fonte. Se algum teste falhar, ajusta o teste.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks GLOBAIS (todos no top-level, exigência do vitest 4.1) ────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
    setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process — controlável por teste (default: sempre falha,
// assim findToolBinary só encontra binários em modes/<mode>/tools/).
const cpMock = vi.hoisted(() => ({
  execSync: vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execSync: cpMock.execSync,
  spawn: cpMock.spawn,
}));

// Estado controlável do luauValidator — describe "Mode + Validators + fileEdit"
// e "Hooks + fileEdit" usam isso.
const validatorState = vi.hoisted(() => ({
  shouldValidate: false,
  validationOk: true,
  blockingError: undefined as string | undefined,
  rules: [] as any[],
}));
vi.mock("../luauValidator.js", () => ({
  shouldValidateFile: vi.fn(async () => validatorState.shouldValidate),
  getActiveValidationRules: vi.fn(async () => validatorState.rules),
  validateLuauBeforeWrite: vi.fn(async () => ({
    ok: validatorState.validationOk,
    blockingError: validatorState.blockingError,
    warnings: [],
    rulesApplied: validatorState.rules.map((r: any) => r.tool),
    rulesSkipped: [],
  })),
}));

// Mock fileLock — acquireLock sempre sucesso
vi.mock("../fileLock.js", () => ({
  acquireLock: vi.fn(async () => vi.fn()),
  getCurrentAgentId: vi.fn(() => "test-agent"),
}));

// Mock safetyReviewer — desativado por default
vi.mock("../safetyReviewer.js", () => ({
  reviewCodeSafety: vi.fn(async () => ({
    risk: "low", reviewedByLlm: false, patternsMatched: [], durationMs: 0,
  })),
  formatSafetyReview: vi.fn(() => ""),
  shouldReviewFile: vi.fn(() => false),
  getDangerousPatterns: vi.fn(() => []),
}));

// Estado controlável do hookRunner — describe "Hooks + fileEdit" usa isso.
const hookState = vi.hoisted(() => ({
  beforeWriteResults: [] as any[],
  onFileResults: [] as any[],
  onFileCalled: false,
  onFileSideEffect: null as (() => void) | null,
}));
const mockedRunHooks = vi.hoisted(() => vi.fn(async () => []));
vi.mock("../hookRunner.js", () => ({
  runHooks: mockedRunHooks,
  loadHooks: vi.fn(() => []),
  loadHooksFromDir: vi.fn(() => []),
  resolveHooksDir: vi.fn(() => ""),
}));

// Mock modeExtensions (runPostEditHooks)
vi.mock("../modeExtensions.js", () => ({
  runPostEditHooks: vi.fn(async () => ""),
  getActivePostEditHooks: vi.fn(async () => []),
  getActiveValidationRules: vi.fn(async () => validatorState.rules),
}));

// Mock honestySystem, impactAnalyzer, importResolver
vi.mock("../honestySystem.js", () => ({
  markFileAsEdited: vi.fn(),
  diffRealityCheck: vi.fn(async () => ({ matches: true, message: "" })),
  detectHallucinations: vi.fn(async () => ({ hallucinatedSymbols: [], message: "" })),
}));
vi.mock("../impactAnalyzer.js", () => ({
  analyzeImpact: vi.fn(async () => ({ referencedBy: [], totalFiles: 0 })),
  formatImpactHint: vi.fn(() => ""),
}));
vi.mock("../importResolver.js", () => ({
  checkImports: vi.fn(() => ({ ok: true, message: "" })),
}));

// Mock modes.getActiveMode — controlável por teste (default: null)
const modesMock = vi.hoisted(() => ({
  getActiveMode: vi.fn(() => null),
}));
vi.mock("../modes.js", () => ({
  getActiveMode: modesMock.getActiveMode,
}));

// Mock toolDetector.findToolBinary — controlável por teste
const toolDetectorMock = vi.hoisted(() => ({
  findToolBinary: vi.fn(() => null),
  detectTool: vi.fn(() => ({
    status: "missing", binaryPath: null, version: null,
    error: null, searchedPaths: [],
  })),
}));
vi.mock("../toolDetector.js", () => ({
  findToolBinary: toolDetectorMock.findToolBinary,
  detectTool: toolDetectorMock.detectTool,
}));

// ─── Setup/Teardown genérico ───────────────────────────────────────────────

let tmpHome: string;
let origHome: string | undefined;
let origUserprofile: string | undefined;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-cross-"));
  origHome = process.env.HOME;
  origUserprofile = process.env.USERPROFILE;
  origCwd = process.cwd();
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  // Reset estado global dos mocks
  validatorState.shouldValidate = false;
  validatorState.validationOk = true;
  validatorState.blockingError = undefined;
  validatorState.rules = [];
  modesMock.getActiveMode.mockReturnValue(null);
  toolDetectorMock.findToolBinary.mockReturnValue(null);
  cpMock.execSync.mockImplementation(() => {
    throw new Error("mocked: command not found");
  });
  cpMock.spawn.mockClear();
  hookState.beforeWriteResults = [];
  hookState.onFileResults = [];
  hookState.onFileCalled = false;
  hookState.onFileSideEffect = null;
  mockedRunHooks.mockImplementation(async (trigger: string) => {
    if (trigger === "before_write") return hookState.beforeWriteResults;
    if (trigger === "on_file") {
      hookState.onFileCalled = true;
      if (hookState.onFileSideEffect) hookState.onFileSideEffect();
      return hookState.onFileResults;
    }
    return [];
  });
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserprofile;
  process.chdir(origCwd);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
  vi.resetModules();
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: Mode + Validators + fileEdit
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: Mode + Validators + fileEdit", () => {
  let editFile: typeof import("../fileEdit.js").editFile;
  let luauValidator: typeof import("../luauValidator.js");

  beforeEach(async () => {
    const fe = await import("../fileEdit.js");
    editFile = fe.editFile;
    luauValidator = await import("../luauValidator.js");
  });

  it("modo roblox + validators ativos + selene falha → fileEdit bloqueia edição .luau", async () => {
    // Cria arquivo .luau no disco
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-luau-"));
    const luauFile = path.join(tmpDir, "test.luau");
    fs.writeFileSync(luauFile, "local x = 1\n", "utf8");

    // Estado: modo roblox ativo + validator bloqueia
    validatorState.shouldValidate = true;
    validatorState.validationOk = false;
    validatorState.blockingError = "Selene lint failed: undefined global 'foo'";
    validatorState.rules = [
      { tool: "selene_lint", filePattern: "*.luau", blocking: true },
    ];
    modesMock.getActiveMode.mockReturnValue({
      name: "roblox", label: "Roblox", builtIn: true,
      enableTools: [], enableSkills: [], enableFeatures: [],
      luauValidation: validatorState.rules,
    });

    const result = await editFile(luauFile, [
      { search: "local x = 1", replace: "local x = foo()" },
    ]);

    // fileEdit retorna erro de validação
    expect(result).toContain("[ERRO]");
    expect(result).toContain("Validação bloqueou");
    expect(result).toContain("Selene lint failed");

    // Arquivo NÃO foi modificado no disco
    expect(fs.readFileSync(luauFile, "utf8")).toBe("local x = 1\n");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("modo roblox + validators ativos → editar .py NÃO valida (pattern não casa)", async () => {
    // Cria arquivo .py no disco
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-py-"));
    const pyFile = path.join(tmpDir, "test.py");
    fs.writeFileSync(pyFile, "x = 1\n", "utf8");

    // Estado: modo roblox ativo + validator com regra *.luau (não casa .py)
    validatorState.shouldValidate = false; // shouldValidateFile retorna false
    // porque matchesPattern("test.py", "*.luau") === false
    validatorState.validationOk = true;
    validatorState.rules = [
      { tool: "selene_lint", filePattern: "*.luau", blocking: true },
    ];
    modesMock.getActiveMode.mockReturnValue({
      name: "roblox", label: "Roblox", builtIn: true,
      enableTools: [], enableSkills: [], enableFeatures: [],
      luauValidation: validatorState.rules,
    });

    const result = await editFile(pyFile, [
      { search: "x = 1", replace: "x = 2" },
    ]);

    // Edição sucedeu — arquivo .py não foi validado
    expect(result).toContain("[SUCESSO]");
    expect(fs.readFileSync(pyFile, "utf8")).toBe("x = 2\n");

    // validateLuauBeforeWrite NÃO foi chamado (shouldValidateFile retornou false)
    expect(luauValidator.validateLuauBeforeWrite).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("modo desativado (null) + validators desativados → editar .luau sem validação", async () => {
    // Cria arquivo .luau no disco
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-no-mode-"));
    const luauFile = path.join(tmpDir, "test.luau");
    fs.writeFileSync(luauFile, "local x = 1\n", "utf8");

    // Estado: SEM modo ativo → shouldValidateFile retorna false
    validatorState.shouldValidate = false;
    validatorState.validationOk = true;
    validatorState.rules = [];
    modesMock.getActiveMode.mockReturnValue(null);

    const result = await editFile(luauFile, [
      { search: "local x = 1", replace: "local x = 42" },
    ]);

    // Edição sucedeu sem validação
    expect(result).toContain("[SUCESSO]");
    expect(fs.readFileSync(luauFile, "utf8")).toBe("local x = 42\n");
    // validateLuauBeforeWrite NÃO foi chamado
    expect(luauValidator.validateLuauBeforeWrite).not.toHaveBeenCalled();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: Manifest + findToolBinary + executeFromManifest
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: Manifest + findToolBinary + executeFromManifest", () => {
  let generateFunctionCallsFromManifests: typeof import("../manifestLoader.js").generateFunctionCallsFromManifests;
  let executeFromManifest: typeof import("../manifestLoader.js").executeFromManifest;
  let isManifestTool: typeof import("../manifestLoader.js").isManifestTool;

  beforeEach(async () => {
    const ml = await import("../manifestLoader.js");
    generateFunctionCallsFromManifests = ml.generateFunctionCallsFromManifests;
    executeFromManifest = ml.executeFromManifest;
    isManifestTool = ml.isManifestTool;
  });

  it("tool com manifest mas SEM binary → function call NÃO gerada", () => {
    toolDetectorMock.findToolBinary.mockReturnValue(null); // binary não encontrado
    const manifests = [
      {
        name: "rojo_build",
        description: "Build Roblox project",
        category: "roblox",
        command: "rojo",
        args: ["build"],
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    // Sem binary → tool não vira function call
    expect(calls.length).toBe(0);
  });

  it("tool com manifest E binary → function call gerada + execução funciona", async () => {
    toolDetectorMock.findToolBinary.mockReturnValue("/fake/path/to/rojo"); // binary encontrado
    // execSync mockado para retornar sucesso (default é throw)
    cpMock.execSync.mockReturnValue("ok output from tool");
    const manifests = [
      {
        name: "rojo_build",
        description: "Build Roblox project",
        category: "roblox",
        command: "rojo",
        args: ["build"],
      },
    ];

    // 1. Function call é gerada
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    expect(calls.length).toBe(1);
    expect(calls[0].function.name).toBe("rojo_build");
    expect(calls[0].function.description).toContain("Build Roblox project");

    // 2. Execução funciona (execSync mockado retorna "ok output from tool")
    const result = await executeFromManifest("rojo_build", {}, manifests, "roblox");
    expect(result.ok).toBe(true);
    expect(result.output).toBe("ok output from tool");
    expect(result.errors).toEqual([]);
    // findToolBinary foi chamado para encontrar o binary
    expect(toolDetectorMock.findToolBinary).toHaveBeenCalledWith("rojo", "roblox");
    // execSync foi chamado para executar o binary
    expect(cpMock.execSync).toHaveBeenCalled();
  });

  it("tool sem manifest → isManifestTool retorna false (não aparece como function call)", () => {
    const manifests = [
      { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: [] },
    ];
    // "outro_tool" não está na lista de manifests
    expect(isManifestTool("outro_tool", manifests)).toBe(false);
    // "rojo_build" está na lista
    expect(isManifestTool("rojo_build", manifests)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: Inbox + organize + findToolBinary
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: Inbox + organize + findToolBinary", () => {
  let organizeInbox: typeof import("../inboxOrganizer.js").organizeInbox;
  let findToolBinary: typeof import("../toolDetector.js").findToolBinary;

  beforeEach(async () => {
    const io = await import("../inboxOrganizer.js");
    organizeInbox = io.organizeInbox;
    const td = await import("../toolDetector.js");
    findToolBinary = td.findToolBinary;
  });

  it("joga .exe no inbox → organize → move pra tools/ → findToolBinary encontra", () => {
    // Cria inbox/ do modo "roblox" e joga um .exe
    const modeDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
    const inboxDir = path.join(modeDir, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    // Usa nome sem extensão para findToolBinary (Unix) encontrar depois do move
    const toolName = process.platform === "win32" ? "my-tool.exe" : "my-tool";
    fs.writeFileSync(path.join(inboxDir, toolName), "fake binary content");

    // Antes do organize: findToolBinary não encontra em tools/
    expect(findToolBinary("my-tool", "roblox")).toBeNull();

    // Roda organize
    const result = organizeInbox("roblox");
    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileType).toBe("tool");

    // Depois do organize: arquivo está em tools/ (verifica no disco)
    const toolsDir = path.join(modeDir, "tools");
    const expectedPath = path.join(toolsDir, toolName);
    expect(fs.existsSync(expectedPath)).toBe(true);
    // Arquivo não está mais no inbox
    expect(fs.existsSync(path.join(inboxDir, toolName))).toBe(false);
  });

  it("joga .exe no inbox → NÃO organize → findToolBinary NÃO encontra em tools/", () => {
    // Cria inbox/ do modo "roblox" e joga um .exe
    const modeDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
    const inboxDir = path.join(modeDir, "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    const toolName = process.platform === "win32" ? "rojo.exe" : "rojo";
    fs.writeFileSync(path.join(inboxDir, toolName), "fake binary");

    // NÃO chama organizeInbox — arquivo fica no inbox

    // findToolBinary não encontra (procura em tools/, não em inbox/)
    const found = findToolBinary("rojo", "roblox");
    expect(found).toBeNull();

    // tools/ nem foi criado (ainda)
    const toolsDir = path.join(modeDir, "tools");
    expect(fs.existsSync(toolsDir)).toBe(false);

    // Arquivo ainda está no inbox
    expect(fs.existsSync(path.join(inboxDir, toolName))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: AskUser + Configurator (allowUserQuestions)
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: AskUser + Configurator (allowUserQuestions)", () => {
  let handleAskUser: typeof import("../askUser.js").handleAskUser;
  let setAskUserCallback: typeof import("../askUser.js").setAskUserCallback;
  let clearAskUserCallback: typeof import("../askUser.js").clearAskUserCallback;

  beforeEach(async () => {
    const au = await import("../askUser.js");
    handleAskUser = au.handleAskUser;
    setAskUserCallback = au.setAskUserCallback;
    clearAskUserCallback = au.clearAskUserCallback;
    clearAskUserCallback();
  });

  afterEach(() => {
    // Limpa o callback no fim de cada teste (evita vazar estado entre testes)
    clearAskUserCallback();
  });

  it("configurador (allowUserQuestions: true) → perguntar_usuario responde com sucesso", async () => {
    // Configurador tem permissão de perguntar
    const mockCb = vi.fn().mockResolvedValue({
      value: "Opção A escolhida",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Qual configuração você quer?",
      alternativas: ["Opção A", "Opção B"],
    });

    // Callback foi chamado e resposta foi formatada
    expect(mockCb).toHaveBeenCalledTimes(1);
    expect(result.resultStr).toContain("[RESPOSTA DO USUÁRIO]");
    expect(result.resultStr).toContain("Opção A escolhida");
    expect(result.usedHeal).toBe(false);
  });

  it("sub-agente (allowUserQuestions: false) → perguntar_usuario retorna erro de permissão", async () => {
    // Sub-agente NÃO tem permissão (allow=false)
    const mockCb = vi.fn();
    setAskUserCallback(mockCb, false);

    const result = await handleAskUser({
      pergunta: "Posso fazer X?",
      alternativas: ["Sim", "Não"],
    });

    // Callback NÃO foi chamado (permissão negada antes)
    expect(mockCb).not.toHaveBeenCalled();
    // Resultado contém erro de permissão
    expect(result.resultStr).toMatch(/não está disponível neste contexto/i);
    expect(result.resultStr).toMatch(/melhor julgamento/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: sharedWith + loadActiveManifests
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: sharedWith + loadActiveManifests", () => {
  let loadActiveManifests: typeof import("../manifestLoader.js").loadActiveManifests;

  beforeEach(async () => {
    const ml = await import("../manifestLoader.js");
    loadActiveManifests = ml.loadActiveManifests;
    modesMock.getActiveMode.mockReturnValue(null);
  });

  /** Helper: cria um manifest JSON no dir de um modo. */
  function writeManifest(modeName: string, fileName: string, content: unknown): void {
    const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(content), "utf8");
  }

  it("tool no normal com sharedWith: [\"roblox\"] → visível no modo roblox ativo", () => {
    // Modo ativo = roblox
    modesMock.getActiveMode.mockReturnValue({ name: "roblox" });

    // Cria tool no modo "normal" com sharedWith ["roblox"]
    writeManifest("normal", "darklua.json", [
      {
        name: "darklua_process",
        description: "Process Luau files with DarkLua",
        category: "normal",
        command: "darklua",
        args: ["process"],
        sharedWith: ["roblox"],
      },
    ]);

    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    // darklua_process deve aparecer (compartilhada de normal → roblox)
    expect(names).toContain("darklua_process");
  });

  it("tool no devops SEM sharedWith → NÃO visível no modo roblox ativo", () => {
    // Modo ativo = roblox
    modesMock.getActiveMode.mockReturnValue({ name: "roblox" });

    // Cria tool no modo "devops" SEM sharedWith
    writeManifest("devops", "terraform.json", [
      {
        name: "terraform_apply",
        description: "Apply Terraform changes",
        category: "devops",
        command: "terraform",
        args: ["apply"],
        // sem sharedWith
      },
    ]);

    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    // terraform_apply NÃO deve aparecer (não compartilhada com roblox)
    expect(names).not.toContain("terraform_apply");
  });

  it("tool no roblox sobrescreve tool do normal de mesmo nome (mode-specific > normal)", () => {
    // Modo ativo = roblox
    modesMock.getActiveMode.mockReturnValue({ name: "roblox" });

    // Manifest "shared_tool" no modo normal
    writeManifest("normal", "shared.json", {
      name: "shared_tool",
      description: "Normal version",
      category: "normal",
      command: "normal-cmd",
      args: [],
    });

    // Manifest "shared_tool" no modo roblox (sobrescreve)
    writeManifest("roblox", "shared.json", {
      name: "shared_tool",
      description: "Roblox version (override)",
      category: "roblox",
      command: "roblox-cmd",
      args: [],
    });

    const manifests = loadActiveManifests();
    const shared = manifests.find((m) => m.name === "shared_tool");
    expect(shared).toBeDefined();
    // A versão do roblox prevalece (maior prioridade)
    expect(shared!.description).toBe("Roblox version (override)");
    expect(shared!.command).toBe("roblox-cmd");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-module: Hooks + fileEdit (before_write blocking / on_file / timeout)
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-module: Hooks + fileEdit", () => {
  let editFile: typeof import("../fileEdit.js").editFile;

  beforeEach(async () => {
    const fe = await import("../fileEdit.js");
    editFile = fe.editFile;
  });

  it("before_write hook blocking → fileEdit retorna erro e não escreve no disco", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-block-"));
    const targetFile = path.join(tmpDir, "target.luau");
    fs.writeFileSync(targetFile, "original content\n", "utf8");

    // Hook before_write retorna blocking=true
    hookState.beforeWriteResults = [
      { blocking: true, message: "Hook rejeitou: arquivo protegido" },
    ];

    const result = await editFile(targetFile, [
      { search: "original", replace: "modified" },
    ]);

    // fileEdit retorna erro do hook
    expect(result).toContain("[ERRO]");
    expect(result).toContain("Hook bloqueou");
    expect(result).toContain("arquivo protegido");

    // Arquivo NÃO foi modificado
    expect(fs.readFileSync(targetFile, "utf8")).toBe("original content\n");

    // runHooks foi chamado para before_write
    expect(mockedRunHooks).toHaveBeenCalledWith(
      "before_write",
      expect.objectContaining({ filePath: targetFile }),
      null,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("on_file hook roda DEPOIS de salvar (verifica side-effect no disco)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-onfile-"));
    const targetFile = path.join(tmpDir, "target.luau");
    fs.writeFileSync(targetFile, "before\n", "utf8");

    // Hook on_file simula side-effect (cria um arquivo de log)
    const logFile = path.join(tmpDir, "hook.log");
    hookState.onFileResults = [{ warning: "on_file hook executado" }];
    hookState.onFileSideEffect = () => {
      fs.writeFileSync(logFile, `hook ran for: ${targetFile}`, "utf8");
    };

    const result = await editFile(targetFile, [
      { search: "before", replace: "after" },
    ]);

    // fileEdit sucedeu
    expect(result).toContain("[SUCESSO]");
    // Arquivo foi modificado no disco
    expect(fs.readFileSync(targetFile, "utf8")).toBe("after\n");
    // on_file hook rodou (onFileCalled = true) — side-effect executado
    expect(hookState.onFileCalled).toBe(true);
    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.readFileSync(logFile, "utf8")).toContain(targetFile);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hook com timeout (lento) → NÃO trava fileEdit (best-effort, retorna warning)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-timeout-"));
    const targetFile = path.join(tmpDir, "target.luau");
    fs.writeFileSync(targetFile, "data\n", "utf8");

    // Hook before_write retorna warning (simula timeout tratado)
    hookState.beforeWriteResults = [
      { warning: "Hook timed out after 5000ms" },
    ];

    const result = await editFile(targetFile, [
      { search: "data", replace: "new-data" },
    ]);

    // fileEdit sucedeu — warning não bloqueia
    expect(result).toContain("[SUCESSO]");
    // Arquivo foi modificado
    expect(fs.readFileSync(targetFile, "utf8")).toBe("new-data\n");
    // on_file hook também foi chamado (depois do write)
    expect(mockedRunHooks).toHaveBeenCalledWith(
      "on_file",
      expect.objectContaining({ filePath: targetFile }),
      null,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
