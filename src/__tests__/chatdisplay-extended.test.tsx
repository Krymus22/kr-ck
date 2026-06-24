/**
 * chatdisplay-extended.test.tsx — Testes estendidos do ChatDisplay.
 *
 * O arquivo existente (tui-chatdisplay.test.ts) tem 18 testes mas só
 * testa lógica de slicing/filtragem via funções helper duplicadas. Aqui
 * cobrimos a renderização real com ink-testing-library, focando em edge
 * cases:
 *   - Prefixos PT-BR ("you:", "Claude-Killer:")
 *   - Tool call com path longo truncado no meio (truncateMiddle com "…")
 *   - Tool result OK com checkmark (✔) e ERRO com X (✘)
 *   - Mensagem muito longa (5000 chars) sem crash
 *   - Emojis sem mojibake
 *   - CJK characters (chinês/japonês)
 *   - Código com backticks
 *   - Mensagem vazia
 *   - Múltiplas mensagens em sequência
 *   - Mix de user/assistant/tool em ordem cronológica
 *
 * Seguimos o padrão de mocks de tui-render-snapshots.test.tsx (logger,
 * config, extensions, etc.) para garantir que o ambiente de teste seja
 * idêntico ao dos outros testes TUI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Mocks (mesmo padrão de tui-render-snapshots.test.tsx) ────────────────

// Mock logger
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(),
  debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Mock extensions (não usado pelo ChatDisplay, mas evita imports cascateados)
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Import DEPOIS dos mocks.
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Renderiza ChatDisplay e retorna o output sem ANSI codes. */
function renderMessages(messages: ChatMessage[]): string {
  const { lastFrame } = render(<ChatDisplay messages={messages} />);
  return stripAnsi(lastFrame() ?? "");
}

// ─── Testes ───────────────────────────────────────────────────────────────

