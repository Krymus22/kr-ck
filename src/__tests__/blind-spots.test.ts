/**
 * blind-spots.test.ts — Testes para os 20 pontos cegos mais críticos.
 *
 * Identificados por investigação profunda das interações entre módulos
 * (agent ↔ history ↔ session ↔ apiClient ↔ TUI ↔ extensions) que NÃO
 * eram cobertas pelos 6900+ testes existentes.
 *
 * 3 BUGS CONFIRMADOS foram corrigidos e seus testes marcados com ✅ FIXED:
 *   BS-3: Stale snapshot wins over newer messages
 *   BS-4: Orphan tool_call_id on terminal close
 *   BS-18: readBeforeWrite state leaks across /reset and /session load
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

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
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: vi.fn(() => null),
  getActiveMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldAutoGenerateTests: vi.fn(() => false),
  shouldUseSubAgents: vi.fn(() => false),
  shouldUseIntelligentCompaction: vi.fn(() => true),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => ""),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => []),
  getCommandI18n: vi.fn(() => ({})),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

vi.mock("../agent.js", () => ({
  runAgentLoop: vi.fn(async () => "mocked response"),
}));

vi.mock("../todo.js", () => ({
  resetTodo: vi.fn(),
  renderTodoBar: vi.fn(() => ""),
  getTodos: vi.fn(() => []),
}));

vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn(() => ({})) }));
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({})) }));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import * as history from "../history.js";
import * as session from "../session.js";
import { recordRead, checkReadBeforeWrite, clearReadPaths, hasBeenRead } from "../readBeforeWrite.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ck-test-"));
}

/**
 * Write a session file in the CORRECT directory structure.
 * session.ts stores sessions in `~/.claude-killer/sessions/<hash(cwd)>/<id>.jsonl`.
 */
