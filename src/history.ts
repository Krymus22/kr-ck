/**
 * history.ts — Stateless in-memory conversation history manager.
 *
 * Maintains a flat array of OpenAI-format messages that grows as the
 * conversation progresses. The entire array is sent to the API on every
 * request so the model has full context of the session.
 *
 * Design decisions:
 *  - No persistence across CLI sessions (MVP scope)
 *  - History is module-level state (singleton); import-time initialised
 *  - The system prompt is pre-injected as the first message
 */

import fs from "node:fs";
import path from "node:path";
import type { Message } from "./apiClient.js";
import type OpenAI from "openai";

import { getActiveSkills } from "./extensions.js";

// ─── Project Memory (CLAUDE.md / AGENTS.md) ──

const MEMORY_FILENAMES = ["CLAUDE.md", "AGENTS.md", ".claude-killer/AGENTS.md"];

/**
 * Walks up from cwd looking for memory files. Returns concatenated contents
 * (with headers) or null if none found. Capped at 10 parent dirs to avoid
 * runaway on weird FS layouts.
 */
function loadProjectMemory(): string | null {
  const start = process.cwd();
  const parts: { file: string; absDir: string }[] = [];
  let dir: string | null = start;
  let safety = 10;
  while (dir && safety-- > 0) {
    for (const file of MEMORY_FILENAMES) {
      const abs = path.join(dir, file);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        parts.push({ file: abs, absDir: dir });
        break; // one per dir to avoid duplicate chains like ./CLAUDE.md + ./.claude-killer/AGENTS.md
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (parts.length === 0) return null;

  // Reverse so closest (most specific) is last and treated as highest precedence
  parts.reverse();

  return parts
    .map((p) => `--- MEMORY: ${path.relative(start, p.file) || p.file} ---\n${fs.readFileSync(p.file, "utf8").trim()}`)
    .join("\n\n");
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are Claude-Killer, an expert AI software engineer and code assistant.
You are running inside a developer's terminal and have direct access to their local filesystem.

## Core Tools

- ler_arquivo(caminho): reads file content or directory listing
- aplicar_diff(caminho, bloco_diff): surgical search/replace edits with syntax validation
- executar_comando(comando): runs shell commands (tests, linters, builds)
- executar_testes(dir?, path?): runs test suite with auto-detection (vitest/jest/pytest/cargo/go)
- sugerir_fixes(dir?): analyzes test failures and suggests fixes
- parse_ast(path): parses code into AST symbols (functions, classes, imports)
- editar_multi_arquivos(requests): atomic multi-file edits with rollback
- buscar_arquivos(pattern, path): glob file search
- buscar_conteudo(pattern, path?): regex content search
- git_status/diff/log/commit/blame: git operations

## Problem-Solving Approach

For any task, follow this structured approach:

1. **Understand**: Read the codebase. Use parse_ast or ler_arquivo to understand the structure.
2. **Plan**: Break complex tasks into steps. Use todo_write to track progress.
3. **Implement**: Make incremental changes, one file per turn when possible.
4. **Verify**: After each edit, run executar_testes or executar_comando to validate.
5. **Iterate**: If tests fail, read the error output and fix. Repeat until clean.

## Editing Rules

1. ALWAYS read a file before editing it.
2. Use aplicar_diff with exact SEARCH blocks. Format:
<<<<<<< SEARCH
[exact old code]
=======
[new code]
>>>>>>> REPLACE
3. For new files, use empty SEARCH block:
<<<<<<< SEARCH
=======
[file contents]
>>>>>>> REPLACE
4. For multi-file changes, use editar_multi_arquivos for atomic rollback.
5. After editing, ALWAYS run tests/linter to verify:
   executar_comando("npm test") or executar_testes()
6. If tests fail, fix the code and re-run until clean.

## SWE-bench / Benchmark Mode

When solving SWE-bench style tasks:
1. Read the issue description carefully. Understand the expected behavior.
2. Search the codebase for relevant files using buscar_arquivos/buscar_conteudo.
3. Read ALL related files to understand the full context before editing.
4. Make minimal, targeted fixes. Don't refactor unrelated code.
5. Write or update tests to cover the fix.
6. Run the full test suite to ensure no regressions.
7. Verify the fix matches the expected behavior from the issue.

## Key Principles

- Be concise. Precision over verbosity.
- Never hallucinate file contents. Always read first.
- Prefer relative paths. You're on the developer's machine.
- Respond in the user's language (Portuguese or English).
- Incremental edits: one file per response for complex tasks.`;

let currentCavemanLevel: string | null = null; // 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra', or null (disabled)

// ─── Plan Mode ─────────────────────────────────────────────────────────────
let planMode = false;

export function isPlanMode(): boolean {
  return planMode;
}

export function setPlanMode(on: boolean): void {
  planMode = on;
}

export function setCavemanLevel(level: string | null): void {
  currentCavemanLevel = level;
  // If history is already initialized, update the system prompt (first message)
  if (history.length > 0 && history[0].role === "system") {
    history[0].content = getSystemPrompt();
  }
}

export function getCavemanLevel(): string | null {
  return currentCavemanLevel;
}

/**
 * Dynamically builds the system prompt combining base instructions and loaded skills.
 */
export function getSystemPrompt(): string {
  const skills = getActiveSkills();
  let basePrompt = BASE_SYSTEM_PROMPT;

  if (currentCavemanLevel) {
    basePrompt = `[SYSTEM NOTE: CAVEMAN MODE IS ACTIVE (Level: ${currentCavemanLevel}). You MUST strictly adhere to the caveman rules below for ALL replies. Speaking in standard conversational prose is strictly forbidden. Keep all technical terms, code blocks, and exact strings intact.]\n\n${basePrompt}`;
  }

    const memory = loadProjectMemoryCached();
  if (memory) {
    basePrompt = `${basePrompt}\n\n## Project Memory (CLAUDE.md / AGENTS.md)\n\nThe following files describe this project's conventions. Follow them.\n\n${memory}\n`;
  }

  if (skills.length === 0) {
    return basePrompt;
  }

  let prompt = `${basePrompt}\n\nAvailable Skills / Workflows you must follow when instructed or relevant:\n`;
  for (const skill of skills) {
    prompt += `\n--- START SKILL: ${skill.name} ---\n`;
    prompt += `Description: ${skill.description}\n`;
    prompt += `Instructions:\n${skill.content}\n`;
    // If caveman mode is active on this skill, reinforce the instruction
    if (skill.name === "caveman" && currentCavemanLevel) {
      prompt += `\nCRITICAL CONTEXT: Caveman Mode is currently locked at level "${currentCavemanLevel}" for this session. You MUST obey the specific rules of level "${currentCavemanLevel}".\n`;
    }
    prompt += `--- END SKILL: ${skill.name} ---\n`;
  }
  return prompt;
}

let cachedMemory: string | null | undefined; // undefined = not loaded yet
function loadProjectMemoryCached(): string | null {
  if (cachedMemory === undefined) {
    cachedMemory = loadProjectMemory();
  }
  return cachedMemory;
}

/** Invalidate the memoized project memory (call on /memory reload). */
export function reloadProjectMemory(): string | null {
  cachedMemory = undefined;
  return loadProjectMemoryCached();
}

// ─── History Store ────────────────────────────────────────────────────────────

let history: Message[] = [];

// ─── Public API ───────────────────────────────────────────────────────────────

/** Initialize history if empty. */
function ensureHistoryInitialized() {
  if (history.length === 0) {
    history.push({ role: "system", content: getSystemPrompt() });
  }
}

/** Append a user message to the history. */
export function addUserMessage(content: string): void {
  ensureHistoryInitialized();
  history.push({ role: "user", content });
}

/**
 * Append an assistant message with tool_calls array as returned by the API.
 * We store the raw choice.message object to preserve tool_call IDs.
 */
export function addRawAssistantMessage(
  msg: OpenAI.Chat.Completions.ChatCompletionMessage
): void {
  ensureHistoryInitialized();
  history.push(msg as unknown as Message);
}

/** Append a tool result message (role: "tool"). */
export function addToolResult(toolCallId: string, content: string): void {
  ensureHistoryInitialized();
  history.push({
    role: "tool",
    tool_call_id: toolCallId,
    content,
  } as Message);
}

/** Append a system message to the history (for memory injection, etc). */
export function addSystemMessage(content: string): void {
  ensureHistoryInitialized();
  history.push({ role: "system", content });
}

/** Return the full history array (passed directly to the API). */
export function getHistory(): Message[] {
  ensureHistoryInitialized();
  return history;
}

/** Return the number of messages in history (including system prompt). */
export function historyLength(): number {
  ensureHistoryInitialized();
  return history.length;
}

/** Reset history to initial state (system prompt only). Useful for /reset. */
export function resetHistory(): void {
  history = [{ role: "system", content: getSystemPrompt() }];
}

/** Rough token estimate: ~4 chars per token, includes tool_calls JSON. */
export function estimateTokens(messages: Message[] = history): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof (m as { content?: unknown }).content === "string") {
      chars += (m as { content: string }).content.length;
    }
    const toolCalls = (m as { tool_calls?: unknown }).tool_calls;
    if (Array.isArray(toolCalls)) {
      chars += JSON.stringify(toolCalls).length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

const COMPACT_KEEP_RECENT = 6; // messages kept after compaction (excluding system + summary)

export interface CompactResult {
  removed: number;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Replace oldest middle of history with a single "[CONTEXT COMPACTADO]" sentinel
 * to bring prompt under threshold. Always preserves:
 *   - index 0 (system prompt)
 *   - last COMPACT_KEEP_RECENT messages (recent context)
 * Returns counts or null when nothing to compact.
 */
export function compactHistory(): CompactResult | null {
  if (history.length <= COMPACT_KEEP_RECENT + 1) return null;

  const beforeTokens = estimateTokens(history);
  const system = history[0];
  const recent = history.slice(-COMPACT_KEEP_RECENT);
  const dropped = history.length - 1 - COMPACT_KEEP_RECENT;
  if (dropped <= 0) return null;

  const summary: Message = {
    role: "system",
    content: `[CONTEXT COMPACTADO — ${dropped} mensagens antigas removidas para caber na janela. Mantive apenas as últimas ${COMPACT_KEEP_RECENT} mensagens recentes e o prompt de sistema. Os IDs de tool_call históricos ficaram desatualizados: se o modelo quiser referenciar ferramentas passadas, peça ao usuário para repetir a informação.]`,
  };

  history = [system, summary, ...recent];

  // Remove dangling tool messages that no longer match a tool_call in history
  // (this also drops orphan tool results from the dropped assistant calls)
  const validToolIds = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      for (const tc of (m as any).tool_calls) validToolIds.add(tc.id);
    }
  }
  history = history.filter((m) => {
    if (m.role === "tool") {
      const id = (m as any).tool_call_id;
      if (typeof id === "string" && !validToolIds.has(id)) return false;
    }
    return true;
  });

  const afterTokens = estimateTokens(history);
  return { removed: dropped, beforeTokens, afterTokens };
}

