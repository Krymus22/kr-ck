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

export type { Message };
import type OpenAI from "openai";

import { getActiveSkills } from "./extensions.js";
import { getEffortPromptSnippet } from "./effortLevels.js";
import { config } from "./config.js";

// --- Project Memory (CLAUDE.md / AGENTS.md) --

const MEMORY_FILENAMES = ["CLAUDE.md", "AGENTS.md", ".claude-killer/AGENTS.md"];

export interface MemoryFile {
  /** Path relative to cwd (or absolute if outside cwd). */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** File contents (trimmed). */
  content: string;
}

/**
 * Walks up from cwd looking for memory files. Returns the list of files found
 * (closest = last = highest precedence). Capped at 10 parent dirs to avoid
 * runaway on weird FS layouts.
 */
export function loadProjectMemoryFiles(): MemoryFile[] {
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

  if (parts.length === 0) return [];

  // Reverse so closest (most specific) is last and treated as highest precedence
  parts.reverse();

  return parts.map((p) => {
    const stat = fs.statSync(p.file);
    return {
      relativePath: path.relative(start, p.file) || p.file,
      absolutePath: p.file,
      sizeBytes: stat.size,
      content: fs.readFileSync(p.file, "utf8").trim(),
    };
  });
}

/**
 * Legacy: returns concatenated contents (with headers) or null if none found.
 * Kept for backward compat with tests; new code should use loadProjectMemoryFiles().
 */
function loadProjectMemory(): string | null {
  const files = loadProjectMemoryFiles();
  if (files.length === 0) return null;
  return files
    .map((p) => `--- MEMORY: ${p.relativePath} ---\n${p.content}`)
    .join("\n\n");
}

