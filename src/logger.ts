/**
 * logger.ts - Minimal, styled terminal output using chalk.
 * All user-visible output goes through here so we can easily control
 * verbosity, colour, and format from a single location.
 *
 * TUI MODE: when setTuiMode(true) is called, console.log output is
 * suppressed because the Ink TUI renderer controls the entire screen.
 * Any console.log would appear ABOVE the TUI layout, breaking it.
 * Tool call/result notifications are routed through the onToolCall/
 * onToolResult callbacks in agent.ts instead, which add proper "tool"
 * messages to the chat in chronological order.
 */

import chalk from "chalk";
import { config } from "./config.js";

// --- Colour Palette ----------------------------------------------------------

const c = {
  primary:   chalk.hex("#6EE7F7"),   // cyan-ish - Claude-Killer brand
  secondary: chalk.hex("#A78BFA"),   // violet   - assistant messages
  success:   chalk.hex("#34D399"),   // green    - OK / saved
  warning:   chalk.hex("#FBBF24"),   // amber    - warnings / retries
  error:     chalk.hex("#F87171"),   // red      - errors / failures
  muted:     chalk.hex("#6B7280"),   // grey     - internal logs
  bold:      chalk.bold,
};

// --- TUI mode flag ----------------------------------------------------------

/**
 * When true, console.log output is suppressed (TUI mode is active).
 * Set by src/index.ts when the Ink app starts.
 *
 * In TUI mode, tool call/result notifications go through the agent's
 * onToolCall/onToolResult callbacks instead of console.log.
 */
let tuiMode = false;

/**
 * Enable or disable TUI mode.
 * When enabled, toolCall() and toolResult() become no-ops (the TUI
 * renders tool messages via the agent callbacks instead).
 */
export function setTuiMode(enabled: boolean): void {
  tuiMode = enabled;
}

/** Returns true if TUI mode is active (console.log output suppressed). */
export function isTuiMode(): boolean {
  return tuiMode;
}

/**
 * Reset TUI mode flag (for tests).
 *
 * BUG FIX (Bug Hunter #8c): the `tuiMode` flag is module-level state with no
 * reset function. If a test set `setTuiMode(true)` and forgot to reset (or
 * threw before its afterEach), subsequent tests in the same Vitest worker
 * would run with TUI mode ON — silently suppressing `reply`/`toolCall`/
 * `toolResult` output and breaking test assertions that expect console.log
 * to be called. This leaked state between test files.
 *
 * Exposing `_resetTuiModeForTests()` gives tests a deterministic reset.
 */
export function _resetTuiModeForTests(): void {
  tuiMode = false;
}

// --- Public API -------------------------------------------------------------

/** Print a banner line (Claude-Killer brand) */
export function banner(text: string): void {
  // TUI mode: suppress. Any console.log writes BETWEEN Ink renders, causing
  // the terminal to scroll and stealing the user's scroll position during
  // streaming (Bug 2 root cause). The Ink TUI uses process.stdout.write for
  // its own banner (see index.ts) — logger.banner is for non-TUI mode only.
  if (tuiMode) return;
  console.log(c.primary.bold(text));
}

/** Print a normal informational message (no prefix). */
export function info(text: string): void {
  // TUI mode: suppress. log.info is called from agent.ts (CHECKPOINT,
  // COMPACTION, BUG_HUNTER) DURING the agent loop, which runs concurrently
  // with Ink streaming. Each console.log writes BETWEEN Ink renders and
  // causes the terminal to scroll, stealing the user's scroll position.
  // (Bug 2 — root cause of scroll stealing during streaming.)
  if (tuiMode) return;
  console.log(chalk.white(text));
}

/** Print a success message with a check prefix. */
export function success(text: string): void {
  // TUI mode: suppress (same reason as info() — see above).
  if (tuiMode) return;
  console.log(c.success(`[SUCCESS] ${text}`));
}

