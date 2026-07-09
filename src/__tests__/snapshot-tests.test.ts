/**
 * snapshot-tests.test.ts — Congela comportamento esperado de funções críticas
 *
 * Se alguém mudar o comportamento de uma função, o snapshot falha e
 * obriga a atualizar conscientemente (vitest run -u).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", model: "test-model",
    contextWindowTokens: 128000, contextCompactThreshold: 0.75,
    temperature: 0.6, topP: 0.9, maxTokens: 4096, effortLevel: "medium",
  },
}));

// ─── robloxMcpGuard ─────────────────────────────────────────────────────────

import { classifyMcpTool, extractToolName, isRobloxStudioMcpTool } from "../robloxMcpGuard.js";

describe("Snapshot: robloxMcpGuard", () => {
  it("classifyMcpTool classifica todas as tools conhecidas", () => {
    const classifications: Record<string, string> = {};
    const allTools = [
      "script_read", "script_search", "script_grep", "search_game_tree",
      "inspect_instance", "explore_subagent", "list_roblox_studios", "console_output",
      "multi_edit", "insert_from_creator_store", "generate_mesh",
      "generate_material", "generate_procedural_model",
      "execute_luau", "run_script_in_play_mode",
      "start_stop_play", "screen_capture", "playtest_subagent",
      "character_navigation", "keyboard_input", "mouse_input",
      "set_active_studio",
    ];
    for (const tool of allTools) {
      classifications[tool] = classifyMcpTool(tool);
    }
    expect(classifications).toMatchInlineSnapshot(`
      {
        "character_navigation": "playtest",
        "console_output": "read",
        "execute_luau": "execute",
        "explore_subagent": "read",
        "generate_material": "write",
        "generate_mesh": "write",
        "generate_procedural_model": "write",
        "insert_from_creator_store": "write",
        "inspect_instance": "read",
        "keyboard_input": "playtest",
        "list_roblox_studios": "read",
        "mouse_input": "playtest",
        "multi_edit": "write",
        "playtest_subagent": "write",
        "run_script_in_play_mode": "execute",
        "screen_capture": "playtest",
        "script_grep": "read",
        "script_read": "read",
        "script_search": "read",
        "search_game_tree": "read",
        "set_active_studio": "session",
        "start_stop_play": "playtest",
      }
    `);
  });

  it("extractToolName extrai nomes corretamente", () => {
    expect(extractToolName("Roblox_Studio__multi_edit")).toMatchInlineSnapshot(`"multi_edit"`);
    expect(extractToolName("Roblox_Studio__script_read")).toMatchInlineSnapshot(`"script_read"`);
    expect(extractToolName("no_prefix")).toMatchInlineSnapshot(`"no_prefix"`);
  });

  it("isRobloxStudioMcpTool detecta todos os prefixos", () => {
    expect(isRobloxStudioMcpTool("Roblox_Studio__multi_edit")).toBe(true);
    expect(isRobloxStudioMcpTool("roblox_studio__script_read")).toBe(true);
    expect(isRobloxStudioMcpTool("RobloxStudio__execute_luau")).toBe(true);
    expect(isRobloxStudioMcpTool("other__tool")).toBe(false);
  });
});

// ─── researchHint ───────────────────────────────────────────────────────────

import { detectResearchTrigger } from "../researchHint.js";

describe("Snapshot: researchHint triggers", () => {
  it("triggers para queries voláteis", () => {
    const triggers: Record<string, string | null> = {
      "o que é Anime Fighters": detectResearchTrigger("o que é Anime Fighters"),
      "latest version of React": detectResearchTrigger("latest version of React?"),
      "what happened this week": detectResearchTrigger("what happened this week?"),
      "notícias sobre OpenAI": detectResearchTrigger("notícias sobre OpenAI"),
    };
    expect(triggers).toMatchInlineSnapshot(`
      {
        "latest version of React": "version_info",
        "notícias sobre OpenAI": "recent_news",
        "o que é Anime Fighters": "current_state",
        "what happened this week": "recent_news",
      }
    `);
  });

  it("NÃO triggers para queries atemporais", () => {
    const nonTriggers: Record<string, string | null> = {
      "print em python": detectResearchTrigger("como fazer print em python?"),
      "OOP": detectResearchTrigger("what is OOP?"),
      "HTTP": detectResearchTrigger("o que é HTTP?"),
      "closure": detectResearchTrigger("what is a closure?"),
    };
    expect(nonTriggers).toMatchInlineSnapshot(`
      {
        "HTTP": null,
        "OOP": null,
        "closure": null,
        "print em python": null,
      }
    `);
  });
});

// ─── argsNormalizer ─────────────────────────────────────────────────────────

import { normalizeArgs } from "../argsNormalizer.js";

describe("Snapshot: argsNormalizer aliases", () => {
  it("caminho → path", () => {
    const args: any = { caminho: "/test.lua" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toMatchInlineSnapshot(`"/test.lua"`);
  });

  it("command → comando", () => {
    const args: any = { command: "npm test" };
    normalizeArgs("executar_comando", args);
    expect(args.comando).toMatchInlineSnapshot(`"npm test"`);
  });

  it("thought → pensamento", () => {
    const args: any = { thought: "thinking..." };
    normalizeArgs("pensar", args);
    expect(args.pensamento).toMatchInlineSnapshot(`"thinking..."`);
  });

  it("question → questao (explorar_subagente)", () => {
    const args: any = { question: "How does X work?" };
    normalizeArgs("explorar_subagente", args);
    expect(args.questao).toMatchInlineSnapshot(`"How does X work?"`);
  });

  it("type coercion: string → number", () => {
    const args: any = { count: "42" };
    const schema = { properties: { count: { type: "number" } } };
    normalizeArgs("test", args, schema as any);
    expect(args.count).toMatchInlineSnapshot(`42`);
  });

  it("type coercion: string → boolean", () => {
    const args: any = { flag: "true" };
    const schema = { properties: { flag: { type: "boolean" } } };
    normalizeArgs("test", args, schema as any);
    expect(args.flag).toMatchInlineSnapshot(`true`);
  });
});

// ─── fileValidator ──────────────────────────────────────────────────────────

import { matchesPattern } from "../fileValidator.js";

describe("Snapshot: fileValidator patterns", () => {
  it("pattern matching results", () => {
    const results: Record<string, boolean> = {
      "main.lua *.lua": matchesPattern("main.lua", "*.lua"),
      "main.py *.lua": matchesPattern("main.py", "*.lua"),
      "anything *": matchesPattern("anything.txt", "*"),
      "main.lua main.lua": matchesPattern("main.lua", "main.lua"),
      "other.lua main.lua": matchesPattern("other.lua", "main.lua"),
    };
    expect(results).toMatchInlineSnapshot(`
      {
        "anything *": true,
        "main.lua *.lua": true,
        "main.lua main.lua": true,
        "main.py *.lua": false,
        "other.lua main.lua": false,
      }
    `);
  });
});

// ─── effortLevels ───────────────────────────────────────────────────────────

import { getEffortPromptSnippet, setEffortLevel } from "../effortLevels.js";

describe("Snapshot: effortLevels", () => {
  beforeEach(() => { setEffortLevel("medium"); });

  it("low effort prompt", () => {
    setEffortLevel("low");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toMatchInlineSnapshot(`
      "## EFFORT LEVEL: LOW
      Always use pensar() before acting — even a 1-sentence thought: "vou fazer X porque Y".
      Responda direto e conciso. Foque em velocidade mas NÃO pule o pensar().
      Categorias: pre_edit (antes de editar), pre_response (antes de responder), planning (antes de começar)."
    `);
  });

  it("medium effort prompt", () => {
    setEffortLevel("medium");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toMatchInlineSnapshot(`
      "## EFFORT LEVEL: MEDIUM (default)
      Use pensar() before any action (edit, command, respond). 2-3 frases: o que, por quê, o que pode dar errado.
      Categorias obrigatórias:
      - pre_edit: antes de editar arquivo (responda o checklist anti-bug)
      - pre_research: antes de pesquisar API
      - pre_response: antes de responder ao usuário (honestidade)
      - planning: antes de começar uma tarefa
      Verifique tipos e erros óbvios antes de escrever código."
    `);
  });

  it("high effort prompt", () => {
    setEffortLevel("high");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toMatchInlineSnapshot(`
      "## EFFORT LEVEL: HIGH
      Use pensar() before EVERY action with the correct category. 4-6 frases, responda o checklist completo.
      Categorias obrigatórias:
      - planning: antes de começar (liste arquivos, ordem, riscos)
      - pre_edit: antes de editar (checklist anti-bug: leu? search existe? quebugs? edge cases? Bug Hunter aprovaria?)
      - pre_research: antes de pesquisar (o que sei, o que preciso confirmar)
      - pre_response: antes de responder (verifiquei? estou sendo honesto?)
      - debugging: investigando bugs
      Após editar, rode testes/tsc para validar.
      Considere delegar exploração para sub-agentes."
    `);
  });

  it("max effort prompt", () => {
    setEffortLevel("max");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toMatchInlineSnapshot(`
      "## EFFORT LEVEL: MAX
      Use pensar() before EVERY tool call. 6+ frases estruturadas. Responda o checklist completo.
      Estruture: (1) o que vou fazer, (2) por quê, (3) o que li do arquivo, (4) edge cases, (5) alternativas consideradas, (6) impacto em outros arquivos, (7) que bugs o Bug Hunter encontraria.
      Categorias obrigatórias: planning, pre_edit, pre_research, pre_response, debugging, architecture.
      Antes de finish, valide explicitamente o trabalho feito nesta turn.
      Use sub-agentes para explorar em paralelo.
      Se não tiver certeza, faça mais research antes de agir.
      HONESTY OVER AGREEMENT — sempre."
    `);
  });
});

// ─── invariants ─────────────────────────────────────────────────────────────

import { invariant } from "../invariants.js";

describe("Snapshot: invariant output format", () => {
  it("formato do erro quando dispara", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    invariant(false, "TEST_ID", "Test message", { key: "value", num: 42 });
    const output = spy.mock.calls[0]?.[0] as string;
    expect(output).toMatchInlineSnapshot(
      `"[INVARIANT VIOLATION] TEST_ID: Test message key="value" num=42"`,
    );
    spy.mockRestore();
  });
});

// ─── autoMemory ─────────────────────────────────────────────────────────────

import { detectUserCorrection } from "../autoMemory.js";

describe("Snapshot: autoMemory correction detection", () => {
  it("detecta correções em PT-BR e EN", () => {
    const results: Record<string, string | null> = {
      "não use print": detectUserCorrection("Não use print, use warn"),
      "sempre use pcall": detectUserCorrection("Sempre use pcall com DataStore"),
      "errado": detectUserCorrection("Errado, o correto é outro"),
      "actually": detectUserCorrection("Actually, you should use await"),
      "pergunta normal": detectUserCorrection("Pode me ajudar?"),
    };
    // null para pergunta normal, não-null para correções
    expect(results["pergunta normal"]).toBeNull();
    expect(results["não use print"]).not.toBeNull();
    expect(results["sempre use pcall"]).not.toBeNull();
    expect(results["errado"]).not.toBeNull();
    expect(results["actually"]).not.toBeNull();
  });
});

// ─── thinkTool ──────────────────────────────────────────────────────────────

import { think } from "../thinkTool.js";

describe("Snapshot: thinkTool output", () => {
  it("retorna confirmed=true para pre_edit", async () => {
    const result = await think({ pensamento: "test", categoria: "pre_edit" } as any);
    expect(result.confirmed).toMatchInlineSnapshot(`true`);
  });

  it("message contém checklist", async () => {
    const result = await think({ pensamento: "test", categoria: "pre_edit" } as any);
    expect(result.message).toMatchInlineSnapshot(`
      "[THINK] ✓ Pensamento registrado (pre_edit, 4 chars)
      🔍 Checklist anti-bug antes de editar:
      □ Li o arquivo? (ler_arquivo)
      □ O search string EXISTE no arquivo atual?
      □ O replace pode quebrar imports/exports/tipos?
      □ Que bugs posso introduzir? (liste cada um)
      □ Tem edge case: null, undefined, vazio, negativo?
      □ O Bug Hunter aprovaria esta mudança?
      → Se não passou no checklist, RELEIA o arquivo antes de editar.
      Próximo passo: Pense em 6+ frases. Estruture: (1) o que, (2) por quê, (3) o que li, (4) edge cases, (5) alternativas, (6) impacto. Responda o checklist completo."
    `);
  });
});

// ─── i18n slash commands ────────────────────────────────────────────────────

import { getLocalizedSlashCommands, setLanguage } from "../i18n.js";

describe("Snapshot: i18n slash commands list", () => {
  it("PT-BR tem 26 comandos", () => {
    setLanguage("pt-BR");
    const cmds = getLocalizedSlashCommands().map(c => c.cmd);
    expect(cmds).toMatchInlineSnapshot(`
      [
        "/help",
        "/hub",
        "/mode",
        "/reset",
        "/history",
        "/skills",
        "/plugins",
        "/tools",
        "/toolinfo",
        "/effort",
        "/pool",
        "/caveman",
        "/memory",
        "/todos",
        "/plan",
        "/compact",
        "/dream",
        "/distill",
        "/lang",
        "/exit",
        "/session",
        "/cd",
        "/mcp",
        "/buscar",
        "/organize",
        "/searx",
      ]
    `);
  });

  it("EN tem 26 comandos", () => {
    setLanguage("en");
    const cmds = getLocalizedSlashCommands().map(c => c.cmd);
    expect(cmds).toMatchInlineSnapshot(`
      [
        "/help",
        "/hub",
        "/mode",
        "/reset",
        "/history",
        "/skills",
        "/plugins",
        "/tools",
        "/toolinfo",
        "/effort",
        "/pool",
        "/caveman",
        "/memory",
        "/todos",
        "/plan",
        "/compact",
        "/dream",
        "/distill",
        "/lang",
        "/exit",
        "/session",
        "/cd",
        "/mcp",
        "/buscar",
        "/organize",
        "/searx",
      ]
    `);
  });
});