/** Human-readable file size (e.g., "2.3 KB", "1.1 MB", "450 B"). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
- explorar_subagente(questao, cwd?): delegate EXPLORATION/RESEARCH to a sub-agent (see Rule 4 below)
- listar_tools(category?): list external tools
- perguntar_usuario(pergunta, alternativas): ask user a question

## Rules

### HIGH PRIORITY — Do these FIRST, always

0. **CHECK YOUR WORKING DIRECTORY.** Before starting any task, verify you are in the correct project directory. If the user mentions a project name or path, use executar_comando("pwd") or ler_arquivo to check where you are. If you are NOT in the right directory, tell the user and suggest they use /cd to switch. The strict quality gate runs validators (tsc, ESLint, selene, rojo build) on the CURRENT directory — if you're in the wrong directory, validations will fail or be skipped.

1. **PLAN before acting.** For any task involving edits, call pensar() with categoria="planning" FIRST. List: which files you'll touch, in what order, what edge cases exist, what could break. This is your #1 tool against bugs and loops. Skipping the plan = guessing = bugs.

2. **RESEARCH APIs before writing code.** When the task involves external APIs, libraries, or frameworks (Roblox, React, Luau APIs, npm packages), use buscar_web() to verify the CURRENT documentation before writing any code. APIs change. What you remember from training data may be outdated. Wrong API usage = bugs that compile but fail at runtime.

3. **DELEGATE EXPLORATION to sub-agents — STRONGLY PREFERRED.** This is your DEFAULT mode of operation, not a last resort. Whenever you need to understand a codebase, find all callers of a function, investigate a bug's root cause, OR gather information before making changes, use explorar_subagente() INSTEAD of doing it yourself. The sub-agent has its OWN context window — it can do deep exploration WITHOUT polluting your main context with hundreds of file reads. This keeps YOUR context clean for the actual editing work.

   USE SUB-AGENTS IN PARALLEL: If you need to BOTH research an API AND explore the codebase, delegate BOTH to sub-agents in the SAME response (multiple tool calls). While they work, you can plan your implementation. You don't need to wait for one to finish before starting the other.

   RULE OF THUMB: If a task needs more than 2 file reads to understand, DELEGATE IT to a sub-agent. Your main context is precious — reserve it for editing, not reading.

   Examples of when to use sub-agents:
   - "Search the codebase for how UserService is used and explain the data flow"
   - "Find all files that import from types.ts and list what they import"
   - "Investigate why the checkout function doesn't decrement stock — read all related files"
   - "Research the current Node.js crypto API for generating random strings"
   - "Map out the directory structure and identify entry points"

4. **READ before WRITE.** Always call ler_arquivo() before editar_arquivo(). The system blocks edits on unread files. Reading first prevents hallucinating file contents.

5. **MINIMAL CODE — Before writing ANY code, ask yourself this checklist IN ORDER:**
   - Does this need to exist? NO → skip it (YAGNI)
   - Already in this codebase? → reuse it, don't rewrite
   - Stdlib does it? → use it
   - Native platform feature? → use it
   - Installed dependency? → use it
   - Can it be one line? → one line
   - Only then: write the MINIMUM that works

   NOTE: You do NOT need to re-read files after editing — the Bug Hunter will independently verify all your edits before the task is allowed to finish. Focus on getting the edit right the first time.

### Standard rules

6. Use ABSOLUTE paths. The agent cwd may differ from what you assume.
7. After editing, run tests to verify. Fix and re-run until clean.
8. Batch multiple read-only tool calls in one response — they run in parallel.
9. For multi-file changes, use editar_multi_arquivos for atomic rollback.
10. Use desfazer_edicao to roll back bad edits.
11. **Track your progress with marcar_feito(item) and atualizar_estado(...).** As you complete each piece of the task, call marcar_feito() to mark it done. This is MANDATORY for multi-step tasks — it forces you to acknowledge completion of each step and prevents skipping work. See the Tool Use section below for the difference between the two.
12. Be concise. Respond in the user's language (PT or EN).
13. One file per turn for complex tasks. Incremental changes.
14. When editar_arquivo fails with "SEARCH not found", RE-READ the file (ler_arquivo) to see the actual current content, then adjust your search string. Do NOT retry with the same search.
15. NEVER use executar_comando to modify files (cat >, echo >, sed -i, tee, etc). Use editar_arquivo for ALL file modifications — it provides backup, validation, and surgical edits. Reescrever arquivos inteiros com "cat >" introduz bugs e contorna os sistemas de segurança.

## Tool Use: atualizar_estado vs marcar_feito (CRITICAL — know the difference)

These two tools serve DIFFERENT purposes. Using them wrong leads to lost progress tracking.

- **atualizar_estado(...)** — Full state sync. Use this to WRITE the entire TASK_STATE.md file. Pass it the COMPLETE current state: { done: [...], todo: [...], decisions: [...], bugs: [...] }. Use this:
  - At the START of a complex task, to plan out the work and write the initial state.
  - When the OVERALL picture changes (new subtask discovered, decision made, bug found).
  - To add a decision or bug to the running log.
  - THINk of it as: "here is the FULL picture of where we are."

- **marcar_feito(item)** — Incremental completion marker. Use this to mark a SINGLE todo item as done (moves it from todo[] to done[] in TASK_STATE.md). Pass the EXACT item text. Use this:
  - AFTER you finish each individual subtask.
  - As a checkpoint to confirm "yes, this specific thing is done."
  - Think of it as: "this ONE thing is now complete."

  WORKFLOW: Call atualizar_estado ONCE at the start to plan, then call marcar_feito after EACH subtask completes. Do NOT call atualizar_estado after every step — that's wasteful. Only call it again if the plan changes.

## Tool Use: pensar() — Structured Thinking (categories)

pensar() is your "brain brake" — it forces you to think before acting. ALWAYS pass a categoria. The category shapes what you should be thinking about:

- **planning**: "What files will I touch? In what order? What edge cases?" — Use BEFORE starting any multi-step task.
- **pre_edit**: "I read the file. The current content is X. I will change Y because Z. Edge case: W." — Use BEFORE every editar_arquivo call.
- **pre_research**: "I need to find X. Where is it likely to be? What search terms?" — Use BEFORE buscar_texto/buscar_arquivos/web search.
- **pre_response**: "Did I actually do what was asked? Did I verify my claims? Am I being honest?" — Use BEFORE responding to the user. This is your HONESTY CHECK — verify that what you're about to say matches what you actually did. If you claimed "tests pass" — did you actually run them? If you claimed "the bug is fixed" — did you verify? If not, correct yourself.
- **debugging**: "The error is X. What could cause it? Top 3 hypotheses. Which is most likely?" — Use when something fails.
- **architecture**: "How do these components interact? What's the data flow? Where are the boundaries?" — Use for design questions.
- **general**: fallback for anything else.

The pre_response category is CRITICAL — it's your last line of defense against sycophancy and false claims. Before you tell the user "done!", run a pre_response check: did I actually verify, or am I just claiming it?

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

Delegate exploration to sub-agent (use for codebase research, NOT simple reads):
  explorar_subagente({ questao: "Find all callers of UserService and explain the data flow", cwd: "/abs/project" })

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

// ─── Gap 12: Environment info ─────────────────────────────────────────────
// IA needs to know its runtime environment to make correct decisions.
// Without this, IA may use Linux commands on Windows, assume wrong cwd,
// or not know the shell available.
function buildEnvironmentInfo(): string {
  try {
    const cwd = process.cwd();
    const platform = process.platform;
    const shell = process.env.SHELL ?? process.env.COMSPEC ?? "unknown";
    const nodeVersion = process.version;
    const platformLabel =
      platform === "win32" ? "Windows" :
      platform === "darwin" ? "macOS" :
      platform === "linux" ? "Linux" :
      platform;
    return [
      "## Environment",
      `- Working directory: ${cwd}`,
      `- Platform: ${platformLabel} (${platform})`,
      `- Shell: ${shell}`,
      `- Node.js: ${nodeVersion}`,
      `- Model: ${config.model}`,
      "",
      "Use platform-appropriate commands. On Windows, prefer PowerShell syntax. " +
      "On macOS/Linux, use bash syntax. The working directory above is your cwd " +
      "— use absolute paths in tools to avoid ambiguity.",
    ].join("\n");
  } catch {
    return "";
  }
}

// ─── Gap 14: Tool-routing rules ───────────────────────────────────────────
// Prevent IA from using executar_comando for file operations when dedicated
// tools exist. This saves tokens (no command output) and is safer (goes
// through poka-yoke, read-before-write, etc).
const TOOL_ROUTING_RULES = `## Tool Routing — CRITICAL

NEVER use \`executar_comando\` for file operations when a dedicated tool exists:

- To READ a file → use \`ler_arquivo({ caminho })\`. NEVER \`executar_comando("cat file")\`.
- To SEARCH file content → use \`buscar_texto({ pattern })\`. NEVER \`executar_comando("grep ...")\`.
- To FIND files → use \`buscar_arquivos({ pattern })\`. NEVER \`executar_comando("find ...")\` or \`executar_comando("ls ...")\`.
- To EDIT a file → use \`editar_arquivo\` or \`editar_multi_arquivos\`. NEVER \`executar_comando("sed ...")\` or \`executar_comando("echo > file")\`.

\`executar_comando\` is ONLY for:
- Running builds (\`npm run build\`, \`rojo build\`)
- Running tests (\`npm test\`, \`npx vitest\`)
- Running git (\`git status\`, \`git commit\`)
- Running package managers (\`npm install\`, \`wally install\`)
- One-off system commands that have no dedicated tool

If you find yourself typing \`executar_comando("cat ...")\` or \`executar_comando("grep ...")\`, STOP and use the dedicated tool instead.`;

// ─── Gap 15: Writing style constraints ────────────────────────────────────
// Keep IA concise. Without limits, IA can be verbose between tool calls
// (explaining what it will do) and in final responses (over-explaining).
const WRITING_STYLE_RULES = `## Response Style — CRITICAL

- Use **markdown** for formatting (headers, bullets, code blocks).
- Between tool calls, keep text **minimal** (≤25 words explaining what you're doing). Don't narrate every step — just act.
- Final responses should be **concise** (≤100 words unless a complex explanation is truly needed).
- Don't repeat what the user said. Don't say "Let me..." or "I'll now..." — just do it.
- When showing code, include only the relevant parts (not the entire file unless asked).
- Respond in the user's language (PT-BR or EN).`;

/**
 * Dynamically builds the system prompt combining base instructions and loaded skills.
 */
