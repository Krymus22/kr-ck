/**
 * invariants-all.ts — Runtime invariants para TODOS os módulos críticos.
 *
 * Importado uma vez no startup (index.ts) e depois cada módulo importa
 * apenas o que precisa de ./invariants.js diretamente.
 *
 * Este arquivo centraliza a VERIFICAÇÃO de invariants que envolvem
 * múltiplos módulos (cross-module invariants).
 */

import { invariant } from "./invariants.js";

/**
 * Verifica invariants cross-module após o startup.
 * Chamado uma vez no index.ts após todas as inicializações.
 */
export function verifyStartupInvariants(opts: {
  poolSize: number;
  heartbeatKeyIndex: number;
  heartbeatIntervalMs: number;
  max403Retries: number;
  hasSearx: boolean;
  activeMode: string | null;
}): void {
  // Pool + Heartbeat
  if (opts.poolSize > 1) {
    invariant(
      opts.heartbeatKeyIndex === opts.poolSize - 1,
      "HEARTBEAT_NOT_USING_RESERVE_KEY",
      "Heartbeat deve usar a última key (reserva), não competir com o pool",
      { heartbeatKeyIndex: opts.heartbeatKeyIndex, poolSize: opts.poolSize },
    );
  }

  // Heartbeat interval
  invariant(
    opts.heartbeatIntervalMs >= 300000,
    "HEARTBEAT_INTERVAL_TOO_SHORT",
    "Heartbeat interval < 5min vai causar 429 no NVIDIA free tier",
    { intervalMs: opts.heartbeatIntervalMs },
  );

  // 403 retry limit
  invariant(
    opts.max403Retries <= 1,
    "403_RETRY_TOO_HIGH",
    "MAX_403_RETRIES > 1 consome budget da key e causa 429",
    { max403Retries: opts.max403Retries },
  );

  // Searx + Docker
  if (opts.hasSearx) {
    // Searx is installed — that's fine, no invariant needed
  }

  // Mode + MCP
  if (opts.activeMode === "roblox") {
    // Roblox mode should have MCP guard active
    // (checked at runtime when MCP tools are called)
  }
}

/**
 * Verifica invariants do apiClient durante o streaming.
 */
export function verifyStreamInvariants(opts: {
  finishReason: string | null;
  hasToolCalls: boolean;
  hasContent: boolean;
  repetitionDetected: boolean;
}): void {
  // If finish_reason is "tool_calls", there must be tool_calls
  if (opts.finishReason === "tool_calls") {
    invariant(
      opts.hasToolCalls,
      "FINISH_TOOL_CALLS_WITHOUT_TOOL_CALLS",
      "finish_reason='tool_calls' mas não há tool_calls na resposta",
      { finishReason: opts.finishReason, hasToolCalls: opts.hasToolCalls },
    );
  }

  // If finish_reason is "stop", there should be content (unless repetition)
  if (opts.finishReason === "stop" && !opts.repetitionDetected) {
    invariant(
      opts.hasContent,
      "STOP_WITHOUT_CONTENT",
      "finish_reason='stop' mas não há content na resposta",
      { finishReason: opts.finishReason, hasContent: opts.hasContent },
    );
  }
}

/**
 * Verifica invariants da compaction.
 */
export function verifyCompactionInvariants(opts: {
  beforeTokens: number;
  afterTokens: number;
  preservedTaskState: boolean;
}): void {
  // Compaction should REDUCE tokens (not increase)
  invariant(
    opts.afterTokens <= opts.beforeTokens,
    "COMPACTION_INCREASED_TOKENS",
    "Compaction aumentou o contexto em vez de diminuir",
    { before: opts.beforeTokens, after: opts.afterTokens },
  );

  // Compaction should preserve TASK_STATE
  invariant(
    opts.preservedTaskState,
    "COMPACTION_LOST_TASK_STATE",
    "Compaction removeu TASK_STATE do histórico",
  );
}

/**
 * Verifica invariants do pool de keys.
 */
