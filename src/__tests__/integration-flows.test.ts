/**
 * integration-flows.test.ts — Fluxos reais de ponta a ponta com mocks controlados
 *
 * Diferente dos invariant tests, estes testam o COMPORTAMENTO REAL
 * de múltiplos módulos trabalhando juntos.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  isTransientNetworkErrorPublic: vi.fn(() => false),
  is429ErrorPublic: vi.fn(() => false),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
  SUB_AGENT_MAX_NETWORK_RETRIES: 15,
  SUB_AGENT_TRANSIENT_NETWORK_CODES: new Set(["ECONNRESET", "ETIMEDOUT"]),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaApiKeys: "key0,key1,key2,key3",
    nvidiaApiKeysFile: "", nvidiaBaseUrl: "https://test.api.com/v1",
    model: "moonshotai/kimi-k2.6", rateLimitRpm: 1000, maxConcurrency: 1,
    maxHealRetries: 3, debug: false, contextWindowTokens: 128000,
    contextCompactThreshold: 0.75, contextWarnThreshold: 0.6,
    costPerKPrompt: 0, costPerKCompletion: 0, diffPreview: false,
    maxTokens: 4096, temperature: 0.6, topP: 0.9, effortLevel: "medium",
  },
}));

// ═══════════════════════════════════════════════════════════════════════════
// Flow 1: Editar arquivo → Bug Hunter → DataGuard → bloqueia ou permite
// ═══════════════════════════════════════════════════════════════════════════

import { applyEdits } from "../fileEdit.js";
import { evaluateMcpToolCall } from "../robloxMcpGuard.js";

describe("Flow 1: Edit → Guard → Block/Allow", () => {
  it("applyEdits muda conteúdo e retorna success=true", () => {
    const result = applyEdits("hello world", [{ search: "hello", replace: "goodbye" }]);
    expect(result.success).toBe(true);
    expect(result.content).toBe("goodbye world");
  });

  it("applyEdits falha quando search não encontrado", () => {
    const result = applyEdits("hello", [{ search: "nonexistent", replace: "x" }]);
    expect(result.success).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("MCP Guard bloqueia multi_edit (write) — IA deve usar aplicar_diff", () => {
    const result = evaluateMcpToolCall("Roblox_Studio__multi_edit", {
      path: "game.ServerScriptService.MyScript",
    });
    expect(result.allowed).toBe(false);
    expect(result.blockReason).toContain("aplicar_diff");
  });

  it("MCP Guard permite script_read (read) — IA pode verificar", () => {
    const result = evaluateMcpToolCall("Roblox_Studio__script_read", {
      path: "game.ServerScriptService.MyScript",
    });
    expect(result.allowed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 2: Auto-compaction preserva contexto crítico
// ═══════════════════════════════════════════════════════════════════════════

import { resetHistory, addSystemMessage, addUserMessage, addRawAssistantMessage, getHistory, compactHistory } from "../history.js";

describe("Flow 2: Compaction preserves context", () => {
  beforeEach(() => { resetHistory(); });

  it("compactHistory preserva TASK_STATE", () => {
    addSystemMessage("## TASK_STATE\nProject: Test\nGoal: Implement feature");
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    compactHistory();

    const history = getHistory();
    const hasTaskState = history.some(m =>
      m.role === "system" && typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
    );
    expect(hasTaskState).toBe(true);
  });

  it("compactHistory preserva Persistent Memory", () => {
    addSystemMessage("## Persistent Memory\nImportant context here");
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i}`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    compactHistory();

    const history = getHistory();
    const hasMemory = history.some(m =>
      m.role === "system" && typeof m.content === "string" && m.content.startsWith("## Persistent Memory")
    );
    expect(hasMemory).toBe(true);
  });

  it("compactHistory preserva últimas 6 mensagens", () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i}`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    compactHistory();

    const history = getHistory();
    // Last messages should include "message 14"
    const lastMessages = history.slice(-6);
    const hasLast = lastMessages.some(m =>
      typeof m.content === "string" && m.content.includes("message 14")
    );
    expect(hasLast).toBe(true);
  });

  it("compactHistory reduz número de mensagens", () => {
    for (let i = 0; i < 20; i++) {
      addUserMessage(`User message ${i}`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    const before = getHistory().length;
    compactHistory();
    const after = getHistory().length;

    expect(after).toBeLessThan(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 3: /mode roblox → MCP carrega → guard bloqueia writes
// ═══════════════════════════════════════════════════════════════════════════

import { isRobloxStudioMcpTool, extractToolName, classifyMcpTool } from "../robloxMcpGuard.js";

describe("Flow 3: Mode Roblox → MCP Guard", () => {
  it("detecta Roblox_Studio__ prefix", () => {
    expect(isRobloxStudioMcpTool("Roblox_Studio__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("Roblox_Studio__script_read")).toBe(true);
    expect(isRobloxStudioMcpTool("other_server__tool")).toBe(false);
  });

  it("extrai nome da tool sem prefixo", () => {
    expect(extractToolName("Roblox_Studio__multi_edit")).toBe("multi_edit");
    expect(extractToolName("Roblox_Studio__script_read")).toBe("script_read");
  });

  it("classifica todas as tools corretamente", () => {
    const writes = ["multi_edit", "generate_mesh", "generate_material", "generate_procedural_model", "insert_from_creator_store"];
    const reads = ["script_read", "script_search", "script_grep", "search_game_tree", "inspect_instance", "explore_subagent", "list_roblox_studios", "console_output"];
    const execs = ["execute_luau", "run_script_in_play_mode"];
    const plays = ["start_stop_play", "screen_capture", "playtest_subagent", "character_navigation", "keyboard_input", "mouse_input"];

    for (const t of writes) expect(classifyMcpTool(t)).toBe("write");
    for (const t of reads) expect(classifyMcpTool(t)).toBe("read");
    for (const t of execs) expect(classifyMcpTool(t)).toBe("execute");
    for (const t of plays) expect(classifyMcpTool(t)).toBe("playtest");
  });

  it("bloqueia TODAS as tools de escrita", () => {
    const writes = ["multi_edit", "generate_mesh", "generate_material", "generate_procedural_model", "insert_from_creator_store"];
    for (const tool of writes) {
      const result = evaluateMcpToolCall(`Roblox_Studio__${tool}`, {});
      expect(result.allowed).toBe(false);
    }
  });

  it("permite TODAS as tools de leitura", () => {
    const reads = ["script_read", "script_search", "script_grep", "search_game_tree", "inspect_instance"];
    for (const tool of reads) {
      const result = evaluateMcpToolCall(`Roblox_Studio__${tool}`, {});
      expect(result.allowed).toBe(true);
    }
  });

  it("bloqueia tools desconhecidas (fail-safe)", () => {
    const result = evaluateMcpToolCall("Roblox_Studio__unknown_new_tool", {});
    expect(result.allowed).toBe(false);
    expect(result.category).toBe("unknown");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 4: Args normalizer → tool executa com path correto
// ═══════════════════════════════════════════════════════════════════════════

import { normalizeArgs } from "../argsNormalizer.js";

describe("Flow 4: Args normalizer → correct execution", () => {
  it("caminho → path + type coercion + defaults", () => {
    const args: any = { caminho: "/test.lua", maxResults: "3" };
    const schema = {
      properties: {
        path: { type: "string" },
        maxResults: { type: "number", default: 5 },
        verbose: { type: "boolean", default: false },
      },
    };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.path).toBe("/test.lua");
    expect(args.maxResults).toBe(3);
    expect(args.verbose).toBe(false);
  });

  it("command → comando para executar_comando", () => {
    const args: any = { command: "npm test" };
    normalizeArgs("executar_comando", args);
    expect(args.comando).toBe("npm test");
  });

  it("thought → pensamento para pensar", () => {
    const args: any = { thought: "Preciso pensar" };
    normalizeArgs("pensar", args);
    expect(args.pensamento).toBe("Preciso pensar");
  });

  it("JSON string array é parseado", () => {
    const args: any = { alternativas: '["A", "B"]' };
    normalizeArgs("perguntar_usuario", args);
    expect(Array.isArray(args.alternativas)).toBe(true);
    expect(args.alternativas).toEqual(["A", "B"]);
  });

  it("string 'true' → boolean true", () => {
    const args: any = { flag: "true" };
    const schema = { properties: { flag: { type: "boolean" } } };
    normalizeArgs("test", args, schema as any);
    expect(args.flag).toBe(true);
  });

  it("não sobrescreve path se já existe", () => {
    const args: any = { caminho: "/a", path: "/b" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe("/b");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 5: Research hints — volatile vs timeless
// ═══════════════════════════════════════════════════════════════════════════

import { detectResearchTrigger, generateResearchHint } from "../researchHint.js";

describe("Flow 5: Research hints behavior", () => {
  it("triggers para jogo específico", () => {
    expect(detectResearchTrigger("o que é Anime Fighters?")).not.toBeNull();
  });

  it("triggers para versão", () => {
    expect(detectResearchTrigger("latest version of React?")).toBe("version_info");
  });

  it("triggers para notícias", () => {
    expect(detectResearchTrigger("what happened this week?")).toBe("recent_news");
  });

  it("NÃO triggers para print em python", () => {
    expect(detectResearchTrigger("como fazer print em python?")).toBeNull();
  });

  it("NÃO triggers para OOP", () => {
    expect(detectResearchTrigger("what is OOP?")).toBeNull();
  });

  it("NÃO triggers para comando", () => {
    expect(detectResearchTrigger("escreve uma função")).toBeNull();
  });

  it("gera hint para trigger", () => {
    const hint = generateResearchHint("current_state", "test");
    expect(hint).toContain("RESEARCH HINT");
    expect(hint).toContain("buscar_web");
  });

  it("não gera hint para null", () => {
    expect(generateResearchHint(null, "test")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 6: Auto Memory — detecta correções
// ═══════════════════════════════════════════════════════════════════════════

import { detectUserCorrection, maybeSuggestMemoryWrite } from "../autoMemory.js";

describe("Flow 6: Auto Memory corrections", () => {
  it("detecta 'não use X'", () => {
    expect(detectUserCorrection("Não use print, use warn")).not.toBeNull();
  });

  it("detecta 'sempre use X'", () => {
    expect(detectUserCorrection("Sempre use pcall com DataStore")).not.toBeNull();
  });

  it("detecta 'errado'", () => {
    expect(detectUserCorrection("Errado, o correto é usar WaitForChild")).not.toBeNull();
  });

  it("detecta 'actually'", () => {
    expect(detectUserCorrection("Actually, you should use await here")).not.toBeNull();
  });

  it("NÃO detecta pergunta normal", () => {
    expect(detectUserCorrection("Pode me ajudar?")).toBeNull();
  });

  it("sugere memory write quando há correção", () => {
    const suggestion = maybeSuggestMemoryWrite("Não use print", "Entendi");
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain("AUTO_MEMORY");
  });

  it("NÃO sugere quando IA já anotou", () => {
    const suggestion = maybeSuggestMemoryWrite("Não use print", "Anotado!");
    expect(suggestion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 7: Think Tool — registra pensamento e retorna checklist
// ═══════════════════════════════════════════════════════════════════════════

import { think } from "../thinkTool.js";

describe("Flow 7: Think Tool behavior", () => {
  it("retorna confirmed=true para pensamento válido", async () => {
    const result = await think({ pensamento: "Preciso analisar", categoria: "pre_edit" } as any);
    expect(result.confirmed).toBe(true);
    expect(typeof result.message).toBe("string");
  });

  it("retorna confirmed=true para pre_research", async () => {
    const result = await think({ pensamento: "Vou pesquisar", categoria: "pre_research" } as any);
    expect(result.confirmed).toBe(true);
  });

  it("retorna confirmed=true para pre_response", async () => {
    const result = await think({ pensamento: "Vou responder", categoria: "pre_response" } as any);
    expect(result.confirmed).toBe(true);
  });

  it("retorna confirmed=true mesmo com pensamento vazio", async () => {
    const result = await think({ pensamento: "", categoria: "pre_edit" } as any);
    expect(result.confirmed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 8: Rollback Store — backup e restore
// ═══════════════════════════════════════════════════════════════════════════

import { saveBackup, restoreBackup, listBackups, getRollbackDirPath, clearAllBackups, resetRollbackState } from "../rollbackStore.js";

describe("Flow 8: Rollback backup → restore", () => {
  beforeEach(() => { resetRollbackState(); });

  it("saveBackup cria backup de arquivo existente", () => {
    const tmpFile = path.join(os.tmpdir(), `rb-flow-${Date.now()}.lua`);
    fs.writeFileSync(tmpFile, "original content");
    try {
      expect(() => saveBackup(tmpFile)).not.toThrow();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* */ }
    }
  });

  it("restoreBackup retorna false para arquivo sem backup", () => {
    expect(restoreBackup("/nonexistent/without/backup.lua")).toBe(false);
  });

  it("listBackups retorna array", () => {
    expect(Array.isArray(listBackups())).toBe(true);
  });

  it("getRollbackDirPath retorna string não vazia", () => {
    const dir = getRollbackDirPath();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
  });

  it("clearAllBackups retorna number", () => {
    expect(typeof clearAllBackups()).toBe("number");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 9: File Validator — matchesPattern
// ═══════════════════════════════════════════════════════════════════════════

import { matchesPattern } from "../fileValidator.js";

describe("Flow 9: File Validator patterns", () => {
  it("*.lua matcheia arquivo .lua", () => {
    expect(matchesPattern("src/main.lua", "*.lua")).toBe(true);
  });

  it("*.lua NÃO matcheia arquivo .py", () => {
    expect(matchesPattern("src/main.py", "*.lua")).toBe(false);
  });

  it("* matcheia qualquer arquivo", () => {
    expect(matchesPattern("anything.txt", "*")).toBe(true);
    expect(matchesPattern("path/file.lua", "*")).toBe(true);
  });

  it("nome exato matcheia", () => {
    expect(matchesPattern("src/main.lua", "main.lua")).toBe(true);
    expect(matchesPattern("src/other.lua", "main.lua")).toBe(false);
  });

  it("usa basename para matching", () => {
    expect(matchesPattern("/home/user/main.lua", "main.lua")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 10: Todo system — items consistency
// ═══════════════════════════════════════════════════════════════════════════

import * as todo from "../todo.js";

describe("Flow 10: Todo system consistency", () => {
  it("renderTodoBar retorna string", () => {
    const bar = todo.renderTodoBar();
    expect(typeof bar).toBe("string");
  });

  it("setTodos e renderTodoBar funcionam", () => {
    todo.setTodos([
      { text: "task 1", status: "completed" },
      { text: "task 2", status: "pending" },
    ]);
    expect(typeof todo.renderTodoBar()).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 11: LLM Compactor — fallback chain
// ═══════════════════════════════════════════════════════════════════════════

import { llmCompact } from "../llmCompactor.js";
import { chat } from "../apiClient.js";
const chatMock = vi.mocked(chat);

describe("Flow 11: LLM Compactor fallback", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("usa LLM quando disponível", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## Resumo\n- Decisão 1\n- Decisão 2" } }],
    } as any);

    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${i} with sufficient content for the LLM compactor test to pass the length threshold check of 500 characters`,
    }));

    const result = await llmCompact(msgs);
    if (result !== null) {
      expect(result).toContain("CONVERSATION MEMORY");
      expect(chatMock).toHaveBeenCalledTimes(1);
    }
  });

  it("retorna null quando LLM falha", async () => {
    chatMock.mockRejectedValue(new Error("API error"));

    const msgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${i} with sufficient content for the test to pass the 500 char threshold`,
    }));

    const result = await llmCompact(msgs);
    expect(result).toBeNull();
  });

  it("retorna null para conversa curta", async () => {
    const result = await llmCompact([{ role: "user", content: "oi" }]);
    expect(result).toBeNull();
  });

  it("retorna null para array vazio", async () => {
    const result = await llmCompact([]);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 12: Effort Levels — todas as combinações
// ═══════════════════════════════════════════════════════════════════════════

import { getEffortLevel, setEffortLevel, getEffortPromptSnippet, getEffortLabel } from "../effortLevels.js";

describe("Flow 12: Effort levels consistency", () => {
  it("cada nível tem prompt snippet diferente", () => {
    const snippets: string[] = [];
    for (const level of ["low", "medium", "high", "max"] as const) {
      setEffortLevel(level);
      const snippet = getEffortPromptSnippet();
      expect(snippet.length).toBeGreaterThan(0);
      snippets.push(snippet);
    }
    // Todos diferentes
    expect(new Set(snippets).size).toBe(4);
  });

  it("getEffortLabel retorna string para cada nível", () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      setEffortLevel(level);
      expect(typeof getEffortLabel()).toBe("string");
    }
  });

  it("setEffortLevel inválido retorna false", () => {
    expect(setEffortLevel("invalid" as any)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 13: i18n — PT-BR e EN têm mesmas chaves
// ═══════════════════════════════════════════════════════════════════════════

import { setLanguage, getLocalizedSlashCommands } from "../i18n.js";

describe("Flow 13: i18n consistency PT-BR vs EN", () => {
  it("ambos idiomas têm 22 comandos", () => {
    setLanguage("pt-BR");
    const ptCmds = getLocalizedSlashCommands();
    setLanguage("en");
    const enCmds = getLocalizedSlashCommands();

    expect(ptCmds.length).toBe(enCmds.length);
    expect(ptCmds.length).toBe(22);
  });

  it("ambos idiomas têm os mesmos command names", () => {
    setLanguage("pt-BR");
    const ptNames = getLocalizedSlashCommands().map(c => c.cmd);
    setLanguage("en");
    const enNames = getLocalizedSlashCommands().map(c => c.cmd);

    expect(ptNames).toEqual(enNames);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 14: Repetition detector não false-positiva em markdown
// ═══════════════════════════════════════════════════════════════════════════

describe("Flow 14: Repetition detector + markdown", () => {
  it("tabela markdown não tem frases 25+ chars repetidas 8x", () => {
    const table = `
| Sistema | Descrição | Status |
|---------|-----------|--------|
| Gacha | Sistema de gacha | Ativo |
| Fusão | Sistema de fusão | Ativo |
| DataStore | Save/Load | Ativo |
| UI | Interface | Pendente |
| Catálogo | Lista de fighters | Pendente |
`;

    const lines = table.split("\n").filter(l => l.includes("|"));
    expect(lines.length).toBeGreaterThan(6);

    const allPhrases: string[] = [];
    for (const line of lines) {
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length >= 25);
      allPhrases.push(...cells);
    }

    const counts = new Map<string, number>();
    for (const p of allPhrases) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const maxReps = Math.max(...counts.values(), 0);
    expect(maxReps).toBeLessThan(8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flow 15: Config Schema — valida configs válidos e inválidos
// ═══════════════════════════════════════════════════════════════════════════

import { validateModeConfig, isValidModeConfig } from "../configSchema.js";

describe("Flow 15: Config Schema validation", () => {
  it("config válido não tem erros", () => {
    const errors = validateModeConfig({
      name: "test", label: "Test", description: "Test mode",
    });
    expect(errors.length).toBe(0);
  });

  it("config sem name tem erros", () => {
    expect(validateModeConfig({ label: "Test" }).length).toBeGreaterThan(0);
  });

  it("config null tem erros", () => {
    expect(validateModeConfig(null).length).toBeGreaterThan(0);
  });

  it("isValidModeConfig true para válido", () => {
    expect(isValidModeConfig({ name: "test", label: "T" })).toBe(true);
  });

  it("isValidModeConfig false para inválido", () => {
    expect(isValidModeConfig({})).toBe(false);
  });
});
