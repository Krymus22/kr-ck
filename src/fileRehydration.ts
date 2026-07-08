/**
 * fileRehydration.ts — Re-read recently modified files after compaction.
 *
 * Gap 1 fix: After context compaction, the IA loses access to file contents
 * it had read earlier. This module tracks files modified during the session
 * and re-injects their CURRENT content as a system message after compaction.
 *
 * Inspired by Claude Code, which re-reads up to 5 most-recently-edited files
 * (50K token budget, 5K/file) after compaction.
 *
 * Why this matters: Without re-hydration, the IA "forgets" where it is in
 * the code. It may try to edit a file without reading it (blocked by
 * read-before-write), or hallucinate file contents.
 *
 * Usage:
 *   - recordSessionFileEdit(path) — called when IA edits a file
 *   - buildRehydrationMessage() — called after compaction, returns system
 *     message with current file contents (or null if nothing to rehydrate)
 *   - clearSessionFiles() — called on /reset, /session load/new
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum number of files to re-hydrate after compaction. */
const MAX_REHYDRATED_FILES = 5;

/** Maximum tokens per file (5K = ~20K chars at 4 chars/token). */
const MAX_TOKENS_PER_FILE = 5000;

/** Maximum total tokens for all re-hydrated files (50K = ~200K chars). */
const MAX_TOTAL_TOKENS = 50000;

/** Files modified this session, in order of most-recent-first. */
let sessionEditedFiles: string[] = [];

/**
 * Record that a file was edited (or read for editing) this session.
 * Called from agent.ts trackFileAccess() when WRITE_FILE_TOOLS are used.
 * Deduplicates — if the file was already recorded, moves it to front
 * (most recent).
 */
export function recordSessionFileEdit(filePath: string): void {
  const resolved = path.resolve(filePath);
  // Remove if already in list (avoid duplicates)
  sessionEditedFiles = sessionEditedFiles.filter((f) => f !== resolved);
  // Add to front (most recent)
  sessionEditedFiles.unshift(resolved);
  // Cap at 20 entries (we only re-hydrate top 5, but keep more history
  // in case some files are deleted or unreadable)
  if (sessionEditedFiles.length > 20) {
    sessionEditedFiles = sessionEditedFiles.slice(0, 20);
  }
}

/**
 * Build a system message containing the CURRENT content of the most
 * recently edited files. Called after compaction.
 *
 * Returns null if:
 *   - No files were edited this session
 *   - All files are unreadable/deleted
 *   - Total content would exceed budget
 *
 * The message format:
 *   ## Recently Modified Files (re-hydrated after compaction)
 *   --- /path/to/file1.ts (1234 tokens) ---
 *   <file content, possibly truncated>
 *   --- /path/to/file2.lua (5678 tokens) ---
 *   <file content, possibly truncated>
 *   ...
 */
export function buildRehydrationMessage(): string | null {
  if (sessionEditedFiles.length === 0) return null;

  const files: { path: string; content: string; tokens: number }[] = [];
  let totalTokens = 0;

  for (const filePath of sessionEditedFiles) {
    if (files.length >= MAX_REHYDRATED_FILES) break;
    if (totalTokens >= MAX_TOTAL_TOKENS) break;

    try {
      // Skip if file doesn't exist (may have been deleted)
      if (!fs.existsSync(filePath)) continue;

      // Skip directories
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) continue;

      // Bug fix (Bug Hunter #2b): for HUGE files (e.g. minified bundles,
      // generated files, large data dumps) the previous code loaded the
      // ENTIRE file into memory via fs.readFileSync, then truncated. That
      // caused OOM kills when a session-edited file was 100MB+.
      //
      // Now we cap the read at a byte budget via readBoundedContent() — for
      // files larger than the budget, we read only the first chunk using a
      // Buffer + fs.readSync (random-access, no full load). This preserves
      // the [TRUNCATED] contract from §6.3 while bounding memory usage.
      const maxChars = MAX_TOKENS_PER_FILE * 4; // 20K chars
      const { content, truncated: wasCapped } = readBoundedContent(filePath, stat.size, maxChars);
      if (content === null) continue; // binary file

      // Two layers of truncation:
      //   1. readBoundedContent may have capped the READ at byteBudget (huge file)
      //   2. Even after a full read, content may exceed the per-file char budget
      // Either way, we mark with [TRUNCATED] per §6.3.
      const isTruncated = wasCapped || content.length > maxChars;
      const truncated = isTruncated
        ? content.slice(0, maxChars) + "\n...[TRUNCATED — file is larger, re-read with ler_arquivo if needed]..."
        : content;

      // Estimate tokens (4 chars/token); cap at per-file budget
      const tokens = Math.min(Math.ceil(truncated.length / 4), MAX_TOKENS_PER_FILE);
      files.push({ path: filePath, content: truncated, tokens });
      totalTokens += tokens;
    } catch {
      // Skip unreadable files
      continue;
    }
  }

  if (files.length === 0) return null;

  const parts: string[] = [
    "## Recently Modified Files (re-hydrated after compaction)",
    "",
    "These are the CURRENT contents of files you edited this session. Use them to continue working — you don't need to re-read these files.",
    "",
  ];

  for (const f of files) {
    parts.push(`--- ${f.path} (~${f.tokens} tokens) ---`);
    parts.push(f.content);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Read up to `maxChars` UTF-8 characters from `filePath`, without loading
 * huge files into memory in full.
 *
 * Strategy:
 *   - If `fileSize` is small enough (≤ maxChars * 4 bytes, the worst-case
 *     UTF-8 encoding), use fs.readFileSync (simple + fast).
 *   - Otherwise, use fs.openSync + fs.readSync with a Buffer cap to avoid OOM.
 *
 * Returns an object:
 *   - `content`: the (possibly partial) string content, or `null` if the
 *     file is binary (contains a NUL byte in the inspected region).
 *   - `truncated`: true if the file was larger than the read budget and we
 *     only read the first chunk.
 *
 * The returned `content` may be longer than `maxChars` by a few bytes (UTF-8
 * decoding can stretch the buffer); the caller is responsible for the final
 * `.slice(0, maxChars)` truncation.
 */
function readBoundedContent(
  filePath: string,
  fileSize: number,
  maxChars: number,
): { content: string | null; truncated: boolean } {
  // Worst case: 4 bytes per char.
  const byteBudget = maxChars * 4;
  if (fileSize <= byteBudget) {
    const content = fs.readFileSync(filePath, "utf8");
    if (content.includes("\0")) return { content: null, truncated: false };
    return { content, truncated: false };
  }
  // Large file — read only the first byteBudget bytes.
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(byteBudget);
    const bytesRead = fs.readSync(fd, buf, 0, byteBudget, 0);
    const content = buf.slice(0, bytesRead).toString("utf8");
    // Binary check on the chunk we actually read
    if (content.includes("\0")) return { content: null, truncated: false };
    return { content, truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Get the list of session-edited files (for testing/debugging).
 */
export function getSessionEditedFiles(): string[] {
  return [...sessionEditedFiles];
}

/**
 * Clear the session file list. Called on:
 *   - /reset
 *   - /session new
 *   - /session load
 *   - Auto-load on startup
 *
 * (Same places clearReadPaths() is called — BS-18 fix pattern.)
 */
export function clearSessionFiles(): void {
  sessionEditedFiles = [];
}
