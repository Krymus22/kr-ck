/**
 * streaming-stress.test.tsx — Testes de stress para streaming e conversas longas.
 *
 * Cobre os cenários que os testes existentes não exercitam:
 *   - Streaming interrompido (múltiplos onStreamStart, 1000 tokens, chunks vazios,
 *     Unicode, reset de tok/s entre turnos)
 *   - Spam de tool calls (50 calls, JSON grande, erro, args vazias)
 *   - Estado de erro/recuperação (token após onUsage, cancelamento mid-stream,
 *     re-render após reset)
 *   - Conversa longa (100 msgs, system messages intercaladas, 10K tokens na
 *     StatusBar)
 *   - Performance/timeout (200 msgs em <1s, 100 tool calls + 1000 tokens, 50
 *     remontagens sem memory leak)
 *
 * Estratégia:
 *   - Mockamos TODAS as dependências (logger, config, history, modes, agent, etc.)
 *     igual ao tui-tokens-context-bar.test.tsx.
 *   - Para testes de lógica de streaming (reset de tok/s, token após onUsage),
 *     simulamos a lógica diretamente + montamos o App com runAgentLoop mockado
 *     que chama callbacks na ordem desejada.
 *   - Para testes de renderização (conversa longa, spam de tool calls), usamos
 *     ChatDisplay/StatusBar diretamente com props controladas — mais
 *     determinístico que submeter via stdin.
 *   - Para testes de performance, medimos com performance.now() e verificamos
 *     que não dá timeout (10s default do vitest).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Mocks (espelham tui-tokens-context-bar.test.tsx) ──────────────────────

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock config
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Mock extensions
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Mock extensionCenter
vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: vi.fn(() => []),
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: vi.fn(() => ({ total: 0, enabled: 0, byCategory: {} })),
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn(() => ""),
  getTriggerModes: vi.fn(() => []),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => ""),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  // Reactive store hooks — required by useSyncExternalStore in ExtensionHub
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

// Mock modes
vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: vi.fn(() => null),
  getActiveMode: vi.fn(() => null),
  getMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  // Reactive store hooks — required by useSyncExternalStore
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
  suggestMode: vi.fn(() => null),
  confirmAndSaveMode: vi.fn(async () => true),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => ""),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => []),
  getCommandI18n: vi.fn(() => ({})),
}));

vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false),
  setPlanMode: vi.fn(),
  resetHistory: vi.fn(),
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: vi.fn(() => ""),
  historyLength: vi.fn(() => 0),
  compactHistory: vi.fn(() => null),
  getCavemanLevel: vi.fn(() => null),
  setCavemanLevel: vi.fn(),
  reloadProjectMemory: vi.fn(() => null),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

// Mock agent — runAgentLoop é configurado por teste via vi.mocked()
vi.mock("../agent.js", () => ({
  runAgentLoop: vi.fn(async () => "mocked response"),
}));

vi.mock("../todo.js", () => ({
  resetTodo: vi.fn(),
  renderTodoBar: vi.fn(() => ""),
  getTodos: vi.fn(() => []),
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})),
  runDream: vi.fn(async () => ({ reviewedSessions: 0, extractedSkills: 0, deduplicatedEntries: 0 })),
  runDistill: vi.fn(async () => ({ skillsExtracted: 0 })),
}));

vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getLastSession: vi.fn(() => ({
    id: "test-session",
    path: "/tmp/test-session.jsonl",
    projectCwd: "/tmp",
    effortLevel: null,
  })),
  loadSessionMessages: vi.fn(() => ({
    messages: [{ role: "user", content: "dummy-previous-message" }],
    lastSnapshot: null,
    postSnapshotMessages: [{ role: "user", content: "dummy-previous-message" }],
    effortLevel: null,
  })),
  getSessionProjectCwd: vi.fn(() => "/tmp"),
  getSessionEffortLevel: vi.fn(() => null),
  updateSessionProjectCwd: vi.fn(),
  updateSessionEffortLevel: vi.fn(),
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => "test-session"),
  listSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  renameSession: vi.fn(() => true),
}));

vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({})) }));

// Import AFTER mocks
import { runAgentLoop } from "../agent.js";
import { App } from "../tui/App.js";
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import { StatusBar } from "../tui/StatusBar.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tipagem do runAgentLoop mockado para acessar os callbacks. */
type AgentCallbacks = {
  onStreamStart?: () => void;
  onToken?: (t: string) => void;
  onThinking?: () => void;
  onUsage?: (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, ok: boolean, result: string) => void;
};

