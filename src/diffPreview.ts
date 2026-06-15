/**
 * diffPreview.ts — Render a unified diff between two strings and optionally
 * prompt the user for approval before writing to disk.
 *
 * Two modes:
 *   - computeUnifiedDiff(before, after) → returns the "@@ ... @@" lines you
 *     would feed to `diff -u`, used by the /preview command and by the
 *     guardrail logger.
 *   - previewAndApprove(filePath, currentContent, newContent): when
 *     config.diffPreview is true, prints the diff to stderr with ANSI colors
 *     and uses readline to ask the user to confirm before applying. When the
 *     flag is false (the default in non-TTY contexts and CI), it auto-approves
 *     and returns true.
 *
 * Color codes follow the LookHere-Diff convention:
 *   - red  for removed lines (prefixed with "-")
 *   - green for added lines   (prefixed with "+")
 *   - grey for context lines  (prefixed with " ")
 */

import readline from "node:readline";
import * as path from "node:path";
import { config } from "./config.js";
import * as log from "./logger.js";

// ─── Minimal LCS-based unified diff ─────────────────────────────────────────

function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  // Strip trailing newline so the final empty string doesn't appear.
  const stripped = s.endsWith("\n") ? s.slice(0, -1) : s;
  return stripped.split("\n");
}

/**
 * Compute a longest-common-subsequence table and emit a unified diff between
 * `before` and `after`. Hunks are returned as plain text (no color), ready
 * to be fed through `renderColoredDiff()` for terminal output.
 *
 * The algorithm is O(n*m) in characters; for files > several thousand lines
 * we cap to the first MAX_DIFF_LINES_PER_HUNK lines to keep the preview snappy.
 */
const CONTEXT_LINES = 3;
const MAX_DIFF_LINES_PER_HUNK = 200;

function buildLcsTable(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function buildEditScript(a: string[], b: string[], dp: number[][]): Array<{ type: "del" | "add" | "eq"; line: string }> {
  const ops: Array<{ type: "del" | "add" | "eq"; line: string }> = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ type: "eq", line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "del", line: a[i] }); i++; }
    else { ops.push({ type: "add", line: b[j] }); j++; }
  }
  while (i < a.length) { ops.push({ type: "del", line: a[i] }); i++; }
  while (j < b.length) { ops.push({ type: "add", line: b[j] }); j++; }
  return ops;
}

function expandHunk(
  ops: Array<{ type: string; line: string }>,
  k: number
): { hunkEnd: number; changedInHunk: number } {
  let hunkEnd = k;
  let changedInHunk = 0;
  let contextTrailing = 0;
  while (hunkEnd < ops.length) {
    const op = ops[hunkEnd];
    if (op.type === "eq") {
      if (changedInHunk === 0) { hunkEnd++; continue; }
      contextTrailing++;
      if (contextTrailing > CONTEXT_LINES) { hunkEnd++; break; }
    } else {
      changedInHunk++;
      contextTrailing = 0;
      if (changedInHunk > MAX_DIFF_LINES_PER_HUNK) { hunkEnd++; break; }
    }
    hunkEnd++;
  }
  return { hunkEnd, changedInHunk };
}

function computeHunkCounts(
  ops: Array<{ type: string; line: string }>,
  hunkStart: number,
  hunkEnd: number
): { aStart: number; oldCount: number; bStart: number; newCount: number } {
  return {
    aStart: ops.slice(0, hunkStart).filter(o => o.type !== "add").length,
    oldCount: ops.slice(hunkStart, hunkEnd).filter(o => o.type !== "add").length,
    bStart: ops.slice(0, hunkStart).filter(o => o.type !== "del").length,
    newCount: ops.slice(hunkStart, hunkEnd).filter(o => o.type !== "del").length,
  };
}

function renderHunkLines(
  ops: Array<{ type: string; line: string }>,
  hunkStart: number,
  hunkEnd: number
): string[] {
  const lines: string[] = [];
  const prefixMap: Record<string, string> = { eq: " ", add: "+", del: "-" };
  for (let p = hunkStart; p < hunkEnd; p++) {
    const op = ops[p];
    const prefix = prefixMap[op.type] ?? "-";
    lines.push(prefix + op.line);
  }
  return lines;
}

