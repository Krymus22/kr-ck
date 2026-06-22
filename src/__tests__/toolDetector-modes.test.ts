/**
 * toolDetector-modes.test.ts — Testes profundos das funções Sprint 2
 * (findToolBinary, getModeToolsDir, listModeTools) + casos novos de
 * detectTool, verifyToolWorks, getSearchPathsForTool.
 *
 * Foco:
 *   - findToolBinary: prioridade (ativo > normal > legacy), fallback,
 *     extensões .exe, mode null, toolName vazio.
 *   - getModeToolsDir: path correto, mode null.
 *   - listModeTools: arquivos, subdirs ignorados, .exe no Windows,
 *     erro de permissão gracefully.
 *
 * Estratégia:
 *   - HOME temporário real (fs.mkdtempSync em os.tmpdir()) para não afetar
 *     o ambiente do desenvolvedor.
 *   - child_process mockado: por padrão lança "command not found" →
 *     detectTool sempre retorna "missing" (deteminístico).
 *   - Em um teste específico, configuramos o mock pra retornar um path
 *     simulando `which` sucesso → fallback legacy retorna o path.
 *
 * NOTA: este arquivo complementa findToolBinary.test.ts (que cobre os
 * casos básicos). Aqui focamos em prioridade, edge cases e cenários
 * não cobertos.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process — por padrão lança "command not found".
// Permite sobrescrever o comportamento via execSyncMock.mockImplementationOnce
// para testar o fallback legacy success.
const execSyncMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
);
vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
  spawn: vi.fn(),
}));

// Partial mock de node:fs — preserva todos os métodos reais (mkdtempSync,
// mkdirSync, writeFileSync, etc.) mas permite sobrescrever statSync por teste
// (para simular erro de permissão no listModeTools). Sem isso, vi.spyOn não
// funciona porque o namespace do fs é "frozen" em ESM.
const statSyncOverride = vi.hoisted(() => ({
  current: null as ((p: any, ...args: any[]) => any) | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: (p: any, ...args: any[]) => {
      if (statSyncOverride.current) return statSyncOverride.current(p, ...args);
      return actual.statSync(p, ...args);
    },
  };
});

// --- Imports (após mocks) ---------------------------------------------------

import {
  findToolBinary,
  getModeToolsDir,
  listModeTools,
  detectTool,
  verifyToolWorks,
  getSearchPathsForTool,
} from "../toolDetector.js";

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;
let originalPlatform: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-modes-"));
  // Salva os valores originais (apenas na 1a chamada)
  if (originalHome === undefined) {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
  }
  // Importante: assignar direto em process.env.HOME (não usar process.env = ...)
  // para que Node chame setenv() e os.homedir() reflita o novo valor.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  originalPlatform = process.platform;
  delete process.env.AUTO_DETECT_TOOLS;
  // Restaura comportamento default do mock: sempre falha
  execSyncMock.mockReset();
  execSyncMock.mockImplementation(() => {
    throw new Error("mocked: command not found");
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  // Restaura HOME/USERPROFILE via assignment direto (NÃO usar process.env = ...)
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  delete process.env.AUTO_DETECT_TOOLS;
  // Limpa override do statSync (se foi setado por algum teste)
  statSyncOverride.current = null;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

// --- Helpers ----------------------------------------------------------------

/** Cria um arquivo de tool (binário fake) em modes/<mode>/tools/<fileName>. */
function createToolFile(modeName: string, fileName: string): string {
  const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "tools");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, "fake binary content", "utf8");
  // Torna executável no Unix (isExecutable exige bit 0o111)
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
  return filePath;
}

