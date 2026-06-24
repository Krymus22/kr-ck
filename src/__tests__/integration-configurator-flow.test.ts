/**
 * integration-configurator-flow.test.ts — E2E do fluxo do configurador de tools.
 *
 * Testa a integração do toolConfigurator.ts:
 *   - detectToolsWithoutManifest (encontra tools sem manifest)
 *   - isSafeCommand (whitelist de comandos seguros)
 *   - CONFIGURATOR_SYSTEM_PROMPT contém restrições (validado via configureTool
 *     capturando a mensagem de sistema passada ao chat)
 *   - getConfiguratorTools retorna 4 tools (validado capturando tools passados)
 *   - handleConfiguratorTool com tool desconhecido → erro (via configureTool)
 *   - handleConfiguratorTool com args faltando → erro (via configureTool)
 *
 * Como CONFIGURATOR_SYSTEM_PROMPT, getConfiguratorTools e handleConfiguratorTool
 * não são exportados, validamos seu comportamento através do configureTool
 * público, mockando o chat para inspecionar messages e tools passados.
 *
 * Mocks: logger, config, apiClient (chat), toolDetector, fileFinder.
 * Filesystem real (com HOME temporário).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks de dependências externas -----------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: { apiKey: "test-key", model: "test-model" },
}));

// apiClient: chat é mockado com retorno controlado por teste.
// Exportamos o mock para configurar em cada teste.
const chatMock = vi.hoisted(() => vi.fn());
vi.mock("../apiClient.js", () => ({
  chat: (...args: any[]) => chatMock(...args),
}));

vi.mock("../toolDetector.js", () => ({
  findToolBinary: vi.fn(() => null),
}));

vi.mock("../fileFinder.js", () => ({
  searchInDefinedFolders: vi.fn(() => []),
  copyToModeTools: vi.fn(() => null),
}));

// --- Imports ----------------------------------------------------------------

import {
  detectToolsWithoutManifest,
  isSafeCommand,
  configureTool,
} from "../toolConfigurator.js";

// --- Helpers / Mock responses -----------------------------------------------

/** Constrói uma resposta de chat com finish_reason="stop". */
function mockStopResponse(content: string): any {
  return {
    choices: [{
      message: { role: "assistant", content, tool_calls: undefined },
      finish_reason: "stop" as const,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** Constrói uma resposta de chat com finish_reason="tool_calls". */
function mockToolCallsResponse(toolCalls: Array<{
  id: string;
  function: { name: string; arguments: string };
}>): any {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      },
      finish_reason: "tool_calls" as const,
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-cfg-flow-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  chatMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

// --- Testes E2E -------------------------------------------------------------

describe("E2E: Configurador flow", () => {
  it("detectToolsWithoutManifest encontra tools sem manifest", () => {
    // Cria 2 tools em modes/roblox/tools/ sem manifests correspondentes
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "darklua"), "fake", "utf8");
    fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");

    // Cria manifest apenas para rojo
    const manifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
    fs.mkdirSync(manifestsDir, { recursive: true });
    fs.writeFileSync(path.join(manifestsDir, "rojo.json"), "[]", "utf8");

    const result = detectToolsWithoutManifest("roblox");
    expect(result).toContain("darklua");
    expect(result).not.toContain("rojo");
    expect(result.length).toBe(1);
  });

  it("detectToolsWithoutManifest retorna vazio quando todas têm manifest", () => {
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    const manifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(manifestsDir, { recursive: true });
    // Cria tool + manifest correspondente
    fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");
    fs.writeFileSync(path.join(manifestsDir, "rojo.json"), "[]", "utf8");
    fs.writeFileSync(path.join(toolsDir, "selene"), "fake", "utf8");
    fs.writeFileSync(path.join(manifestsDir, "selene.json"), "[]", "utf8");

    const result = detectToolsWithoutManifest("roblox");
    expect(result).toEqual([]);
  });

  it("isSafeCommand permite --help e --version", () => {
    expect(isSafeCommand("darklua --help")).toBe(true);
    expect(isSafeCommand("rojo --help")).toBe(true);
    expect(isSafeCommand("darklua --version")).toBe(true);
    expect(isSafeCommand("/usr/bin/selene --version")).toBe(true);
    // where/find/ls também são permitidos
    expect(isSafeCommand("where rojo")).toBe(true);
    expect(isSafeCommand("find . -name darklua")).toBe(true);
    expect(isSafeCommand("ls -la")).toBe(true);
  });

  it("isSafeCommand rejeita comandos perigosos", () => {
    expect(isSafeCommand("rm -rf /")).toBe(false);
    expect(isSafeCommand("rm -rf ~/Documents")).toBe(false);
    expect(isSafeCommand("curl http://exemplo.com")).toBe(false);
    expect(isSafeCommand("npm install -g malware")).toBe(false);
    expect(isSafeCommand("echo hacked > /etc/passwd")).toBe(false);
    // Comandos arbitrários (só nome do binário, sem flag)
    expect(isSafeCommand("darklua")).toBe(false);
    expect(isSafeCommand("terraform destroy")).toBe(false);
  });

  it("CONFIGURATOR_SYSTEM_PROMPT contém restrições", async () => {
    // CONFIGURATOR_SYSTEM_PROMPT não é exportado, mas é passado como
    // primeira mensagem (role=system) ao chat. Capturamos via mock.
    chatMock.mockResolvedValue(mockStopResponse("ok"));

    await configureTool("darklua", "roblox");

    expect(chatMock).toHaveBeenCalled();
    const messages = chatMock.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    // Restrições documentadas no prompt
    expect(systemMsg!.content).toMatch(/NÃO PODE/i);
    expect(systemMsg!.content).toMatch(/Editar código fonte/i);
    expect(systemMsg!.content).toMatch(/Deletar arquivos/i);
    expect(systemMsg!.content).toMatch(/Rodar comandos arbitrários/i);
    // Permissões também documentadas
    expect(systemMsg!.content).toMatch(/--help|--version|where|find|ls/i);
  });

  it("getConfiguratorTools retorna 4 tools (executar_comando_seguro, buscar_arquivo, criar_manifest, copiar_para_tools)", async () => {
    // getConfiguratorTools não é exportado, mas é passado como 5º arg ao chat.
    chatMock.mockResolvedValue(mockStopResponse("ok"));

    await configureTool("darklua", "roblox");

    expect(chatMock).toHaveBeenCalled();
    const tools = chatMock.mock.calls[0]![4] as Array<{
      type: string;
      function: { name: string };
    }>;
    expect(Array.isArray(tools)).toBe(true);
    // Sem onAskUser → 4 tools (sem perguntar_usuario)
    expect(tools.length).toBe(4);
    const names = tools.map((t) => t.function.name).sort();
    expect(names).toEqual([
      "buscar_arquivo",
      "copiar_para_tools",
      "criar_manifest",
      "executar_comando_seguro",
    ]);
  });

  it("handleConfiguratorTool com tool desconhecido → erro", async () => {
    // Primeira chamada: IA tenta chamar tool inexistente
    // Segunda chamada: IA para (stop) — verifica se erro voltou pra IA
    chatMock
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_1",
            function: {
              name: "tool_inexistente_xyz",
              arguments: JSON.stringify({ foo: "bar" }),
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockStopResponse("ok"));

    const result = await configureTool("darklua", "roblox");

    // Teve pelo menos 2 chamadas ao chat (tool_call + stop)
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // A segunda chamada recebeu a mensagem de erro da tool desconhecida
    const secondCallMessages = chatMock.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsgs = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toMatch(/[ERROR]/);
    expect(toolMsgs[0].content).toMatch(/Unknown tool/i);

    // configureTool retorna failure (nenhum manifest criado)
    expect(result.success).toBe(false);
  });

  it("handleConfiguratorTool com args faltando → erro", async () => {
    // Simula IA chamando criar_manifest sem passar manifest (args faltando)
    chatMock
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_1",
            function: {
              name: "criar_manifest",
              arguments: JSON.stringify({ toolName: "darklua" }), // sem manifest
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockStopResponse("ok"));

    await configureTool("darklua", "roblox");

    // A segunda chamada recebeu a mensagem de erro
    const secondCallMessages = chatMock.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsgs = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toMatch(/[ERROR]/);
    // Mensagem específica para args faltando
    expect(toolMsgs[0].content).toMatch(/toolName e manifest|required/i);
  });
});