export function computeUnifiedDiff(before: string, after: string, filePath: string): string {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0 && b.length === 0) return "";

  const dp = buildLcsTable(a, b);
  const ops = buildEditScript(a, b, dp);

  const out: string[] = [];
  out.push(`--- a/${filePath}`, `+++ b/${filePath}`);

  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].type === "eq") k++;
    if (k >= ops.length) break;

    const hunkStart = Math.max(0, k - CONTEXT_LINES);
    const { hunkEnd, changedInHunk } = expandHunk(ops, k);
    const { aStart, oldCount, bStart, newCount } = computeHunkCounts(ops, hunkStart, hunkEnd);

    out.push(
      `@@ -${aStart + 1},${oldCount} +${bStart + 1},${newCount} @@`,
      ...renderHunkLines(ops, hunkStart, hunkEnd)
    );

    k = hunkEnd;
    if (changedInHunk === 0) break;
    if (out.length > MAX_DIFF_LINES_PER_HUNK * 4) {
      out.push("@@ (diff truncated for preview — file too large) @@");
      break;
    }
  }

  if (out.length === 2) return "";
  return out.join("\n");
}

// ─── Coloured renderer ────────────────────────────────────────────────────────

function colour(s: string, hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

export function renderColoredDiff(unified: string): string {
  const out: string[] = [];
  for (const line of unified.split("\n")) {
    if (line.startsWith("+++")) out.push(colour(line, "#A78BFA"));       // violet — new file
    else if (line.startsWith("---")) out.push(colour(line, "#F87171"));  // red    — old file
    else if (line.startsWith("@@")) out.push(colour(line, "#6EE7F7"));   // cyan   — hunk header
    else if (line.startsWith("+")) out.push(colour(line, "#34D399"));    // green  — addition
    else if (line.startsWith("-")) out.push(colour(line, "#F87171"));    // red    — removal
    else out.push(colour(line, "#6B7280"));                              // grey   — context
  }
  return out.join("\n");
}

// ─── Approval prompt ─────────────────────────────────────────────────────────

/**
 * If config.diffPreview is true, print the colored unified diff to stderr and
 * prompt the user to confirm before writing the file. Returns true to allow
 * the write, false to abort.
 *
 * Behavior:
 *   - non-TTY (CI, piped input)  → auto-approves (returns true)
 *   - empty input (Enter)        → approves
 *   - 'y' / 'yes'                → approves
 *   - 'n' / 'no' / anything else → rejects (returns false)
 *
 * The prompt is a single-line readline that does NOT pause the rest of the
 * agent loop — tools.ts is called synchronously, but readline.question is
 * async; await on its promise is enough.
 */
export async function previewAndApprove(
  filePath: string,
  currentContent: string,
  newContent: string
): Promise<boolean> {
  if (!config.diffPreview) return true;

  const unified = computeUnifiedDiff(currentContent, newContent, path.relative(process.cwd(), filePath) || filePath);
  if (unified === "") {
    // No real change — silently approve.
    return true;
  }

  const rel = path.relative(process.cwd(), filePath) || filePath;
  process.stderr.write("\n" + colour(`─── Diff preview: ${rel} ───`, "#6EE7F7") + "\n");
  process.stderr.write(renderColoredDiff(unified) + "\n");
  process.stderr.write(colour(`(end of diff — ${unified.split("\n").length} lines)\n`, "#6B7280"));

  // Stats summary
  const adds = unified.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
  const dels = unified.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length;
  process.stderr.write(colour(`+${adds} -${dels}\n`, "#6B7280"));

  // If stdin is not interactive, auto-approve (CI / scripted use).
  if (!process.stdin.isTTY) {
    process.stderr.write(colour("[non-TTY] auto-approving diff.\n", "#FBBF24"));
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(colour("Apply this diff? [Y/n] ", "#FBBF24"), (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      const allow = trimmed === "" || trimmed === "y" || trimmed === "yes";
      if (!allow) {
        log.warn(`Diff rejected for ${rel}.`);
      }
      resolve(allow);
    });
  });
}