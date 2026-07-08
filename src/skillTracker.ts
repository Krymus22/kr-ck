/**
 * skillTracker.ts — Track skills invoked this session for re-injection.
 *
 * Gap 9 fix: After context compaction, skills that were invoked during
 * the session are lost. This module tracks which skills were read by the
 * IA and provides a function to build a re-injection message with their
 * current content.
 *
 * Inspired by Claude Code, which re-injects invoked skill bodies after
 * compaction (capped at 5K tokens/skill, 25K total).
 *
 * Usage:
 *   - recordSkillInvocation(skillPath) — called when IA reads a skill file
 *   - buildSkillReInjectionMessage() — called after compaction
 *   - clearInvokedSkills() — called on /reset, /session load/new
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum tokens per skill (5K = ~20K chars at 4 chars/token). */
const MAX_TOKENS_PER_SKILL = 5000;

/** Maximum total tokens for all re-injected skills (25K = ~100K chars). */
const MAX_TOTAL_TOKENS = 25000;

/** Skills invoked this session (file paths), most-recent-first. */
let invokedSkills: string[] = [];

/**
 * Record that a skill was invoked (read) this session.
 * Called from agent.ts when ler_arquivo reads a file that matches a skill path.
 */
export function recordSkillInvocation(skillPath: string): void {
  const resolved = path.resolve(skillPath);
  // Deduplicate — move to front if already exists
  invokedSkills = invokedSkills.filter((s) => s !== resolved);
  invokedSkills.unshift(resolved);
  // Cap at 10 entries
  if (invokedSkills.length > 10) {
    invokedSkills = invokedSkills.slice(0, 10);
  }
}

/**
 * Build a system message containing the content of skills invoked this session.
 * Called after compaction.
 *
 * Returns null if:
 *   - No skills were invoked
 *   - All skill files are unreadable
 *   - Total content would exceed budget
 */
export function buildSkillReInjectionMessage(): string | null {
  if (invokedSkills.length === 0) return null;

  const skills: { path: string; content: string; tokens: number }[] = [];
  let totalTokens = 0;

  for (const skillPath of invokedSkills) {
    if (totalTokens >= MAX_TOTAL_TOKENS) break;

    try {
      if (!fs.existsSync(skillPath)) continue;
      const stat = fs.statSync(skillPath);
      if (stat.isDirectory()) continue;

      const content = fs.readFileSync(skillPath, "utf8");
      if (content.includes("\0")) continue;

      const tokens = Math.ceil(content.length / 4);
      const maxChars = MAX_TOKENS_PER_SKILL * 4;
      const truncated = content.length > maxChars
        ? content.slice(0, maxChars) + "\n...[TRUNCATED — re-read with ler_arquivo for full content]..."
        : content;

      skills.push({ path: skillPath, content: truncated, tokens: Math.min(tokens, MAX_TOKENS_PER_SKILL) });
      totalTokens += Math.min(tokens, MAX_TOKENS_PER_SKILL);
    } catch {
      continue;
    }
  }

  if (skills.length === 0) return null;

  const parts: string[] = [
    "## Invoked Skills (re-injected after compaction)",
    "",
    "These skills were invoked earlier this session. Their content is re-injected here so you can continue using them without re-reading.",
    "",
  ];

  for (const s of skills) {
    parts.push(`--- ${s.path} (~${s.tokens} tokens) ---`);
    parts.push(s.content);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Get the list of invoked skills (for testing/debugging).
 */
export function getInvokedSkills(): string[] {
  return [...invokedSkills];
}

/**
 * Clear the invoked skills list. Called on:
 *   - /reset
 *   - /session new
 *   - /session load
 *   - Auto-load on startup
 */
export function clearInvokedSkills(): void {
  invokedSkills = [];
}