/** Return a human-readable summary of the current history stats. */
export function historySummary(): string {
  const roles = history.reduce<Record<string, number>>((acc, m) => {
    const r = (m as { role: string }).role;
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(roles)
    .map(([r, n]) => `${r}:${n}`)
    .join(", ");
}

/** Helper to find the tool name that generated a specific tool_call_id. */
function getToolName(toolCallId: string, currentIndex: number): string {
  for (let j = currentIndex - 1; j >= 0; j--) {
    const msg = history[j];
    if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls)) {
      const call = (msg as any).tool_calls.find((c: any) => c.id === toolCallId);
      if (call) return call.function.name;
    }
  }
  return "";
}

const READ_TOOLS = new Set(["ler_arquivo", "buscar_texto_no_projeto", "ler_linhas_arquivo"]);

function isReadTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}

function isErrorMessage(content: string): boolean {
  return content.includes("[ERRO]") || content.includes("[FALHA_GUARDRAIL]") || content.includes("Erro:");
}

function hasFlowAdvancedAfterIndex(fromIndex: number): boolean {
  for (let k = fromIndex + 1; k < history.length; k++) {
    const futureMsg = history[k];
    if (futureMsg.role === "user") return true;
    if (futureMsg.role === "tool") {
      const futureToolCallId = (futureMsg as any).tool_call_id as string;
      const futureToolName = getToolName(futureToolCallId, k);
      const futureContent = (futureMsg as any).content as string;
      if (futureToolName === "aplicar_diff" && futureContent?.includes("[SUCESSO]")) return true;
    }
  }
  return false;
}

