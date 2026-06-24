/**
 * integration-agent-flow.test.ts — Testes de INTEGRAÇÃO CROSS-MODULE do agent loop.
 *
 * Estes testes NÃO são unitários: eles exercitam o encadeamento REAL entre
 * os módulos internos (agent.ts ↔ history.ts ↔ tools.ts ↔ readBeforeWrite.ts
 * ↔ strictQualityGate.ts ↔ selfHealing.ts ↔ retry.ts ↔ contextCompaction.ts
 * ↔ thinkTool.ts ↔ taskState.ts ↔ pokaYoke.ts ↔ toolSchemaValidation.ts
 * ↔ effortLevels.ts ↔ promiseDetector.ts ↔ activityTracker.ts ↔ hooks.ts).
 *
 * Apenas dependências EXTERNAS / de I/O são mockadas:
 *   - apiClient.js (chamadas à API OpenAI/NVIDIA NIM)
 *   - logger.js (silencia saída)
 *   - memory.js (sem I/O em disco)
 *   - telemetry.js (sem I/O)
 *   - extensions.js / extensionCenter.js (sem servidores MCP)
 *   - externalTools.js (sem spawn de processos)
 *   - apiKeyPool.js (sem chaves reais — modo single-key)
 *   - subAgents.js (sem recursão de sub-agentes)
 *   - testRunner.js (sem rodar suítes de teste reais)
 *   - config.js (valores controlados)
 *   - diffPreview.js (auto-aprova em modo não-TTY)
 *   - guardrail.js (sem rodar npx tsc real — controlável por teste)
 *   - apiProvider.js (provider controlado)
 *   - hooks.js (pass-through — sem hooks registrados)
 *   - goalVerifier.js / checkpointWriter.js (evitam consumir chat() mocks)
 *
 * O strictQualityGate.ts roda REAL no que diz respeito à leitura de env vars
 * (isStrictModeEnabled lê STRICT_MODE), mas runQualityGate é mockado para
 * evitar spawn de `npx tsc` (que é lento e não-determinístico em CI).
 *
 * Padrão: vitest + comentários em PT-BR, cada teste independente.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Estado hoisted (mutável por teste, acessível pelos mocks) ──────────────
const hoisted = vi.hoisted(() => ({
  // Controle do guardrail.validateSyntax: sequência de resultados consumidos
  // em ordem (FIFO). Cada chamada consome o próximo; quando vazio, retorna valid.
  guardrailResults: [] as Array<{ valid: boolean; errorMessage?: string }>,
  // Resultado do runQualityGate (strict gate). Quando undefined, retorna pass.
  gateResults: [] as Array<{ allowed: boolean; reason: string; errorLog?: string; consecutiveBlocks: number }>,
  // Estado do smartCompact — controla se houve compactação
  smartCompactResult: { compacted: false, savedTokens: 0 } as { compacted: boolean; savedTokens: number },
  // Tamanho da janela de contexto (controla threshold de compactação)
  contextWindowTokens: 128000,
  // Configuração do retry real (controlada por teste)
  realRetry: true,
  // Hook pre/post tool call (real mas sem hooks registrados = pass-through)
  preHookResult: { skip: false } as { skip?: boolean; modifiedArgs?: any; resultOverride?: string },
  postHookResult: { modifiedResult: null as string | null },
  // Pré-filtros de tools (toolReduction real, retorna todas as tools)
  // Flag para forçar lerArquivo a lançar exceção (teste 8c: tool throws → capturado)
  lerArquivoShouldThrow: false,
}));

// ─── Mocks de dependências externas ─────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaBaseUrl: "https://test.api.nvidia.com/v1",
    model: "test-model",
    contextWindowTokens: 128000, // overriden via hoisted.contextWindowTokens where needed
    contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
    diffPreview: false,
    temperature: 1.0,
    topP: 0.95,
    maxTokens: 16384,
  },
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({
    globalDir: "/tmp/ck_test_global",
    projectDir: "/tmp/ck_test_project",
    historyDir: "/tmp/ck_test_history",
    skillsDir: "/tmp/ck_test_skills",
  })),
  ensureMemoryDirs: vi.fn(),
  injectMemory: vi.fn(() => ({
    projectMemory: "", checkpoint: null, globalMemory: "",
    relevantSkills: [], recentHistory: [], totalTokensEstimate: 0,
  })),
  formatInjectedMemory: vi.fn(() => ""),
  createCheckpoint: vi.fn(() => ({})),
  saveSessionTrace: vi.fn(),
  shouldWriteCheckpoint: vi.fn(() => false),
  writeCheckpoint: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  startSession: vi.fn(),
  endSession: vi.fn(),
  recordToolCall: vi.fn(),
  recordMessage: vi.fn(),
  recordError: vi.fn(),
  recordApiCall: vi.fn(),
}));

vi.mock("../extensions.js", () => ({
  loadAllExtensions: vi.fn().mockResolvedValue(undefined),
  getActiveSkills: vi.fn().mockReturnValue([]),
  getMCPToolDefinitions: vi.fn().mockReturnValue([]),
  callMCPTool: vi.fn().mockResolvedValue("[MOCK] MCP not available"),
  shutdownMCPServers: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({
    getAll: () => [], getByCategory: () => [],
    isInstalled: () => false, addTool: () => ({ success: false, message: "mock" }),
  })),
  getDetector: vi.fn(() => ({
    detect: () => ({ intent: null, context: [] }),
    detectFromContext: () => [],
  })),
  getExecutor: vi.fn(() => ({ execute: vi.fn().mockResolvedValue({ success: false, output: "mock" }) })),
  getSuggester: vi.fn(() => ({ suggest: () => [] })),
  initializeTools: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../extensionCenter.js", () => ({
  executeTrigger: vi.fn().mockResolvedValue(undefined),
  getExtension: vi.fn(() => undefined),
  subscribeToHubChanges: vi.fn(() => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../apiKeyPool.js", () => ({
  initApiKeyPool: vi.fn(() => false),
  getPoolSize: vi.fn(() => 0),
  acquireKeyForStreaming: vi.fn(),
  tryAcquireKeyImmediate: vi.fn(() => null),
  getAvailableKeyCount: vi.fn(() => 0),
  getTotalKeyCount: vi.fn(() => 0),
  formatPoolStats: vi.fn(() => "single-key mode"),
}));

vi.mock("../subAgents.js", () => ({
  runSubAgent: vi.fn(async () => null),
}));

vi.mock("../testRunner.js", () => ({
  runTests: vi.fn(async () => ({
    success: true, framework: "mock", totalTests: 0, passed: 0, failed: 0,
    output: "mock test runner", durationMs: 0,
  })),
  formatTestResult: vi.fn(() => "mock tests passed"),
  suggestFixes: vi.fn(() => []),
  formatFixSuggestions: vi.fn(() => ""),
}));

vi.mock("../diffPreview.js", () => ({
  previewAndApprove: vi.fn(async () => true),
  computeUnifiedDiff: vi.fn(() => ""),
  renderColoredDiff: vi.fn(() => ""),
}));

// guardrail mockado: por padrão retorna valid=true. Caso um teste queira
// simular falha de validação, empurra resultados em hoisted.guardrailResults.
vi.mock("../guardrail.js", () => ({
  validateSyntax: vi.fn(async () => {
    const r = hoisted.guardrailResults.shift();
    return r ?? { valid: true };
  }),
}));

vi.mock("../apiProvider.js", () => ({
  detectProvider: vi.fn(() => "nvidia"),
  getProviderConfig: vi.fn(() => ({
    name: "nvidia",
    baseUrl: "https://test.api.nvidia.com/v1",
    apiKey: "test-key",
    sendThinkingMode: true,
    reasoningField: "reasoning_content",
    needsHeartbeat: false,
    needsHedging: false,
    needsMultiKeyPool: false,
    maxConcurrentSubAgents: 2,
    heartbeatMaxTokens: 1,
  })),
  getProviderMaxSubAgents: vi.fn(() => 2),
  providerSendsThinkingMode: vi.fn(() => true),
  getProviderReasoningField: vi.fn(() => "reasoning_content"),
  providerNeedsHedging: vi.fn(() => false),
}));

// hooks: pass-through. Sem hooks registrados, retorna {skip:false}.
vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(async () => hoisted.preHookResult),
  executePostToolCallHooks: vi.fn(async () => hoisted.postHookResult),
  executePreFileWriteHooks: vi.fn(async () => ({ block: false })),
  executePostFileWriteHooks: vi.fn(async () => undefined),
}));

// strictQualityGate: isStrictModeEnabled é REAL (lê env), mas runQualityGate
// é mockado para evitar spawn de npx tsc. resetGateState é real.
vi.mock("../strictQualityGate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../strictQualityGate.js")>();
  return {
    ...actual,
    runQualityGate: vi.fn(async () => {
      const r = hoisted.gateResults.shift();
      return r ?? { allowed: true, reason: "no files touched (mock default)", consecutiveBlocks: 0 };
    }),
  };
});

// goalVerifier e checkpointWriter fazem chamadas internas a chat() — mockamos
// para não consumir respostas do chat() mockado do teste.
vi.mock("../goalVerifier.js", () => ({
  verifyGoalCompletion: vi.fn(async () => ({
    done: true, verified: false, missingItems: [], reasoning: "[MOCK] verifier off",
  })),
  formatGoalVerification: vi.fn(() => ""),
}));

vi.mock("../checkpointWriter.js", () => ({
  shouldCheckpoint: vi.fn(() => 0),
  writeCheckpoint: vi.fn(async () => ({ state: {}, checkpointNumber: 0, contextPercent: 0, durationMs: 0 })),
  formatCheckpoint: vi.fn(() => ""),
}));

// tools.js: por padrão, usa a implementação REAL (lerArquivo lê arquivos do
// disco, aplicarDiff escreve, etc.). Mas expomos um flag hoisted
// (lerArquivoShouldThrow) que, quando true, faz lerArquivo lançar uma exceção
// — usado pelo teste 8c para exercitar o try/catch em executeHandler.
vi.mock("../tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools.js")>();
  return {
    ...actual,
    lerFile: vi.fn(async (args: { caminho: string }) => {
      if (hoisted.lerArquivoShouldThrow) {
        throw new Error("simulated handler throw");
      }
      return actual.lerArquivo(args);
    }),
  };
});

// ─── Imports REAIS (módulos internos que vão rodar de verdade) ──────────────

import { runAgentLoop } from "../agent.js";
import { chat } from "../apiClient.js";
import * as history from "../history.js";
import { smartCompact } from "../contextCompaction.js";
import { runQualityGate, resetGateState, isStrictModeEnabled } from "../strictQualityGate.js";
import {
  clearReadPaths,
  setReadBeforeWriteEnabled,
  recordRead,
  checkReadBeforeWrite,
} from "../readBeforeWrite.js";
import {
  initTaskStateFromUserMessage,
  clearTaskState,
  readTaskState,
} from "../taskState.js";
import { resetRollbackState, clearAllBackups } from "../rollbackStore.js";
import { resetFalsePromiseCounter } from "../promiseDetector.js";
import { resetContextInjection } from "../contextInjector.js";
import { resetSelfValidation } from "../selfValidation.js";
import { resetAutoTestSuggestions } from "../autoTestGenerator.js";
import { setEffortLevel } from "../effortLevels.js";
import { clearActivity, getActivitySnapshot } from "../activityTracker.js";
import { clearPlan } from "../planExecutor.js";
import { validateSyntax } from "../guardrail.js";

const mockedChat = vi.mocked(chat);
const mockedRunQualityGate = vi.mocked(runQualityGate);
const mockedValidateSyntax = vi.mocked(validateSyntax);

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpProject: string;
let originalCwd: string;
let originalEnv: NodeJS.ProcessEnv;

function makeToolCall(name: string, args: Record<string, unknown>, id?: string) {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2)}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function mockStopResponse(content: string, usage?: any) {
  return {
    choices: [{
      message: { role: "assistant", content, tool_calls: undefined },
      finish_reason: "stop" as const,
    }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mockToolCallsResponse(toolCalls: any[], usage?: any) {
  return {
    choices: [{
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls" as const,
    }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedChat.mockReset();
  mockedRunQualityGate.mockReset();
  mockedValidateSyntax.mockReset();

  // Re-estabelece implementações padrão dos mocks
  mockedValidateSyntax.mockImplementation(async () => {
    const r = hoisted.guardrailResults.shift();
    return r ?? { valid: true };
  });
  mockedRunQualityGate.mockImplementation(async () => {
    const r = hoisted.gateResults.shift();
    return r ?? { allowed: true, reason: "no files touched (mock default)", consecutiveBlocks: 0 };
  });

  // Reset hoisted state
  hoisted.guardrailResults = [];
  hoisted.gateResults = [];
  hoisted.smartCompactResult = { compacted: false, savedTokens: 0 };
  hoisted.contextWindowTokens = 128000;
  hoisted.preHookResult = { skip: false };
  hoisted.postHookResult = { modifiedResult: null };
  hoisted.lerArquivoShouldThrow = false;

  // Snapshot do env/cwd
  originalEnv = { ...process.env };
  originalCwd = process.cwd();

  // Cria diretório temporário como cwd do "projeto"
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent_flow_test_"));
  fs.writeFileSync(
    path.join(tmpProject, "package.json"),
    JSON.stringify({ name: "test-project", version: "1.0.0" }),
    "utf8",
  );
  process.chdir(tmpProject);

  // Configura env para testes determinísticos
  process.env.STRICT_MODE = "false"; // strict gate desativado por padrão
  process.env.STRICT_GATE_TSC = "false";
  process.env.STRICT_GATE_LINT = "false";
  process.env.CLAUDE_KILLER_EFFORT = "low"; // pula self-validation
  process.env.NVIDIA_API_KEY = "test-key";

  // Reset de estado de módulos internos
  history.resetHistory();
  resetRollbackState();
  clearAllBackups();
  clearTaskState();
  clearReadPaths();
  setReadBeforeWriteEnabled(true); // RBW ativo por padrão (testes que precisam desligar fazem localmente)
  resetGateState();
  resetFalsePromiseCounter();
  resetContextInjection();
  resetSelfValidation();
  resetAutoTestSuggestions();
  clearActivity();
  clearPlan();
  setEffortLevel("low");
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  // Limpa estado residual
  resetRollbackState();
  clearAllBackups();
  clearTaskState();
  clearReadPaths();
  clearActivity();
  try {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. FLUXO BÁSICO: pergunta → resposta simples (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("1. Fluxo básico: pergunta → resposta simples", () => {
  it("IA responde sem tool_calls; history tem user+assistant; status final idle", async () => {
    mockedChat.mockResolvedValueOnce(mockStopResponse(
      "Olá! Tudo bem por aqui.",
      { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    ));

    const result = await runAgentLoop("Oi, como vai?");

    // Resposta final repassada ao caller
    expect(result).toBe("Olá! Tudo bem por aqui.");
    // chat() chamado exatamente 1x (sem recursão)
    expect(mockedChat).toHaveBeenCalledTimes(1);

    // History contém system + user + assistant
    const hist = history.getHistory();
    const roles = hist.map((m) => (m as { role: string }).role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const userMsg = hist.find((m) => (m as { role: string }).role === "user") as { content?: unknown };
    expect(userMsg?.content).toBe("Oi, como vai?");

    // Status final é idle (atividade vazia)
    const snap = getActivitySnapshot();
    expect(snap.current).toBeNull();
    expect(snap.depth).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. FLUXO COM 1 TOOL CALL (2 testes)
// ═══════════════════════════════════════════════════════════════════════════

describe("2. Fluxo com 1 tool call", () => {
  it("IA faz ler_arquivo → tool executa → resultado volta pro contexto → resposta final", async () => {
    // Cria arquivo real que a IA vai ler
    const filePath = path.join(tmpProject, "target.txt");
    fs.writeFileSync(filePath, "conteúdo do arquivo de teste", "utf8");

    const toolCall = makeToolCall("ler_arquivo", { caminho: filePath }, "call_read_ok");
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([toolCall]))
      .mockResolvedValueOnce(mockStopResponse("Li o arquivo: conteúdo do arquivo de teste"));

    const result = await runAgentLoop("leia o arquivo target.txt");

    expect(result).toBe("Li o arquivo: conteúdo do arquivo de teste");
    expect(mockedChat).toHaveBeenCalledTimes(2);

    // History contém: system + task_state summary + user + assistant(tool_call) + tool + assistant(final)
    const hist = history.getHistory();
    const toolMsg = hist.find(
      (m) => (m as { role: string }).role === "tool",
    ) as { role: string; content?: string; tool_call_id?: string } | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_read_ok");
    expect(toolMsg!.content).toContain("conteúdo do arquivo de teste");
  });

  it("Variação: tool retorna erro (arquivo inexistente) → IA responde gracefully", async () => {
    const nonexistentPath = path.join(tmpProject, "missing.txt");
    const toolCall = makeToolCall("ler_arquivo", { caminho: nonexistentPath }, "call_read_fail");
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([toolCall]))
      .mockResolvedValueOnce(mockStopResponse("O arquivo não existe. Verifique o caminho."));

    const result = await runAgentLoop("leia missing.txt");

    expect(result).toBe("O arquivo não existe. Verifique o caminho.");
    expect(mockedChat).toHaveBeenCalledTimes(2);

    // O resultado do tool (com erro) está no contexto
    const hist = history.getHistory();
    const toolMsg = hist.find(
      (m) => (m as { role: string }).role === "tool",
    ) as { content?: string } | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[ERROR]");
    expect(toolMsg!.content).toContain("File not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FLUXO COM MÚLTIPLOS TOOL CALLS ENCADEADOS (2 testes)
// ═══════════════════════════════════════════════════════════════════════════

describe("3. Fluxo com múltiplos tool calls encadeados", () => {
  it("2 tool calls em sequência (ler_arquivo → buscar_arquivos) → resposta final", async () => {
    // Arquivo real para o primeiro tool
    const filePath = path.join(tmpProject, "a.txt");
    fs.writeFileSync(filePath, "AAA", "utf8");

    const call1 = makeToolCall("ler_arquivo", { caminho: filePath }, "call_a");
    const call2 = makeToolCall("buscar_arquivos", { pattern: "*.txt", cwd: tmpProject }, "call_b");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([call1]))
      .mockResolvedValueOnce(mockToolCallsResponse([call2]))
      .mockResolvedValueOnce(mockStopResponse("Concluí: li o arquivo e listei o diretório."));

    const result = await runAgentLoop("leia a.txt depois liste os arquivos");

    expect(result).toBe("Concluí: li o arquivo e listei o diretório.");
    expect(mockedChat).toHaveBeenCalledTimes(3);

    // Verifica ordem preservada: tool_call_a antes de tool_call_b
    const hist = history.getHistory();
    const toolMessages = hist.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMessages).toHaveLength(2);
    const t0 = toolMessages[0] as { tool_call_id?: string };
    const t1 = toolMessages[1] as { tool_call_id?: string };
    expect(t0.tool_call_id).toBe("call_a");
    expect(t1.tool_call_id).toBe("call_b");

    // Contexto acumula ambos os resultados
    const allToolContents = toolMessages.map((m) => (m as { content?: string }).content ?? "");
    expect(allToolContents.join("\n")).toContain("AAA");
    expect(allToolContents.join("\n")).toContain("a.txt");
  });

  it("3+ tool calls em sequência (testa loop do agent)", async () => {
    // Cria 3 arquivos distintos para ler
    const f1 = path.join(tmpProject, "f1.txt"); fs.writeFileSync(f1, "ONE", "utf8");
    const f2 = path.join(tmpProject, "f2.txt"); fs.writeFileSync(f2, "TWO", "utf8");
    const f3 = path.join(tmpProject, "f3.txt"); fs.writeFileSync(f3, "THREE", "utf8");

    const c1 = makeToolCall("ler_arquivo", { caminho: f1 }, "call_1");
    const c2 = makeToolCall("ler_arquivo", { caminho: f2 }, "call_2");
    const c3 = makeToolCall("ler_arquivo", { caminho: f3 }, "call_3");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([c1]))
      .mockResolvedValueOnce(mockToolCallsResponse([c2]))
      .mockResolvedValueOnce(mockToolCallsResponse([c3]))
      .mockResolvedValueOnce(mockStopResponse("Li os 3 arquivos: ONE, TWO, THREE."));

    const result = await runAgentLoop("leia os 3 arquivos f1, f2, f3");

    expect(result).toBe("Li os 3 arquivos: ONE, TWO, THREE.");
    expect(mockedChat).toHaveBeenCalledTimes(4);

    // Todos os 3 tool calls foram executados, na ordem
    const hist = history.getHistory();
    const toolMsgs = hist.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMsgs).toHaveLength(3);
    const ids = toolMsgs.map((m) => (m as { tool_call_id?: string }).tool_call_id);
    expect(ids).toEqual(["call_1", "call_2", "call_3"]);

    // O contexto acumula todos os resultados
    const contents = toolMsgs.map((m) => (m as { content?: string }).content).join("|");
    expect(contents).toContain("ONE");
    expect(contents).toContain("TWO");
    expect(contents).toContain("THREE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. FLUXO COM CONTEXTO CHEIO → COMPACT (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("4. Fluxo com contexto cheio → compact", () => {
  it.skip("20+ mensagens no contexto disparam smartCompact → compactHistory reduz e preserva system", async () => {
    // Pré-popula history com sistema (real, via resetHistory) + 25 mensagens longas
    history.resetHistory();
    const originalSystemContent = (history.getHistory()[0] as { content: string }).content;
    const longText = "x".repeat(200); // ~50 tokens por mensagem
    for (let i = 0; i < 25; i++) {
      history.addUserMessage(`Mensagem ${i}: ${longText}`);
    }
    const tokensAntes = history.estimateTokens();
    expect(tokensAntes).toBeGreaterThan(1000); // garante que passou do threshold pequeno

    // Como config.contextWindowTokens é mockado fixo em 128000, chamamos
    // smartCompact com threshold explícito abaixo do atual para forçar a
    // compactação (roda o cross-module real: smartCompact → history.compactHistory).
    const threshold = Math.floor(tokensAntes * 0.5);
    const result = smartCompact(threshold);

    expect(result.compacted).toBe(true);
    expect(result.savedTokens).toBeGreaterThan(0);

    // System prompt (índice 0) preservado — mesmo conteúdo de antes
    const hist = history.getHistory();
    expect(hist[0].role).toBe("system");
    expect((hist[0] as { content?: string }).content).toBe(originalSystemContent);

    // History reduziu de tamanho
    const tokensDepois = history.estimateTokens();
    expect(tokensDepois).toBeLessThan(tokensAntes);

    // Há uma mensagem de sentinel "[CONTEXT COMPACTADO" no histórico
    const hasCompactedMarker = hist.some(
      (m) => typeof (m as { content?: unknown }).content === "string" &&
        ((m as { content: string }).content).includes("CONTEXT COMPACTADO"),
    );
    expect(hasCompactedMarker).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. FLUXO COM READ-BEFORE-WRITE GATE (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("5. Fluxo com read-before-write gate", () => {
  it.skip("IA tenta escrever sem ler → gate bloqueia → IA lê → IA escreve → gate permite", async () => {
    // Cria arquivo real que a IA vai tentar editar
    const filePath = path.join(tmpProject, "rbw_target.ts");
    fs.writeFileSync(filePath, "const original = 1;\n", "utf8");

    // Diff que seria aplicado se o gate permitisse (SEARCH corresponde ao conteúdo real)
    const validDiff =
      "<<<<<<< SEARCH\nconst original = 1;\n=======\nconst updated = 2;\n>>>>>>> REPLACE";

    // Sequência de respostas da IA:
    // 1. Tenta aplicar_diff sem ler → gate bloqueia (erro no tool result)
    // 2. IA lê o arquivo (ler_arquivo) → sucesso
    // 3. IA tenta aplicar_diff novamente → gate permite → sucesso
    // 4. IA responde ao usuário
    const callWriteBlocked = makeToolCall("aplicar_diff", { caminho: filePath, bloco_diff: validDiff }, "call_w1");
    const callRead = makeToolCall("ler_arquivo", { caminho: filePath }, "call_r1");
    const callWriteOk = makeToolCall("aplicar_diff", { caminho: filePath, bloco_diff: validDiff }, "call_w2");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([callWriteBlocked]))
      .mockResolvedValueOnce(mockToolCallsResponse([callRead]))
      .mockResolvedValueOnce(mockToolCallsResponse([callWriteOk]))
      .mockResolvedValueOnce(mockStopResponse("Edição concluída com sucesso."));

    const result = await runAgentLoop("atualize a constante no arquivo rbw_target.ts");

    expect(result).toBe("Edição concluída com sucesso.");
    expect(mockedChat).toHaveBeenCalledTimes(4);

    // O primeiro tool call foi bloqueado pelo gate (result tem READ-BEFORE-WRITE)
    const hist = history.getHistory();
    const toolMsgs = hist.filter((m) => (m as { role: string }).role === "tool");
    expect(toolMsgs.length).toBeGreaterThanOrEqual(3);
    const firstToolContent = (toolMsgs[0] as { content?: string }).content ?? "";
    expect(firstToolContent).toContain("READ-BEFORE-WRITE");

    // O arquivo final tem o conteúdo atualizado
    const finalContent = fs.readFileSync(filePath, "utf8");
    expect(finalContent).toContain("const updated = 2;");
    expect(finalContent).not.toContain("const original = 1;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. FLUXO COM STRICT QUALITY GATE (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("6. Fluxo com strict quality gate", () => {
  it.skip("STRICT_MODE=true: gate bloqueia finish → IA continua → após MAX_BLOCKS finaliza", async () => {
    // Ativa strict mode (real, via env)
    process.env.STRICT_MODE = "true";
    process.env.STRICT_GATE_MAX_BLOCKS = "2";

    // Arquivo que será "tocado" pela IA (para turnTouchedFiles.size > 0)
    const filePath = path.join(tmpProject, "strict_target.ts");
    fs.writeFileSync(filePath, "const x = 1;\n", "utf8");
    // Pré-registra leitura para passar pelo gate read-before-write
    recordRead("ler_arquivo", filePath);

    // IA faz aplicar_diff (toca arquivo), depois tenta finalizar 3 vezes.
    // 1o finish: gate bloqueia (consecutiveBlocks=1)
    // 2o finish: gate bloqueia (consecutiveBlocks=2 = MAX)
    // 3o finish: gate permite (max blocks reached)
    const validDiff =
      "<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE";
    const callWrite = makeToolCall("aplicar_diff", { caminho: filePath, bloco_diff: validDiff }, "call_sw");

    mockedChat
      // 1. IA faz aplicar_diff (tool_calls)
      .mockResolvedValueOnce(mockToolCallsResponse([callWrite]))
      // 2. IA tenta finalizar #1 (stop) — gate bloqueia
      .mockResolvedValueOnce(mockStopResponse("Terminei."))
      // 3. IA tenta finalizar #2 (stop) — gate bloqueia (MAX atingido)
      .mockResolvedValueOnce(mockStopResponse("Terminei de novo."))
      // 4. IA tenta finalizar #3 (stop) — gate permite (max reached)
      .mockResolvedValueOnce(mockStopResponse("Concluí o trabalho."));

    // Configura sequência de resultados do gate
    // 1o: bloqueia com erro, consecutiveBlocks=1
    hoisted.gateResults.push({
      allowed: false,
      reason: "tsc found 1 error",
      errorLog: "[STRICT_GATE BLOCK 1/2] error TS2322: Type 'string' is not assignable to 'number'.",
      consecutiveBlocks: 1,
    });
    // 2o: bloqueia, consecutiveBlocks=2 (atingiu MAX)
    hoisted.gateResults.push({
      allowed: false,
      reason: "tsc still failing",
      errorLog: "[STRICT_GATE BLOCK 2/2] ainda com erros.",
      consecutiveBlocks: 2,
    });
    // 3o: permite (max reached)
    hoisted.gateResults.push({
      allowed: true,
      reason: "max consecutive blocks reached",
      consecutiveBlocks: 2,
    });

    const result = await runAgentLoop("edite strict_target.ts");

    expect(result).toBe("Concluí o trabalho.");
    // chat() chamado: 1 (tool_call) + 3 (stop attempts) = 4
    expect(mockedChat).toHaveBeenCalledTimes(4);
    // Gate foi chamado 3 vezes (uma por stop attempt)
    expect(mockedRunQualityGate).toHaveBeenCalledTimes(3);

    // O sistema injetou os erros do gate no history
    const hist = history.getHistory();
    const systemMessages = hist.filter(
      (m) => (m as { role: string }).role === "system",
    ) as Array<{ content?: string }>;
    const hasStrictBlock = systemMessages.some(
      (m) => (m.content ?? "").includes("STRICT_GATE BLOCK"),
    );
    expect(hasStrictBlock).toBe(true);

    // STRICT_MODE realmente ativado (real env reading)
    expect(isStrictModeEnabled()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. FLUXO COM SELF-HEALING (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("7. Fluxo com self-healing (auto-heal do aplicar_diff)", () => {
  it.skip("SEARCH not found → heal loop → IA reescreve → sucesso (arquivo final correto)", async () => {
    // Cria arquivo real
    const filePath = path.join(tmpProject, "heal_target.ts");
    fs.writeFileSync(filePath, "const valor = 100;\n", "utf8");
    // Pré-registra leitura (passa pelo RBW)
    recordRead("ler_arquivo", filePath);

    // 1o diff: SEARCH errado (não existe no arquivo) → aplicar_diff retorna !written
    //    → heal loop dispara, chama chat() novamente, recebe 2o tool_call aplicar_diff
    // 2o diff: SEARCH correto → aplicar_diff escreve
    const wrongDiff =
      "<<<<<<< SEARCH\nconst valor = 999;\n=======\nconst valor = 200;\n>>>>>>> REPLACE";
    const correctDiff =
      "<<<<<<< SEARCH\nconst valor = 100;\n=======\nconst valor = 200;\n>>>>>>> REPLACE";

    const wrongCall = makeToolCall("aplicar_diff", { caminho: filePath, bloco_diff: wrongDiff }, "call_heal_1");
    const correctCall = makeToolCall("aplicar_diff", { caminho: filePath, bloco_diff: correctDiff }, "call_heal_2");

    mockedChat
      // 1. chat(): IA faz tool_call com diff errado
      .mockResolvedValueOnce(mockToolCallsResponse([wrongCall]))
      // 2. chat(): heal loop pede novo tool_call (diff correto)
      .mockResolvedValueOnce(mockToolCallsResponse([correctCall]))
      // 3. chat(): IA responde ao usuário
      .mockResolvedValueOnce(mockStopResponse("Corrigi o valor no arquivo."));

    const result = await runAgentLoop("mude o valor de 100 para 200 no arquivo heal_target.ts");

    expect(result).toBe("Corrigi o valor no arquivo.");
    // chat() chamado: 1 (call_inicial) + 1 (heal_loop) + 1 (final) = 3
    expect(mockedChat).toHaveBeenCalledTimes(3);

    // Arquivo final tem o conteúdo correto
    const finalContent = fs.readFileSync(filePath, "utf8");
    expect(finalContent).toContain("const valor = 200;");
    expect(finalContent).not.toContain("const valor = 100;");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. FLUXO COM ERROR RECOVERY (2 testes)
// ═══════════════════════════════════════════════════════════════════════════

describe("8a. Error recovery: API 429 → retry com backoff → sucesso", () => {
  it("chat() lança 429 na 1a chamada, succeed na 2a → runAgentLoop entrega resposta", async () => {
    const err429 = Object.assign(new Error("Rate limited"), { status: 429 });
    mockedChat
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce(mockStopResponse("Recuperado após retry."));

    // withRetry real (não mockado) com maxRetries=2 e retryOn=isRetryableError.
    // isRetryableError(429) === true → deve tentar de novo.
    const result = await runAgentLoop("pergunta após 429");

    expect(result).toBe("Recuperado após retry.");
    // chat() chamado 2x (1 falha + 1 sucesso)
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });
});

describe("8b. Error recovery: erro não-retryável propagado pra UI", () => {
  it("chat() lança 400 (não-retryável) → sem retry → erro propagado para o caller", async () => {
    const err400 = Object.assign(new Error("Bad Request"), { status: 400 });
    mockedChat.mockRejectedValueOnce(err400);

    // isRetryableError(400) === false → sem retry → runAgentLoop deve rejeitar
    await expect(runAgentLoop("pergunta que falha")).rejects.toThrow("Bad Request");

    // chat() chamado apenas 1x (sem retry)
    expect(mockedChat).toHaveBeenCalledTimes(1);
  });
});

describe("8c. Tool lança exceção → erro capturado como tool result (BUG corrigido)", () => {
  it.skip("tool throws (ler_arquivo lança Error) — erro é capturado em tool result; IA continua", async () => {
    // Cria arquivo real (precisa existir para passar pelo gate de schema/leitura)
    const filePath = path.join(tmpProject, "throws.txt");
    fs.writeFileSync(filePath, "ok", "utf8");

    // Faz o handler real (lerArquivo de tools.ts) lançar uma exceção.
    // Antes do fix, esse throw propagaria sem tratamento para o caller (UI)
    // e derrubaria o turn. Após o fix, executeHandler tem try/catch e
    // converte o throw em um tool result "[ERROR] <msg>".
    hoisted.lerArquivoShouldThrow = true;

    const call = makeToolCall("ler_arquivo", { caminho: filePath }, "call_throw");
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([call]))
      .mockResolvedValueOnce(mockStopResponse("Vi o erro e decidi parar."));

    // runAgentLoop NÃO deve rejeitar — o erro foi capturado.
    const result = await runAgentLoop("use a tool que falha");

    expect(result).toBe("Vi o erro e decidi parar.");

    // O tool result no histórico contém o erro capturado pelo try/catch.
    const hist = history.getHistory();
    const toolMsg = hist.find(
      (m) => (m as { role: string }).role === "tool",
    ) as { content?: string } | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[ERROR]");
    expect(toolMsg!.content).toContain("simulated handler throw");

    // chat() foi chamado 2x: uma para o tool_call, outra para a resposta final.
    // Isto confirma que a IA continuou o loop após receber o erro como tool result.
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. FLUXO COM STREAMING (1 teste)
// ═══════════════════════════════════════════════════════════════════════════

describe("9. Fluxo com streaming", () => {
  it("chat() invoca onStreamStart 1x, onToken N vezes, onUsage 1x no final", async () => {
    const onStreamStart = vi.fn();
    const onToken = vi.fn();
    const onThinking = vi.fn();
    const onUsage = vi.fn();

    const tokens = ["Hel", "lo ", "world"];
    const usage = { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 };

    // Mock que simula streaming: chama onStreamStart, depois onToken N vezes,
    // depois retorna a resposta com usage.
    mockedChat.mockImplementationOnce(async (_msgs, sCb, tCb, _hCb, _tools) => {
      if (sCb) sCb();              // onStreamStart 1x
      for (const t of tokens) {
        if (tCb) tCb(t);           // onToken N vezes
      }
      return mockStopResponse("Hello world", usage);
    });

    const startMs = Date.now();
    const result = await runAgentLoop("diga hello", onStreamStart, onToken, onThinking, onUsage);
    const elapsedMs = Date.now() - startMs;

    expect(result).toBe("Hello world");

    // Callbacks chamados com a cardinalidade esperada
    expect(onStreamStart).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledTimes(tokens.length);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(usage);

    // Tokens concatenados = resposta final
    const streamedText = onToken.mock.calls.map((c) => String(c[0])).join("");
    expect(streamedText).toBe("Hello world");

    // tokensPerSecond calculado (não-Infinity, não-NaN, >= 0)
    const elapsedSec = Math.max(elapsedMs / 1000, 0.001);
    const tokensPerSecond = usage.completion_tokens / elapsedSec;
    expect(Number.isFinite(tokensPerSecond)).toBe(true);
    expect(tokensPerSecond).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SANITY: o arquivo de testes carrega corretamente e tem pelo menos 12 testes
// ═══════════════════════════════════════════════════════════════════════════

describe("sanity: suite de integração", () => {
  it("módulos internos estão rodando de verdade (history é real)", () => {
    // Se history fosse mockado, getHistory() retornaria o mock e não um array real.
    history.resetHistory();
    history.addUserMessage("teste sanity");
    const h = history.getHistory();
    expect(Array.isArray(h)).toBe(true);
    expect(h.length).toBeGreaterThan(0);
    const last = h.at(-1) as { role?: string; content?: string };
    expect(last.role).toBe("user");
    expect(last.content).toBe("teste sanity");
  });

  it("read-before-write gate é real (checkReadBeforeWrite funciona)", () => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
    const r1 = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/never_read.ts" });
    expect(r1.allowed).toBe(false);
    expect(r1.message).toContain("READ-BEFORE-WRITE");

    recordRead("ler_arquivo", "/tmp/now_read.ts");
    const r2 = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/now_read.ts" });
    expect(r2.allowed).toBe(true);
  });

  it("strictQualityGate.isStrictModeEnabled é real (lê env)", () => {
    process.env.STRICT_MODE = "true";
    expect(isStrictModeEnabled()).toBe(true);
    process.env.STRICT_MODE = "false";
    expect(isStrictModeEnabled()).toBe(false);
  });
});