/** Print a warning with a warning prefix. */
export function warn(text: string): void {
  // TUI mode: suppress. console.warn writes to stderr, which most terminals
  // display inline with stdout — same scroll-stealing effect as console.log.
  // In TUI mode, warnings surface via the activityTracker (ThinkingIndicator
  // shows "Salvando checkpoint…" / "Compactando contexto…") or via the chat
  // (setMessages with isError=true).
  if (tuiMode) return;
  console.warn(c.warning(`[WARN] ${text}`));
}

/** Print an error with a cross prefix. */
export function error(text: string): void {
  // TUI mode: suppress (same reason as warn() — see above). In TUI mode,
  // errors are surfaced via the chat (setMessages with isError=true).
  if (tuiMode) return;
  console.error(c.error(`[ERROR] ${text}`));
}

function getVisibleLength(text: string): number {
  let clean = text.replaceAll("**", "");
  clean = clean.replaceAll("`", "");
  return clean.length;
}

function isSeparatorRow(row: string[]): boolean {
  return row.length > 0 && row.every(cell => /^[:\-\s]+$/.exec(cell));
}

function renderFencedCode(lang: string, body: string): string {
  const lines = body.split("\n");
  const maxLen = Math.min(
    Math.max(...lines.map((l) => getVisibleLength(l)), 0),
    80
  );
  const width = Math.max(maxLen, 20);
  const bottom = "+" + "-".repeat(width + 2) + "+";
  const header = chalk.hex("#6B7280")(
    "-".repeat(3) + (lang ? ` ${lang} ` : "") + "-".repeat(Math.max(0, width + 2 - (lang ? lang.length + 3 : 3)))
  );

  const rendered = lines.map((line) => {
    const visible = getVisibleLength(line);
    const pad = Math.max(0, width - visible);
    return chalk.hex("#0EA5E9")("| ") + line + " ".repeat(pad) + chalk.hex("#0EA5E9")(" |");
  });

  return [header, ...rendered, bottom].join("\n");
}

// Wraps each non-empty line of a block in a coloured side bar.
function renderBlock(body: string, barColor: string): string {
  return body
    .split("\n")
    .map((l) => (l.length > 0 ? chalk.hex(barColor)("| ") + l : ""))
    .join("\n");
}

function parseTableRows(tableLines: string[]): string[][] {
  return tableLines.map(line => {
    const parts = line.split("|").map(p => p.trim());
    if (line.trim().startsWith("|")) parts.shift();
    if (line.trim().endsWith("|")) parts.pop();
    return parts;
  });
}

function separateHeaderAndData(parsedRows: string[][]): { headerRow: string[]; dataRows: string[][] } {
  const headerRow: string[] = [];
  const dataRows: string[][] = [];
  for (const row of parsedRows) {
    if (isSeparatorRow(row)) continue;
    if (headerRow.length === 0) headerRow.push(...row);
    else dataRows.push(row);
  }
  return { headerRow, dataRows };
}

function padCell(text: string, width: number): string {
  const visibleLen = getVisibleLength(text);
  const spaceCount = width - visibleLen;
  const leftPad = 1;
  const rightPad = Math.max(0, spaceCount - 1);
  return " ".repeat(leftPad) + text + " ".repeat(rightPad);
}

function buildTableBorder(colWidths: number[], char: string, joiner: string): string {
  return char + colWidths.map(w => "-".repeat(w + 2)).join(joiner) + char;
}