function hasErrorBeenOvercomeAfterIndex(fromIndex: number, toolName: string): boolean {
  for (let k = fromIndex + 1; k < history.length; k++) {
    const futureMsg = history[k];
    if (futureMsg.role === "user") return true;
    if (futureMsg.role === "tool") {
      const futureToolCallId = (futureMsg as any).tool_call_id as string;
      const futureToolName = getToolName(futureToolCallId, k);
      const futureContent = (futureMsg as any).content as string;
      if (futureToolName === toolName) {
        if (futureContent && !isErrorMessage(futureContent)) return true;
      }
    }
  }
  return false;
}

function optimizeToolMessage(i: number): boolean {
  const msg = history[i];
  if (msg.role !== "tool") return false;

  const toolCallId = (msg as any).tool_call_id as string;
  const content = (msg as any).content as string;
  if (!content || typeof content !== "string") return false;

  const toolName = getToolName(toolCallId, i);

  if (isReadTool(toolName) && content.length > 800 && !content.startsWith("[CONTEÚDO LIDO")) {
    if (hasFlowAdvancedAfterIndex(i)) {
      (history[i] as any).content = `[CONTEÚDO LIDO - OMITIDO PARA OTIMIZAÇÃO DE CONTEXTO. COMPRIMENTO ORIGINAL: ${content.length} CARACTERES]`;
      return true;
    }
  }

  if (isErrorMessage(content) && !content.startsWith("[ERRO ANTERIOR")) {
    if (hasErrorBeenOvercomeAfterIndex(i, toolName)) {
      (history[i] as any).content = `[ERRO ANTERIOR SUPERADO E OMITIDO PARA OTIMIZAÇÃO]`;
      return true;
    }
  }

  return false;
}

/**
 * In-place optimization of the message history to save tokens.
 *
 * 1. Read tool results (ler_arquivo, etc) are summarized if the flow has advanced
 *    (a subsequent aplicar_diff succeeded or a new user message exists).
 * 2. Error logs from tools are summarized if a subsequent tool of the same type succeeded
 *    or if the flow advanced (for executar_comando, a later success).
 * 3. User instructions and assistant conclusions (messages without tool_calls) are NEVER deleted.
 */
export function optimizeContext(): void {
  for (let i = 0; i < history.length; i++) {
    optimizeToolMessage(i);
  }
}