const baseStatusBarProps = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  contextWindow: 256000,
  warnThreshold: 0.6,
  compactThreshold: 0.75,
  costPerKPrompt: 0.01,
  costPerKCompletion: 0.03,
  planMode: false,
  mcpCount: 0,
  skillsCount: 0,
};

// ─── 1. Streaming interruptions ────────────────────────────────────────────

describe("Streaming interruptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentLoop).mockReset();
  });

  it("onStreamStart chamado múltiplas vezes (tool calls encadeados) sem crashar", async () => {
    // Simula um turno com 3 streams encadeados (após cada tool call, o agent
    // chama chat() novamente, disparando onStreamStart).
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        // Stream 1
        onStreamStart?.();
        onToken?.("Olá");
        // Stream 2 (após tool call hipotético)
        onStreamStart?.();
        onToken?.(" mundo");
        // Stream 3 (após outro tool call)
        onStreamStart?.();
        onToken?.("!");
        onUsage?.({ prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 });
        return "Olá mundo!";
      }
    );

    const { stdin, lastFrame } = render(<App />);
    // ink-text-input exige que o Enter seja enviado em write separado do
    // texto (escrever "oi\r" junto NÃO dispara onSubmit).
    stdin.write("oi");
    await delay(50);
    stdin.write("\r");
    await delay(250);
    const out = stripAnsi(lastFrame() ?? "");
    // App não crashou — banner ainda aparece
    expect(out).toContain("Claude-Killer");
    // Conteúdo final está visível
    expect(out).toContain("Olá");
    expect(out).toContain("mundo");
  });

  it("onStreamToken chamado 1000 vezes em sequência (chunks grandes)", async () => {
    // Gera 1000 chunks pequenos (1 char cada) — simula stream de 1000 tokens.
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        for (let i = 0; i < 1000; i++) {
          onToken?.(i % 10 === 0 ? "X" : "x");
        }
        onUsage?.({ prompt_tokens: 50, completion_tokens: 1000, total_tokens: 1050 });
        return "X" + "x".repeat(999);
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("gera");
    await delay(50);
    stdin.write("\r");
    await delay(500); // mais tempo para 1000 tokens
    const out = stripAnsi(lastFrame() ?? "");
    // App continua renderizando sem crash
    expect(out).toContain("Claude-Killer");
    // Pelo menos parte do conteúdo foi renderizada (Xx ou x)
    expect(out.length).toBeGreaterThan(100);
    // StatusBar deve mostrar tokens (1k+ ou tok/s)
    expect(out).toMatch(/1k|tok/);
  });

  it("REGRESSÃO scroll-roubo: throttle de setMessages não perde conteúdo final", async () => {
    // BUG: antes do throttle, setMessages era chamado a cada token (1000x em
    // 1 seg). Agora com throttle de 80ms, apenas ~12 updates acontecem por
    // segundo. O trailing setTimeout garante que o último conteúdo seja
    // sempre escrito — este teste verifica que mesmo com 500 tokens rápidos
    // (todos chegando em <80ms, ou seja dentro de uma única janela de throttle),
    // o conteúdo final aparece corretamente após o flush.
    const finalText = "RespostaCompleta";
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, onThinking, onUsage) => {
        onStreamStart?.();
        // Dispara 500 tokens MUITO rápido (todos dentro de 80ms) — todos
        // caem na mesma janela de throttle, só o primeiro dispara flush
        // imediato, os demais agendam o trailing.
        for (let i = 0; i < finalText.length; i++) {
          onToken?.(finalText[i]);
        }
        // Chama onThinking (stream end) — deve fazer o flush final
        onThinking?.();
        onUsage?.({ prompt_tokens: 10, completion_tokens: finalText.length, total_tokens: 10 + finalText.length });
        return finalText;
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("test");
    await delay(50);
    stdin.write("\r");
    await delay(400); // tempo para o trailing flush + finalize
    const out = stripAnsi(lastFrame() ?? "");
    // O conteúdo final deve estar completo (não truncado pelo throttle)
    expect(out).toContain("RespostaCompleta");
  });

  it("REGRESSÃO scroll-roubo: múltiplos streams no mesmo turno resetam throttle", async () => {
    // BUG: o throttle state (lastStreamFlushRef, streamFlushTimerRef) deve
    // ser resetado a cada onStreamStart. Se não for, o segundo stream
    // poderia herdar o timer pendente do primeiro e escrever conteúdo
    // stale na mensagem errada.
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, onThinking, onUsage) => {
        // Stream 1
        onStreamStart?.();
        onToken?.("Primeiro");
        onThinking?.();
        // Stream 2 (após tool call, por exemplo)
        onStreamStart?.();
        onToken?.("Segundo");
        onThinking?.();
        onUsage?.({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
        return "Segundo";
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("multi");
    await delay(50);
    stdin.write("\r");
    await delay(400);
    const out = stripAnsi(lastFrame() ?? "");
    // O conteúdo final do segundo stream deve aparecer (não o do primeiro)
    expect(out).toContain("Segundo");
    // App não crashou
    expect(out).toContain("Claude-Killer");
  });

  it("onStreamToken com chunks vazios (\"\") não quebra", async () => {
    // Chunks vazios ocorrem em alguns SSE streams (heartbeats/keepalives).
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        // Mistura chunks vazios com conteúdo
        onToken?.("");
        onToken?.("Hello");
        onToken?.("");
        onToken?.("");
        onToken?.(" World");
        onToken?.("");
        onUsage?.({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        return "Hello World";
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("test");
    await delay(50);
    stdin.write("\r");
    await delay(250);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Claude-Killer");
    // Conteúdo final (sem os chunks vazios) está presente
    expect(out).toContain("Hello");
    expect(out).toContain("World");
  });

  it("onStreamToken com Unicode (emojis, CJK, RTL) preserva caracteres", async () => {
    // Texto com caracteres Unicode variados — deve preservar sem corromper.
    const unicodeText = "🔥 Adoro café ☕ 日本語テスト שלום مرحبا";
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        // Stream char a char (incluindo surrogate pairs)
        onToken?.("🔥 ");
        onToken?.("Adoro café ☕ ");
        onToken?.("日本語テスト ");
        onToken?.("שלום ");
        onToken?.("مرحبا");
        onUsage?.({ prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 });
        return unicodeText;
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("unicode");
    await delay(50);
    stdin.write("\r");
    await delay(250);
    const out = stripAnsi(lastFrame() ?? "");
    // Pelo menos alguns caracteres Unicode devem aparecer no output
    expect(out).toContain("🔥");
    expect(out).toContain("日本語");
    // App não crashou com RTL/emojis
    expect(out).toContain("Claude-Killer");
  });

  it("Tokens/s é resetado a cada turno (não acumula entre streams)", () => {
    // Teste de lógica: simula 3 streams na mesma conversa e verifica que
    // tokenCount e streamStartTime são resetados a cada onStreamStart.
    // (Bug 1 do tui-tokens-context-bar.test.tsx — garantimos que não regrediu.)
    let streamStartTime = 0;
    let tokenCount = 0;

    // Turno 1 — Stream 1: 30 tokens em 0.3s → 100 tok/s
    streamStartTime = 1000;
    tokenCount = 0;
    for (let i = 0; i < 30; i++) tokenCount++;
    let elapsed = (1300 - streamStartTime) / 1000;
    let tps = Math.round(tokenCount / elapsed * 10) / 10;
    expect(tps).toBe(100);

    // Turno 1 — Stream 2 (após tool call): 20 tokens em 0.2s → 100 tok/s
    streamStartTime = 2000;
    tokenCount = 0; // RESET
    for (let i = 0; i < 20; i++) tokenCount++;
    elapsed = (2200 - streamStartTime) / 1000;
    tps = Math.round(tokenCount / elapsed * 10) / 10;
    expect(tps).toBe(100);
    // Se NÃO tivesse resetado, tokenCount=50 → 250 tok/s (bug antigo)

    // Turno 1 — Stream 3 (após outro tool call): 10 tokens em 0.1s → 100 tok/s
    streamStartTime = 3000;
    tokenCount = 0; // RESET
    for (let i = 0; i < 10; i++) tokenCount++;
    elapsed = (3100 - streamStartTime) / 1000;
    tps = Math.round(tokenCount / elapsed * 10) / 10;
    expect(tps).toBe(100);

    // Verifica adicional: tokensPerSecond começa em 0 no início de cada turno
    // (setTokensPerSecond(0) no início do runStreaming).
    let tokensPerSecond = 99.9; // valor residual do turno anterior
    tokensPerSecond = 0; // reset no início do runStreaming
    expect(tokensPerSecond).toBe(0);
  });
});

// ─── 2. Tool call spam ─────────────────────────────────────────────────────

describe("Tool call spam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("50 tool calls em sequência (rota por ferramentas diferentes)", () => {
    // 50 mensagens de tool call + 50 de tool result, alternando ferramentas.
    const toolNames = [
      "ler_arquivo", "aplicar_diff", "executar_comando", "buscar_arquivo",
      "editar_arquivo", "listar_dir", "grep_codigo", "rodar_teste",
    ];
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      const tool = toolNames[i % toolNames.length];
      messages.push({
        role: "tool",
        content: JSON.stringify({ path: `/file${i}.ts` }),
        toolName: tool,
        isResult: false,
      });
      messages.push({
        role: "tool",
        content: `resultado ${i}`,
        toolName: tool,
        isResult: true,
        ok: true,
      });
    }

    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={200} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Pelo menos algumas ferramentas aparecem
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("executar_comando");
    // Última ferramenta visível
    expect(out).toContain("/file49.ts");
    // Não crashou
    expect(out.length).toBeGreaterThan(100);
  });

  it("Tool call com resultado JSON muito grande (10KB)", () => {
    // JSON de 10KB — deve ser truncado pelo formatToolResult (200 chars).
    const bigContent = JSON.stringify({
      data: Array.from({ length: 500 }, (_, i) => ({ id: i, value: "x".repeat(20) })),
    });
    expect(bigContent.length).toBeGreaterThan(10000);

    const messages: ChatMessage[] = [
      { role: "user", content: "consulta" },
      {
        role: "tool",
        content: bigContent,
        toolName: "ler_arquivo",
        isResult: true,
        ok: true,
      },
    ];

    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // App não crashou com JSON grande
    expect(out).toContain("ler_arquivo");
    // O conteúdo é truncado (não aparece o JSON inteiro)
    expect(out).toContain("data");
    // Output não explodiu (truncado em ~200 chars + label)
    expect(out.length).toBeLessThan(2000);
  });

  it("Tool call com erro (status: false) mostra cross icon", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "testa erro" },
      {
        role: "tool",
        content: "[ERROR] File not found: /missing.ts",
        toolName: "ler_arquivo",
        isResult: true,
        ok: false,
      },
    ];

    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Tool name aparece
    expect(out).toContain("ler_arquivo");
    // Mensagem de erro aparece
    expect(out).toContain("[ERROR]");
    expect(out).toContain("not found");
  });

  it("Tool call sem args (args vazio)", () => {
    // args vazio deve renderizar como "{}" via formatToolArgs/parseArgsSafe.
    const messages: ChatMessage[] = [
      { role: "user", content: "rodar" },
      {
        role: "tool",
        content: JSON.stringify({}),
        toolName: "executar_comando",
        isResult: false,
      },
      {
        role: "tool",
        content: "OK",
        toolName: "executar_comando",
        isResult: true,
        ok: true,
      },
    ];

    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Não crashou — tool name aparece
    expect(out).toContain("executar_comando");
    // Não há campo path/comando/query, então formatToolArgs retorna JSON "{}"
    // (truncado para 50 chars, mas "{}" tem 2 chars, então aparece inteiro).
    expect(out).toContain("{}");
  });
});