/** Simula plataforma Windows. */
function setWindowsPlatform(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

/** Simula plataforma Linux/macOS. */
function setUnixPlatform(): void {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
}

// --- Testes: findToolBinary -------------------------------------------------

describe("findToolBinary (Sprint 2)", () => {
  it("retorna path quando binary existe em modes/<mode>/tools/", () => {
    const filePath = createToolFile("roblox", "rojo");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
  });

  it("retorna null quando binary não existe em nenhum lugar", () => {
    // Não cria o arquivo em lugar nenhum; detectTool mockado pra falhar
    const result = findToolBinary("nonexistent-tool-xyz-12345", "roblox");
    expect(result).toBeNull();
  });

  it("procura no modo normal (base) quando não encontra no modo ativo", () => {
    // Cria o binary no modo normal, mas não no roblox
    const filePath = createToolFile("normal", "selene");
    const result = findToolBinary("selene", "roblox");
    expect(result).toBe(filePath);
    expect(result).toContain(path.join("modes", "normal", "tools"));
  });

  it("fallback pra detectTool (legacy) quando não encontra em nenhum modo", () => {
    // Configura o mock pra simular que `which darklua` retornou um path
    // e que `darklua --version` retornou uma string com versão.
    // Assim detectTool retorna status: "found" e findToolBinary retorna o path.
    const fakeBinaryPath = path.join(tmpHome, "fake-bin", "darklua");
    fs.mkdirSync(path.dirname(fakeBinaryPath), { recursive: true });
    fs.writeFileSync(fakeBinaryPath, "fake", "utf8");
    if (process.platform !== "win32") fs.chmodSync(fakeBinaryPath, 0o755);

    // Mock: which darklua → fakeBinaryPath, darklua --version → "darklua 1.2.3"
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("which darklua")) {
        return fakeBinaryPath;
      }
      if (typeof cmd === "string" && cmd.includes("--version")) {
        return "darklua 1.2.3\n";
      }
      throw new Error("mocked: command not found");
    });

    // Não cria em modes/ — deve cair no fallback detectTool
    const result = findToolBinary("darklua", "roblox");
    expect(result).toBe(fakeBinaryPath);
  });

  it("mode null → pula pasta de modo, vai direto pro normal + legacy", () => {
    // Cria binary no modo normal → deve ser encontrado mesmo com mode null
    const filePath = createToolFile("normal", "tool-em-normal");
    const result = findToolBinary("tool-em-normal", null);
    expect(result).toBe(filePath);
    expect(result).toContain(path.join("modes", "normal", "tools"));
  });

  it("toolName vazio → retorna null", () => {
    const result = findToolBinary("", "roblox");
    expect(result).toBeNull();
  });

  it("Windows: adiciona .exe automaticamente ao procurar", () => {
    setWindowsPlatform();
    // Cria "rojo.exe" no modo roblox (não "rojo")
    const filePath = createToolFile("roblox", "rojo.exe");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
    expect(result).toMatch(/rojo\.exe$/);
  });

  it("Unix: não adiciona extensão ao procurar", () => {
    setUnixPlatform();
    const filePath = createToolFile("roblox", "rojo");
    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(filePath);
    expect(result).not.toMatch(/\.exe$/);
  });

  it("prioridade: modo ativo > normal > legacy", () => {
    // Cria o binary em todos os 3 lugares com conteúdo diferente pra distinguir
    const activePath = createToolFile("roblox", "rojo");
    const normalPath = createToolFile("normal", "rojo");
    // Pra legacy: precisa que detectTool encontre — mas como os modes já tem,
    // findToolBinary retorna o do modo ativo sem chamar detectTool.
    // Verificamos só que o path retornado é o do modo ativo (não o normal).
    expect(activePath).not.toBe(normalPath);

    const result = findToolBinary("rojo", "roblox");
    expect(result).toBe(activePath);
    expect(result).not.toBe(normalPath);

    // Remove o do modo ativo → deve cair pro normal
    fs.unlinkSync(activePath);
    const result2 = findToolBinary("rojo", "roblox");
    expect(result2).toBe(normalPath);
  });
});

// --- Testes: getModeToolsDir ------------------------------------------------