function renderStyledTable(tableLines: string[]): string {
  const parsedRows = parseTableRows(tableLines);
  const colCount = Math.max(...parsedRows.map(row => row.length));
  const { headerRow, dataRows } = separateHeaderAndData(parsedRows);

  while (headerRow.length < colCount) headerRow.push("");
  for (const row of dataRows) {
    while (row.length < colCount) row.push("");
  }

  const colWidths = new Array(colCount).fill(0);
  for (let c = 0; c < colCount; c++) {
    let maxLen = getVisibleLength(headerRow[c] ?? "");
    for (const row of dataRows) {
      const cellLen = getVisibleLength(row[c] ?? "");
      if (cellLen > maxLen) maxLen = cellLen;
    }
    colWidths[c] = maxLen;
  }

  const grey = chalk.hex("#6B7280");
  const topBorder = buildTableBorder(colWidths, "+", "-");
  const midBorder = buildTableBorder(colWidths, "+", "+");
  const bottomBorder = buildTableBorder(colWidths, "+", "-");

  const renderedHeader = "|" + headerRow.map((cell, idx) => {
    return chalk.hex("#6EE7F7").bold(padCell(cell, colWidths[idx] + 2));
  }).join("|") + "|";

  const renderedData = dataRows.map(row => {
    return "|" + row.map((cell, idx) => padCell(cell, colWidths[idx] + 2)).join("|") + "|";
  });

  const result: string[] = [grey(topBorder), renderedHeader, grey(midBorder), ...renderedData, grey(bottomBorder)];

  return result.join("\n");
}

function parseFencedCode(lines: string[], startIdx: number): { lang: string; body: string; nextIdx: number } {
  const line = lines[startIdx];
  const fenceMatch = /^(\s*)```(\w*)\s*$/.exec(line)!;
  const lang = (fenceMatch[2] || "").trim();
  const body: string[] = [];
  let i = startIdx + 1;
  while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  return { lang, body: body.join("\n"), nextIdx: i + 1 };
}

function parseTableBlock(lines: string[], startIdx: number): { tableLines: string[]; nextIdx: number } {
  const tableLines: string[] = [];
  let i = startIdx;
  while (i < lines.length && (lines[i].match(/\|/g) ?? []).length >= 2 && !/^\s*```/.test(lines[i])) {
    tableLines.push(lines[i]);
    i++;
  }
  return { tableLines, nextIdx: i };
}

function renderHeading(line: string): string[] {
  const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)!;
  const level = headingMatch[1].length;
  const ht = headingMatch[2];
  const styles = ["#6EE7F7", "#A78BFA", "#34D399", "#FBBF24", "#F87171", "#6B7280"];
  const ch = styles[Math.min(level, 6) - 1];
  if (level <= 2) {
    return ["", chalk.hex(ch).bold(ht), chalk.hex(ch)("-".repeat(Math.min(ht.length + 4, 40))), ""];
  }
  return [chalk.hex(ch).bold(ht), ""];
}

function parseBlockquote(lines: string[], startIdx: number): { body: string; nextIdx: number } {
  const body: string[] = [];
  let i = startIdx;
  while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
    body.push(lines[i].replace(/^\s*>\s?/, ""));
    i++;
  }
  return { body: body.join("\n"), nextIdx: i };
}