export function getSystemPrompt(): string {
  const skills = getActiveSkills();
  // Inject current date dynamically (so long-running sessions stay accurate)
  const today = new Date().toISOString().split("T")[0];
  let basePrompt = `## Current Date\n\nToday is ${today}. Always use this date when referencing current events, API versions, or searching the web. Your training data may be outdated — verify with buscar_web() before assuming API details.\n\n${BASE_SYSTEM_PROMPT}`;

  // ── Gap 12: Environment info ────────────────────────────────────────────
  // IA needs to know where it's running to make correct decisions (commands,
  // paths, shell). Without this, IA may use Linux commands on Windows or
  // assume wrong working directory.
  const envInfo = buildEnvironmentInfo();
  if (envInfo) {
    basePrompt = `${basePrompt}\n\n${envInfo}`;
  }

  // ── Gap 14: Tool-routing rules ──────────────────────────────────────────
  // Prevent IA from using executar_comando for file operations when dedicated
  // tools exist (ler_arquivo, buscar_texto, buscar_arquivos).
  basePrompt = `${basePrompt}\n\n${TOOL_ROUTING_RULES}`;

  // ── Gap 15: Writing style constraints ───────────────────────────────────
  // Keep IA concise: ≤25 words between tool calls, ≤100 words final response.
  basePrompt = `${basePrompt}\n\n${WRITING_STYLE_RULES}`;

  // IDEIA 4: Append effort-level instructions (Low/Medium/High/Max)
  const effortSnippet = getEffortPromptSnippet();
  if (effortSnippet) {
    basePrompt = `${basePrompt}\n\n${effortSnippet}`;
  }

  if (currentCavemanLevel) {
    basePrompt = `[SYSTEM NOTE: CAVEMAN MODE IS ACTIVE (Level: ${currentCavemanLevel}). You MUST strictly adhere to the caveman rules below for ALL replies. Speaking in standard conversational prose is strictly forbidden. Keep all technical terms, code blocks, and exact strings intact.]\n\n${basePrompt}`;
  }

    const memoryFiles = loadProjectMemoryFilesCached();
  if (memoryFiles.length > 0) {
    const fileList = memoryFiles
      .map((f) => `- ${f.relativePath} (${formatFileSize(f.sizeBytes)})`)
      .join("\n");
    const fileContents = memoryFiles
      .map((f) => `--- ${f.relativePath} (${formatFileSize(f.sizeBytes)}) ---\n${f.content}`)
      .join("\n\n");
    basePrompt = `${basePrompt}\n\n## Project Memory (CLAUDE.md / AGENTS.md)\n\n` +
      `The following files were loaded from disk at startup and describe this project's conventions:\n\n` +
      `${fileList}\n\n` +
      `You can re-read any of these files at any time using \`ler_arquivo(<path>)\` to see the CURRENT content ` +
      `(the cached version below may be stale if the file was edited since startup). ` +
      `When the user asks "which config file did you read?" or "what files are in your context?", answer with the list above.\n\n` +
      `### File contents:\n\n${fileContents}\n`;
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

let cachedMemoryFiles: MemoryFile[] | undefined; // undefined = not loaded yet
function loadProjectMemoryFilesCached(): MemoryFile[] {
  if (cachedMemoryFiles === undefined) {
    cachedMemoryFiles = loadProjectMemoryFiles();
  }
  return cachedMemoryFiles;
}

/**
 * Returns the list of project memory files currently loaded (cached).
 * Used by the `listar_memoria` tool so the model can answer "which config
 * files did you read?" without relying on system prompt parsing.
 */
export function getLoadedMemoryFiles(): MemoryFile[] {
  return loadProjectMemoryFilesCached();
}

/** Invalidate the memoized project memory (call on /memory reload). */
export function reloadProjectMemory(): string | null {
  cachedMemoryFiles = undefined;
  const files = loadProjectMemoryFilesCached();
  if (files.length === 0) return null;
  return files.map((f) => `--- MEMORY: ${f.relativePath} ---\n${f.content}`).join("\n\n");
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
  // Auto-persist: append to session file immediately (like Claude Code)
  tryAppendToSession({ role: "user", content });
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
  // Auto-persist: append to session file immediately
  tryAppendToSession(msg as unknown as Record<string, unknown>);
}

/** Append a tool result message (role: "tool"). */
export function addToolResult(toolCallId: string, content: string): void {
  ensureHistoryInitialized();
  history.push({
    role: "tool",
    tool_call_id: toolCallId,
    content,
  } as Message);
  // Auto-persist: append to session file immediately
  tryAppendToSession({ role: "tool", tool_call_id: toolCallId, content });
}

/**
 * Load history DIRECTLY from an array of messages — bypassing the normal
 * add* functions. This is used on session load to restore the IA's context
 * WITHOUT re-persisting to the session file (which would cause a double-write
 * bug: every loaded message would be appended again, duplicating the file).
 *
 * Use this when restoring from a compaction snapshot (the exact compacted
 * state the IA had) or from a regular session file when no snapshot exists.
 *
 * @param messages  The messages to set as the current history. Should include
 *                  the system prompt at index 0.
 *
 * BUG FIX (BS-4): Detects and repairs "orphan tool_calls" — when the session
 * file has an assistant message with `tool_calls` but NO matching `tool`
 * role message (happens when terminal closed mid-tool-call). The OpenAI API
 * rejects this with 400, permanently breaking the session. Now we inject a
 * synthetic tool result `[ERROR] Session interrupted — tool did not complete`
 * for each orphan tool_call_id, so the API accepts the history and the IA
 * can recover gracefully.
 */
export function loadHistoryDirect(messages: Message[]): void {
  // Replace history entirely — no ensureHistoryInitialized (messages already
  // contain the system prompt if it was saved).
  if (messages.length > 0 && messages[0]?.role === "system") {
    history = [...messages];
  } else {
    // If no system prompt, prepend one (defensive — shouldn't happen normally)
    history = [{ role: "system", content: getSystemPrompt() }, ...messages];
  }

  // ── Repair orphan tool_calls (BS-4) ─────────────────────────────────────
  // Collect all tool_call_ids from assistant messages, and all tool_call_ids
  // that have matching tool results. Any assistant tool_call_id WITHOUT a
  // matching tool result is an "orphan" — inject a synthetic error result.
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const m of history) {
    if (m.role === "assistant" && Array.isArray((m as any).tool_calls)) {
      for (const tc of (m as any).tool_calls) {
        if (tc?.id) toolCallIds.add(tc.id);
      }
    }
    if (m.role === "tool" && typeof (m as any).tool_call_id === "string") {
      toolResultIds.add((m as any).tool_call_id);
    }
  }

  // Find orphans: tool_call_ids without matching tool results.
  const orphans = [...toolCallIds].filter((id) => !toolResultIds.has(id));
  if (orphans.length > 0) {
    // Inject synthetic tool results for each orphan, placed right after the
    // last assistant message that contains that tool_call_id. We insert them
    // immediately after the assistant message to maintain chronological order.
    for (const orphanId of orphans) {
      // Find the assistant message that has this tool_call_id
      const assistantIdx = history.findIndex(
        (m) => m.role === "assistant" && Array.isArray((m as any).tool_calls) &&
          (m as any).tool_calls.some((tc: any) => tc?.id === orphanId)
      );
      if (assistantIdx >= 0) {
        // Insert synthetic tool result right after the assistant message
        history.splice(assistantIdx + 1, 0, {
          role: "tool",
          tool_call_id: orphanId,
          content: "[ERROR] Session interrupted — tool did not complete. The terminal was closed mid-tool-call. Please retry or check the current state.",
        } as Message);
      }
    }
    console.warn(`[SESSION] Repaired ${orphans.length} orphan tool_call(s) with synthetic error results (BS-4 fix)`);
  }

  // NOTE: intentionally does NOT call tryAppendToSession — these messages
  // are being LOADED from the session file, not newly created.
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
    "[PLAN",  // BUG FIX (Gap 3): was "[PLAN]" (with closing bracket) but formatPlan() returns "[PLAN - N steps]" (space+dash). Changed to "[PLAN" so it matches.
    "[SESSION CONTINUATION",  // Gap 2: continuation message
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

  // ─── Bug Hunter: summarize previous round before injecting new one ──────
  // Bug Hunter findings can be ~13K chars per round. Without cleanup, after
  // 2 rounds there's ~26K chars of OBSOLETE findings (bugs the IA already
  // corrected or dismissed) permanently in context. After 10 rounds (max),
  // that's ~130K chars — more than the entire context window.
  //
  // Solution: when a new Bug Hunter message is injected, find the PREVIOUS
  // Bug Hunter message and replace it with a 1-line summary. The IA already
  // saw the old findings, corrected them, and the new round has the current
  // state. The old findings are useless clutter.
  //
  // We only keep the MOST RECENT Bug Hunter message in full. All previous
  // rounds are summarized to "[BUG_HUNTER ROUND N COMPLETE - X findings
  // (Y critical/high, Z medium/low) — IA corrected or dismissed. OMITTED
  // FOR CONTEXT OPTIMIZATION.]"
  if (content.startsWith("[BUG_HUNTER]")) {
    // Find the most recent previous Bug Hunter message (not the one we're
    // about to add)
    for (let i = history.length - 1; i >= 1; i--) {
      if (history[i]!.role === "system") {
        const prevContent = (history[i] as any).content as string;
        if (prevContent && prevContent.startsWith("[BUG_HUNTER]")) {
          // Extract finding count from the previous message if possible
          const findingsMatch = prevContent.match(/All Findings \((\d+) total\)/);
          const findingsCount = findingsMatch ? findingsMatch[1] : "?";

          // Determine if it was a blocking or advisory round
          const wasBlocking = prevContent.includes("ISSUES FOUND");

          // Replace the old verbose findings with a compact summary
          (history[i] as any).content =
            `[BUG_HUNTER] Previous round complete — ${findingsCount} findings were reported, ` +
            `IA corrected or dismissed them. Findings omitted for context optimization. ` +
            (wasBlocking ? `(was blocking)` : `(was advisory)`);
          break; // Only summarize the most recent one
        }
      }
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
  method: "llm" | "mechanical";
}

/**
 * Replace oldest middle of history with a single "[CONTEXT COMPACTED]" sentinel
 * to bring prompt under threshold. Always preserves:
 *   - index 0 (system prompt)
 *   - last COMPACT_KEEP_RECENT messages (recent context)
 *
 * ASYNC VERSION: tries LLM-based compaction first (uses the AI to generate
 * an intelligent summary), falls back to mechanical compaction if LLM fails.
 *
 * @param customInstruction Optional user instruction for what to preserve
 *                          (e.g., "focus on code changes and API decisions")
 *                          Empty/null = automatic compaction (preserve everything important)
 * Returns counts or null when nothing to compact.
 */
export async function compactHistoryAsync(customInstruction?: string): Promise<CompactResult | null> {
  if (history.length <= COMPACT_KEEP_RECENT + 1) return null;

  const beforeTokens = estimateTokens(history);
  const system = history[0];

  // CLAUDE-CODE-STYLE COMPACTION: preserve critical context that the IA
  // needs to continue the task. Without this, the IA forgets:
  //   - The project name and goal (TASK_STATE)
  //   - What was already decided (decisions, plans)
  //   - What bugs are open
  //   - Persistent memory (skills, project context)
  const PRESERVE_PREFIXES = [
    "## TASK_STATE",
    "## Persistent Memory",
    "[CONVERSATION MEMORY",  // accumulated summaries from previous compactions
    "[PLAN",  // Gap 3: preserve plan state across compaction
    "[SESSION CONTINUATION",  // Gap 2: preserve continuation message
    "## Recently Modified Files",  // Gap 1: preserve re-hydrated files
    "## Invoked Skills",  // Gap 9: preserve re-injected skills
  ];

  const preservedSystem: Message[] = [];
  for (let i = 1; i < history.length - COMPACT_KEEP_RECENT; i++) {
    const m = history[i];
    if (m.role !== "system") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (PRESERVE_PREFIXES.some(p => content.startsWith(p))) {
      if (!preservedSystem.some(p => (typeof p.content === "string" ? p.content : "") === content)) {
        preservedSystem.push(m);
      }
    }
  }

  const recent = history.slice(-COMPACT_KEEP_RECENT);
  const dropped = history.length - 1 - COMPACT_KEEP_RECENT - preservedSystem.length;
  if (dropped <= 0) return null;

  // Messages that will be compacted (everything between system and recent)
  const compactedMessages = history.slice(1, history.length - COMPACT_KEEP_RECENT);

  // ── Try LLM-based compaction first ───────────────────────────────────────
  // Uses the AI itself to generate an intelligent summary that preserves
  // decisions, code changes, bugs, and context. Falls back to mechanical
  // compaction if the LLM call fails.
  let compactedSummary: string;
  let method: "llm" | "mechanical";

  try {
    const { llmCompact, isLlmCompactionAvailable } = await import("./llmCompactor.js");
    const llmAvailable = await isLlmCompactionAvailable();
    if (llmAvailable) {
      console.log("[COMPACT] Generating LLM-based summary...");
      const llmSummary = await llmCompact(compactedMessages, customInstruction);
      if (llmSummary && llmSummary.length > 100) {
        compactedSummary = llmSummary;
        method = "llm";
        console.log("[COMPACT] LLM summary generated successfully.");
      } else {
        console.log("[COMPACT] LLM summary too short, falling back to mechanical.");
        compactedSummary = buildCompactionSummary(compactedMessages);
        method = "mechanical";
      }
    } else {
      console.log("[COMPACT] LLM not available, using mechanical compaction.");
      compactedSummary = buildCompactionSummary(compactedMessages);
      method = "mechanical";
    }
  } catch (err) {
    console.log(`[COMPACT] LLM compaction failed (${(err as Error).message}), using mechanical.`);
    compactedSummary = buildCompactionSummary(compactedMessages);
    method = "mechanical";
  }

  const summary: Message = {
    role: "system",
    content: compactedSummary,
  };

  // ── Gap 2: Continuation message ─────────────────────────────────────────
  // After compaction, inject an explicit continuation instruction so the IA
  // knows to continue working on the task without asking the user what to do.
  // Without this, IA may ask "what would you like me to do next?" after
  // compaction, losing the thread of work it was doing.
  // (Inspired by Claude Code's continuation message.)
  const continuationMsg: Message = {
    role: "system",
    content: "[SESSION CONTINUATION] This session was continued from a previous conversation that ran out of context. The summary above covers the earlier portion. Continue working on the last task you were doing — do NOT ask the user what to do next. Pick up where you left off and keep working until the task is complete or you need user input.",
  };

  // Reconstruct: [system_prompt, preserved_critical_context, compaction_summary, continuation, ...recent]
  history = [system, ...preservedSystem, summary, continuationMsg, ...recent];

  // ── Gap 1: Re-hydrate recently edited files ─────────────────────────────
  // After compaction, the IA loses access to file contents it had read.
  // Re-read the 5 most-recently-edited files from disk and inject as a
  // system message so the IA can continue working without re-reading.
  // (Inspired by Claude Code's re-hydration: 5 files, 50K token budget.)
  try {
    const { buildRehydrationMessage } = await import("./fileRehydration.js");
    const rehydrationMsg = buildRehydrationMessage();
    if (rehydrationMsg) {
      // Insert after continuation message, before recent messages
      const insertIdx = history.length - recent.length;
      history.splice(insertIdx, 0, { role: "system", content: rehydrationMsg });
    }
  } catch (err) {
    console.debug(`[COMPACT] Failed to re-hydrate files: ${(err as Error).message}`);
  }

  // ── Gap 9: Re-inject invoked skills ─────────────────────────────────────
  // After compaction, skills that were invoked earlier are lost. Re-inject
  // their content so the IA can continue using them without re-reading.
  // (Inspired by Claude Code: 5K tokens/skill, 25K total.)
  try {
    const { buildSkillReInjectionMessage } = await import("./skillTracker.js");
    const skillMsg = buildSkillReInjectionMessage();
    if (skillMsg) {
      const insertIdx = history.length - recent.length;
      history.splice(insertIdx, 0, { role: "system", content: skillMsg });
    }
  } catch (err) {
    console.debug(`[COMPACT] Failed to re-inject skills: ${(err as Error).message}`);
  }

  // Remove dangling tool messages that no longer match a tool_call in history
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

  // ── Save compaction snapshot to session file ────────────────────────────
  // This captures the EXACT in-memory history after compaction, so that on
  // session load we can restore the IA's context precisely as it was
  // (compacted summary + recent messages) instead of the full un-compacted
  // history (which might exceed the context window).
  // See appendCompactionSnapshot() in session.ts for details.
  try {
    const { appendCompactionSnapshot } = await import("./session.js");
    appendCompactionSnapshot(history, method);
  } catch (err) {
    console.debug(`[COMPACT] Failed to save compaction snapshot: ${(err as Error).message}`);
  }

  return { removed: dropped, beforeTokens, afterTokens, method };
}

/**
 * Synchronous mechanical compaction (legacy, used as fallback and in tests).
 * Keeps the old behavior for backwards compatibility.
 */
export function compactHistory(): CompactResult | null {
  if (history.length <= COMPACT_KEEP_RECENT + 1) return null;

  const beforeTokens = estimateTokens(history);
  const system = history[0];

  const PRESERVE_PREFIXES = [
    "## TASK_STATE",
    "## Persistent Memory",
    "[CONVERSATION MEMORY",
    "[PLAN",  // Gap 3: preserve plan state across compaction
    "[SESSION CONTINUATION",  // Gap 2: preserve continuation message
  ];

  const preservedSystem: Message[] = [];
  for (let i = 1; i < history.length - COMPACT_KEEP_RECENT; i++) {
    const m = history[i];
    if (m.role !== "system") continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (PRESERVE_PREFIXES.some(p => content.startsWith(p))) {
      if (!preservedSystem.some(p => (typeof p.content === "string" ? p.content : "") === content)) {
        preservedSystem.push(m);
      }
    }
  }

  const recent = history.slice(-COMPACT_KEEP_RECENT);
  const dropped = history.length - 1 - COMPACT_KEEP_RECENT - preservedSystem.length;
  if (dropped <= 0) return null;

  const compactedMessages = history.slice(1, history.length - COMPACT_KEEP_RECENT);
  const compactedSummary = buildCompactionSummary(compactedMessages);

  const summary: Message = {
    role: "system",
    content: compactedSummary,
  };

  history = [system, ...preservedSystem, summary, ...recent];

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
  return { removed: dropped, beforeTokens, afterTokens, method: "mechanical" };
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
  const filesRead: Set<string> = new Set();
  const errorsEncountered: string[] = [];
  const decisions: string[] = [];
  const commandsRun: string[] = [];

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
        assistantConclusions.push(content.slice(0, 400));
        // Detect decisions (sentences with decision keywords)
        const decisionKeywords = /\b(decid|vou|vamos|usar|usarei|implementar|criar|fazer|refatorar|mudar|alterar)\b/i;
        const sentences = content.split(/[.!?\n]/);
        for (const s of sentences) {
          if (decisionKeywords.test(s) && s.trim().length > 20 && s.trim().length < 200) {
            decisions.push(s.trim());
          }
        }
      }
      // Collect tool names and details
      if (Array.isArray((m as any).tool_calls)) {
        for (const tc of (m as any).tool_calls) {
          const name = tc?.function?.name;
          if (name && !toolsUsed.includes(name)) toolsUsed.push(name);
          try {
            const args = JSON.parse(tc?.function?.arguments ?? "{}");
            const filePath = args.path ?? args.caminho ?? args.filePath;
            // Track file modifications
            if (typeof filePath === "string" &&
                (tc.function.name === "editar_arquivo" || tc.function.name === "editar_multi_arquivos")) {
              filesModified.add(filePath);
            }
            // Track files read
            if (typeof filePath === "string" && tc.function.name === "ler_arquivo") {
              filesRead.add(filePath);
            }
            // Track commands run
            if (tc.function.name === "executar_comando" && typeof args.comando === "string") {
              commandsRun.push(args.comando.slice(0, 100));
            }
          } catch { /* ignore */ }
        }
      }
    } else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : "";
      // Capture errors from tool results
      if (content.includes("[ERROR]") || content.includes("[ERRO") ||
          content.includes("Error:") || content.includes("failed")) {
        const errorLine = content.split("\n").find(l =>
          l.includes("[ERROR]") || l.includes("[ERRO") ||
          l.includes("Error:") || l.includes("failed"));
        if (errorLine && errorLine.length < 200) {
          errorsEncountered.push(errorLine.trim());
        }
      }
    }
  }

  const lines: string[] = [];
  lines.push(`[CONVERSATION MEMORY - ${messages.length} old messages compacted]`);
  lines.push(``);
  lines.push(`IMPORTANT: This memory preserves what happened. Use it to answer questions about project context.`);
  lines.push(``);

  if (userRequests.length > 0) {
    lines.push(`## User Requests (chronological — these are the GOALS)`);
    for (const r of userRequests.slice(-8)) { // last 8 user requests (was 5)
      lines.push(`- ${r}`);
    }
    lines.push(``);
  }

  if (decisions.length > 0) {
    lines.push(`## Decisions Made (what was decided)`);
    for (const d of decisions.slice(-6)) { // last 6 decisions
      lines.push(`- ${d}`);
    }
    lines.push(``);
  }

  if (assistantConclusions.length > 0) {
    lines.push(`## Key Conclusions (what was done)`);
    for (const c of assistantConclusions.slice(-4)) { // last 4 conclusions (was 3)
      lines.push(`- ${c}`);
    }
    lines.push(``);
  }

  if (filesModified.size > 0) {
    lines.push(`## Files Modified (these EXIST on disk)`);
    for (const f of filesModified) {
      lines.push(`- ${f}`);
    }
    lines.push(``);
  }

  if (filesRead.size > 0) {
    lines.push(`## Files Read (context was gathered from these)`);
    for (const f of [...filesRead].slice(0, 10)) { // limit to 10
      lines.push(`- ${f}`);
    }
    lines.push(``);
  }

  if (commandsRun.length > 0) {
    lines.push(`## Commands Executed`);
    for (const c of commandsRun.slice(-5)) { // last 5 commands
      lines.push(`- ${c}`);
    }
    lines.push(``);
  }

  if (errorsEncountered.length > 0) {
    lines.push(`## Errors Encountered (may need follow-up)`);
    for (const e of errorsEncountered.slice(-5)) { // last 5 errors
      lines.push(`- ${e}`);
    }
    lines.push(``);
  }

  if (toolsUsed.length > 0) {
    lines.push(`## Tools Used`);
    lines.push(toolsUsed.join(", "));
    lines.push(``);
  }

  lines.push(`Note: Historical tool_call IDs are now stale. If you need to reference past tool results, ask the user.`);
  lines.push(`If asked about project name or context, check TASK_STATE above or this memory.`);

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

