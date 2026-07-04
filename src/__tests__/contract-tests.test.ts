/**
 * contract-tests.test.ts — Verifica que TODAS as exports públicas existem
 *
 * Se alguém remover ou renomear uma função exportada, este teste falha.
 * Isso previne breaking changes acidentais.
 */

import { describe, it, expect } from "vitest";

// Helper: verifica que um módulo exporta as funções esperadas
function expectExports(modulePath: string, expectedExports: string[]) {
  return async () => {
    const mod = await import(modulePath);
    for (const name of expectedExports) {
      expect(mod, `${modulePath} should export "${name}"`).toHaveProperty(name);
      expect(typeof mod[name as keyof typeof mod], `${modulePath}.${name} should be a function`).toBe("function");
    }
  };
}

describe("Contract: API & Network", () => {
  it("apiClient exports", expectExports("../apiClient.js", [
    "chat", "isTransientNetworkErrorPublic", "is429ErrorPublic",
  ]));

  it("apiKeyPool exports", expectExports("../apiKeyPool.js", [
    "initApiKeyPool", "getPoolSize", "acquireKeyForStreaming",
    "tryAcquireKeyImmediate", "getAvailableKeyCount", "getTotalKeyCount",
    "getPoolStats", "formatPoolStats", "resetPoolStats", "resetPool",
    "prewarmPool", "resetPrewarm", "loadApiKeys",
  ]));

  it("heartbeat exports", expectExports("../heartbeat.js", [
    "startHeartbeat", "stopHeartbeat", "getHeartbeatStats", "resetHeartbeat",
  ]));

  it("apiProvider exports", expectExports("../apiProvider.js", [
    "providerSendsThinkingMode", "getProviderReasoningField",
    "providerNeedsHedging", "detectProvider", "getProviderConfig",
    "providerNeedsHeartbeat", "getProviderMaxSubAgents", "providerUsesMultiKeyPool",
  ]));
});

describe("Contract: Context & Memory", () => {
  it("history exports", expectExports("../history.js", [
    "getSystemPrompt", "addUserMessage", "addRawAssistantMessage",
    "addToolResult", "addSystemMessage", "getHistory", "historyLength",
    "historySummary", "resetHistory", "replaceHistory", "estimateTokens",
    "compactHistory", "compactHistoryAsync", "isPlanMode", "setPlanMode",
    "setCavemanLevel", "getCavemanLevel", "reloadProjectMemory",
  ]));

  it("llmCompactor exports", expectExports("../llmCompactor.js", [
    "llmCompact", "isLlmCompactionAvailable",
  ]));

  it("autoMemory exports", expectExports("../autoMemory.js", [
    "ensureAutoMemoryFile", "readAutoMemory", "appendAutoMemory",
    "detectUserCorrection", "maybeSuggestMemoryWrite", "getAutoMemoryPath",
  ]));

  it("contextCompaction exports", expectExports("../contextCompaction.js", [
    "smartCompact",
  ]));

  it("memory exports", expectExports("../memory.js", [
    "getMemoryConfig", "ensureMemoryDirs", "readProjectMemory",
    "writeProjectMemory", "readCheckpoint", "writeCheckpoint",
    "saveSessionTrace", "listSessionTraces",
  ]));
});

