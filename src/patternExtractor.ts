/**
 * patternExtractor.ts - Extract coding patterns from existing project files.
 *
 * Analyzes 3-5 files in the project to extract conventions:
 *   - Naming (camelCase, snake_case, PascalCase)
 *   - Error handling style (try-catch, Result type, panic)
 *   - Import style (relative, absolute, aliased)
 *   - Comment style (// or -- or #)
 *   - Indentation (tabs, 2-space, 4-space)
 *
 * The extracted patterns are injected into the system prompt so the AI
 * generates code that matches the project's existing style. This prevents
 * the "AI-generated code" look where naming/style is inconsistent with
 * the rest of the codebase.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface CodePatterns {
  namingConvention: "camelCase" | "snake_case" | "PascalCase" | "mixed" | "unknown";
  errorHandling: "try-catch" | "result-type" | "panic" | "none" | "unknown";
  importStyle: "relative" | "absolute" | "aliased" | "mixed" | "unknown";
  commentStyle: "//" | "--" | "#" | "/*" | "unknown";
  indentation: "tabs" | "2-space" | "4-space" | "unknown";
  quoteStyle: "single" | "double" | "backtick" | "mixed" | "unknown";
  filesAnalyzed: number;
  rawSummary: string;
}

// --- Pattern detection -----------------------------------------------------

function detectNaming(content: string): CodePatterns["namingConvention"] {
  const camel = (content.match(/\b[a-z][a-zA-Z0-9]*\b/g) ?? []).filter((w) => /[A-Z]/.test(w));
  const snake = (content.match(/\b[a-z][a-z0-9_]*\b/g) ?? []).filter((w) => w.includes("_"));
  const pascal = (content.match(/\b[A-Z][a-zA-Z0-9]*\b/g) ?? []).filter((w) => w.length > 2);

  if (camel.length > snake.length * 2 && camel.length > pascal.length) return "camelCase";
  if (snake.length > camel.length * 2) return "snake_case";
  if (pascal.length > camel.length) return "PascalCase";
  if (camel.length > 0 || snake.length > 0) return "mixed";
  return "unknown";
}

function detectErrorHandling(content: string): CodePatterns["errorHandling"] {
  const hasTryCatch = /\btry\s*[\({]/i.test(content) || /\bcatch\b/i.test(content) || /\bpcall\b/i.test(content);
  const hasResult = /\bResult\b/i.test(content) || /\bEither\b/i.test(content) || /\bok,\s*err\b/i.test(content);
  const hasPanic = /\bpanic!?\s*\(/i.test(content);

  if (hasResult) return "result-type";
  if (hasTryCatch) return "try-catch";
  if (hasPanic) return "panic";
  if (content.length > 100) return "none";
  return "unknown";
}

function detectImportStyle(content: string): CodePatterns["importStyle"] {
  const relative = (content.match(/from\s+['"]\.\.?\//g) ?? []).length;
  const absolute = (content.match(/from\s+['"][^.]/g) ?? []).length;
  const aliased = (content.match(/from\s+['"]@/g) ?? []).length;

  if (aliased > 0) return "aliased";
  if (relative > absolute * 2) return "relative";
  if (absolute > relative * 2) return "absolute";
  if (relative > 0 || absolute > 0) return "mixed";
  return "unknown";
}

function detectCommentStyle(content: string): CodePatterns["commentStyle"] {
  if (/^\s*\/\//m.test(content)) return "//";
  if (/^\s*--/m.test(content)) return "--";
  if (/^\s*#/m.test(content)) return "#";
  if (/^\s*\/\*/m.test(content)) return "/*";
  return "unknown";
}

function detectIndentation(content: string): CodePatterns["indentation"] {
  const lines = content.split("\n").filter((l) => l.startsWith(" ") || l.startsWith("\t"));
  if (lines.length === 0) return "unknown";
  const tabs = lines.filter((l) => l.startsWith("\t")).length;
  const twoSpace = lines.filter((l) => l.startsWith("  ") && !l.startsWith("   ")).length;
  const fourSpace = lines.filter((l) => l.startsWith("    ")).length;

  if (tabs > twoSpace && tabs > fourSpace) return "tabs";
  if (fourSpace > twoSpace) return "4-space";
  if (twoSpace > 0) return "2-space";
  return "unknown";
}