describe("getModeToolsDir", () => {
  it("retorna path correto: ~/.claude-killer/modes/<mode>/tools/", () => {
    const dir = getModeToolsDir("roblox");
    expect(dir).toBe(path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools"));
    // Confirma que tem os componentes esperados
    expect(dir).toContain(path.join(".claude-killer", "modes", "roblox", "tools"));
    expect(dir).toContain(tmpHome);
  });

  it("funciona com mode null (retorna path mas não verifica existência)", () => {
    // getModeToolsDir aceita string; passando "null" como string (coerção)
    // — o importante é que NÃO lança e retorna um path.
    const dir = getModeToolsDir("null" as string);
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
    // Não verifica existência — só retorna o path
    expect(fs.existsSync(dir)).toBe(false);
  });
});

// --- Testes: listModeTools --------------------------------------------------

describe("listModeTools", () => {
  it("lista arquivos na pasta tools/ do modo", () => {
    createToolFile("roblox", "rojo");
    createToolFile("roblox", "selene");
    createToolFile("roblox", "stylua");

    const tools = listModeTools("roblox");
    expect(tools.length).toBe(3);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["rojo", "selene", "stylua"]);
    // Todos os paths devem conter o tmpHome e a pasta tools
    for (const t of tools) {
      expect(t.path).toContain(tmpHome);
      expect(t.path).toContain(path.join("modes", "roblox", "tools"));
    }
  });

  it("retorna array vazio quando pasta tools/ não existe", () => {
    const tools = listModeTools("modo-inexistente-xyz");
    expect(tools).toEqual([]);
  });

  it("strip .exe no Windows pra nome", () => {
    setWindowsPlatform();
    createToolFile("roblox", "rojo.exe");
    createToolFile("roblox", "selene.exe");

    const tools = listModeTools("roblox");
    expect(tools.length).toBe(2);
    const names = tools.map((t) => t.name).sort();
    // .exe deve ser removido dos nomes
    expect(names).toEqual(["rojo", "selene"]);
    // Mas os paths ainda contêm .exe
    for (const t of tools) {
      expect(t.path).toMatch(/\.exe$/);
    }
  });

  it("ignora subdiretórios (só arquivos)", () => {
    createToolFile("roblox", "rojo");
    // Cria um subdiretório em tools/ — deve ser ignorado
    fs.mkdirSync(path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools", "subdir"), {
      recursive: true,
    });

    const tools = listModeTools("roblox");
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("rojo");
  });

  it("lida com erro de permissão gracefully (pula arquivo inacessível)", () => {
    // Cria 2 arquivos: um normal e um que vai falhar ao statSync.
    // Usamos o statSyncOverride (definido no vi.mock de node:fs) pra
    // simular um erro EACCES no arquivo "broken".
    createToolFile("roblox", "rojo");
    createToolFile("roblox", "broken");

    const realStatSync = fs.statSync;
    statSyncOverride.current = (p: any, ...args: any[]) => {
      if (typeof p === "string" && p.endsWith("broken")) {
        throw new Error("EACCES: permission denied");
      }
      return realStatSync(p, ...args);
    };

    const tools = listModeTools("roblox");
    // Deve listar apenas rojo (broken foi pulado)
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("rojo");

    // Limpa o override (afterEach também limpa, mas fazemos aqui pra clareza)
    statSyncOverride.current = null;
  });
});

// --- Testes adicionais: detectTool, verifyToolWorks, getSearchPathsForTool --
// Estes cobrem funções existentes mencionadas no foco da tarefa.

describe("detectTool (complementar)", () => {
  it("retorna 'missing' quando tool não existe e AUTO_DETECT desativado", () => {
    delete process.env.AUTO_DETECT_TOOLS;
    const result = detectTool("nonexistent-xyz-999");
    expect(result.status).toBe("missing");
    expect(result.binaryPath).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("retorna 'found' quando tool existe em pasta de search path (deep search)", () => {
    // Força deep search via AUTO_DETECT=1 e cria binary em ~/.rokit/bin/
    process.env.AUTO_DETECT_TOOLS = "1";
    // Reimporta o módulo pra reavaliar AUTO_DETECT_ENABLED
    // (não é necessário reimportar — passing forceDeepSearch=true funciona igual)
    const rokitDir = path.join(tmpHome, ".rokit", "bin");
    fs.mkdirSync(rokitDir, { recursive: true });
    const fakeBinary = path.join(rokitDir, "fakeTool");
    fs.writeFileSync(fakeBinary, "fake", "utf8");
    if (process.platform !== "win32") fs.chmodSync(fakeBinary, 0o755);

    // Mock: getVersion retorna uma versão válida pra esse binary
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("fakeTool") && cmd.includes("--version")) {
        return "fakeTool 9.9.9\n";
      }
      throw new Error("mocked: command not found");
    });

    const result = detectTool("fakeTool", { forceDeepSearch: true });
    expect(result.status).toBe("found");
    expect(result.binaryPath).toBe(fakeBinary);
    expect(result.version).toBe("9.9.9");
  });
});

describe("verifyToolWorks (complementar)", () => {
  it("retorna { works: false } para binary inexistente", async () => {
    const result = await verifyToolWorks("selene", "/caminho/que/nao/existe/selene");
    expect(result.works).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("retorna { works: false } para tool desconhecida (default: --version falha)", async () => {
    // Mock: --version lança erro
    execSyncMock.mockImplementation(() => {
      throw new Error("command failed");
    });
    const result = await verifyToolWorks("unknown-tool-xyz", "/bin/echo");
    expect(result.works).toBe(false);
  });
});

describe("getSearchPathsForTool (complementar)", () => {
  it("retorna array não vazio com paths do home", () => {
    const paths = getSearchPathsForTool("rojo");
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThan(5);
    // Pelo menos um path inclui o tmpHome (porque HOME foi setado)
    expect(paths.some((p) => p.includes(tmpHome))).toBe(true);
  });

  it("inclui ~/.claude-killer/bin/ e ~/.rokit/bin/", () => {
    const paths = getSearchPathsForTool("selene");
    expect(paths.some((p) => p.includes(".claude-killer"))).toBe(true);
    expect(paths.some((p) => p.includes(".rokit"))).toBe(true);
  });
});