describe("Contract: Safety & Guards", () => {
  it("robloxMcpGuard exports", expectExports("../robloxMcpGuard.js", [
    "classifyMcpTool", "extractToolName", "isRobloxStudioMcpTool",
    "evaluateMcpToolCall", "getAllowedRobloxMcpTools", "getBlockedRobloxMcpTools",
  ]));

  it("bugHunter exports", expectExports("../bugHunter.js", [
    "resetBugHunterState", "runBugHunter", "parseFindings",
    "formatBugHuntMessage", "compareFindings", "allCriticalHighTestsPass",
    "runTestsForFindings", "snapshotFileBeforeEdit", "generateDiffAfterEdit",
  ]));

  it("dataGuard exports", expectExports("../dataGuard.js", [
    "resetDataGuardState", "runDataGuard",
  ]));

  it("invariants exports", expectExports("../invariants.js", [
    "invariant", "invariantFatal",
  ]));

  it("invariants-all exports", expectExports("../invariants-all.js", [
    "verifyStartupInvariants", "verifyStreamInvariants", "verifyCompactionInvariants",
    "verifyPoolInvariants", "verifyFileEditInvariants", "verifyMcpGuardInvariants",
    "verifyBugHunterInvariants", "verifyDataGuardInvariants", "verifyQualityGateInvariants",
    "verifyRollbackInvariants", "verifyResearchHintInvariants", "verifyArgsNormalizerInvariants",
    "verifySearxInvariants", "verifyHeartbeatInvariants", "verifyLlmCompactorInvariants",
    "verifyAutoMemoryInvariants", "verifyContextCompactionInvariants", "verifyToolDetectorInvariants",
    "verifyExtensionInvariants", "verifyModeInvariants", "verifySessionInvariants",
    "verifyTelemetryInvariants", "verifyThinkToolInvariants", "verifyFileValidatorInvariants",
    "verifyTodoInvariants",
  ]));

  it("strictQualityGate exports", expectExports("../strictQualityGate.js", [
    "getQualityGateConfig", "resetGateState",
  ]));

  it("guardrail exports", expectExports("../guardrail.js", [
    "validateSyntax",
  ]));

  it("readBeforeWrite exports", expectExports("../readBeforeWrite.js", [
    "checkReadBeforeWrite",
  ]));
});

describe("Contract: Search & Research", () => {
  it("apiResearcher exports", expectExports("../apiResearcher.js", [
    "webSearch", "webRead", "researchApi", "formatResearchResult",
    "getCacheStats", "clearCache", "getTodayDate", "getLastSearchSource",
  ]));

  it("researchHint exports", expectExports("../researchHint.js", [
    "detectResearchTrigger", "generateResearchHint",
  ]));

  it("searxManager exports", expectExports("../searxManager.js", [
    "isSearxInstalled", "isSearxRunning", "autoStartSearx",
    "autoStopSearx", "getSearxStatus",
  ]));
});

describe("Contract: Tools & Files", () => {
  it("fileEdit exports", expectExports("../fileEdit.js", [
    "applyEdits", "editFile",
  ]));

  it("fileValidator exports", expectExports("../fileValidator.js", [
    "matchesPattern", "validateFile", "getActiveValidationRules", "shouldValidateFile",
  ]));

  it("argsNormalizer exports", expectExports("../argsNormalizer.js", [
    "normalizeArgs",
  ]));

  it("rollbackStore exports", expectExports("../rollbackStore.js", [
    "saveBackup", "restoreBackup", "listBackups", "getRollbackDirPath",
    "clearAllBackups", "resetRollbackState", "pruneOldBackups",
  ]));

  it("toolDetector exports", expectExports("../toolDetector.js", [
    "detectTool", "verifyToolWorks", "detectAndVerify",
    "isAutoDetectEnabled", "extractToolBinaryName", "findToolBinary",
  ]));

  it("tools exports", expectExports("../tools.js", [
    "executarComando",
  ]));
});

describe("Contract: Modes & Extensions", () => {
  it("modes exports", expectExports("../modes.js", [
    "getBuiltInModes", "getUserModes", "getAllModes", "getMode",
    "saveUserMode", "deleteUserMode", "getActiveModeName", "getActiveMode",
    "setActiveMode", "applyMode", "deactivateMode", "suggestMode",
    "confirmAndSaveMode",
  ]));

  it("extensions exports", expectExports("../extensions.js", [
    "loadAllExtensions", "shutdownMCPServers", "getActiveSkills",
    "getActiveMCPServers", "getMCPToolDefinitions", "callMCPTool",
    "loadModeMCPs",
  ]));

  it("modeExtensions exports", expectExports("../modeExtensions.js", [
    "getActiveSafetyPatterns", "getActiveResearchSources",
    "getActiveSymbolPatterns", "getActiveValidationRules",
    "runHook", "runPostEditHooks",
  ]));
});