export function verifyPoolInvariants(opts: {
  poolSize: number;
  availableKeys: number;
  totalKeys: number;
}): void {
  // Available keys should never exceed total
  invariant(
    opts.availableKeys <= opts.totalKeys,
    "POOL_AVAILABLE_EXCEEDS_TOTAL",
    "Keys disponíveis > total de keys — bug no pool",
    { available: opts.availableKeys, total: opts.totalKeys },
  );

  // Pool size should match total
  invariant(
    opts.poolSize === opts.totalKeys,
    "POOL_SIZE_MISMATCH",
    "Pool size != total keys — bug na inicialização",
    { poolSize: opts.poolSize, total: opts.totalKeys },
  );
}

/**
 * Verifica invariants do fileEdit.
 */
export function verifyFileEditInvariants(opts: {
  success: boolean;
  contentChanged: boolean;
  hasBackup: boolean;
}): void {
  // If content changed, success must be true
  if (opts.contentChanged) {
    invariant(
      opts.success,
      "FILE_EDIT_CHANGED_BUT_FAILED",
      "Conteúdo mudou mas success=false — estado inconsistente",
    );
  }

  // If edit succeeded, backup should exist
  if (opts.success && opts.contentChanged) {
    invariant(
      opts.hasBackup,
      "FILE_EDIT_NO_BACKUP",
      "Edição bem-sucedida mas não criou backup — rollback impossível",
    );
  }
}

/**
 * Verifica invariants do MCP Guard.
 */
export function verifyMcpGuardInvariants(opts: {
  toolName: string;
  allowed: boolean;
  category: string;
}): void {
  // Write tools must NEVER be allowed
  if (opts.category === "write") {
    invariant(
      !opts.allowed,
      "MCP_GUARD_ALLOWED_WRITE",
      `MCP Guard permitiu tool de escrita "${opts.toolName}" — deve ser bloqueada`,
      { toolName: opts.toolName, category: opts.category },
    );
  }

  // Unknown tools must NEVER be allowed (fail-safe)
  if (opts.category === "unknown") {
    invariant(
      !opts.allowed,
      "MCP_GUARD_ALLOWED_UNKNOWN",
      `MCP Guard permitiu tool desconhecida "${opts.toolName}" — deve ser bloqueada`,
      { toolName: opts.toolName },
    );
  }
}

/**
 * Verifica invariants do Bug Hunter.
 */
export function verifyBugHunterInvariants(opts: {
  findingsCount: number;
  shouldBlock: boolean;
  hasCritical: boolean;
}): void {
  // If there are critical findings, should block
  if (opts.hasCritical) {
    invariant(
      opts.shouldBlock,
      "BUG_HUNTER_CRITICAL_NOT_BLOCKING",
      "Bug Hunter encontrou findings críticos mas não está bloqueando",
      { findingsCount: opts.findingsCount, hasCritical: opts.hasCritical },
    );
  }
}

/**
 * Verifica invariants do DataGuard.
 */
export function verifyDataGuardInvariants(opts: {
  findingsCount: number;
  shouldBlock: boolean;
  hasCritical: boolean;
}): void {
  // Same as Bug Hunter — critical findings should block
  if (opts.hasCritical) {
    invariant(
      opts.shouldBlock,
      "DATAGUARD_CRITICAL_NOT_BLOCKING",
      "DataGuard encontrou riscos críticos mas não está bloqueando",
      { findingsCount: opts.findingsCount, hasCritical: opts.hasCritical },
    );
  }
}

/**
 * Verifica invariants do research hint.
 */
export function verifyResearchHintInvariants(opts: {
  trigger: string | null;
  isCommand: boolean;
}): void {
  // Commands should never trigger research hints
  if (opts.isCommand) {
    invariant(
      opts.trigger === null,
      "RESEARCH_HINT_ON_COMMAND",
      "Research hint disparou para um comando (não uma pergunta)",
      { trigger: opts.trigger },
    );
  }
}

/**
 * Verifica invariants do args normalizer.
 */
