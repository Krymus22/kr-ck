/**
 * extensions-extended.test.ts - Expansão de cobertura de src/extensions.ts.
 *
 * Foca em cenários não cobertos por extensions.test.ts e extensions-mcp.test.ts:
 *   - loadAllExtensions: merge de skills globais + locais + plugins, falha de
 *     MCP server não aborta o resto
 *   - getActiveSkills: retorna lista mesclada após múltiplas cargas, expõe
 *     todos os campos (name, description, path, content)
 *   - getActiveMCPServers: lista múltiplos servidores ativos, retorna vazio
 *     após shutdown
 *   - shutdownMCPServers: mata todos os child processes e envia notificação
 *     cancelled; idempotente
 *   - callMCPTool: chamada bem-sucedida com content array de texto, erro JSON-
 *     RPC retornado como string [ERROR]
 *   - Edge cases: MCP server crash (spawn error e exit), skill com conteúdo
 *     unicode, extensions vazias
 *
 * IMPORTANTE: GLOBAL_DIR = `${os.homedir()}/.claude-killer` e LOCAL_DIR =
 * `${process.cwd()}/.claude-killer` são computados no load do módulo. Skills
 * devem ser escritas em `${homedir}/.claude-killer/skills` (não em
 * `${homedir}/skills`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// --- Helpers ----------------------------------------------------------------

function frame(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
/**
 * Parse NDJSON from stdin data (what the production code sends).
 * Returns the first valid JSON object found, or null.
 */
function parseStdinNDJSON(data: string): any | null {
  const lines = data.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { return JSON.parse(trimmed); } catch { /* skip non-JSON lines */ }
  }
  return null;
}


function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

/** Cria um child que responde automaticamente a initialize e tools/list */
function withAutoReply(child: any, tools: any[] = []) {
  child.stdin.write = vi.fn((data: string) => {
    const req = parseStdinNDJSON(data);
    if (!req) return;
    if (req.id == null) return; // notification
    if (req.method === "initialize") {
      const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: { tools: {} } } };
      process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
    } else if (req.method === "tools/list") {
      const res = { jsonrpc: "2.0", id: req.id, result: { tools } };
      process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
    }
  });
  return child;
}

// --- Setup ------------------------------------------------------------------
// globalHome é o que os.homedir() retorna; globalSkillsDir = globalHome/.claude-killer/skills
// localCwd é o que process.cwd() retorna; localSkillsDir = localCwd/.claude-killer/skills

let tmpDir: string;
let globalHome: string;
let localCwd: string;
let globalSkillsDir: string;
let localSkillsDir: string;
let globalPluginsDir: string;
let localPluginsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext_ext_"));
  globalHome = path.join(tmpDir, "global-home");
  localCwd = path.join(tmpDir, "local-cwd");
  globalSkillsDir = path.join(globalHome, ".claude-killer", "skills");
  localSkillsDir = path.join(localCwd, ".claude-killer", "skills");
  globalPluginsDir = path.join(globalHome, ".claude-killer", "plugins");
  localPluginsDir = path.join(localCwd, ".claude-killer", "plugins");
  fs.mkdirSync(globalSkillsDir, { recursive: true });
  fs.mkdirSync(localSkillsDir, { recursive: true });
  fs.mkdirSync(globalPluginsDir, { recursive: true });
  fs.mkdirSync(localPluginsDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(globalHome);
  vi.spyOn(process, "cwd").mockReturnValue(localCwd);
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* */
  }
});

async function loadModule() {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(globalHome);
  vi.spyOn(process, "cwd").mockReturnValue(localCwd);
  return import("../extensions.js");
}

function writeSkill(dir: string, name: string, body: string, description = `Skill ${name}`) {
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
  );
}

function writeMcpPlugin(
  pluginsDir: string,
  pluginName: string,
  serverName: string,
  cmd: string,
  extra?: { skills?: Array<{ file: string; name: string; body: string }> }
) {
  const dir = path.join(pluginsDir, pluginName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name: pluginName,
      version: "1.0.0",
      skills: extra?.skills?.map((s) => s.file) ?? [],
      mcpServers: { [serverName]: { command: cmd } },
    })
  );
  if (extra?.skills) {
    for (const s of extra.skills) {
      fs.writeFileSync(
        path.join(dir, s.file),
        `---\nname: ${s.name}\ndescription: desc\n---\n${s.body}`
      );
    }
  }
  return dir;
}

// --- Tests ------------------------------------------------------------------