describe("Contract: IA Behavior", () => {
  it("thinkTool exports", expectExports("../thinkTool.js", [
    "think",
  ]));

  it("honestySystem exports", expectExports("../honestySystem.js", [
    "getHonestyFeatures", "isHonestyFeatureEnabled", "runDevilsAdvocate",
    "extractConfidence", "markFileAsEdited", "markFileAsReadBack",
    "getUnreadBackFiles", "getReadBackWarning",
  ]));

  it("agent exports", expectExports("../agent.js", [
    "runAgentLoop", "getMergedToolsPublic", "dispatchToolCallPublic",
  ]));

  it("subAgents exports", expectExports("../subAgents.js", [
    "runSubAgent", "shouldDelegateToSubAgent", "shouldUsePowerfulSubAgents",
  ]));
});

describe("Contract: Infrastructure", () => {
  it("config exports", async () => {
    const mod = await import("../config.js");
    expect(mod).toHaveProperty("config");
  });

  it("i18n exports", expectExports("../i18n.js", [
    "detectLanguage", "setLanguage", "resetLanguageCache", "t",
    "getCommandI18n", "getLocalizedSlashCommands",
  ]));

  it("effortLevels exports", expectExports("../effortLevels.js", [
    "getEffortLevel", "setEffortLevel", "getEffortPromptSnippet",
    "getEffortLabel", "shouldAutoGenerateTests", "shouldUseSubAgents",
  ]));

  it("todo exports", expectExports("../todo.js", [
    "renderTodoBar", "getTodos", "setTodos", "todoWrite",
  ]));

  it("taskState exports", expectExports("../taskState.js", [
    "readTaskState", "writeTaskState", "updateTaskState",
    "appendTaskStateItem", "markTaskItemDone", "getTaskStateSummary",
    "clearTaskState", "initTaskStateFromUserMessage",
  ]));

  it("session exports", expectExports("../session.js", [
    "saveSession", "loadSession", "listSessions",
  ]));

  it("logger exports", expectExports("../logger.js", [
    "debug", "warn", "error", "info", "success",
  ]));

  it("streaming exports", expectExports("../streaming.js", [
    "TokenCounter", "BufferedStreamProcessor", "estimateTokenCount",
  ]));

  it("utf8Safety exports", expectExports("../utf8Safety.js", [
    "forceUtf8Environment", "listSystemLocales", "pickBestUtf8Locale",
    "diagnoseUtf8",
  ]));

  it("configSchema exports", expectExports("../configSchema.js", [
    "validateModeConfig", "isValidModeConfig",
  ]));

  it("configSeeder exports", expectExports("../configSeeder.js", [
    "seedUserConfig", "forceReseedOnNextRun", "isSeeded",
  ]));

  it("toolInstaller exports", expectExports("../toolInstaller.js", [
    "installTool", "canInstall", "getInstallDir",
    "listInstallableTools", "getToolRepo",
  ]));

  it("toolUpdater exports", expectExports("../toolUpdater.js", [
    "checkToolUpdate", "checkAllToolUpdates", "shouldCheckNow",
    "performUpdateCheck", "forceCheckOnNextRun",
  ]));

  it("externalTools exports", expectExports("../externalTools.js", [
    "getRegistry", "getDetector", "getExecutor", "getSuggester",
  ]));

  it("manifestLoader exports", expectExports("../manifestLoader.js", [
    "loadModeManifests", "loadActiveManifests", "isManifestTool",
  ]));

  it("hookRunner exports", expectExports("../hookRunner.js", [
    "loadHooksFromDir", "loadHooks", "resolveHooksDir", "runHooks",
  ]));
});
