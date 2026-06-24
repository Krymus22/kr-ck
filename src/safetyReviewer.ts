/**
 * safetyReviewer.ts - LLM-based safety reviewer for Roblox data operations.
 *
 * Before code is written to disk (and then synced to Roblox Studio via Rojo),
 * this module:
 *   1. Scans the proposed code for "dangerous patterns" (DataStore calls,
 *      PlayerData mutations, Replica.Data writes, :RemoveAsync, :SetAsync,
 *      :Destroy, :ClearAllChildren, HttpService:PostAsync, etc.)
 *   2. If any pattern matches, calls the LLM with the code + a specific
 *      safety question: "Can this code affect the database or delete
 *      player data?"
 *   3. LLM returns: { risk: "none" | "low" | "high", reasoning: string }
 *   4. If risk=high, the write is BLOCKED and the AI must revise.
 *
 * Why both heuristics AND LLM:
 *   - Heuristics alone: too many false positives (any DataStore call is
 *     flagged, even safe reads)
 *   - LLM alone: too slow (3-5s per write) and expensive
 *   - Combined: heuristics filter to ~5% of writes, LLM only reviews those
 *
 * Integration:
 *   - Called by fileEdit.ts AFTER luau validation passes, BEFORE write
 *   - Only active when mode has safetyReview=true (Roblox mode does)
 *   - Non-blocking on errors (reviewer failure doesn't block writes)
 */

import { chat } from "./apiClient.js";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export type SafetyRisk = "none" | "low" | "high";

export interface SafetyReviewResult {
  risk: SafetyRisk;
  reasoning: string;
  patternsMatched: string[];
  reviewedByLlm: boolean;
  durationMs: number;
}

// --- Dangerous patterns -----------------------------------------------------