describe("extensions (extended) - loadAllExtensions", () => {
  it("mescla skills globais e locais na lista final de getActiveSkills", async () => {
    const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
    initExtensionDirs();
    writeSkill(globalSkillsDir, "global-skill", "global body");
    writeSkill(localSkillsDir, "local-skill", "local body");
    await loadAllExtensions();
    const skills = getActiveSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("global-skill");
    expect(names).toContain("local-skill");
    const g = skills.find((s) => s.name === "global-skill")!;
    const l = skills.find((s) => s.name === "local-skill")!;
    expect(g.content).toBe("global body");
    expect(l.content).toBe("local body");
  });

  it("continua carregando skills mesmo quando MCP server falha ao inicializar (stdin.write throws)", async () => {
    writeMcpPlugin(globalPluginsDir, "bad-mcp", "failing", "nonexistent-binary-xyz", {
      skills: [{ file: "skill.md", name: "bad-mcp-skill", body: "body" }],
    });
    // Child cujo stdin.write lança erro (EPIPE / child morto).
    // sendRequest captura o throw e rejeita a Promise -> initializeServer
    // captura e retorna false -> startAndInitMCPServer pula discoverTools.
    // O servidor permanece no mapa mas com initialized=false.
    const child = fakeChild();
    child.stdin.write = vi.fn(() => {
      throw new Error("write EPIPE");
    });
    spawnMock.mockImplementation(() => child);
    const { initExtensionDirs, loadAllExtensions, getActiveSkills, callMCPTool } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    // Skill ainda foi carregada
    expect(getActiveSkills().find((s) => s.name === "bad-mcp-skill")).toBeDefined();
    // Servidor não está inicializado: chamadas a tools retornam [ERROR]
    const result = await callMCPTool("failing__someTool", {});
    expect(result).toContain("[ERROR]");
    expect(result).toContain("not available");
  });
});

describe("extensions (extended) - getActiveSkills", () => {
  it("retorna lista com todos os campos preenchidos (name, description, path, content)", async () => {
    const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
    initExtensionDirs();
    writeSkill(globalSkillsDir, "full", "body text", "Full skill");
    await loadAllExtensions();
    const skill = getActiveSkills().find((s) => s.name === "full")!;
    expect(skill).toBeDefined();
    expect(skill.description).toBe("Full skill");
    expect(skill.path).toContain("full.md");
    expect(skill.content).toBe("body text");
    expect(typeof skill.name).toBe("string");
  });

  it("reseta lista a cada nova carga (não acumula skills de cargas anteriores)", async () => {
    const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
    initExtensionDirs();
    writeSkill(globalSkillsDir, "skill-a", "a");
    await loadAllExtensions();
    const firstCount = getActiveSkills().length;
    // Adiciona outra skill e recarrega
    writeSkill(globalSkillsDir, "skill-b", "b");
    await loadAllExtensions();
    const secondCount = getActiveSkills().length;
    expect(secondCount).toBe(firstCount + 1);
    // Não deve duplicar skill-a
    const aCount = getActiveSkills().filter((s) => s.name === "skill-a").length;
    expect(aCount).toBe(1);
  });
});

describe("extensions (extended) - getActiveMCPServers", () => {
  it("retorna múltiplos servidores ativos simultaneamente", async () => {
    writeMcpPlugin(globalPluginsDir, "p1", "s1", "echo");
    writeMcpPlugin(globalPluginsDir, "p2", "s2", "echo");
    spawnMock.mockImplementation(() => withAutoReply(fakeChild()));
    const { initExtensionDirs, loadAllExtensions, getActiveMCPServers, shutdownMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    const servers = getActiveMCPServers();
    expect(servers).toContain("s1");
    expect(servers).toContain("s2");
    expect(servers).toHaveLength(2);
    shutdownMCPServers();
  });

  it("retorna array vazio após shutdownMCPServers", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    spawnMock.mockImplementation(() => withAutoReply(fakeChild()));
    const { initExtensionDirs, loadAllExtensions, getActiveMCPServers, shutdownMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    expect(getActiveMCPServers()).toContain("srv");
    shutdownMCPServers();
    expect(getActiveMCPServers()).toHaveLength(0);
  });
});

describe("extensions (extended) - shutdownMCPServers", () => {
  it("chama kill() em todos os child processes e envia notificação cancelled", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    const child = withAutoReply(fakeChild());
    spawnMock.mockImplementation(() => child);
    const { initExtensionDirs, loadAllExtensions, shutdownMCPServers } = await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    shutdownMCPServers();
    // kill() foi chamado
    expect(child.kill).toHaveBeenCalled();
    // notificação cancelled foi escrita no stdin
    const writes = (child.stdin.write as any).mock.calls.map((c: any) => c[0]);
    const cancelledWrite = writes.find((w: string) => w.includes("notifications/cancelled"));
    expect(cancelledWrite).toBeDefined();
  });

  it("é idempotente: múltiplos shutdowns não lançam erro", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    spawnMock.mockImplementation(() => withAutoReply(fakeChild()));
    const { initExtensionDirs, loadAllExtensions, shutdownMCPServers } = await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    expect(() => {
      shutdownMCPServers();
      shutdownMCPServers();
      shutdownMCPServers();
    }).not.toThrow();
  });
});

