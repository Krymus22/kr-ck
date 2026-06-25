/**
 * history.ts - Stateless in-memory conversation history manager.
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
import { getEffortPromptSnippet } from "./effortLevels.js";

// --- Project Memory (CLAUDE.md / AGENTS.md) --

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

// --- System Prompt ------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are Claude-Killer, an expert AI software engineer.
You have direct access to the user's filesystem via tools.

## Tools

- ler_arquivo(path, offset?, limit?, grep?): read file or list directory
- editar_arquivo(path, search, replace, edits?, createIfMissing?): edit file via match/replace
- editar_multi_arquivos(requests): atomic multi-file edits with rollback
- desfazer_edicao(caminho): undo last edit (rollback)
- executar_comando(comando, cwd?): run shell command (includes git, npm, etc)
- executar_testes(dir?, path?): run tests (auto-detects vitest/jest/pytest/cargo/go)
- sugerir_fixes(dir?): analyze test failures and suggest fixes
- buscar_arquivos(pattern, path): glob file search
- buscar_texto(pattern, path?): grep content search
- buscar_web(query, maxResults?): web search
- ler_url(url, maxLength?): read web page content
- parse_ast(path): extract symbols (functions, classes, imports)
- pensar(pensamento, categoria?): structured thinking — use BEFORE every write
- atualizar_estado(...): update TASK_STATE.md (done/todo/decisions/bugs)
- marcar_feito(item): mark todo item as done
- ler_estado(): read TASK_STATE.md
- explorar_subagente(questao, cwd?): delegate to read-only sub-agent
- listar_tools(category?): list external tools
- perguntar_usuario(pergunta, alternativas): ask user a question

## Rules

1. ALWAYS read a file before editing — the system blocks edits on unread files.
2. Call pensar() BEFORE every write operation. Checklist: what changes, did I read it, edge cases, minimal change, correct intent.
3. Use ABSOLUTE paths. The agent cwd may differ from what you assume.
4. After editing, run tests to verify. Fix and re-run until clean.
5. Batch multiple read-only tool calls in one response — they run in parallel.
6. For multi-file changes, use editar_multi_arquivos for atomic rollback.
7. Use desfazer_edicao to roll back bad edits.
8. Keep TASK_STATE.md current via atualizar_estado.
9. Be concise. Respond in the user's language (PT or EN).
10. One file per turn for complex tasks. Incremental changes.
11. When unsure about an API, use buscar_web to verify current docs before writing code.

## HONESTY RULES — CRITICAL

You are NOT a yes-man. Be a RELIABLE engineer, not a people-pleaser.

1. NEVER agree with a claim just because the user said it. VERIFY first — read the file, run the command, check the docs. If reality differs, TELL THEM.
2. If asked "are we at X level?" — give an HONEST assessment with evidence. If NOT at that level, say so and explain what's missing.
3. If you don't know something — SAY "I don't know" or "I need to verify". Fabricating answers is the WORST thing you can do.
4. When asked "does X work?" — don't say "yes" without checking. Run the test, read the code. "Let me check" > confident wrong answer.
5. If you previously said something wrong — CORRECT YOURSELF. Don't hope they forget.
6. Disagreeing is NOT rude — it's your job. A doctor who agrees with self-diagnosis without checking is a bad doctor.
7. If the user points out a "bug" that isn't actually a bug — explain why. But ALSO check if they might be right.

BAD: "Yes, all tests pass!" (without running them)
GOOD: "Let me verify... [runs tests] Yes, 1695/1695 pass. 2 skipped — want me to investigate?"

BAD: "You're right, critical bug!" (without checking if it's actually handled)
GOOD: "Let me check... Line 42 already handles X. But there IS an edge case with Y."

HONESTY OVER AGREEMENT. Always.

## Tool Call Examples (CORRECT syntax)

Use these EXACT argument names. The system auto-corrects common aliases
(caminho→path, command→comando) but using the canonical names is safer.

Read a file:
  ler_arquivo({ path: "/abs/path/to/file.ts" })

Edit a file (search/replace):
  editar_arquivo({ path: "/abs/path.ts", search: "old code", replace: "new code" })

Create a new file:
  editar_arquivo({ path: "/abs/new.ts", replace: "file content", createIfMissing: true })

Append to a file:
  editar_arquivo({ path: "/abs/existing.ts", search: "", replace: "// comment", createIfMissing: true })

Multi-file edit (atomic):
  editar_multi_arquivos({ requests: [
    { filePath: "/abs/a.ts", edits: [{ search: "x", replace: "y" }] },
    { filePath: "/abs/b.ts", edits: [{ search: "1", replace: "2" }] }
  ]})

Run a command:
  executar_comando({ comando: "npm test" })

Search for text:
  buscar_texto({ pattern: "functionName", path: "/abs/dir" })

Find files:
  buscar_arquivos({ pattern: "*.ts", cwd: "/abs/dir" })

Think before acting (call BEFORE every write):
  pensar({ pensamento: "I will change X because Y. I read the file. Edge case: Z.", categoria: "planning" })

Undo last edit:
  desfazer_edicao({ caminho: "/abs/file.ts" })

Ask the user:
  perguntar_usuario({ pergunta: "Which option?", alternativas: ["A", "B"] })

## Tool Call Examples (INCORRECT — will be blocked or auto-corrected)

WRONG: ler_arquivo({ caminho: "/x" })           → use 'path' (caminho is auto-corrected)
WRONG: executar_comando({ command: "ls" })       → use 'comando' (command is auto-corrected)
WRONG: pensar({ thought: "..." })                → use 'pensamento' (thought is auto-corrected)
WRONG: editar_arquivo({ path: "/x" })            → missing search+replace or edits
WRONG: editar_arquivo({ path: "/x", search: "" }) → empty search needs createIfMissing:true

Always pass arguments as a JSON object, not a string.`;

let currentCavemanLevel: string | null = null; // 'lite', 'full', 'ultra', 'wenyan-lite', 'wenyan-full', 'wenyan-ultra', or null (disabled)

// --- Plan Mode -------------------------------------------------------------
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

  // IDEIA 4: Append effort-level instructions (Low/Medium/High/Max)
  const effortSnippet = getEffortPromptSnippet();
  if (effortSnippet) {
    basePrompt = `${basePrompt}\n\n${effortSnippet}`;
  }

  if (currentCavemanLevel) {
    basePrompt = `[SYSTEM NOTE: CAVEMAN MODE IS ACTIVE (Level: ${currentCavemanLevel}). You MUST strictly adhere to the caveman rules below for ALL replies. Speaking in standard conversational prose is strictly forbidden. Keep all technical terms, code blocks, and exact strings intact.]\n\n${basePrompt}`;
  }

    const memory = loadProjectMemoryCached();
  if (memory) {
    basePrompt = `${basePrompt}\n\n## Project Memory (CLAUDE.md / AGENTS.md)\n\nThe following files describe this project's conventions. Follow them.\n\n${memory}\n`;
  }

  if (skills.length === 0) {
    // Even without skills, inject code patterns if available
    return injectPatterns(basePrompt);
  }

  // Sprint C: inject ONLY skill name + description (not full content).
  // IA can read the full skill file with ler_arquivo when needed.
  // This reduces context from ~20k to ~500 tokens for 17 skills.
  let prompt = `${basePrompt}\n\n## Available Skills\n`;
  prompt += `Use ler_arquivo to read the full skill file when you need details.\n\n`;
  for (const skill of skills) {
    // Extract a short description: try skill.description, then skill.name
    const desc = skill.description?.slice(0, 100) ?? "";
    prompt += `- ${skill.name}: ${desc}\n`;
  }
  return injectPatterns(prompt);
}

/**
 * Inject extracted code patterns into the system prompt.
 * This makes the AI match the project's existing coding style.
 */