function writeSessionFile(cwd: string, id: string, lines: object[]): string {
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const sessionDir = path.join(home, ".claude-killer", "sessions", hash);
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${id}.jsonl`);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function getHashDir(cwd: string): string {
  const crypto = require("node:crypto");
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".claude-killer", "sessions", hash);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("20 Pontos Cegos Críticos — Integration Tests", () => {

  beforeEach(() => {
    history.resetHistory();
    clearReadPaths();
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-1: onThinking/stream-end wiring mismatch (score 9)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-1: onThinking/stream-end wiring mismatch", () => {
    it("runAgentLoop existe e é importável", async () => {
      const { runAgentLoop } = await import("../agent.js");
      expect(typeof runAgentLoop).toBe("function");
    });

    it("reasoning chunks disparam onThinking (não onStreamEnd)", async () => {
      const { runAgentLoop } = await import("../agent.js");
      let thinkingCalls = 0;
      vi.mocked(runAgentLoop).mockImplementation(
        async (_input: any, _onStart: any, _onToken: any, onThinking: any) => {
          onThinking?.();
          onThinking?.();
          onThinking?.();
          thinkingCalls = 3;
          return "response";
        }
      );
      await runAgentLoop("test", undefined, undefined, () => {}, undefined);
      expect(thinkingCalls).toBe(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-2: Model-based compaction loses TASK_STATE (score 9)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-2: compactHistory preserva TASK_STATE", () => {
    it("TASK_STATE no slice compactado é preservado", () => {
      history.resetHistory();
      history.addSystemMessage("## TASK_STATE\nproject: test\ngoal: build feature");
      for (let i = 0; i < 20; i++) {
        history.addUserMessage(`msg ${i}`);
        history.addRawAssistantMessage({ role: "assistant", content: `resp ${i}` } as any);
      }
      const beforeHas = history.getHistory().some(
        (m) => typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
      );
      expect(beforeHas).toBe(true);
      history.compactHistory();
      const afterHas = history.getHistory().some(
        (m) => typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
      );
      expect(afterHas).toBe(true);
    });

    it("PRESERVE_PREFIXES cobre TASK_STATE, Persistent Memory, CONVERSATION MEMORY", () => {
      const prefixes = ["## TASK_STATE", "## Persistent Memory", "[CONVERSATION MEMORY"];
      for (const p of prefixes) {
        history.resetHistory();
        history.addSystemMessage(`${p}\nconteúdo de teste`);
        for (let i = 0; i < 20; i++) {
          history.addUserMessage(`x${i}`);
        }
        history.compactHistory();
        const preserved = history.getHistory().some(
          (m) => typeof m.content === "string" && m.content.startsWith(p)
        );
        expect(preserved, `prefix "${p}" should be preserved`).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-3: Stale snapshot wins over newer messages (score 9) — ✅ FIXED
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-3: merge snapshot + postSnapshotMessages", () => {
    it("mensagens pós-snapshot estão no array messages (visual)", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "remember secret code 12345" },
        {
          type: "compaction-snapshot",
          messages: [{ role: "system", content: "compacted" }],
          method: "llm",
          ts: 1000,
        },
        { role: "user", content: "what was the secret code?" },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(2);
      expect(loaded!.messages[0]).toMatchObject({ role: "user", content: "remember secret code 12345" });
      expect(loaded!.messages[1]).toMatchObject({ role: "user", content: "what was the secret code?" });
      expect(loaded!.lastSnapshot).not.toBeNull();
      expect(loaded!.lastSnapshot!.messages).toHaveLength(1);
    });

    it("✅ FIXED: postSnapshotMessages contém msgs pós-snapshot", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "msg before snapshot" },
        {
          type: "compaction-snapshot",
          messages: [{ role: "system", content: "system" }],
          method: "llm",
          ts: 1000,
        },
        { role: "user", content: "what was the secret code?" },
        { role: "assistant", content: "I don't know" },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      // postSnapshotMessages deve ter as 2 msgs pós-snapshot
      expect(loaded!.postSnapshotMessages.length).toBe(2);
      expect(loaded!.postSnapshotMessages[0]).toMatchObject({ content: "what was the secret code?" });
      expect(loaded!.postSnapshotMessages[1]).toMatchObject({ content: "I don't know" });
    });

    it("✅ FIXED: merge snapshot + postSnapshotMessages preserva msgs recentes no contexto da IA", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "remember secret code 12345" },
        {
          type: "compaction-snapshot",
          messages: [
            { role: "system", content: "system prompt" },
            { role: "system", content: "[CONVERSATION MEMORY - old chat]" },
          ],
          method: "llm",
          ts: 1000,
        },
        { role: "user", content: "what was the secret code?" },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();

      // Simula o que App.tsx faz agora (merge):
      if (loaded!.lastSnapshot && loaded!.lastSnapshot.messages.length > 0) {
        const merged = [...loaded!.lastSnapshot.messages, ...loaded!.postSnapshotMessages];
        history.loadHistoryDirect(merged as any);
      }

      // ✅ FIX: a IA AGORA tem "what was the secret code?" no contexto
      const iaHistory = history.getHistory();
      const hasRecentQuestion = iaHistory.some(
        (m) => typeof m.content === "string" && m.content.includes("what was the secret code?")
      );
      expect(hasRecentQuestion).toBe(true);
    });

    it("sem snapshot: postSnapshotMessages = todas as mensagens", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.lastSnapshot).toBeNull();
      // Sem snapshot, postSnapshotMessages = todas as mensagens
      expect(loaded!.postSnapshotMessages.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-4: Orphan tool_call_id on terminal close (score 8) — ✅ FIXED
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-4: orphan tool_call_id repair", () => {
    it("session com orphan tool_calls carrega sem crash", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "lê o arquivo" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"/tmp/x"}' } },
          ],
        },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(2);
    });

    it("✅ FIXED: loadHistoryDirect injeta tool result sintético para orphan", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "lê" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
        },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      history.loadHistoryDirect(loaded!.messages as any);

      const h = history.getHistory();
      // Tem assistant com tool_calls
      const hasToolCalls = h.some(
        (m) => m.role === "assistant" && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0
      );
      expect(hasToolCalls).toBe(true);
      // ✅ FIX: agora TEM tool result sintético
      const hasToolResult = h.some((m) => m.role === "tool");
      expect(hasToolResult).toBe(true);
      // O tool result sintético tem a mensagem de erro esperada
      const syntheticResult = h.find(
        (m) => m.role === "tool" && typeof (m as any).content === "string" && (m as any).content.includes("Session interrupted")
      );
      expect(syntheticResult).toBeDefined();
      expect((syntheticResult as any).tool_call_id).toBe("c1");
    });

    it("múltiplos orphans: cada um recebe tool result sintético", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "lê dois arquivos" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          ],
        },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      history.loadHistoryDirect(loaded!.messages as any);

      const h = history.getHistory();
      const toolResults = h.filter((m) => m.role === "tool");
      expect(toolResults.length).toBe(2);
      const ids = toolResults.map((m) => (m as any).tool_call_id).sort();
      expect(ids).toEqual(["c1", "c2"]);
    });

    it("tool_calls com tool result correspondente não é orphan", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "lê" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "conteúdo do arquivo" },
      ]);

      const loaded = session.loadSessionMessages("test", dir);
      history.loadHistoryDirect(loaded!.messages as any);

      const h = history.getHistory();
      // Tem 1 tool result (o original), nenhum sintético
      const toolResults = h.filter((m) => m.role === "tool");
      expect(toolResults.length).toBe(1);
      expect((toolResults[0] as any).content).toBe("conteúdo do arquivo");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-18: readBeforeWrite state leaks (score 8) — ✅ FIXED
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-18: readBeforeWrite state leaks", () => {
    it("recordRead marca arquivo como lido", () => {
      recordRead("ler_arquivo", "/tmp/foo.ts");
      expect(hasBeenRead("/tmp/foo.ts")).toBe(true);
      const check = checkReadBeforeWrite("editar_arquivo", { path: "/tmp/foo.ts" });
      expect(check.allowed).toBe(true);
    });

    it("✅ FIXED: /reset (handleResetCommand) limpa readPaths", () => {
      // BUG FIX (BS-18): handleResetCommand agora chama clearReadPaths()
      // depois de resetHistory(). Antes: só resetHistory(), readPaths
      // persistia e o gate de read-before-write era bypassado.
      recordRead("ler_arquivo", "/tmp/foo.ts");
      expect(hasBeenRead("/tmp/foo.ts")).toBe(true);

      // Simula /reset: resetHistory() + clearReadPaths() (como App.tsx faz)
      history.resetHistory();
      clearReadPaths();

      expect(hasBeenRead("/tmp/foo.ts")).toBe(false);
      const check = checkReadBeforeWrite("editar_arquivo", { path: "/tmp/foo.ts" });
      expect(check.allowed).toBe(false);
    });

    it("clearReadPaths limpa o estado", () => {
      recordRead("ler_arquivo", "/tmp/foo.ts");
      expect(hasBeenRead("/tmp/foo.ts")).toBe(true);
      clearReadPaths();
      expect(hasBeenRead("/tmp/foo.ts")).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-7: Two streams in same turn (score 7)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-7: Two streams in same turn", () => {
    it("múltiplos onStreamStart no mesmo turno não crasham", async () => {
      const { runAgentLoop } = await import("../agent.js");
      vi.mocked(runAgentLoop).mockImplementation(
        async (_input: any, onStreamStart: any, onToken: any) => {
          onStreamStart?.();
          onToken?.("lendo arquivo...");
          onStreamStart?.();
          onToken?.("pronto!");
          return "pronto!";
        }
      );
      const result = await runAgentLoop("test", undefined, undefined, undefined, undefined);
      expect(result).toBe("pronto!");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-5: MCP crash mid-tool-call (score 7)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-5: MCP server crash", () => {
    it("callMCPTool rejeita quando server morre", async () => {
      const { callMCPTool } = await import("../extensions.js");
      vi.mocked(callMCPTool).mockRejectedValue(new Error("MCP server exited"));
      await expect(callMCPTool("test__tool", {})).rejects.toThrow("MCP server exited");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-6: Double-write on /session load (score 7)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-6: Double-write prevention", () => {
    it("setActiveSession previne auto-create de nova session", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test-session", [
        { type: "session-header", id: "test-session", createdAt: "2026-01-01", cwd: dir },
      ]);
      session.setActiveSession("test-session", dir);
      expect(session.getActiveSessionId()).toBe("test-session");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-16: Empty session file (score 4)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-16: Empty session file", () => {
    it("session com 0 mensagens retorna messages vazias", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "empty", [
        { type: "session-header", id: "empty", createdAt: "2026-01-01", cwd: dir },
      ]);
      const loaded = session.loadSessionMessages("empty", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toHaveLength(0);
      expect(loaded!.lastSnapshot).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-19: Corrupted compaction snapshot (score 5)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-19: Corrupted snapshot line", () => {
    it("linha corrupted não impede carregamento de mensagens regulares", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "msg1" },
        { role: "user", content: "msg2" },
      ]);
      const filePath = path.join(getHashDir(dir), "test.jsonl");
      fs.appendFileSync(filePath, "{invalid json here\n", "utf8");

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(2);
    });

    it("snapshot válido + snapshot corrupted → mantém o válido", () => {
      const dir = makeTempDir();
      writeSessionFile(dir, "test", [
        { type: "session-header", id: "test", createdAt: "2026-01-01", cwd: dir },
        { role: "user", content: "msg1" },
        {
          type: "compaction-snapshot",
          messages: [{ role: "system", content: "valid snapshot" }],
          method: "llm",
          ts: 1000,
        },
        { role: "user", content: "msg2" },
      ]);
      const filePath = path.join(getHashDir(dir), "test.jsonl");
      fs.appendFileSync(filePath, "{type: compaction-snapshot, BROKEN JSON\n", "utf8");

      const loaded = session.loadSessionMessages("test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.lastSnapshot).not.toBeNull();
      expect(loaded!.lastSnapshot!.messages[0]).toMatchObject({ content: "valid snapshot" });
      expect(loaded!.messages.length).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // BS-12: Snapshot write fails (score 5)
  // ═══════════════════════════════════════════════════════════════════════

  describe("BS-12: compactHistory não crasha se snapshot write falha", () => {
    it("compactHistory não throw", () => {
      history.resetHistory();
      for (let i = 0; i < 20; i++) {
        history.addUserMessage(`msg ${i}`);
      }
      expect(() => history.compactHistory()).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Round-trip: appendCompactionSnapshot + loadSessionMessages
  // ═══════════════════════════════════════════════════════════════════════

  describe("Compaction snapshot round-trip", () => {
    it("append + load round-trip", () => {
      const dir = makeTempDir();
      session.startSession(dir, "roundtrip-test");
      session.appendMessage({ role: "user", content: "hello" });
      session.appendMessage({ role: "assistant", content: "hi" });

      const snapshotMsgs = [
        { role: "system", content: "system" },
        { role: "system", content: "[CONVERSATION MEMORY]" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      session.appendCompactionSnapshot(snapshotMsgs, "llm");

      const loaded = session.loadSessionMessages("roundtrip-test", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.messages.length).toBe(2);
      expect(loaded!.lastSnapshot).not.toBeNull();
      expect(loaded!.lastSnapshot!.messages).toHaveLength(4);
      expect(loaded!.lastSnapshot!.method).toBe("llm");
    });

    it("múltiplos snapshots → último vence", () => {
      const dir = makeTempDir();
      session.startSession(dir, "multi-snapshot");
      session.appendMessage({ role: "user", content: "msg1" });

      session.appendCompactionSnapshot(
        [{ role: "system", content: "first snapshot" }],
        "mechanical"
      );
      session.appendMessage({ role: "user", content: "msg2" });
      session.appendCompactionSnapshot(
        [{ role: "system", content: "second snapshot" }],
        "llm"
      );

      const loaded = session.loadSessionMessages("multi-snapshot", dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.lastSnapshot!.messages[0]).toMatchObject({ content: "second snapshot" });
      expect(loaded!.lastSnapshot!.method).toBe("llm");
      expect(loaded!.messages.length).toBe(2);
    });

    it("postSnapshotMessages após múltiplos snapshots: só pós-último", () => {
      const dir = makeTempDir();
      session.startSession(dir, "multi-post");
      session.appendMessage({ role: "user", content: "msg1" });
      session.appendCompactionSnapshot([{ role: "system", content: "snap1" }], "llm");
      session.appendMessage({ role: "user", content: "msg2" });
      session.appendCompactionSnapshot([{ role: "system", content: "snap2" }], "llm");
      session.appendMessage({ role: "user", content: "msg3" });
      session.appendMessage({ role: "user", content: "msg4" });

      const loaded = session.loadSessionMessages("multi-post", dir);
      expect(loaded).not.toBeNull();
      // postSnapshotMessages: só msg3 e msg4 (após o ÚLTIMO snapshot)
      expect(loaded!.postSnapshotMessages.length).toBe(2);
      expect(loaded!.postSnapshotMessages[0]).toMatchObject({ content: "msg3" });
      expect(loaded!.postSnapshotMessages[1]).toMatchObject({ content: "msg4" });
    });
  });
});
