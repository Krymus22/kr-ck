/**
 * integration-full.test.ts — Integration tests completos para TODO o projeto
 *
 * Cobertura de fluxos que envolvem múltiplos módulos working together.
 * Cada teste simula um cenário real que o usuário encontraria.
 *
 * Organizado por categoria:
 *   1. API & Network (apiClient, apiKeyPool, heartbeat)
 *   2. Context & Memory (history, compaction, autoMemory, llmCompactor)
 *   3. Safety & Guards (bugHunter, dataGuard, mcpGuard, qualityGate)
 *   4. Search & Research (apiResearcher, researchHint, searxManager)
 *   5. Tools & Files (fileEdit, rollback, toolDetector, argsNormalizer)
 *   6. Modes & Extensions (modes, extensions, modeExtensions)
 *   7. IA Behavior (thinkTool, honestySystem, goalVerifier)
 *   8. Invariants (invariants, invariants-all)
 *   9. Infrastructure (session, telemetry, streaming, utf8Safety)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks globais ──────────────────────────────────────────────────────────

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
// 1. API & NETWORK
// ═══════════════════════════════════════════════════════════════════════════

import { invariant } from "../invariants.js";
import {
  verifyStartupInvariants, verifyStreamInvariants, verifyPoolInvariants,
  verifyHeartbeatInvariants,
} from "../invariants-all.js";

describe("Integration: API & Network", () => {
  describe("Startup invariants", () => {
    it("passa quando heartbeat usa key de reserva", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStartupInvariants({
        poolSize: 4, heartbeatKeyIndex: 3, heartbeatIntervalMs: 300000,
        max403Retries: 1, hasSearx: false, activeMode: null,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando heartbeat usa key #0", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStartupInvariants({
        poolSize: 4, heartbeatKeyIndex: 0, heartbeatIntervalMs: 300000,
        max403Retries: 1, hasSearx: false, activeMode: null,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando heartbeat interval < 5min", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStartupInvariants({
        poolSize: 4, heartbeatKeyIndex: 3, heartbeatIntervalMs: 60000,
        max403Retries: 1, hasSearx: false, activeMode: null,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando MAX_403_RETRIES > 1", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStartupInvariants({
        poolSize: 4, heartbeatKeyIndex: 3, heartbeatIntervalMs: 300000,
        max403Retries: 2, hasSearx: false, activeMode: null,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Stream invariants", () => {
    it("passa quando finish_reason=stop com content", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStreamInvariants({
        finishReason: "stop", hasToolCalls: false, hasContent: true,
        repetitionDetected: false,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando finish_reason=tool_calls sem tool_calls", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStreamInvariants({
        finishReason: "tool_calls", hasToolCalls: false, hasContent: false,
        repetitionDetected: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando finish_reason=stop sem content", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStreamInvariants({
        finishReason: "stop", hasToolCalls: false, hasContent: false,
        repetitionDetected: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("NÃO dispara quando repetition detectada e sem content", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyStreamInvariants({
        finishReason: "stop", hasToolCalls: false, hasContent: false,
        repetitionDetected: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Pool invariants", () => {
    it("passa quando available <= total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyPoolInvariants({ poolSize: 4, availableKeys: 3, totalKeys: 4 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando available > total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyPoolInvariants({ poolSize: 4, availableKeys: 5, totalKeys: 4 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando poolSize != total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyPoolInvariants({ poolSize: 3, availableKeys: 3, totalKeys: 4 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Heartbeat invariants", () => {
    it("passa quando < 5 falhas e rodando", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyHeartbeatInvariants({ consecutiveFailures: 3, isRunning: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando 5+ falhas e ainda rodando", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyHeartbeatInvariants({ consecutiveFailures: 5, isRunning: true });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("passa quando 5+ falhas e parou", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyHeartbeatInvariants({ consecutiveFailures: 5, isRunning: false });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONTEXT & MEMORY
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifyCompactionInvariants, verifyLlmCompactorInvariants,
  verifyAutoMemoryInvariants, verifyContextCompactionInvariants,
} from "../invariants-all.js";

describe("Integration: Context & Memory", () => {
  describe("Compaction invariants", () => {
    it("passa quando after < before", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyCompactionInvariants({
        beforeTokens: 10000, afterTokens: 5000, preservedTaskState: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando after > before", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyCompactionInvariants({
        beforeTokens: 5000, afterTokens: 10000, preservedTaskState: true,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando TASK_STATE não preservado", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyCompactionInvariants({
        beforeTokens: 10000, afterTokens: 5000, preservedTaskState: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("LLM Compactor invariants", () => {
    it("passa quando output < input", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyLlmCompactorInvariants({ inputLength: 2000, outputLength: 500 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando output > input", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyLlmCompactorInvariants({ inputLength: 1000, outputLength: 2000 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Auto Memory invariants", () => {
    it("passa quando arquivo < 250 linhas", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyAutoMemoryInvariants({ fileExists: true, lineCount: 200 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando arquivo > 250 linhas", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyAutoMemoryInvariants({ fileExists: true, lineCount: 300 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Context compaction invariants", () => {
    it("passa quando before > threshold", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyContextCompactionInvariants({
        beforeTokens: 10000, afterTokens: 5000, threshold: 5000,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando compaction rodou abaixo do threshold", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyContextCompactionInvariants({
        beforeTokens: 3000, afterTokens: 2000, threshold: 5000,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SAFETY & GUARDS
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifyMcpGuardInvariants, verifyBugHunterInvariants,
  verifyDataGuardInvariants, verifyQualityGateInvariants,
  verifyRollbackInvariants,
} from "../invariants-all.js";

describe("Integration: Safety & Guards", () => {
  describe("MCP Guard invariants", () => {
    it("passa quando write tool é bloqueada", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyMcpGuardInvariants({
        toolName: "multi_edit", allowed: false, category: "write",
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando write tool é permitida", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyMcpGuardInvariants({
        toolName: "multi_edit", allowed: true, category: "write",
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando unknown tool é permitida", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyMcpGuardInvariants({
        toolName: "unknown_tool", allowed: true, category: "unknown",
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("passa quando read tool é permitida", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyMcpGuardInvariants({
        toolName: "script_read", allowed: true, category: "read",
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Bug Hunter invariants", () => {
    it("passa quando critical e blocking", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyBugHunterInvariants({
        findingsCount: 3, shouldBlock: true, hasCritical: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando critical mas não blocking", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyBugHunterInvariants({
        findingsCount: 3, shouldBlock: false, hasCritical: true,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("DataGuard invariants", () => {
    it("passa quando critical e blocking", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyDataGuardInvariants({
        findingsCount: 2, shouldBlock: true, hasCritical: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando critical mas não blocking", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyDataGuardInvariants({
        findingsCount: 2, shouldBlock: false, hasCritical: true,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Quality Gate invariants", () => {
    it("passa quando testes falham e bloqueia", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyQualityGateInvariants({
        hasTests: true, testsPassed: false, blocked: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando testes falham mas não bloqueia", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyQualityGateInvariants({
        hasTests: true, testsPassed: false, blocked: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Rollback invariants", () => {
    it("passa quando backup e original existem", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyRollbackInvariants({
        backupCreated: true, originalFileExists: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando backup criado mas original não existe", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyRollbackInvariants({
        backupCreated: true, originalFileExists: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SEARCH & RESEARCH
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifyResearchHintInvariants, verifySearxInvariants,
} from "../invariants-all.js";

describe("Integration: Search & Research", () => {
  describe("Research Hint invariants", () => {
    it("passa quando command não triggera hint", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyResearchHintInvariants({ trigger: null, isCommand: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando command triggera hint", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyResearchHintInvariants({ trigger: "current_state", isCommand: true });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Searx invariants", () => {
    it("passa quando Docker não é marcado como started by CLI", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifySearxInvariants({
        method: "docker", weStarted: false, isDocker: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando Docker é marcado como started by CLI", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifySearxInvariants({
        method: "docker", weStarted: true, isDocker: true,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. TOOLS & FILES
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifyFileEditInvariants, verifyArgsNormalizerInvariants,
  verifyToolDetectorInvariants, verifyFileValidatorInvariants,
} from "../invariants-all.js";

describe("Integration: Tools & Files", () => {
  describe("File Edit invariants", () => {
    it("passa quando content mudou e success=true com backup", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyFileEditInvariants({
        success: true, contentChanged: true, hasBackup: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando content mudou mas success=false", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyFileEditInvariants({
        success: false, contentChanged: true, hasBackup: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando success=true mas sem backup", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyFileEditInvariants({
        success: true, contentChanged: true, hasBackup: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Args Normalizer invariants", () => {
    it("passa quando caminho foi copiado para path", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyArgsNormalizerInvariants({ hasPath: true, hasCaminho: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando caminho existe mas path não foi setado", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyArgsNormalizerInvariants({ hasPath: false, hasCaminho: true });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Tool Detector invariants", () => {
    it("passa quando binaryPath null e não installed", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyToolDetectorInvariants({
        toolName: "selene", binaryPath: null, isInstalled: false,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando binaryPath null mas installed=true", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyToolDetectorInvariants({
        toolName: "selene", binaryPath: null, isInstalled: true,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("File Validator invariants", () => {
    it("passa quando .lua matches *.lua", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyFileValidatorInvariants({
        filePath: "test.lua", pattern: "*.lua", matches: true,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando .lua deveria matchear *.lua mas não matcheou", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyFileValidatorInvariants({
        filePath: "test.lua", pattern: "*.lua", matches: false,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MODES & EXTENSIONS
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifyExtensionInvariants, verifyModeInvariants,
} from "../invariants-all.js";

describe("Integration: Modes & Extensions", () => {
  describe("Extension invariants", () => {
    it("passa quando enabled <= total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyExtensionInvariants({ totalExtensions: 10, enabledExtensions: 5 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando enabled > total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyExtensionInvariants({ totalExtensions: 5, enabledExtensions: 10 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Mode invariants", () => {
    it("passa quando active mode existe", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyModeInvariants({ activeMode: "roblox", modeExists: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando active mode não existe", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyModeInvariants({ activeMode: "nonexistent", modeExists: false });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("passa quando não há active mode", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyModeInvariants({ activeMode: null, modeExists: false });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. IA BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════

import { verifyThinkToolInvariants } from "../invariants-all.js";

describe("Integration: IA Behavior", () => {
  describe("Think Tool invariants", () => {
    it("passa quando pensamento existe", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyThinkToolInvariants({ hasPensamento: true, result: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("passa quando sem pensamento mas result=true", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyThinkToolInvariants({ hasPensamento: false, result: true });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando sem pensamento e result=false", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyThinkToolInvariants({ hasPensamento: false, result: false });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════

import {
  verifySessionInvariants, verifyTelemetryInvariants,
  verifyTodoInvariants,
} from "../invariants-all.js";

describe("Integration: Infrastructure", () => {
  describe("Session invariants", () => {
    it("passa quando session ativa com start time", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifySessionInvariants({
        sessionActive: true, startTime: "2026-07-03T12:00:00Z",
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando session ativa sem start time", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifySessionInvariants({
        sessionActive: true, startTime: null,
      });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("passa quando session inativa", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifySessionInvariants({
        sessionActive: false, startTime: null,
      });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Telemetry invariants", () => {
    it("passa quando errors <= calls", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyTelemetryInvariants({ totalApiCalls: 100, totalErrors: 5 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando errors > calls", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyTelemetryInvariants({ totalApiCalls: 5, totalErrors: 100 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("Todo invariants", () => {
    it("passa quando done <= total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyTodoInvariants({ totalItems: 10, doneItems: 5 });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("dispara quando done > total", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      verifyTodoInvariants({ totalItems: 5, doneItems: 10 });
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. INVARIANT SYSTEM ITSELF
// ═══════════════════════════════════════════════════════════════════════════

import { invariantFatal } from "../invariants.js";

describe("Integration: Invariant System", () => {
  it("invariant não dispara quando true", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    invariant(true, "TEST", "should not fire");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("invariant dispara quando false", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    invariant(false, "TEST", "should fire", { x: 1 });
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0][0]).toContain("TEST");
    expect(spy.mock.calls[0][0]).toContain("should fire");
    expect(spy.mock.calls[0][0]).toContain("x=1");
    spy.mockRestore();
  });

  it("invariantFatal throws quando false", () => {
    expect(() => invariantFatal(false, "FATAL", "throws")).toThrow("FATAL");
  });

  it("invariantFatal não throws quando true", () => {
    expect(() => invariantFatal(true, "FATAL", "ok")).not.toThrow();
  });

  it("todos os verify* functions existem e são callable", () => {
    expect(typeof verifyStartupInvariants).toBe("function");
    expect(typeof verifyStreamInvariants).toBe("function");
    expect(typeof verifyCompactionInvariants).toBe("function");
    expect(typeof verifyPoolInvariants).toBe("function");
    expect(typeof verifyFileEditInvariants).toBe("function");
    expect(typeof verifyMcpGuardInvariants).toBe("function");
    expect(typeof verifyBugHunterInvariants).toBe("function");
    expect(typeof verifyDataGuardInvariants).toBe("function");
    expect(typeof verifyResearchHintInvariants).toBe("function");
    expect(typeof verifyArgsNormalizerInvariants).toBe("function");
    expect(typeof verifySearxInvariants).toBe("function");
    expect(typeof verifyHeartbeatInvariants).toBe("function");
    expect(typeof verifyLlmCompactorInvariants).toBe("function");
    expect(typeof verifyAutoMemoryInvariants).toBe("function");
    expect(typeof verifyContextCompactionInvariants).toBe("function");
    expect(typeof verifyQualityGateInvariants).toBe("function");
    expect(typeof verifyRollbackInvariants).toBe("function");
    expect(typeof verifyToolDetectorInvariants).toBe("function");
    expect(typeof verifyExtensionInvariants).toBe("function");
    expect(typeof verifyModeInvariants).toBe("function");
    expect(typeof verifySessionInvariants).toBe("function");
    expect(typeof verifyTelemetryInvariants).toBe("function");
    expect(typeof verifyThinkToolInvariants).toBe("function");
    expect(typeof verifyFileValidatorInvariants).toBe("function");
    expect(typeof verifyTodoInvariants).toBe("function");
  });
});