/** Edit tools that may have an [IMPACT] hint appended to their result. */
const EDIT_TOOLS = new Set([
  "editar_arquivo",
  "editar_multi_arquivos",
  "escrever_arquivo",
  "aplicar_diff",
]);

function isReadTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}

function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(toolName);
}

function isErrorMessage(content: string): boolean {
  return content.includes("[ERROR]") || content.includes("[GUARDRAIL_FAIL]") || content.includes("Error:");
}

function hasFlowAdvancedAfterIndex(fromIndex: number): boolean {
  for (let k = fromIndex + 1; k < history.length; k++) {
    const futureMsg = history[k];
    if (futureMsg.role === "user") return true;
    if (futureMsg.role === "tool") {
      // Any subsequent tool call means the flow advanced past the previous one.
      // (Previously only "aplicar_diff" with [SUCCESS] counted as advancement,
      // which was too strict — it meant ler_arquivo results were never summarized
      // unless the IA explicitly called aplicar_diff afterwards.)
      return true;
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

  // ─── Edit tool results with [IMPACT] hint ──────────────────────────────
  // The impact hint (showing which files reference the symbols being edited)
  // is useful BEFORE the edit — but useless AFTER. It clutters context forever.
  // Once the flow has advanced (another tool call or user message), strip the
  // [IMPACT] section and keep only the success/error line.
  // This saves ~2K chars per edit. With 20 edits = ~40K chars saved.
  if (isEditTool(toolName) && content.includes("[IMPACT]") && !content.startsWith("[EDIT COMPLETED")) {
    if (hasFlowAdvancedAfterIndex(i)) {
      // Keep only the first line (the success/error message), drop the IMPACT hint.
      const firstLine = content.split("\n")[0];
      (history[i] as any).content = `[EDIT COMPLETED - IMPACT HINT OMITTED FOR OPTIMIZATION]\n${firstLine}`;
      return true;
    }
  }

  // ─── Read tool results (ler_arquivo, etc) ──────────────────────────────
  // REMOVIDO: otimização que omitia conteúdo de ler_arquivo.
  // Se a IA chamou ler_arquivo, é porque PRECISA do conteúdo. Omitir
  // o conteúdo faz a IA perder acesso ao que ela mesma pediu pra ler,
  // causando loop de re-leitura e respostas incorretas.
  // A otimização de contexto deve acontecer via /compact (LLM-based),
  // não removendo conteúdo que a IA explicitamente solicitou.

  // ─── Error messages that have been overcome ────────────────────────────
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

// --- Auto-persist sessions (like Claude Code) --------------------------------

// Static import to avoid ESM require() issues.
import { appendMessage as sessionAppendMessage } from "./session.js";

/**
 * Append a message to the active session file.
 * Uses static import — no require() (which doesn't exist in ESM).
 * If session module fails, logs warning (does NOT silently swallow).
 */
function tryAppendToSession(msg: Record<string, unknown>): void {
  try {
    sessionAppendMessage(msg as { role: string; content?: string; [key: string]: unknown });
  } catch (err) {
    // Log warning instead of silently swallowing — helps debug session loss
    console.error(`[SESSION] Failed to persist message: ${(err as Error).message}`);
  }
}