export function verifyArgsNormalizerInvariants(opts: {
  hasPath: boolean;
  hasCaminho: boolean;
}): void {
  // If caminho was provided, path should be set after normalization
  if (opts.hasCaminho) {
    invariant(
      opts.hasPath,
      "ARGS_NORMALIZER_CAMINHO_NOT_COPIED",
      "Args normalizer não copiou caminho → path",
    );
  }
}

/**
 * Verifica invariants do Searx Manager.
 */
export function verifySearxInvariants(opts: {
  method: string | null;
  weStarted: boolean;
  isDocker: boolean;
}): void {
  // Docker containers should NOT be stopped by CLI on shutdown
  if (opts.isDocker) {
    invariant(
      !opts.weStarted,
      "SEARX_DOCKER_SHOULD_NOT_STOP",
      "CLI marcou Docker container como 'started by CLI' — não deve parar no shutdown",
      { method: opts.method, weStarted: opts.weStarted },
    );
  }
}

/**
 * Verifica invariants do heartbeat.
 */
export function verifyHeartbeatInvariants(opts: {
  consecutiveFailures: number;
  isRunning: boolean;
}): void {
  // If 5+ consecutive failures, heartbeat should have stopped
  if (opts.consecutiveFailures >= 5) {
    invariant(
      !opts.isRunning,
      "HEARTBEAT_RUNNING_AFTER_5_FAILURES",
      "Heartbeat ainda rodando após 5 falhas consecutivas — deveria ter parado",
      { consecutiveFailures: opts.consecutiveFailures },
    );
  }
}

/**
 * Verifica invariants do LLM Compactor.
 */
export function verifyLlmCompactorInvariants(opts: {
  inputLength: number;
  outputLength: number;
}): void {
  // LLM summary should be shorter than input (otherwise compaction is useless)
  if (opts.inputLength > 500) {
    invariant(
      opts.outputLength < opts.inputLength,
      "LLM_COMPACTOR_OUTPUT_LONGER_THAN_INPUT",
      "Resumo do LLM é maior que o input — compaction inútil",
      { inputLength: opts.inputLength, outputLength: opts.outputLength },
    );
  }
}

/**
 * Verifica invariants do auto memory.
 */
export function verifyAutoMemoryInvariants(opts: {
  fileExists: boolean;
  lineCount: number;
}): void {
  // Auto memory file should not exceed 200 lines (same as Claude Code)
  if (opts.fileExists) {
    invariant(
      opts.lineCount <= 250, // small buffer above 200
      "AUTO_MEMORY_TOO_LARGE",
      "Auto memory excedeu 250 linhas — vai consumir muito contexto",
      { lineCount: opts.lineCount },
    );
  }
}

/**
 * Verifica invariants do context compaction.
 */
export function verifyContextCompactionInvariants(opts: {
  beforeTokens: number;
  afterTokens: number;
  threshold: number;
}): void {
  // Compaction should only happen when above threshold
  invariant(
    opts.beforeTokens > opts.threshold || opts.afterTokens === opts.beforeTokens,
    "COMPACTION_RAN_BELOW_THRESHOLD",
    "Compaction rodou abaixo do threshold — desperdício",
    { before: opts.beforeTokens, threshold: opts.threshold },
  );
}

/**
 * Verifica invariants do strict quality gate.
 */
export function verifyQualityGateInvariants(opts: {
  hasTests: boolean;
  testsPassed: boolean;
  blocked: boolean;
}): void {
  // If tests exist and failed, gate should block
  if (opts.hasTests && !opts.testsPassed) {
    invariant(
      opts.blocked,
      "QUALITY_GATE_NOT_BLOCKING_FAILED_TESTS",
      "Testes falharam mas quality gate não bloqueou",
      { hasTests: opts.hasTests, testsPassed: opts.testsPassed },
    );
  }
}

/**
 * Verifica invariants do rollback store.
 */
export function verifyRollbackInvariants(opts: {
  backupCreated: boolean;
  originalFileExists: boolean;
}): void {
  // If backup was created, original file should exist
  if (opts.backupCreated) {
    invariant(
      opts.originalFileExists,
      "ROLLBACK_BACKUP_WITHOUT_ORIGINAL",
      "Backup criado mas arquivo original não existe — inconsistente",
    );
  }
}