function injectPatterns(prompt: string): string {
  try {
    // Dynamic import to avoid circular dependency at module load time
    const { getPatternsCached } = require("./patternExtractor.js");
    const patterns = getPatternsCached(process.cwd());
    if (patterns.filesAnalyzed > 0) {
      return `${prompt}\n\n${patterns.rawSummary}`;
    }
  } catch {
    // patternExtractor not available - skip
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

// --- History Store ------------------------------------------------------------

let history: Message[] = [];

// --- Public API ---------------------------------------------------------------

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
/**
 * Add a system message, replacing any previous message with the same prefix.
 *
 * Sprint C (BUG-CC): Previously, addSystemMessage just pushed a new message
 * every turn. TASK_STATE and Memory were injected at EVERY turn, accumulating
 * 10+ copies in history after 10 turns. This caused:
 * 1. Context bloat (each copy ~200-500 tokens × 10 turns = 2-5k wasted tokens)
 * 2. IA confusion (sees multiple conflicting versions of TASK_STATE)
 * 3. Hallucination (IA might reference outdated state from turn 3)
 *
 * Now: if the new message starts with a known prefix (## TASK_STATE, ## Persistent
 * Memory, ## SELF-VALIDATION, [PLAN], [GOAL, [HONESTY), any previous system
 * message with the same prefix is REPLACED instead of duplicated.
 */
export function addSystemMessage(content: string): void {
  ensureHistoryInitialized();

  // Known injectable prefixes that should replace, not accumulate
  const REPLACABLE_PREFIXES = [
    "## TASK_STATE",
    "## Persistent Memory",
    "## SELF-VALIDATION",
    "[SELF-VALIDATION",
    "[PLAN]",
    "[GOAL",
    "[HONESTY",
    "[STRICT_GATE",
    "[QUALITY",
    "[FALSE_PROMISE",
    "[CHECKPOINT",
  ];

  // Check if this message matches a replacable prefix
  for (const prefix of REPLACABLE_PREFIXES) {
    if (content.startsWith(prefix)) {
      // Find and remove ALL previous system messages with same prefix
      // (except the base system prompt at index 0)
      for (let i = history.length - 1; i >= 1; i--) {
        if (history[i]!.role === "system") {
          const prevContent = (history[i] as any).content as string;
          if (prevContent && prevContent.startsWith(prefix)) {
            history.splice(i, 1);
          }
        }
      }
      break; // Only match one prefix
    }
  }

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

/**
 * Replace the entire history with the provided messages.
 * Used by model-based compaction (IDEIA 3) to swap in a compacted history.
 * The first message MUST be the system prompt; if not, we prepend it.
 */
export function replaceHistory(messages: Message[]): void {
  if (messages.length === 0 || messages[0].role !== "system") {
    history = [{ role: "system", content: getSystemPrompt() }, ...messages];
  } else {
    history = [...messages];
  }
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
 * Replace oldest middle of history with a single "[CONTEXT COMPACTED]" sentinel
 * to bring prompt under threshold. Always preserves:
 *   - index 0 (system prompt)
 *   - last COMPACT_KEEP_RECENT messages (recent context)
 * Returns counts or null when nothing to compact.
 */
export function compactHistory(): CompactResult | null {
  if (history.length <= COMPACT_KEEP_RECENT + 1) return null;

  const beforeTokens = estimateTokens(history);
  const system = history[0];

  // CLAUDE-CODE-STYLE COMPACTION: preserve critical context that the IA
  // needs to continue the task. Without this, the IA forgets:
  //   - The project name and goal (TASK_STATE)
  //   - What was already decided (decisions, plans)
  //   - What bugs are open
  //   - Persistent memory (skills, project context)
  //
  // Strategy: instead of dropping everything except the last N messages,
  // we ALSO preserve system messages with critical prefixes.
  const PRESERVE_PREFIXES = [
    "## TASK_STATE",
    "## Persistent Memory",
    "[CONVERSATION MEMORY",  // accumulated summaries from previous compactions
  ];

  const preservedSystem: Message[] = [];
  for (let i = 1; i < history.length - COMPACT_KEEP_RECENT; i++) {
    const m = history[i];
    if (m.role !== "system") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (PRESERVE_PREFIXES.some(p => content.startsWith(p))) {
      // Avoid duplicates
      if (!preservedSystem.some(p => (typeof p.content === "string" ? p.content : "") === content)) {
        preservedSystem.push(m);
      }
    }
  }

  const recent = history.slice(-COMPACT_KEEP_RECENT);
  const dropped = history.length - 1 - COMPACT_KEEP_RECENT - preservedSystem.length;
  if (dropped <= 0) return null;

  // Build a summary of what was compacted, preserving key facts
  const compactedMessages = history.slice(1, history.length - COMPACT_KEEP_RECENT);
  const compactedSummary = buildCompactionSummary(compactedMessages);

  const summary: Message = {
    role: "system",
    content: compactedSummary,
  };

  // Reconstruct: [system_prompt, preserved_critical_context, compaction_summary, ...recent]
  history = [system, ...preservedSystem, summary, ...recent];

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

/**
 * Build a compact summary of the messages being dropped.
 * Preserves: user requests, assistant conclusions, tool names (not full results).
 * This is the "conversation memory" that survives compaction.
 */
function buildCompactionSummary(messages: Message[]): string {
  const userRequests: string[] = [];
  const assistantConclusions: string[] = [];
  const toolsUsed: string[] = [];
  const filesModified: Set<string> = new Set();

  for (const m of messages) {
    if (m.role === "user") {
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length > 10 && content.length < 500) {
        userRequests.push(content.slice(0, 200));
      }
    } else if (m.role === "assistant") {
      const content = typeof m.content === "string" ? m.content : "";
      if (content.length > 20 && !content.startsWith("[TOOL")) {
        // Capture conclusions (not tool call descriptions)
        assistantConclusions.push(content.slice(0, 300));
      }
      // Collect tool names
      if (Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls) {
          const name = tc?.function?.name;
          if (name && !toolsUsed.includes(name)) toolsUsed.push(name);
          // Track file modifications
          try {
            const args = JSON.parse(tc?.function?.arguments ?? "{}");
            const path = args.path ?? args.caminho ?? args.filePath;
            if (typeof path === "string" && (tc.function.name === "editar_arquivo" || tc.function.name === "editar_multi_arquivos")) {
              filesModified.add(path);
            }
          } catch { /* ignore */ }
        }
      }
    }
  }

  const lines: string[] = [];
  lines.push(`[CONVERSATION MEMORY - ${messages.length} old messages compacted]`);
  lines.push(``);

  if (userRequests.length > 0) {
    lines.push(`## User Requests (chronological)`);
    for (const r of userRequests.slice(-5)) { // last 5 user requests
      lines.push(`- ${r}`);
    }
    lines.push(``);
  }

  if (assistantConclusions.length > 0) {
    lines.push(`## Key Conclusions`);
    for (const c of assistantConclusions.slice(-3)) { // last 3 conclusions
      lines.push(`- ${c}`);
    }
    lines.push(``);
  }

  if (toolsUsed.length > 0) {
    lines.push(`## Tools Used`);
    lines.push(toolsUsed.join(", "));
    lines.push(``);
  }

  if (filesModified.size > 0) {
    lines.push(`## Files Modified`);
    for (const f of filesModified) {
      lines.push(`- ${f}`);
    }
    lines.push(``);
  }

  lines.push(`Note: Historical tool_call IDs are now stale. If you need to reference past tool results, ask the user.`);

  return lines.join("\n");
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
  return content.includes("[ERROR]") || content.includes("[GUARDRAIL_FAIL]") || content.includes("Error:");
}

function hasFlowAdvancedAfterIndex(fromIndex: number): boolean {
  for (let k = fromIndex + 1; k < history.length; k++) {
    const futureMsg = history[k];
    if (futureMsg.role === "user") return true;
    if (futureMsg.role === "tool") {
      const futureToolCallId = (futureMsg as any).tool_call_id as string;
      const futureToolName = getToolName(futureToolCallId, k);
      const futureContent = (futureMsg as any).content as string;
      if (futureToolName === "aplicar_diff" && futureContent?.includes("[SUCCESS]")) return true;
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

  if (isReadTool(toolName) && content.length > 800 && !content.startsWith("[FILE READ")) {
    if (hasFlowAdvancedAfterIndex(i)) {
      (history[i] as any).content = `[FILE READ - OMITTED FOR CONTEXT OPTIMIZATION. ORIGINAL LENGTH: ${content.length} CHARS]`;
      return true;
    }
  }

  if (isErrorMessage(content) && !content.startsWith("[ERRO ANTERIOR")) {
    if (hasErrorBeenOvercomeAfterIndex(i, toolName)) {
      (history[i] as any).content = `[PREVIOUS ERROR OVERCOME AND OMITTED FOR OPTIMIZATION]`;
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