describe("extensions (extended) - callMCPTool", () => {
  it("retorna texto concatenado quando tools/call responde com content array", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req) return;
      if (req.id == null) return;
      if (req.method === "initialize") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(frame({ jsonrpc: "2.0", id: req.id, result: { capabilities: {} } }))
          )
        );
      } else if (req.method === "tools/list") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(frame({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }))
          )
        );
      } else if (req.method === "tools/call") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(
              frame({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                  content: [
                    { type: "text", text: "Linha 1 do resultado" },
                    { type: "text", text: "Linha 2 do resultado" },
                    { type: "image", text: "ignored" }, // não-texto, ignorado
                  ],
                },
              })
            )
          )
        );
      }
    });
    spawnMock.mockImplementation(() => child);
    const { initExtensionDirs, loadAllExtensions, callMCPTool, shutdownMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    const result = await callMCPTool("srv__someTool", { arg: 1 });
    expect(result).toContain("Linha 1 do resultado");
    expect(result).toContain("Linha 2 do resultado");
    expect(result).not.toContain("ignored");
    shutdownMCPServers();
  });

  it("retorna string [ERROR] quando tools/call recebe erro JSON-RPC", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    const child = fakeChild();
    child.stdin.write = vi.fn((data: string) => {
      const req = parseStdinNDJSON(data);
      if (!req) return;
      if (req.id == null) return;
      if (req.method === "initialize") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(frame({ jsonrpc: "2.0", id: req.id, result: { capabilities: {} } }))
          )
        );
      } else if (req.method === "tools/list") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(frame({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }))
          )
        );
      } else if (req.method === "tools/call") {
        process.nextTick(() =>
          child.stdout.emit(
            "data",
            Buffer.from(
              frame({
                jsonrpc: "2.0",
                id: req.id,
                error: { code: -32602, message: "Invalid params" },
              })
            )
          )
        );
      }
    });
    spawnMock.mockImplementation(() => child);
    const { initExtensionDirs, loadAllExtensions, callMCPTool, shutdownMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    const result = await callMCPTool("srv__badTool", {});
    expect(result).toContain("[ERROR]");
    expect(result).toContain("MCP Error -32602");
    shutdownMCPServers();
  });
});

describe("extensions (extended) - edge cases", () => {
  it("MCP server que crasha após init (exit) é removido da lista de ativos", async () => {
    writeMcpPlugin(globalPluginsDir, "p", "srv", "echo");
    const child = withAutoReply(fakeChild());
    spawnMock.mockImplementation(() => child);
    const { initExtensionDirs, loadAllExtensions, getActiveMCPServers, shutdownMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    expect(getActiveMCPServers()).toContain("srv");
    // Simula crash: emite exit
    child.emit("exit", 1);
    // Após exit, servidor deve ser removido
    expect(getActiveMCPServers()).not.toContain("srv");
    shutdownMCPServers();
  });

  it("skill com conteúdo contendo caracteres unicode é carregada sem corrupção", async () => {
    const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
    initExtensionDirs();
    const body = "# Skill Unicode\nConteúdo: café ☕ 日本語 ñ éíóú";
    writeSkill(globalSkillsDir, "unicode-skill", body, "Unicode");
    await loadAllExtensions();
    const skill = getActiveSkills().find((s) => s.name === "unicode-skill")!;
    expect(skill).toBeDefined();
    expect(skill.content).toContain("café ☕ 日本語");
    expect(skill.description).toBe("Unicode");
  });

  it("loadAllExtensions em diretórios totalmente vazios não lança e retorna listas vazias", async () => {
    // tmpDir já vem com dirs criados mas sem skills/plugins
    const { initExtensionDirs, loadAllExtensions, getActiveSkills, getActiveMCPServers } =
      await loadModule();
    initExtensionDirs();
    await loadAllExtensions();
    expect(getActiveSkills()).toEqual([]);
    expect(getActiveMCPServers()).toEqual([]);
  });
});
