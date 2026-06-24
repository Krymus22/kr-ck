/**
 * subAgents.ts - In-process sub-agents for parallel task execution.
 *
 * Two modes:
 *   - READ_ONLY (default): 4 read tools, focused on exploration. Fast, cheap, safe.
 *   - POWERFUL: inherits main agent's tools + system prompt. Can write, edit,
 *     run tests, etc. Same safety checks (file lock, safety reviewer, luau
 *     validator, impact analyzer) apply to its writes.
 *
 * POWERFUL mode is for parallel task execution:
 *   - Main agent: implements InventoryService.luau
 *   - Sub-agent 1: writes InventoryService.spec.luau (tests)
 *   - Sub-agent 2: researches current ProfileStore API
 *
 * When POWERFUL:
 *   - System prompt = main agent's getSystemPrompt() (inherits effort, mode, etc)
 *   - Tools = all main agent's tools (write, edit, git, test, MCP, etc)
 *   - Tool dispatch = same dispatchToolCallPublic (with all safety hooks)
 *   - CLAUDE_KILLER_AGENT_ID env var = "sub-N" (for rollback tracking)
 *   - File locks prevent concurrent edits to same file
 *   - Max 15 tool calls (vs 8 in read-only)
 *
 * When READ_ONLY:
 *   - System prompt = focused exploration prompt (40 lines, fixed)
 *   - Tools = 4 read-only (ler_arquivo, buscar_arquivos, buscar_texto, parse_ast)
 *   - Max 8 tool calls
 *
 * Both modes:
 *   - Clean history (don't inherit main agent's conversation)
 *   - No recursion (sub-agent can't spawn sub-agents)
 *   - Return 1-2k token summary to main agent
 *   - Reuse same API key pool as main agent
 *
 * Activation:
 *   - READ_ONLY: effort high/max (shouldUseSubAgents)
 *   - POWERFUL: effort max only (shouldUsePowerfulSubAgents) - costs more
 */

import { chat, isTransientNetworkErrorPublic, is429ErrorPublic, SUB_AGENT_MAX_CHAT_RETRIES } from "./apiClient.js";
import { getPoolSize } from "./apiKeyPool.js";
import { lerArquivo } from "./tools.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { parseFile } from "./lspAst.js";
import { shouldUseSubAgents, getEffortLevel } from "./effortLevels.js";
import { getSystemPrompt } from "./history.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";

// --- Sub-agent ID counter (for tracking in rollback) ----------------------

let subAgentCounter = 0;

/** Generate a unique sub-agent ID like "sub-1", "sub-2", etc. */
function nextSubAgentId(): string {
  subAgentCounter++;
  return `sub-${subAgentCounter}`;
}

// --- System prompts --------------------------------------------------------

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused code-exploration sub-agent for Claude-Killer.
Your job: answer the main agent's question by reading code, then return a CONCISE summary.

RULES:
- You have ONLY read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast.
- You CANNOT edit, write, or run commands. Just read and report.
- Do AT MOST 8 tool calls. If you can't answer in 8, give your best guess.
- Return a summary of 500-2000 tokens. Be specific: file paths, line numbers, key code snippets.
- Format your final answer as:

## Summary
[concise answer to the main agent's question]

## Files Inspected
- [path]: [what's relevant there]

## Key Findings
- [bullet points with file:line references]

If you can't find the answer, say so explicitly - don't invent.`;

/**
 * System prompt for POWERFUL sub-agents.
 *
 * Inherits the main agent's system prompt (with effort level, mode, skills,
 * project memory, etc) and prepends a "you are a sub-agent" context block
 * that explains the constraints (no recursion, return summary, etc).
 */
function buildPowerfulSubAgentPrompt(mainPrompt: string, subAgentId: string, question: string): string {
  return `## SUB-AGENT CONTEXT

You are a POWERFUL sub-agent (ID: ${subAgentId}) spawned by the main Claude-Killer agent.
You have the SAME tools, system prompt, and safety checks as the main agent.

CONSTRAINTS (different from main agent):
- You CANNOT spawn your own sub-agents (no recursion).
- You MUST return a summary of your work at the end (1-2k tokens max).
- Your file edits will acquire file locks - if another agent (main or sibling)
  is editing the same file, you will wait. Don't deadlock by holding locks.
- All safety checks (read-before-write, schema validation, safety reviewer,
  luau validator, impact analyzer) apply to YOUR writes too.
- Release any locks promptly - don't hold a lock across multiple tool calls
  unless you're actively editing that file.

YOUR TASK (from main agent):
${question}

When done, format your final answer as:

## Summary
[concise summary of what you did]

## Files Modified
- [path]: [what you changed and why]

## Key Findings
- [any relevant info for the main agent to know]

## Issues / Warnings
- [anything the main agent should watch out for]

If you can't complete the task, say so explicitly in the summary.

---

## INHERITED MAIN AGENT SYSTEM PROMPT (follow all rules below)

${mainPrompt}`;
}

// --- Read-only tools (fixed set) -------------------------------------------

const SUB_AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "ler_arquivo",
      description: "Read a file's content. Returns the full text.",
      parameters: {
        type: "object",
        properties: { caminho: { type: "string", description: "File path to read." } },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_arquivos",
      description: "Find files by glob pattern (e.g. **/*.ts).",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern." } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_texto",
      description: "Grep for a regex pattern across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex to search for." },
          path: { type: "string", description: "Directory or file to search in." },
          include: { type: "string", description: "File pattern filter." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "parse_ast",
      description: "Parse a source file and extract symbols (functions, classes, imports).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File to parse." } },
        required: ["path"],
      },
    },
  },
];

// --- Args ------------------------------------------------------------------

interface SubAgentArgs {
  /** The task/question to answer */
  question: string;
  /** Starting directory for the search (defaults to cwd) */
  cwd?: string;
  /** Max tool calls before giving up (default 8 for read-only, 15 for powerful) */
  maxToolCalls?: number;
  /**
   * If true, the sub-agent inherits the main agent's system prompt + all tools
   * (write, edit, git, test, etc) and can perform real work in parallel.
   * Default: false (read-only mode).
   *
   * Powerful mode only activates at /effort max (see shouldUsePowerfulSubAgents).
   */
  powerful?: boolean;
}

// --- Main entry point ------------------------------------------------------

/**
 * Run a sub-agent to answer a question or complete a task.
 * Returns the sub-agent's final summary as a string.
 *
 * Returns null if sub-agents are disabled (effort too low) or if the
 * sub-agent failed to produce a useful answer.
 *
 * Modes:
 *   - powerful=false (default): read-only, 4 tools, 8 max calls
 *   - powerful=true: inherits main agent's tools + system prompt, 15 max calls
 */
export async function runSubAgent(args: SubAgentArgs): Promise<string | null> {
  const powerful = args.powerful === true;

  // Check effort level requirements
  if (powerful) {
    if (!shouldUsePowerfulSubAgents()) {
      log.debug(`[SUB_AGENT] Skipped - powerful mode requires /effort max`);
      return null;
    }
  } else if (!shouldUseSubAgents()) {
    log.debug(`[SUB_AGENT] Skipped - effort level too low`);
    return null;
  }

  const cwd = args.cwd ?? process.cwd();
  const maxCalls = args.maxToolCalls ?? (powerful ? 15 : 8);
  const subAgentId = nextSubAgentId();
  const poolInfo = getPoolSize() > 0 ? ` (pool: ${getPoolSize()} keys)` : " (single key)";
  log.info(`[SUB_AGENT:${subAgentId}] Starting ${powerful ? "POWERFUL" : "READ-ONLY"}: "${args.question.slice(0, 80)}..." (cwd=${cwd}, maxCalls=${maxCalls}${poolInfo})`);

  // Surface sub-agent activity in the TUI so the user sees the agent is
  // delegating work to a sub-agent (not just "thinking forever").
  const shortQ = args.question.length > 60 ? args.question.slice(0, 59) + "…" : args.question;
  const subActivityDone = pushActivity("subagent", `#${subAgentId}: ${shortQ}`);

  try {
    return await runSubAgentInner(args, powerful, cwd, maxCalls, subAgentId);
  } finally {
    subActivityDone();
  }
}

/** Inner implementation of runSubAgent — separated so we can wrap it with activity tracking. */
async function runSubAgentInner(
  args: SubAgentArgs,
  powerful: boolean,
  cwd: string,
  maxCalls: number,
  subAgentId: string,
): Promise<string | null> {
  // Build initial history
  const systemPrompt = powerful
    ? buildPowerfulSubAgentPrompt(getSystemPrompt(), subAgentId, args.question)
    : SUB_AGENT_SYSTEM_PROMPT;

  const initialHistory: SubAgentMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Working directory: ${cwd}\n\nQuestion: ${args.question}` },
  ];

  let subHistory = [...initialHistory];
  let callNum = 0;
  let consecutiveFailures = 0;

  // Set agent ID env var for rollback tracking (fileLock.ts reads this)
  const previousAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = subAgentId;

  try {
    // Lazy-import agent.ts to avoid circular dependency at module load time.
    // Only needed in powerful mode (read-only mode uses its own tool executor).
    const agentMod = powerful ? await import("./agent.js") : null;

    while (callNum < maxCalls) {
      const checkpoint = [...subHistory];
      try {
        // Choose tool set: powerful mode uses all main agent's tools
        const tools = powerful && agentMod ? agentMod.getMergedToolsPublic() : SUB_AGENT_TOOLS;
        const response = await chatWithRetry(subHistory, callNum, tools);
        const choice = response.choices[0];
        if (!choice) break;

        subHistory.push(choice.message as SubAgentMessage);
        consecutiveFailures = 0;

        const finalSummary = tryExtractFinalSummary(choice, callNum);
        if (finalSummary.done) return finalSummary.summary;

        for (const tc of choice.message.tool_calls ?? []) {
          let result: string;
          if (powerful && agentMod) {
            // Use main agent's dispatcher (with all safety hooks, file locks, etc)
            const toolResult = await agentMod.dispatchToolCallPublic(tc);
            result = toolResult.resultStr;
          } else {
            // Use read-only sub-agent tool executor
            result = await executeSubAgentTool(tc.function.name, JSON.parse(tc.function.arguments), cwd);
          }
          subHistory.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        callNum++;
      } catch (err) {
        const retryDecision = handleSubAgentError(err, callNum, consecutiveFailures);
        if (retryDecision.shouldRetry) {
          subHistory = [...checkpoint];
          consecutiveFailures = retryDecision.newConsecutiveFailures;
          await new Promise((r) => setTimeout(r, retryDecision.waitMs));
          continue;
        }
        log.error(`[SUB_AGENT:${subAgentId}] Giving up at call ${callNum + 1} after ${consecutiveFailures + 1} failures: ${(err as Error).message}`);
        return null;
      }
    }

    log.warn(`[SUB_AGENT:${subAgentId}] Hit maxToolCalls (${maxCalls}) without finishing`);
    return null;
  } finally {
    // Restore previous agent ID (or clear if there was none)
    if (previousAgentId !== undefined) {
      process.env.CLAUDE_KILLER_AGENT_ID = previousAgentId;
    } else {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    }
  }
}

type SubAgentMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: any[] };

/**
 * If the choice represents the final answer (no more tool_calls), extract it.
 * Returns { done: true, summary } on success, { done: true, summary: null } on empty/invalid,
 * { done: false, summary: null } if there are still tool_calls to execute.
 */
function tryExtractFinalSummary(choice: any, callNum: number): { done: boolean; summary: string | null } {
  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
    return { done: false, summary: null };
  }
  const summary = choice.message.content ?? "";
  if (!summary || summary.trim().length < 10) {
    log.warn(`[SUB_AGENT] Model returned empty/too-short summary`);
    return { done: true, summary: null };
  }
  log.debug(`[SUB_AGENT] Done in ${callNum + 1} calls (${summary.length} chars)`);
  return { done: true, summary };
}

async function executeSubAgentTool(name: string, args: any, cwd: string): Promise<string> {
  try {
    switch (name) {
      case "ler_arquivo": {
        const resolved = args.caminho?.startsWith("/") ? args.caminho : `${cwd}/${args.caminho}`;
        return await lerArquivo({ caminho: resolved });
      }
      case "buscar_arquivos": {
        const results = globSearch({ pattern: args.pattern ?? "**/*", cwd });
        return results.length > 0 ? results.join("\n") : "No files found.";
      }
      case "buscar_texto": {
        const searchPath = resolveSearchPath(args.path, cwd);
        const matches = grepSearch({
          pattern: args.pattern,
          path: searchPath,
          include: args.include,
        });
        return formatGrepResults(matches);
      }
      case "parse_ast": {
        const resolved = args.path?.startsWith("/") ? args.path : `${cwd}/${args.path}`;
        const result = await parseFile(resolved);
        return [
          `Language: ${result.language}`,
          `Lines: ${result.lineCount}`,
          `Symbols: ${result.symbols.length}`,
          ...result.symbols.map((s: any) => `  ${s.type} ${s.name} (line ${s.line})`),
        ].join("\n");
      }
      default:
        return `[ERROR] Unknown tool: ${name}`;
    }
  } catch (err) {
    return `[ERROR] ${name} failed: ${(err as Error).message}`;
  }
}

/** Decide whether to retry after an error, and how long to wait. */
function handleSubAgentError(err: unknown, callNum: number, consecutiveFailures: number): {
  shouldRetry: boolean;
  newConsecutiveFailures: number;
  waitMs: number;
} {
  const newConsecutive = consecutiveFailures + 1;
  const isTransient = isTransientNetworkErrorPublic(err) || is429ErrorPublic(err);
  log.warn(`[SUB_AGENT] Call ${callNum + 1} failed (attempt ${newConsecutive}/${SUB_AGENT_MAX_CHAT_RETRIES + 1}): ${(err as Error).message}`);

  if (!isTransient || newConsecutive > SUB_AGENT_MAX_CHAT_RETRIES) {
    return { shouldRetry: false, newConsecutiveFailures: newConsecutive, waitMs: 0 };
  }

  const waitMs = 1000 * (2 ** (newConsecutive - 1));
  log.warn(`[SUB_AGENT] Restoring checkpoint and retrying in ${waitMs}ms (call ${callNum + 1})`);
  return { shouldRetry: true, newConsecutiveFailures: newConsecutive, waitMs };
}

/**
 * Wrapper around chat() that re-throws transient errors for the outer loop to handle.
 * The inner chat() already retries ECONNRESET (8x) and 429 (4x) - this just classifies
 * the error for the outer retry loop.
 *
 * Now accepts an optional tools parameter - in powerful mode, sub-agents pass the
 * full main agent tool list (so they can call write/edit/git tools too).
 */
async function chatWithRetry(subHistory: any[], callNum: number, tools?: any) {
  try {
    return await chat(subHistory, undefined, undefined, undefined, tools);
  } catch (err) {
    if (!isTransientNetworkErrorPublic(err) && !is429ErrorPublic(err)) {
      throw err; // non-transient - let caller give up immediately
    }
    log.warn(`[SUB_AGENT] chat() exhausted inner retries at call ${callNum + 1}: ${(err as Error).message}`);
    throw err;
  }
}

/**
 * Decide whether a user message looks like it would benefit from sub-agent exploration.
 * Heuristic: mentions multiple files, "understand how X works", "find all places that Y", etc.
 */
export function shouldDelegateToSubAgent(userMessage: string): boolean {
  if (!shouldUseSubAgents()) return false;
  const lower = userMessage.toLowerCase();
  const triggers = [
    "understand how",
    "entenda como",
    "find all",
    "encontre todos",
    "where is",
    "onde está",
    "trace through",
    "map the",
    "what does the",
    "how does",
    "explore",
    "investigate",
  ];
  return triggers.some((t) => lower.includes(t));
}

/** Resolve a possibly-relative path against the sub-agent's cwd. */
function resolveSearchPath(rawPath: any, cwd: string): string {
  if (!rawPath) return cwd;
  if (typeof rawPath !== "string") return cwd;
  if (rawPath.startsWith("/")) return rawPath;
  return `${cwd}/${rawPath}`;
}

/**
 * Whether powerful sub-agents should be used.
 * Only at /effort max - powerful sub-agents cost more (more tool calls,
 * safety reviewer on each write, etc) but enable true parallel task execution.
 */
export function shouldUsePowerfulSubAgents(): boolean {
  return getEffortLevel() === "max";
}