/**
 * Verifica invariants do tool detector.
 */
export function verifyToolDetectorInvariants(opts: {
  toolName: string;
  binaryPath: string | null;
  isInstalled: boolean;
}): void {
  // If binaryPath is null, tool should not be marked as installed
  if (opts.binaryPath === null) {
    invariant(
      !opts.isInstalled,
      "TOOL_DETECTOR_INSTALLED_WITHOUT_BINARY",
      `Tool "${opts.toolName}" marcada como instalada mas sem binaryPath`,
      { toolName: opts.toolName },
    );
  }
}

/**
 * Verifica invariants do extension center.
 */
export function verifyExtensionInvariants(opts: {
  totalExtensions: number;
  enabledExtensions: number;
}): void {
  // Enabled extensions should never exceed total
  invariant(
    opts.enabledExtensions <= opts.totalExtensions,
    "EXTENSIONS_ENABLED_EXCEEDS_TOTAL",
    "Extensões habilitadas > total — bug no extension center",
    { enabled: opts.enabledExtensions, total: opts.totalExtensions },
  );
}

/**
 * Verifica invariants do mode system.
 */
export function verifyModeInvariants(opts: {
  activeMode: string | null;
  modeExists: boolean;
}): void {
  // If active mode is set, it must exist
  if (opts.activeMode !== null) {
    invariant(
      opts.modeExists,
      "MODE_ACTIVE_BUT_NOT_FOUND",
      `Modo ativo "${opts.activeMode}" não existe na lista de modos`,
      { activeMode: opts.activeMode },
    );
  }
}

/**
 * Verifica invariants do session tracking.
 */
export function verifySessionInvariants(opts: {
  sessionActive: boolean;
  startTime: string | null;
}): void {
  // If session is active, start time must be set
  if (opts.sessionActive) {
    invariant(
      opts.startTime !== null,
      "SESSION_ACTIVE_WITHOUT_START_TIME",
      "Sessão ativa mas sem start time — bug no session tracking",
    );
  }
}

/**
 * Verifica invariants do telemetry.
 */
export function verifyTelemetryInvariants(opts: {
  totalApiCalls: number;
  totalErrors: number;
}): void {
  // Errors should never exceed total calls
  invariant(
    opts.totalErrors <= opts.totalApiCalls,
    "TELEMETRY_ERRORS_EXCEED_CALLS",
    "Erros > total de chamadas — bug no telemetry",
    { errors: opts.totalErrors, calls: opts.totalApiCalls },
  );
}

/**
 * Verifica invariants do think tool.
 */
export function verifyThinkToolInvariants(opts: {
  hasPensamento: boolean;
  result: boolean;
}): void {
  // If pensar was called without pensamento, result should still be valid
  if (!opts.hasPensamento) {
    invariant(
      opts.result,
      "THINK_TOOL_NO_PENSAMENTO",
      "pensar() chamado sem pensamento — deveria ainda retornar resultado válido",
    );
  }
}

/**
 * Verifica invariants do file validator.
 */
export function verifyFileValidatorInvariants(opts: {
  filePath: string;
  pattern: string;
  matches: boolean;
}): void {
  // If file extension matches pattern, matches should be true
  const ext = "." + opts.filePath.split(".").pop();
  if (opts.pattern === "*" + ext) {
    invariant(
      opts.matches,
      "FILE_VALIDATOR_PATTERN_MISMATCH",
      `Arquivo "${opts.filePath}" deveria matchear pattern "${opts.pattern}"`,
      { filePath: opts.filePath, pattern: opts.pattern },
    );
  }
}

/**
 * Verifica invariants do todo system.
 */
export function verifyTodoInvariants(opts: {
  totalItems: number;
  doneItems: number;
}): void {
  // Done items should never exceed total
  invariant(
    opts.doneItems <= opts.totalItems,
    "TODO_DONE_EXCEEDS_TOTAL",
    "Itens feitos > total — bug no todo system",
    { done: opts.doneItems, total: opts.totalItems },
  );
}