function applyInlineFormatting(text: string): string {
  let output = text;
  output = output.replaceAll(/\*\*(.+?)\*\*/g, (_, c) => chalk.bold(c));
  output = output.replaceAll(/(?<!\*)\*(?!\s)([^*\n]+?)\*(?!\*)/g, (_, c) => chalk.italic(c));
  output = output.replaceAll(/`([^`\n]+)`/g, (_, c) => chalk.hex("#0EA5E9").bgHex("#1F2937")(` ${c} `));
  output = output.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) =>
    chalk.hex("#0EA5E9").underline(txt) + chalk.hex("#6B7280")(` (${url})`)
  );
  return output;
}

function processMarkdownLine(lines: string[], i: number, result: string[]): number {
  const line = lines[i];

  if (/^(\s*)```(\w*)\s*$/.test(line)) {
    const { lang, body, nextIdx } = parseFencedCode(lines, i);
    result.push(renderFencedCode(lang, body));
    return nextIdx;
  }

  if ((line.match(/\|/g) ?? []).length >= 2) {
    const { tableLines, nextIdx } = parseTableBlock(lines, i);
    result.push(renderStyledTable(tableLines));
    return nextIdx;
  }

  if (/^(#{1,6})\s+(.+?)\s*#*\s*$/.test(line)) {
    result.push(...renderHeading(line));
    return i + 1;
  }

  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    result.push(chalk.hex("#6B7280")("-".repeat(60)));
    return i + 1;
  }

  if (/^\s*>\s?/.test(line)) {
    const { body, nextIdx } = parseBlockquote(lines, i);
    result.push(renderBlock(body, "#A78BFA"));
    return nextIdx;
  }

  const taskMatch = /^(\s*)[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
  if (taskMatch) {
    const checked = taskMatch[2].toLowerCase() === "x";
    const icon = checked ? chalk.hex("#34D399")("[OK]") : chalk.hex("#6B7280")("[ ]");
    result.push(`${icon} ${taskMatch[3]}`);
    return i + 1;
  }

  const bulletMatch = /^(\s*)[-*]\s+(.+)$/.exec(line);
  if (bulletMatch) {
    const bullet = chalk.hex("#6EE7F7")("*");
    result.push(`${bulletMatch[1] ?? ""}${bullet} ${bulletMatch[2]}`);
    return i + 1;
  }

  const numMatch = /^(\s*)(\d+)\.\s+(.+)$/.exec(line);
  if (numMatch) {
    const numberedItem = `${numMatch[2]}.`;
    result.push(`${numMatch[1] ?? ""}${chalk.hex("#A78BFA")(numberedItem)} ${numMatch[3]}`);
    return i + 1;
  }

  result.push(line);
  return i + 1;
}

export function formatMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    i = processMarkdownLine(lines, i, result);
  }

  return applyInlineFormatting(result.join("\n"));
}

/** Print the model's final reply in a distinct style. */
export function reply(text: string): void {
  // In TUI mode, the reply is rendered by the ChatDisplay component via
  // the onToken/onStreamStart callbacks. console.log would appear ABOVE
  // the Ink layout and break the TUI.
  if (tuiMode) return;
  console.log("\n" + c.secondary.bold("Claude-Killer:") + "\n");
  console.log(formatMarkdown(text));
  console.log();
}

/** Print a tool-call notification. */
export function toolCall(toolName: string, args: Record<string, unknown>): void {
  // In TUI mode, tool calls are rendered as "tool" messages in the chat
  // via the agent's onToolCall callback. console.log would break the TUI.
  if (tuiMode) return;
  // BUG FIX (Bug Hunter #8c): previously the truncation check used
  // `preview.length >= 120`, but `preview` was already sliced to 120 chars.
  // When the JSON was EXACTLY 120 chars long, nothing was actually truncated,
  // yet "..." was appended — misleading the user into thinking args were cut.
  // Fix: compare against the ORIGINAL json length, not the sliced preview.
  const json = JSON.stringify(args);
  const preview = json.slice(0, 120);
  console.log(c.muted(`  [TOOL CALL] ${toolName}(${preview}${json.length > 120 ? "..." : ""})`));
}

/** Print a tool-call result summary. */
export function toolResult(toolName: string, ok: boolean, detail?: string): void {
  // In TUI mode, tool results are rendered as "tool" messages in the chat
  // via the agent's onToolResult callback. console.log would break the TUI.
  if (tuiMode) return;
  const icon = ok ? c.success("  [OK]") : c.error("  [FAIL]");
  const suffix = detail ? c.muted(` - ${detail}`) : "";
  console.log(`${icon}  ${toolName}${suffix}`);
}

/** Print a rate-limiter / concurrency throttle notice. */
export function throttle(reason: string): void {
  // TUI mode: suppress (same reason as info() — see above).
  if (tuiMode) return;
  console.log(c.muted(`  ... ${reason}`));
}

/** Debug output - only shown when DEBUG=true. */
export function debug(text: string): void {
  // TUI mode: suppress (same reason as info() — see above). Even debug
  // output writes BETWEEN Ink renders and causes scroll stealing.
  if (tuiMode) return;
  if (config.debug) {
    console.debug(c.muted(`[DBG] ${text}`));
  }
}

