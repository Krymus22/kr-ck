/**
 * subAgents-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: runSubAgent (3 extras), parallel agents (2), result aggregation (2)
 * e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  isTransientNetworkErrorPublic: vi.fn((err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
  }),
  is429ErrorPublic: vi.fn((err: any) => err?.status === 429),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

vi.mock("../tools.js", () => ({
  lerFile: vi.fn().mockResolvedValue("conteúdo mock"),
}));

vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn().mockReturnValue([]) }));
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(),
  formatGrepResults: vi.fn().mockReturnValue(""),
}));
vi.mock("../lspAst.ts", () => ({ parseFile: vi.fn() }));

vi.mock("../effortLevels.js", () => ({
  shouldUseSubAgents: vi.fn().mockReturnValue(true),
  getEffortLevel: vi.fn().mockReturnValue("high"),
}));

vi.mock("../history.js", () => ({
  getSystemPrompt: vi.fn().mockReturnValue("MOCK MAIN SYSTEM PROMPT"),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../agent.js", () => ({
  getMergedToolsPublic: vi.fn().mockReturnValue([
    {
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Read a file",
        parameters: { type: "object", properties: { caminho: { type: "string" } } },
      },
    },
  ]),
  dispatchToolCallPublic: vi.fn().mockResolvedValue({
    resultStr: "[OK] mock dispatch result",
    usedHeal: false,
  }),
}));

import { runSubAgent, shouldDelegateToSubAgent, shouldUsePowerfulSubAgents } from "../subAgents.js";
import { chat } from "../apiClient.js";
import { shouldUseSubAgents, getEffortLevel } from "../effortLevels.js";

const mockedChat = chat as ReturnType<typeof vi.fn>;
const mockedShouldUse = shouldUseSubAgents as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedChat.mockReset();
  mockedShouldUse.mockReturnValue(true);
  mockedGetEffort.mockReturnValue("high");
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

describe("subAgents — extended", () => {
  // ─── runSubAgent (3 extras) ────────────────────────────────────────────────

  describe("runSubAgent — extras", () => {
    it("chama chat() com histórico contendo system + user (cwd)", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{ message: { content: "## Summary\nok" }, finish_reason: "stop" }],
      });
      await runSubAgent({ question: "explore foo", cwd: "/tmp/project" });
      const args = mockedChat.mock.calls[0];
      const messages = args[0];
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toContain("/tmp/project");
      expect(messages[1].content).toContain("explore foo");
    });

    it("retorna null quando histórico é muito curto (content <10 chars)", async () => {
      mockedChat.mockResolvedValueOnce({
        choices: [{ message: { content: "short" }, finish_reason: "stop" }],
      });
      const r = await runSubAgent({ question: "test" });
      // "short".length === 5 < 10 → considerado muito curto → null
      expect(r).toBeNull();
    });

    it("respeita maxToolCalls custom (2) e para antes de exceder", async () => {
      let calls = 0;
      mockedChat.mockImplementation(async () => {
        calls++;
        // Todas as chamadas retornam tool_calls (nunca finaliza)
        return {
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: `tc${calls}`, function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        };
      });
      const r = await runSubAgent({ question: "q", maxToolCalls: 2 });
      // Após 2 iterações sem finish_reason=stop, retorna null (hit maxToolCalls)
      expect(r).toBeNull();
      expect(calls).toBe(2); // loop rodou exatamente 2 vezes
    });
  });

  // ─── Parallel agents (2) ───────────────────────────────────────────────────

  describe("parallel agents", () => {
    it("deve ser possível chamar runSubAgent múltiplas vezes em paralelo (Promise.all)", async () => {
      mockedChat
        .mockResolvedValueOnce({ choices: [{ message: { content: "## Summary\nA" }, finish_reason: "stop" }] })
        .mockResolvedValueOnce({ choices: [{ message: { content: "## Summary\nB" }, finish_reason: "stop" }] });

      const [a, b] = await Promise.all([
        runSubAgent({ question: "task A" }),
        runSubAgent({ question: "task B" }),
      ]);
      expect(a).toBe("## Summary\nA");
      expect(b).toBe("## Summary\nB");
    });

    it("ids de sub-agentes devem ser distintos em execuções paralelas", async () => {
      const ids = new Set<string>();
      mockedChat.mockImplementation(async () => {
        // Captura o agent ID corrente durante a chamada
        ids.add(process.env.CLAUDE_KILLER_AGENT_ID ?? "(none)");
        return { choices: [{ message: { content: "## Summary\nok" }, finish_reason: "stop" }] };
      });
      await Promise.all([
        runSubAgent({ question: "a" }),
        runSubAgent({ question: "b" }),
        runSubAgent({ question: "c" }),
      ]);
      // Pelo menos 2 IDs distintos devem ter sido observados (concorrência)
      expect(ids.size).toBeGreaterThanOrEqual(2);
      for (const id of ids) {
        expect(id).toMatch(/^sub-\d+$/);
      }
    });
  });

  // ─── Result aggregation (2) ────────────────────────────────────────────────

  describe("result aggregation", () => {
    it("preserva o summary do modelo mesmo quando ele chama tool_calls antes", async () => {
      mockedChat
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: "tc1", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: "## Summary\nResultado final com contexto" }, finish_reason: "stop" }],
        });
      const r = await runSubAgent({ question: "investiga", maxToolCalls: 3 });
      expect(r).toBe("## Summary\nResultado final com contexto");
    });

    it("delega para tools read-only quando modelo chama 'buscar_arquivos'", async () => {
      mockedChat
        .mockResolvedValueOnce({
          choices: [{
            message: {
              content: null,
              tool_calls: [{ id: "tc1", function: { name: "buscar_arquivos", arguments: '{"pattern":"**/*.ts"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        })
        .mockResolvedValueOnce({
          choices: [{ message: { content: "## Summary\nbuscou arquivos" }, finish_reason: "stop" }],
        });
      const r = await runSubAgent({ question: "busca", maxToolCalls: 2 });
      expect(r).toBe("## Summary\nbuscou arquivos");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("shouldDelegateToSubAgent respeita lista de triggers em PT e EN", () => {
      expect(shouldDelegateToSubAgent("onde está o arquivo X?")).toBe(true);
      expect(shouldDelegateToSubAgent("where is the auth module?")).toBe(true);
      expect(shouldDelegateToSubAgent("how does the parser work?")).toBe(true);
      expect(shouldDelegateToSubAgent("olá, tudo bem?")).toBe(false);
    });

    it("shouldUsePowerfulSubAgents só é true em effort=max", () => {
      mockedGetEffort.mockReturnValue("high");
      expect(shouldUsePowerfulSubAgents()).toBe(false);
      mockedGetEffort.mockReturnValue("max");
      expect(shouldUsePowerfulSubAgents()).toBe(true);
      mockedGetEffort.mockReturnValue("medium");
      expect(shouldUsePowerfulSubAgents()).toBe(false);
    });
  });
});