interface DangerPattern {
  regex: RegExp;
  description: string;
  severity: "low" | "medium" | "high";
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  // DataStore destructive operations
  { regex: /:RemoveAsync\s*\(/g, description: "DataStore:RemoveAsync (deletes data permanently)", severity: "high" },
  { regex: /:RemoveAllAsync\s*\(/g, description: "DataStore:RemoveAllAsync (deletes entire datastore)", severity: "high" },
  { regex: /:SetAsync\s*\(/g, description: "DataStore:SetAsync (overwrites without merge)", severity: "medium" },
  { regex: /:UpdateAsync\s*\(/g, description: "DataStore:UpdateAsync (mutates stored data)", severity: "medium" },

  // PlayerData mutations (ProfileStore / Replica patterns)
  { regex: /profile\.Data\s*=/gi, description: "ProfileStore: direct profile.Data assignment (overwrites all data)", severity: "high" },
  { regex: /profile\.Data\.\w+\s*=/gi, description: "ProfileStore: profile.Data.X = (mutates player data)", severity: "medium" },
  { regex: /replica\.Data\s*=/gi, description: "Replica: direct Replica.Data assignment (overwrites)", severity: "high" },
  { regex: /replica\.Data\.\w+\s*=/gi, description: "Replica: replica.Data.X = (mutates replicated state)", severity: "medium" },
  { regex: /:SetValue\s*\(\s*\{/g, description: "Replica:SetValue (mutates replicated state)", severity: "medium" },
  { regex: /:Release\s*\(\s*\)/g, description: "ProfileStore:Release (releases session lock - affects data access)", severity: "low" },

  // Instance destruction
  { regex: /:ClearAllChildren\s*\(/g, description: "Instance:ClearAllChildren (deletes all children)", severity: "high" },
  { regex: /:Destroy\s*\(\s*\)/g, description: "Instance:Destroy (permanent deletion)", severity: "medium" },
  { regex: /:Remove\s*\(\s*\)/g, description: "Instance:Remove (deprecated but still works)", severity: "medium" },

  // HTTP calls to external endpoints
  { regex: /:PostAsync\s*\(/g, description: "HttpService:PostAsync (sends data to external endpoint)", severity: "medium" },
  { regex: /:PatchAsync\s*\(/g, description: "HttpService:PatchAsync (mutates external resource)", severity: "medium" },
  { regex: /:DeleteAsync\s*\(/g, description: "HttpService:DeleteAsync (deletes external resource)", severity: "high" },

  // Loop patterns that could lock server
  { regex: /while\s+true\s+do/g, description: "while true do (potential infinite loop)", severity: "low" },
  { regex: /while\s+not\s+\w+\s+do/g, description: "while not X do (busy-wait risk)", severity: "low" },

  // Bulk operations
  { regex: /GetPlayers\s*\(\s*\).*for/g, description: "Iterating all players + mutation (bulk effect)", severity: "low" },
  { regex: /:GetChildren\s*\(\s*\).*for/g, description: "Iterating children + mutation (bulk effect)", severity: "low" },
];

// --- Heuristic scan ---------------------------------------------------------

export interface HeuristicResult {
  matched: DangerPattern[];
  hasHighSeverity: boolean;
}

/**
 * Quick regex scan for dangerous patterns in proposed code.
 * Returns list of matched patterns and whether any are high-severity.
 *
 * NOTE: This uses ONLY the built-in DANGEROUS_PATTERNS. For mode-aware
 * scanning (which merges built-in + custom mode patterns), use
 * scanDangerousPatternsAsync() instead.
 */
export function scanDangerousPatterns(code: string): HeuristicResult {
  const matched: DangerPattern[] = [];
  for (const pattern of DANGEROUS_PATTERNS) {
    // Reset regex state (since we use /g flag)
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(code)) {
      matched.push(pattern);
    }
  }
  return {
    matched,
    hasHighSeverity: matched.some((p) => p.severity === "high"),
  };
}

/**
 * Async version that merges built-in patterns with any custom patterns
 * defined in the active mode's `safetyPatterns` field.
 *
 * This is the version used by reviewCodeSafety() (the main entry point).
 * Mode authors can add language-specific dangerous patterns without
 * modifying source code.
 */
export async function scanDangerousPatternsAsync(code: string): Promise<HeuristicResult> {
  // Get merged patterns (built-in + mode-specific)
  const { getActiveSafetyPatterns } = await import("./modeExtensions.js");
  const allPatterns = await getActiveSafetyPatterns();

  const matched: DangerPattern[] = [];
  for (const pattern of allPatterns) {
    // Reset regex state (since we use /g flag)
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(code)) {
      matched.push({
        regex: pattern.regex,
        description: pattern.description,
        severity: pattern.severity,
      });
    }
  }
  return {
    matched,
    hasHighSeverity: matched.some((p) => p.severity === "high"),
  };
}

// --- LLM review -------------------------------------------------------------

/**
 * Build the prompt for the safety reviewer LLM call.
 *
 * The prompt is intentionally focused on ONE question: "Can this code affect
 * the database or delete player data?" This narrow focus gets better answers
 * than a generic "is this code safe?" prompt.
 */
function buildReviewPrompt(
  code: string,
  filePath: string,
  matchedPatterns: DangerPattern[]
): Array<{ role: "system" | "user"; content: string }> {
  const patternsList = matchedPatterns.length > 0
    ? matchedPatterns.map((p) => `- ${p.description} (severity: ${p.severity})`).join("\n")
    : "(no specific patterns - general review)";

  return [
    {
      role: "system",
      content: `You are a safety reviewer for Roblox Luau code. Your ONLY job is to answer ONE question:

"Can this code affect the game's database (DataStore) or delete/lose player data?"

Respond in JSON format ONLY:
{
  "risk": "none" | "low" | "high",
  "reasoning": "<1-3 sentences explaining your assessment>"
}

Risk levels:
- "none": Code does not touch persistent data, no risk to player data
- "low":  Code touches data but in a safe way (read-only, additive, properly locked)
- "high": Code can DELETE, OVERWRITE, or CORRUPT player data, OR has obvious bugs
         that would cause data loss (race conditions, nil propagation, missing release)

Be CONSERVATIVE: if uncertain, lean toward "high" and explain in reasoning.

DO NOT comment on code style, performance, or anything except the data safety question.`,
    },
    {
      role: "user",
      content: `File: ${filePath}

Detected potentially dangerous patterns:
${patternsList}

Code to review:
\`\`\`luau
${code.slice(0, 8000)}  ${code.length > 8000 ? "...(truncated)" : ""}
\`\`\`

Question: Can this code affect the database or delete/lose player data?`,
    },
  ];
}

/**
 * Parse the LLM's response. Tries to extract JSON, falls back to text parsing.
 */
function parseLlmResponse(content: string): { risk: SafetyRisk; reasoning: string } {
  // Try JSON parse first
  try {
    // Find first { and last }
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const jsonStr = content.slice(start, end + 1);
      const obj = JSON.parse(jsonStr);
      const risk = obj.risk?.toLowerCase();
      if (risk === "none" || risk === "low" || risk === "high") {
        return {
          risk,
          reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
        };
      }
    }
  } catch {
    // JSON parse failed, fall through
  }

  // Fallback: keyword matching
  const lower = content.toLowerCase();
  if (lower.includes('"high"') || lower.includes("risk: high") || lower.includes("risk=high")) {
    return { risk: "high", reasoning: content.slice(0, 500) };
  }
  if (lower.includes('"low"') || lower.includes("risk: low") || lower.includes("risk=low")) {
    return { risk: "low", reasoning: content.slice(0, 500) };
  }
  return { risk: "none", reasoning: content.slice(0, 500) };
}

/**
 * Call the LLM to review code for data safety.
 *
 * Uses the same chat() function as the main agent (so it respects the API
 * key pool, retries, etc).
 */
async function callLlmReviewer(
  code: string,
  filePath: string,
  matchedPatterns: DangerPattern[]
): Promise<{ risk: SafetyRisk; reasoning: string }> {
  const messages = buildReviewPrompt(code, filePath, matchedPatterns);

  try {
    const response = await chat(messages);

    const content = response.choices?.[0]?.message?.content ?? "";
    return parseLlmResponse(content);
  } catch (err) {
    log.warn(`safetyReviewer: LLM call failed: ${(err as Error).message}`);
    // On LLM failure, return "low" risk (don't block) but flag the failure
    return {
      risk: "low",
      reasoning: `[REVIEWER LLM UNAVAILABLE - skipping review: ${(err as Error).message}]`,
    };
  }
}

// --- Main reviewer ----------------------------------------------------------

/**
 * Review proposed code for data safety.
 *
 * Flow:
 *   1. Heuristic scan (regex patterns)
 *   2. If no dangerous patterns found -> return risk=none (no LLM call)
 *   3. If patterns found -> call LLM with focused safety question
 *   4. Return LLM's verdict
 *
 * @param code - Proposed code content (will be written to disk)
 * @param filePath - Target file path (for context)
 * @returns SafetyReviewResult with risk level + reasoning
 */
export async function reviewCodeSafety(
  code: string,
  filePath: string
): Promise<SafetyReviewResult> {
  const start = Date.now();

  // 1. Heuristic scan (async - merges built-in + mode-specific patterns)
  const heuristic = await scanDangerousPatternsAsync(code);

  // 2. If no dangerous patterns, skip LLM (saves time + tokens)
  if (heuristic.matched.length === 0) {
    return {
      risk: "none",
      reasoning: "No dangerous patterns detected in static scan.",
      patternsMatched: [],
      reviewedByLlm: false,
      durationMs: Date.now() - start,
    };
  }

  // 3. Call LLM with the specific safety question
  const llmResult = await callLlmReviewer(code, filePath, heuristic.matched);

  return {
    risk: llmResult.risk,
    reasoning: llmResult.reasoning,
    patternsMatched: heuristic.matched.map((p) => p.description),
    reviewedByLlm: true,
    durationMs: Date.now() - start,
  };
}

// --- Formatter --------------------------------------------------------------

/**
 * Format a SafetyReviewResult as a readable message for the AI agent.
 *
 * If risk=high, the message is framed as a BLOCKING error.
 * If risk=low/none, it's an informational note.
 */
export function formatSafetyReview(result: SafetyReviewResult): string {
  const lines: string[] = [];

  if (result.risk === "high") {
    lines.push("[SECURITY BLOCK] Reviewer detected HIGH risk to data:");
    lines.push("");
    lines.push(`Risk: HIGH`);
    lines.push(`Reasoning: ${result.reasoning}`);
    if (result.patternsMatched.length > 0) {
      lines.push("");
      lines.push("Patterns detected:");
      for (const p of result.patternsMatched) {
        lines.push(`  - ${p}`);
      }
    }
    lines.push("");
    lines.push("[!] DO NOT write this code without:");
    lines.push("  1. Explicitly confirming with the user that they want this operation");
    lines.push("  2. Adding guardrails (e.g. if not IS_TEST_SERVER then return end)");
    lines.push("  3. Implementing backup/rollback before the destructive operation");
    lines.push("  4. For DataStore: use :UpdateAsync instead of :SetAsync (merge instead of overwrite)");
    lines.push("");
    lines.push("Review the code and try again. If you are CERTAIN the user asked for this,");
    lines.push("explain the risk in your response and ask for confirmation before proceeding.");
  } else if (result.risk === "low") {
    lines.push("[SECURITY WARNING] Reviewer detected LOW risk:");
    lines.push(`Reasoning: ${result.reasoning}`);
    if (result.patternsMatched.length > 0) {
      lines.push("Patterns detected (handle with care):");
      for (const p of result.patternsMatched) {
        lines.push(`  - ${p}`);
      }
    }
  } else {
    // risk = none, but LLM was called (patterns matched but LLM said safe)
    if (result.reviewedByLlm) {
      lines.push("[SECURITY OK] Reviewer analyzed and confirmed: no data risk.");
      lines.push(`Reasoning: ${result.reasoning}`);
    }
    // If risk=none and not reviewed by LLM, return empty (no message needed)
  }

  return lines.join("\n");
}

/**
 * Quick check: should this file even be reviewed?
 * Only .luau and .lua files need safety review.
 */
export function shouldReviewFile(filePath: string): boolean {
  const ext = filePath.slice(-5).toLowerCase();
  return ext === ".luau" || filePath.toLowerCase().endsWith(".lua");
}

/**
 * Get the list of dangerous patterns (for testing/debugging).
 */
export function getDangerousPatterns(): DangerPattern[] {
  return [...DANGEROUS_PATTERNS];
}