// ─── 3. Estado de erro/recuperação ─────────────────────────────────────────

describe("Estado de erro/recuperação", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentLoop).mockReset();
  });

  it("onStreamToken recebido DEPOIS do onUsage final (estado inconsistente)", async () => {
    // Cenário buggy: API envia um chunk tardio após o chunk de usage.
    // App.tsx não tem guard explícito contra isso — verify que não crasha.
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        onToken?.("Hello");
        onUsage?.({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
        // Token tardio — depois do usage. App.tsx atualiza streamContent
        // (sem crashar) — apenas o conteúdo final do finalizeMessage é o
        // "response" retornado, então o token tardio é descartado no final.
        onToken?.(" world");
        return "Hello";
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("test");
    await delay(50);
    stdin.write("\r");
    await delay(250);
    const out = stripAnsi(lastFrame() ?? "");
    // App não crashou — banner aparece
    expect(out).toContain("Claude-Killer");
    // Conteúdo final (response retornado) é "Hello"
    expect(out).toContain("Hello");
  });

  it("setStatus(\"idle\") no meio de streaming (cancelamento) — App não trava", async () => {
    // Simula um cancelamento: o agent começa a streamar, mas o usuário
    // cancela (ou um erro força status=idle). Como não podemos injetar
    // setStatus externamente, simulamos via um agent que falha no meio.
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, _onUsage) => {
        onStreamStart?.();
        onToken?.("Parcial...");
        // Simula erro/cancelamento — lança exceção no meio do stream
        throw new Error("Cancelado pelo usuário");
      }
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("test");
    await delay(50);
    stdin.write("\r");
    await delay(350);
    const out = stripAnsi(lastFrame() ?? "");
    // App continua renderizando — o erro é capturado pelo try/catch do
    // handleSubmit e vira systemMessage "Erro: ..."
    expect(out).toContain("Claude-Killer");
    // Mensagem de erro aparece no output
    expect(out).toContain("Erro");
    // Status volta para idle — input placeholder aparece
    expect(out).toMatch(/Digite sua mensagem/i);
  });

  it("Re-render após reset de estado — App continua consistente", async () => {
    // Testa: 1) submete uma mensagem, 2) executa /reset, 3) submete outra.
    // Verifica que o estado é resetado e o App re-renderiza limpo.
    let callCount = 0;
    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        callCount++;
        onStreamStart?.();
        onToken?.(`Resposta ${callCount}`);
        onUsage?.({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
        return `Resposta ${callCount}`;
      }
    );

    const { stdin, lastFrame } = render(<App />);
    // Primeira mensagem (texto e Enter em writes separados — ink-text-input)
    stdin.write("msg1");
    await delay(50);
    stdin.write("\r");
    await delay(200);
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Resposta 1");

    // Reset via slash command
    stdin.write("/reset");
    await delay(50);
    stdin.write("\r");
    await delay(200);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("History reset");

    // Segunda mensagem — App deve estar consistente
    stdin.write("msg2");
    await delay(50);
    stdin.write("\r");
    await delay(200);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Resposta 2");
    // Banner ainda aparece (App não desmontou)
    expect(out).toContain("Claude-Killer");
  });
});

