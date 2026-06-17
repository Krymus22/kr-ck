/**
 * selfHealing.ts - Structured compiler feedback for self-healing.
 *
 * When tsc/lint/selene/any validator fails, this module parses the raw
 * error output into a structured format (file, line, column, error code,
 * expected vs got) before injecting it back into the AI's context.
 *
 * Structured errors are easier for the model to act on than raw text.
 * Instead of seeing a wall of text, the model sees:
 *   { file: "src/apiClient.ts", line: 42, code: "TS2345",
 *     message: "Argument of type 'string' is not assignable to 'number'" }
 *
 * Integration:
 *   - strictQualityGate.ts: parse errors before injecting
 *   - luauValidator.ts: parse selene errors before injecting
 *   - agent.ts: inject structured errors after tool failures
 */

import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface StructuredError {
  file: string;
  line: number;
  column?: number;
  code?: string;
  severity: "error" | "warning";
  message: string;
  expected?: string;
  got?: string;
}

// --- Parsers ----------------------------------------------------------------

/**
 * Parse TypeScript compiler errors (tsc --noEmit output).
 *
 * Format: file.ts(42,10): error TS2345: Argument of type 'X' is not assignable to parameter of type 'Y'.
 */
function parseTscErrors(output: string): StructuredError[] {
  const errors: StructuredError[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    const [, file, lineStr, colStr, severity, code, message] = match;
    const error: StructuredError = {
      file: file!,
      line: parseInt(lineStr!, 10),
      column: parseInt(colStr!, 10),
      code: code!,
      severity: severity as "error" | "warning",
      message: message!,
    };

    // Try to extract expected/got from message
    const typeMatch = message!.match(/type '([^']+)'.*type '([^']+)'/);
    if (typeMatch) {
      error.expected = typeMatch[1];
      error.got = typeMatch[2];
    }

    errors.push(error);
  }

  return errors;
}

/**
 * Parse Selene lint errors.
 *
 * Format: file.luau:42:1: warning: undefined_global
 * Or:     file.luau:42:1: error: mismatched_end
 */
function parseSeleneErrors(output: string): StructuredError[] {
  const errors: StructuredError[] = [];
  const pattern = /^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      severity: match[4] as "error" | "warning",
      message: match[5]!,
    });
  }

  return errors;
}

/**
 * Parse ESLint errors.
 *
 * Format: /path/to/file.ts:42:5: error  Expected '===' ExpectationEquality
 */
function parseEslintErrors(output: string): StructuredError[] {
  const errors: StructuredError[] = [];
  const pattern = /^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)(?:\s+(\w+))?$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(output)) !== null) {
    errors.push({
      file: match[1]!,
      line: parseInt(match[2]!, 10),
      column: parseInt(match[3]!, 10),
      severity: match[4] as "error" | "warning",
      message: match[5]!,
      code: match[6],
    });
  }

  return errors;
}

/**
 * Parse generic command output. Falls back to line-by-line parsing.
 * Looks for common error patterns: "Error:", "error:", "failed", etc.
 */
function parseGenericErrors(output: string): StructuredError[] {
  const errors: StructuredError[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("panic")) {
      // Try to extract file:line from line
      const fileMatch = line.match(/([^\s]+\.(?:ts|tsx|js|jsx|luau|lua|py|rs|go)):(\d+)/);
      errors.push({
        file: fileMatch?.[1] ?? "unknown",
        line: fileMatch ? parseInt(fileMatch[2]!, 10) : 0,
        severity: "error",
        message: line.trim().slice(0, 200),
      });
    }
  }

  return errors;
}

// --- Public API -------------------------------------------------------------

/**
 * Parse raw compiler/linter output into structured errors.
 * Auto-detects format (tsc, selene, eslint, or generic).
 */
export function parseErrors(output: string, source?: "tsc" | "selene" | "eslint" | "generic"): StructuredError[] {
  if (!output || output.trim().length === 0) return [];

  // Auto-detect format if not specified
  if (!source) {
    if (/TS\d{4}/.test(output)) source = "tsc";
    else if (/:\d+:\d+:\s*(error|warning):\s*\w+/.test(output)) source = "selene";
    else if (/\d+:\d+:\s*(error|warning)\s+/.test(output)) source = "eslint";
    else source = "generic";
  }

  switch (source) {
    case "tsc": return parseTscErrors(output);
    case "selene": return parseSeleneErrors(output);
    case "eslint": return parseEslintErrors(output);
    default: return parseGenericErrors(output);
  }
}

/**
 * Format structured errors as a readable string for the AI.
 *
 * Format:
 *   [STRUCTURED ERRORS - 3 found]
 *   1. src/apiClient.ts:42  TS2345 (error)
 *      Expected: number | Got: string
 *      Argument of type 'string' is not assignable to 'number'
 *
 *   2. src/file.luau:10  (warning)
 *      undefined_global: TweenService
 */
export function formatStructuredErrors(errors: StructuredError[]): string {
  if (errors.length === 0) return "";

  const lines: string[] = [`[STRUCTURED ERRORS - ${errors.length} found]`];

  errors.forEach((err, i) => {
    const location = `${err.file}:${err.line}${err.column ? `:${err.column}` : ""}`;
    const codeStr = err.code ? ` ${err.code}` : "";
    lines.push(`${i + 1}. ${location}  ${codeStr} (${err.severity})`);

    if (err.expected && err.got) {
      lines.push(`   Expected: ${err.expected} | Got: ${err.got}`);
    }

    lines.push(`   ${err.message}`);
  });

  return lines.join("\n");
}

/**
 * Get a quick summary of errors (for status bar / logging).
 */
export function getErrorSummary(errors: StructuredError[]): string {
  const errors_count = errors.filter((e) => e.severity === "error").length;
  const warnings = errors.filter((e) => e.severity === "warning").length;
  return `${errors_count} error(s), ${warnings} warning(s)`;
}