describe("ChatDisplay — testes estendidos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Prefixos PT-BR ──────────────────────────────────────────────────

  it("renderiza mensagem de user com prefixo 'you:' (PT-BR)", () => {
    const out = renderMessages([{ role: "user", content: "olá, tudo bem?" }]);
    expect(out).toContain("you:");
    expect(out).toContain("olá, tudo bem?");
  });

  it("renderiza mensagem de assistant com prefixo 'Claude-Killer:'", () => {
    const out = renderMessages([{ role: "assistant", content: "tudo certo!" }]);
    expect(out).toContain("Claude-Killer:");
    expect(out).toContain("tudo certo!");
  });

  // ─── Tool call/result ───────────────────────────────────────────────

  it("renderiza tool call com path longo truncado no meio (truncateMiddle)", () => {
    const longPath = "/home/usuario/projetos/meuapp/src/components/botao/muito/nested/Arquivo.tsx";
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({ path: longPath }),
        toolName: "ler_arquivo",
        isResult: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // truncateMiddle insere "…" (Unicode U+2026) no meio.
    expect(out).toContain("…");
    // O path completo não deve aparecer inalterado (foi truncado).
    expect(out).not.toContain(longPath);
    // Mas início e fim do path devem aparecer.
    expect(out).toContain("/home/usuario");
    expect(out).toContain("Arquivo.tsx");
  });

  it("renderiza tool result OK com checkmark (✔ ou v)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "conteúdo do arquivo",
        toolName: "ler_arquivo",
        isResult: true,
        ok: true,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // icons.check = "✔" (figures tick). Aceita fallback "v" também.
    expect(out).toMatch(/[✔v]/);
    expect(out).toContain("conteúdo do arquivo");
  });

  it("renderiza tool result ERRO com X (✘ ou x)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "[ERROR] arquivo not found",
        toolName: "ler_arquivo",
        isResult: true,
        ok: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("ler_arquivo");
    // icons.cross = "✘" (figures cross). Aceita fallback "x" também.
    expect(out).toMatch(/[✘x]/);
    expect(out).toContain("[ERROR] arquivo not found");
  });

  // ─── Edge cases de conteúdo ─────────────────────────────────────────

  it("renderiza mensagem muito longa (5000 chars) sem crash", () => {
    const longContent = "A".repeat(5000);
    const out = renderMessages([{ role: "user", content: longContent }]);
    expect(out).toContain("you:");
    // Pelo menos algum do conteúdo deve aparecer.
    expect(out).toContain("A");
    // Não deve crashar — output deve ser non-empty.
    expect(out.length).toBeGreaterThan(0);
  });

  it("renderiza mensagem com emojis sem mojibake", () => {
    const out = renderMessages([
      { role: "user", content: "Olá! 🚀🎉💯 teste de emojis" },
    ]);
    expect(out).toContain("🚀");
    expect(out).toContain("🎉");
    expect(out).toContain("💯");
    expect(out).toContain("teste de emojis");
  });

  it("renderiza mensagem com CJK characters (chinês/japonês)", () => {
    const out = renderMessages([
      { role: "assistant", content: "你好世界！ こんにちは。" },
    ]);
    expect(out).toContain("你好世界");
    expect(out).toContain("こんにちは");
  });

  it("renderiza mensagem com código (backticks)", () => {
    const out = renderMessages([
      { role: "assistant", content: "Use `npm test` para rodar os testes" },
    ]);
    expect(out).toContain("`npm test`");
    expect(out).toContain("npm test");
  });

  it("renderiza mensagem vazia sem crash", () => {
    const out = renderMessages([{ role: "user", content: "" }]);
    // Deve renderizar o prefixo "you:" mesmo com conteúdo vazio.
    expect(out).toContain("you:");
    // Não deve crashar.
    expect(out.length).toBeGreaterThan(0);
  });

  // ─── Múltiplas mensagens ────────────────────────────────────────────

  it("renderiza múltiplas mensagens em sequência", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "primeira pergunta" },
      { role: "assistant", content: "primeira resposta" },
      { role: "user", content: "segunda pergunta" },
      { role: "assistant", content: "segunda resposta" },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("primeira pergunta");
    expect(out).toContain("primeira resposta");
    expect(out).toContain("segunda pergunta");
    expect(out).toContain("segunda resposta");
  });

  it("renderiza mensagens misturando user/assistant/tool em ordem cronológica", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "leia o arquivo foo.ts" },
      {
        role: "tool",
        content: JSON.stringify({ path: "/foo.ts" }),
        toolName: "ler_arquivo",
        isResult: false,
      },
      {
        role: "tool",
        content: "conteúdo do foo.ts",
        toolName: "ler_arquivo",
        isResult: true,
        ok: true,
      },
      { role: "assistant", content: "arquivo lido com sucesso" },
    ];
    const out = renderMessages(messages);
    // Todas as mensagens devem aparecer.
    expect(out).toContain("leia o arquivo foo.ts");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("/foo.ts");
    expect(out).toContain("conteúdo do foo.ts");
    expect(out).toContain("arquivo lido com sucesso");
    // Ordem cronológica: user → tool call → tool result → assistant.
    const userPos = out.indexOf("leia o arquivo");
    const toolCallPos = out.indexOf("ler_arquivo");
    const toolResultPos = out.indexOf("conteúdo do foo.ts");
    const assistantPos = out.indexOf("arquivo lido com sucesso");
    expect(userPos).toBeLessThan(toolCallPos);
    expect(toolCallPos).toBeLessThan(toolResultPos);
    expect(toolResultPos).toBeLessThan(assistantPos);
  });

  // ─── Casos extras ───────────────────────────────────────────────────

  it("filtra mensagens de sistema (não renderiza)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "visível" },
      { role: "system", content: "mensagem interna secreta" },
      { role: "assistant", content: "também visível" },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("visível");
    expect(out).toContain("também visível");
    expect(out).not.toContain("mensagem interna secreta");
  });

  it("respeita maxVisible (mostra apenas as últimas N mensagens)", () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `msg${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={10} />);
    const out = stripAnsi(lastFrame() ?? "");
    // maxVisible=10 → mostra as últimas 10 (msg50 a msg59).
    expect(out).toContain("msg59");
    expect(out).toContain("msg50");
    // Não mostra msg49 (foi cortado).
    expect(out).not.toContain("msg49");
  });

  it("renderiza tool call com args de comando (não path)", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: JSON.stringify({ comando: "npm run build" }),
        toolName: "executar_comando",
        isResult: false,
      },
    ];
    const out = renderMessages(messages);
    expect(out).toContain("executar_comando");
    expect(out).toContain("npm run build");
  });
});