function detectQuoteStyle(content: string): CodePatterns["quoteStyle"] {
  const single = (content.match(/'/g) ?? []).length;
  const double = (content.match(/"/g) ?? []).length;
  const backtick = (content.match(/`/g) ?? []).length;

  if (backtick > single && backtick > double) return "backtick";
  if (single > double * 2) return "single";
  if (double > single * 2) return "double";
  if (single > 0 || double > 0) return "mixed";
  return "unknown";
}

// --- Public API -------------------------------------------------------------

/**
 * Analyze project files to extract coding patterns.
 *
 * @param projectRoot - Root directory of the project
 * @param maxFiles - Maximum files to analyze (default 5)
 * @returns CodePatterns with detected conventions
 */
export function extractPatterns(projectRoot: string, maxFiles: number = 5): CodePatterns {
  const extensions = [".ts", ".tsx", ".luau", ".lua", ".py", ".rs", ".go", ".js", ".jsx"];
  const sampleFiles: string[] = [];

  // Find source files (skip node_modules, dist, tests)
  function walk(dir: string, depth: number = 0) {
    if (sampleFiles.length >= maxFiles || depth > 3) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (sampleFiles.length >= maxFiles) break;
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        if (["node_modules", "dist", "build", "target", "__pycache__", ".git"].includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext) && !entry.name.includes(".test.") && !entry.name.includes(".spec.")) {
            sampleFiles.push(fullPath);
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(projectRoot);

  if (sampleFiles.length === 0) {
    return {
      namingConvention: "unknown",
      errorHandling: "unknown",
      importStyle: "unknown",
      commentStyle: "unknown",
      indentation: "unknown",
      quoteStyle: "unknown",
      filesAnalyzed: 0,
      rawSummary: "No source files found for pattern analysis.",
    };
  }

  // Analyze each file and aggregate
  let combinedContent = "";
  for (const file of sampleFiles) {
    try {
      combinedContent += fs.readFileSync(file, "utf8") + "\n";
    } catch { /* skip */ }
  }

  const patterns: CodePatterns = {
    namingConvention: detectNaming(combinedContent),
    errorHandling: detectErrorHandling(combinedContent),
    importStyle: detectImportStyle(combinedContent),
    commentStyle: detectCommentStyle(combinedContent),
    indentation: detectIndentation(combinedContent),
    quoteStyle: detectQuoteStyle(combinedContent),
    filesAnalyzed: sampleFiles.length,
    rawSummary: "",
  };

  patterns.rawSummary = formatPatterns(patterns);
  log.info(`[PATTERN_EXTRACTOR] Analyzed ${sampleFiles.length} files: ${patterns.namingConvention}, ${patterns.indentation}, ${patterns.commentStyle}`);
  return patterns;
}

/**
 * Format patterns as a string for system prompt injection.
 */
export function formatPatterns(patterns: CodePatterns): string {
  const lines: string[] = [`## Project Code Patterns (from ${patterns.filesAnalyzed} files)`];
  lines.push(`- Naming: ${patterns.namingConvention}`);
  lines.push(`- Error handling: ${patterns.errorHandling}`);
  lines.push(`- Import style: ${patterns.importStyle}`);
  lines.push(`- Comment style: ${patterns.commentStyle}`);
  lines.push(`- Indentation: ${patterns.indentation}`);
  lines.push(`- Quote style: ${patterns.quoteStyle}`);
  lines.push(`\nFollow these conventions when generating new code. Match the existing style.`);
  return lines.join("\n");
}

// --- Cache ------------------------------------------------------------------

let cachedPatterns: CodePatterns | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

/**
 * Get cached patterns (or extract if cache expired).
 */
export function getPatternsCached(projectRoot: string): CodePatterns {
  if (cachedPatterns && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedPatterns;
  }
  cachedPatterns = extractPatterns(projectRoot);
  cacheTime = Date.now();
  return cachedPatterns;
}

/** Clear cache (for tests). */
export function clearPatternCache(): void {
  cachedPatterns = null;
  cacheTime = 0;
}
