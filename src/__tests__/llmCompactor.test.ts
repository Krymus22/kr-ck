/**
 * llmCompactor.test.ts — Testes do LLM-based context compaction
 *
 * Mocka o apiClient.chat() para testar llmCompact() sem fazer chamadas
 * reais à API. Testa também buildConversationText, buildSummarizationPrompt
 * (via export interno), e isLlmCompactionAvailable.
 *
 * IMPORTANTE: llmCompactor usa `await import("./apiClient.js")` (dynamic import),
 * então usamos vi.mock com factory que retorna o módulo mockado. O vitest
 * intercepta dynamic imports quando o mock é registrado antes do teste.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock apiClient usando vi.hoisted (disponível antes da inicialização do módulo)
const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: chatMock,
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaApiKeys: "",
    nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test.api.com/v1",
    model: "test-model",
    rateLimitRpm: 1000,
    maxConcurrency: 1,
    maxHealRetries: 3,
    debug: false,
    contextWindowTokens: 128000,
    contextCompactThreshold: 0.75,
    contextWarnThreshold: 0.6,
    costPerKPrompt: 0,
    costPerKCompletion: 0,
    diffPreview: false,
    maxTokens: 4096,
    temperature: 0.6,
    topP: 0.9,
  },
}));

// Importar após os mocks
import { llmCompact, isLlmCompactionAvailable } from "../llmCompactor.js";

// Helper: criar mensagens de teste
function createTestMessages(count: number = 10): any[] {
  const msgs: any[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: "user", content: `User message ${i} with some content that is long enough` });
    msgs.push({
      role: "assistant",
      content: `Assistant response ${i} with detailed explanation that is long enough`,
      tool_calls: i % 3 === 0 ? [{
        id: `call_${i}`,
        type: "function",
        function: { name: "ler_arquivo", arguments: JSON.stringify({ path: `src/file${i}.lua` }) },
      }] : undefined,
    });
    msgs.push({ role: "tool", content: `Tool result ${i} with some content`, tool_call_id: `call_${i}` });
  }
  return msgs;
}

describe("llmCompactor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("llmCompact", () => {
    it("retorna null para array vazio de mensagens", async () => {
      const result = await llmCompact([]);
      expect(result).toBeNull();
    });

    it("retorna null para conversa muito curta (< 500 chars)", async () => {
      const shortMsgs = [{ role: "user", content: "oi" }];
      const result = await llmCompact(shortMsgs as any);
      expect(result).toBeNull();
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("gera resumo usando LLM quando chat retorna sucesso", async () => {
      chatMock.mockResolvedValue({
        choices: [{
          message: {
            content: "## Resumo da conversa\n- Decisão 1\n- Decisão 2\n- Código criado",
          },
        }],
      } as any);

      const msgs = createTestMessages(5);
      const result = await llmCompact(msgs);

      expect(result).not.toBeNull();
      expect(result).toContain("CONVERSATION MEMORY");
      expect(result).toContain("LLM-generated summary");
      expect(result).toContain("Resumo da conversa");
      expect(chatMock).toHaveBeenCalledTimes(1);
    });

    it("passa custom instruction para o prompt do LLM", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo focado em código" } }],
      } as any);

      const msgs = createTestMessages(5);
      await llmCompact(msgs, "focus on code changes");

      expect(chatMock).toHaveBeenCalledTimes(1);
      const callArgs = chatMock.mock.calls[0][0];
      // O custom instruction deve aparecer no prompt do sistema
      const systemPrompt = callArgs.find((m: any) => m.role === "system")?.content;
      expect(systemPrompt).toContain("focus on code changes");
    });

    it("retorna null quando LLM retorna conteúdo muito curto (< 50 chars)", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "curto" } }],
      } as any);

      const msgs = createTestMessages(5);
      const result = await llmCompact(msgs);

      expect(result).toBeNull();
    });

    it("retorna null quando LLM retorna conteúdo vazio", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "" } }],
      } as any);

      const msgs = createTestMessages(5);
      const result = await llmCompact(msgs);

      expect(result).toBeNull();
    });

    it("retorna null quando LLM retorna choices vazio", async () => {
      chatMock.mockResolvedValue({
        choices: [],
      } as any);

      const msgs = createTestMessages(5);
      const result = await llmCompact(msgs);

      expect(result).toBeNull();
    });

    it("retorna null quando chat() lança exceção", async () => {
      chatMock.mockRejectedValue(new Error("API error"));

      const msgs = createTestMessages(5);
      const result = await llmCompact(msgs);

      expect(result).toBeNull();
    });

    it("filtra mensagens do sistema no texto da conversa", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo gerado pela IA com detalhes suficientes para passar no teste." } }],
      } as any);

      const msgs = [
        { role: "system", content: "## TASK_STATE\nProject: Test projeto Anime Fighters com gacha e fusão de fighters" },
        { role: "system", content: "## Persistent Memory\nInfo sobre o projeto e decisoes tomadas anteriormente" },
        { role: "system", content: "Mensagem de sistema genérica que deve ser filtrada" },
        { role: "user", content: "Mensagem do usuário com conteúdo suficiente para não ser filtrada e passar do limite de 500 caracteres para garantir que o LLM seja chamado neste teste específico do vitest." },
        { role: "assistant", content: "Resposta do assistente com conteúdo suficiente para o teste e mais alguma informação sobre o sistema de gacha" },
        { role: "user", content: "Segunda mensagem do usuário para aumentar o tamanho da conversa e garantir que passa do limite" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo e detalhes sobre implementação" },
        { role: "user", content: "Terceira mensagem do usuário com mais conteúdo para garantir o tamanho" },
        { role: "assistant", content: "Terceira resposta do assistente com detalhes suficientes" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      // TASK_STATE e Persistent Memory devem ser preservados
      expect(userPrompt).toContain("TASK_STATE");
      expect(userPrompt).toContain("Persistent Memory");
      // Mensagem de sistema genérica deve ser filtrada
      expect(userPrompt).not.toContain("Mensagem de sistema genérica");
    });

    it("trunca tool results para 200 chars", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo gerado com sucesso pelo LLM no teste." } }],
      } as any);

      const longToolResult = "A".repeat(500);
      const msgs = [
        { role: "user", content: "Teste do usuário com conteúdo suficiente para passar do limite de 500 caracteres e garantir que o LLM seja chamado neste teste específico do vitest aqui." },
        {
          role: "assistant",
          content: "Resposta do assistente com conteúdo suficiente para o teste",
          tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
        },
        { role: "tool", content: longToolResult, tool_call_id: "c1" },
        { role: "user", content: "Segunda mensagem do usuário para aumentar o tamanho total" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      // Tool result deve ser truncado (conter "..." ou ser menor que 500)
      expect(userPrompt).toContain("TOOL_RESULT");
      // O conteúdo completo de 500 chars não deve estar presente
      expect(userPrompt.includes("A".repeat(300))).toBe(false);
    });

    it("extrai key args de tool calls (path, query, comando)", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo do LLM com conteúdo suficiente para o teste passar do limite de 500 caracteres." } }],
      } as any);

      const msgs = [
        { role: "user", content: "Mensagem do usuário com conteúdo suficiente para o teste e para passar do limite de quinhentos caracteres do llmCompactor com bastante texto adicional" },
        {
          role: "assistant",
          content: "Vou ler o arquivo para entender o contexto do projeto e implementar a funcionalidade solicitada",
          tool_calls: [{
            id: "c1",
            type: "function",
            function: {
              name: "ler_arquivo",
              arguments: JSON.stringify({ path: "src/main.lua", caminho: "src/main.lua" }),
            },
          }],
        },
        { role: "tool", content: "resultado da leitura do arquivo com conteúdo suficiente para o teste do vitest aqui", tool_call_id: "c1" },
        { role: "user", content: "Segunda mensagem para aumentar o tamanho total da conversa e garantir que passa do limite" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo e detalhes sobre a implementação" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      // Path deve aparecer no texto da conversa
      expect(userPrompt).toContain("path=src/main.lua");
    });
  });

  describe("isLlmCompactionAvailable", () => {
    it("retorna true quando API key está configurada", async () => {
      const result = await isLlmCompactionAvailable();
      expect(result).toBe(true);
    });
  });

  describe("buildConversationText (via llmCompact)", () => {
    it("preserva mensagens do usuário", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo gerado pela IA com detalhes suficientes para o teste passar do limite de 500 caracteres do llmCompactor." } }],
      } as any);

      const msgs = [
        { role: "user", content: "Crie um sistema de gacha para o jogo com raridades diferentes e sistema de fusão de fighters" },
        { role: "assistant", content: "Vou criar o sistema solicitado pelo usuário com WeightedRandom e quatro raridades diferentes no Roblox" },
        { role: "user", content: "Segunda mensagem do usuário para aumentar o tamanho total da conversa e garantir que passa do limite" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo suficiente para o teste do vitest passar" },
        { role: "user", content: "Terceira mensagem do usuário com mais conteúdo para garantir o tamanho total da conversa" },
        { role: "assistant", content: "Terceira resposta do assistente com detalhes suficientes para o teste" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      expect(userPrompt).toContain("Crie um sistema de gacha");
    });

    it("preserva respostas do assistente (não tool calls)", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo gerado pela IA com conteúdo suficiente para passar do limite de 500 caracteres do llmCompactor." } }],
      } as any);

      const msgs = [
        { role: "user", content: "Mensagem do usuário para teste com conteúdo suficiente para passar do limite de 500 caracteres do llmCompactor" },
        { role: "assistant", content: "Decidi usar WeightedRandom para o gacha com quatro raridades diferentes no projeto" },
        { role: "user", content: "Segunda mensagem do usuário para aumentar o tamanho total da conversa significativamente" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo e detalhes sobre a implementação" },
        { role: "user", content: "Terceira mensagem do usuário para garantir o tamanho total suficiente" },
        { role: "assistant", content: "Terceira resposta do assistente com mais conteúdo para o teste" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      expect(userPrompt).toContain("WeightedRandom");
    });

    it("filtra respostas que começam com [TOOL", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Resumo gerado pela IA com detalhes suficientes." } }],
      } as any);

      const msgs = [
        { role: "user", content: "Mensagem do usuário para teste com conteúdo suficiente para passar do limite de 500 caracteres do llmCompactor" },
        { role: "assistant", content: "[TOOL_CALL] executar_comando" },
        { role: "assistant", content: "Resposta real do assistente com conteúdo suficiente e detalhes sobre o projeto de gacha" },
        { role: "user", content: "Segunda mensagem do usuário para aumentar o tamanho total da conversa significativamente" },
        { role: "assistant", content: "Segunda resposta do assistente com mais conteúdo para garantir que passa do limite" },
        { role: "user", content: "Terceira mensagem do usuário com mais conteúdo para o teste do vitest" },
        { role: "assistant", content: "Terceira resposta do assistente com mais conteúdo suficiente" },
        { role: "user", content: "Quarta mensagem do usuário para garantir o tamanho total da conversa" },
      ];

      await llmCompact(msgs as any);

      const callArgs = chatMock.mock.calls[0][0];
      const userPrompt = callArgs.find((m: any) => m.role === "user")?.content;

      // [TOOL_CALL] deve ser filtrado
      expect(userPrompt).not.toContain("[TOOL_CALL]");
      // Resposta real deve ser preservada
      expect(userPrompt).toContain("Resposta real do assistente");
    });
  });
});