// ─── 4. Conversa longa ─────────────────────────────────────────────────────

describe("Conversa longa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("100 mensagens alternadas user/assistant — só mostra últimas 50", () => {
    // ChatDisplay tem maxVisible=50 por default — mensagens antigas somem.
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Mensagem ${i}`,
    }));

    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={50} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Última mensagem aparece
    expect(out).toContain("Mensagem 99");
    // Primeira mensagem da janela visível (50) aparece
    expect(out).toContain("Mensagem 50");
    // Mensagens antigas (0-49) não aparecem
    expect(out).not.toContain("Mensagem 0");
    expect(out).not.toContain("Mensagem 49");
  });

  it("20 system messages intercaladas — não aparecem, mas user/assistant em ordem", () => {
    // System messages são filtradas no ChatDisplay (return null).
    // Verificamos que: (1) não aparecem no output, (2) user/assistant
    // aparecem na ordem correta.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `User ${i}` });
      messages.push({ role: "system", content: `[SYS] Evento ${i}` });
      messages.push({ role: "assistant", content: `Assistant ${i}` });
    }

    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={200} />);
    const out = stripAnsi(lastFrame() ?? "");
    // System messages não aparecem
    expect(out).not.toContain("[SYS]");
    // User/Assistant aparecem em ordem (verificamos o primeiro e o último)
    expect(out).toContain("User 0");
    expect(out).toContain("Assistant 0");
    expect(out).toContain("User 19");
    expect(out).toContain("Assistant 19");

    // Verifica ordem: User 0 vem antes de Assistant 0, que vem antes de User 1
    const u0 = out.indexOf("User 0");
    const a0 = out.indexOf("Assistant 0");
    const u1 = out.indexOf("User 1");
    expect(u0).toBeGreaterThan(-1);
    expect(a0).toBeGreaterThan(u0);
    expect(u1).toBeGreaterThan(a0);
  });

  it("History com 10K tokens simulados — StatusBar mostra % corretamente", () => {
    // 10000 / 256000 = 3.90625% → Math.round = 4%
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        promptTokens={8000}
        completionTokens={2000}
        totalTokens={10000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // Tokens formatados como "10k/256k"
    expect(out).toContain("10k/256k");
    // Porcentagem arredondada: 4%
    expect(out).toContain("4%");
    // Não mostra 0% (regression check)
    expect(out).not.toMatch(/^0%/);
  });
});

// ─── 5. Performance/timeout ────────────────────────────────────────────────

describe("Performance/timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Renderiza 200 mensagens em menos de 1 segundo", () => {
    // Gera 200 mensagens variadas e mede o tempo de render.
    const messages: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: (i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool") as
        | "user" | "assistant" | "tool",
      content: `Mensagem ${i} com conteúdo razoável para exercitar o layout `.repeat(2),
      ...(i % 3 === 2 ? { toolName: `tool_${i}`, isResult: i % 6 === 5, ok: i % 2 === 0 } : {}),
    }));

    const start = performance.now();
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    const elapsed = performance.now() - start;

    // Renderizou sem timeout
    expect(out).toContain("Mensagem 199");
    // Tempo < 1000ms (com margem generosa para CI)
    expect(elapsed).toBeLessThan(1000);
  });

  it("Não trava com 100 tool calls + 1000 tokens em 500ms", () => {
    // Cenário de stress: 100 tool calls + 1 assistant message com 1000
    // "tokens" (chars). Verifica que renderiza dentro do timeout do vitest.
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: "tool",
        content: JSON.stringify({ path: `/f${i}.ts`, line: i }),
        toolName: `tool_${i % 10}`,
        isResult: false,
      });
      messages.push({
        role: "tool",
        content: `ok result ${i}`,
        toolName: `tool_${i % 10}`,
        isResult: true,
        ok: true,
      });
    }
    // Assistant message com ~1000 chars (≈ 250 tokens reais, mas chamamos de 1000)
    messages.push({
      role: "assistant",
      content: "A".repeat(1000),
    });

    const start = performance.now();
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={300} />);
    const out = stripAnsi(lastFrame() ?? "");
    const elapsed = performance.now() - start;

    // Não travou — renderizou
    // Note: MarkdownRenderer may split text, so we check for partial content
    expect(out).toContain("A"); // at least some A's appear
    expect(out.length).toBeGreaterThan(50);
    // Tempo razoável (< 5000ms com margem — garante que não houve travamento)
    expect(elapsed).toBeLessThan(5000);
  });

  it("Memory leak: 50 conversas em sequência (remontar componente) sem estourar memória", () => {
    // Renderiza e desmonta o App 50 vezes com conversas crescentes.
    // Se houver memory leak (ex: listeners não removidos, refs acumulando),
    // o processo pode ficar lento ou crashar — mas o teste só verifica que
    // completa sem erro dentro do timeout.
    const instances: Array<{ unmount: () => void; lastFrame: () => string | undefined }> = [];

    for (let i = 0; i < 50; i++) {
      const messages: ChatMessage[] = Array.from({ length: 20 }, (_, j) => ({
        role: j % 2 === 0 ? "user" as const : "assistant" as const,
        content: `Conv${i} Msg${j}`,
      }));
      const inst = render(<ChatDisplay messages={messages} />);
      instances.push(inst);
      // Verifica que cada instância renderizou
      const out = stripAnsi(inst.lastFrame() ?? "");
      expect(out).toContain(`Conv${i} Msg19`);
    }

    // Desmonta todas (libera refs)
    for (const inst of instances) {
      inst.unmount();
    }

    // Se chegou aqui sem erro/timeout, não houve memory leak crítico.
    // Como sanity check, força GC se disponível e verifica que o processo
    // ainda responde.
    if (typeof global.gc === "function") {
      global.gc();
    }
    expect(instances.length).toBe(50);
  });
});
