/**
 * history-compactAsync.test.ts — Testes do compactHistoryAsync (LLM-based)
 *
 * Testa a nova função async que tenta LLM compaction primeiro, com fallback
 * para compaction mecânico.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock llmCompactor
const { llmCompactMock, isLlmCompactionAvailableMock } = vi.hoisted(() => ({
  llmCompactMock: vi.fn(),
  isLlmCompactionAvailableMock: vi.fn(),
}));

vi.mock("../llmCompactor.js", () => ({
  llmCompact: llmCompactMock,
  isLlmCompactionAvailable: isLlmCompactionAvailableMock,
}));

vi.mock("../extensions.js", () => ({
  getActiveSkills: vi.fn(() => []),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn(() => ""),
}));

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    model: "test-model",
    contextWindowTokens: 128000,
    contextCompactThreshold: 0.75,
    temperature: 0.6,
    topP: 0.9,
    maxTokens: 4096,
    effortLevel: "medium",
  },
}));

import { compactHistoryAsync, addUserMessage, addRawAssistantMessage, addSystemMessage, resetHistory, getHistory } from "../history.js";

describe("compactHistoryAsync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHistory();
    isLlmCompactionAvailableMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHistory();
  });

  it("retorna null quando histórico é muito curto", async () => {
    const result = await compactHistoryAsync();
    expect(result).toBeNull();
  });

  it("usa LLM quando disponível e retorna method=llm", async () => {
    // Popular histórico com mais de COMPACT_KEEP_RECENT + 1 mensagens
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with sufficient content for testing`);
      addRawAssistantMessage({ role: "assistant", content: `Assistant response ${i} with sufficient content` });
    }

    llmCompactMock.mockResolvedValue(
      "[CONVERSATION MEMORY - LLM-generated summary]\n\n## Context\nTest project\n## Decisions\n- Decision 1\n## Code Changes\n- File edited"
    );

    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("llm");
    expect(llmCompactMock).toHaveBeenCalledTimes(1);
  });

  it("passa custom instruction para llmCompact", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockResolvedValue("[CONVERSATION MEMORY]\n\n## Summary\nTest summary with enough content to pass the length check.");

    await compactHistoryAsync("focus on code changes");

    expect(llmCompactMock).toHaveBeenCalledWith(expect.any(Array), "focus on code changes");
  });

  it("faz fallback para mecânico quando LLM retorna null", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockResolvedValue(null);

    const result = await compactHistoryAsync();
    expect(result).not.toBeNull();
    expect(result?.method).toBe("mechanical");
  });

  it("faz fallback para mecânico quando LLM retorna string muito curta", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockResolvedValue("short");

    const result = await compactHistoryAsync();
    expect(result?.method).toBe("mechanical");
  });

  it("faz fallback para mecânico quando llmCompact lança exceção", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockRejectedValue(new Error("LLM error"));

    const result = await compactHistoryAsync();
    expect(result?.method).toBe("mechanical");
  });

  it("faz fallback para mecânico quando LLM não está disponível", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    isLlmCompactionAvailableMock.mockResolvedValue(false);

    const result = await compactHistoryAsync();
    expect(result?.method).toBe("mechanical");
    expect(llmCompactMock).not.toHaveBeenCalled();
  });

  it("preserva TASK_STATE e Persistent Memory durante compactação", async () => {
    addSystemMessage("## TASK_STATE\nProject: Test\nGoal: Implement feature");

    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockResolvedValue("[CONVERSATION MEMORY]\n\n## Summary\nTest summary.");

    await compactHistoryAsync();

    // TASK_STATE deve estar preservado no histórico
    const history = getHistory();
    const hasTaskState = history.some(m =>
      m.role === "system" && typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
    );
    expect(hasTaskState).toBe(true);
  });

  it("preserva últimos COMPACT_KEEP_RECENT mensagens", async () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`User message ${i} with content`);
      addRawAssistantMessage({ role: "assistant", content: `Response ${i}` });
    }

    llmCompactMock.mockResolvedValue("[CONVERSATION MEMORY]\n\n## Summary\nTest summary.");

    await compactHistoryAsync();

    // As últimas mensagens devem estar preservadas
    const history = getHistory();
    // system prompt + preserved system + compaction summary + recent (6)
    // Verificar que as últimas mensagens contêm "14" (último user message)
    const lastMessages = history.slice(-6);
    const hasLastMessage = lastMessages.some(m =>
      typeof m.content === "string" && m.content.includes("message 14")
    );
    expect(hasLastMessage).toBe(true);
  });
});