/** A styled horizontal divider. */
export function divider(): void {
  // TUI mode: suppress (same reason as info() — see above).
  if (tuiMode) return;
  console.log(c.muted("-".repeat(60)));
}

// --- Status Bar (context window usage) ------------------------------------

export interface StatusBarInput {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  warnThreshold: number;
  compactThreshold: number;
  costPerKPrompt: number;
  costPerKCompletion: number;
}

/**
 * Render a compact one-line status bar showing context usage.
 *
 * Format:
 *       27.4k / 128k . 21% . session $0.012
 *   +--------------------------------------+
 *   |########------------------------------|
 *   +--------------------------------------+
 *
 * Color of the bar shifts: green when < warnThreshold,
 * amber when between warn and compact, red when >= compact.
 */
export function statusBar(input: StatusBarInput): void {
  // TUI mode: suppress. In TUI mode the Ink StatusBar component renders the
  // context usage bar (see src/tui/StatusBar.tsx). This logger.statusBar
  // writes multiple lines to stdout BETWEEN Ink renders, causing scroll
  // stealing during streaming (Bug 2 root cause).
  if (tuiMode) return;
  const {
    promptTokens, completionTokens, totalTokens,
    contextWindow, warnThreshold, compactThreshold,
    costPerKPrompt, costPerKCompletion,
  } = input;

  const pct = contextWindow > 0 ? totalTokens / contextWindow : 0;
  // BUG FIX: clamp fillCount/emptyCount to [0,40] — when totalTokens exceeds
  // contextWindow (pct > 1) the unclamped emptyCount becomes negative and
  // String.prototype.repeat(-N) throws RangeError, crashing the status bar.
  const fillCount = Math.min(40, Math.max(0, Math.round(pct * 40)));
  const emptyCount = Math.max(0, 40 - fillCount);

  let color = "#34D399"; // green
  if (pct >= compactThreshold) color = "#F87171";      // red
  else if (pct >= warnThreshold) color = "#FBBF24";    // amber

  const bar = chalk.hex(color)("#".repeat(fillCount)) + chalk.hex("#374151")("-".repeat(emptyCount));

  // Estimate cost if rates configured (both must be > 0)
  let costStr = "";
  // BUG FIX: original used `||`, but the comment says "both must be > 0".
  // With `||`, if only one rate is set, cost is computed using 0 for the
  // other — yielding a misleadingly low estimate. Use `&&` to require both.
  if (costPerKPrompt > 0 && costPerKCompletion > 0) {
    const cost =
      (promptTokens / 1000) * costPerKPrompt +
      (completionTokens / 1000) * costPerKCompletion;
    if (cost > 0) {
      const costDisplay = `$${cost.toFixed(4)}`;
      costStr = ` . session ${chalk.hex("#FBBF24")(costDisplay)}`;
    }
  }

  const formatTok = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

  const tokDisplay = `${formatTok(totalTokens)} / ${formatTok(contextWindow)}`;
  const pctDisplay = `${Math.round(pct * 100)}%`;
  const ioDisplay = `in ${formatTok(promptTokens)} / out ${formatTok(completionTokens)}`;

  const line1 = `  ${chalk.hex("#6B7280")("ctx")} ` +
    `${chalk.white(tokDisplay)} . ` +
    `${chalk.hex(color).bold(pctDisplay)}` +
    ` . ${chalk.hex("#6B7280")(ioDisplay)}` +
    costStr;

  const line2 = `  +${"-".repeat(40)}+\n` +
    `  |${bar}|\n` +
    `  +${"-".repeat(40)}+`;

  if (pct >= compactThreshold) {
    console.log(c.warning(`!  Context ${Math.round(pct * 100)}% cheio - compactação recomendada.`));
  } else if (pct >= warnThreshold) {
    console.log(c.warning(`!  Context em ${Math.round(pct * 100)}% - aproxime-se do limite em breve.`));
  }

  console.log(line1);
  console.log(line2);
}
