/**
 * contentSearch.ts - Content search (Grep) with regex support.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as glob from "./fileSearch.js";
import * as log from "./logger.js";
import { t } from "./i18n.js";

export interface GrepOptions {
  pattern: string;
  path?: string;       // file or directory
  include?: string;    // file pattern filter (e.g., "*.ts")
  ignore?: string[];
  maxResults?: number;
  contextLines?: number;
  caseInsensitive?: boolean;
  wholeWord?: boolean;
  maxDepth?: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  before?: string[];  // context lines before
  after?: string[];   // context lines after
}

function buildGrepRegex(opts: GrepOptions): RegExp | null {
  let flags = "g";
  if (opts.caseInsensitive) flags += "i";
  let patternStr = opts.pattern;
  if (opts.wholeWord) patternStr = String.raw`\b${patternStr}\b`;

  try {
    return new RegExp(patternStr, flags);
  } catch {
    return null;
  }
}

function resolveGrepFiles(opts: GrepOptions, searchPath: string, ignore: string[]): string[] {
  // BUG FIX: previously fs.statSync(searchPath) was called without a try/catch.
  // If `searchPath` did not exist (typo, race condition, deleted directory),
  // the ENOENT error propagated up and crashed the whole grepSearch call,
  // instead of being treated as "no files to search" → return [].
  let stat: fs.Stats;
  try {
    stat = fs.statSync(searchPath);
  } catch {
    return [];
  }
  if (stat.isFile()) return [searchPath];

  const globPattern = opts.include ? `**/${opts.include}` : "**/*";
  const files = glob.globSearch({ pattern: globPattern, cwd: searchPath, ignore, maxDepth: opts.maxDepth ?? 15 });
  return files.map((f) => path.join(searchPath, f));
}

function searchFileForMatches(
  file: string,
  re: RegExp,
  context: number,
  maxResults: number,
  results: GrepMatch[],
): void {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }

  if (content.includes("\0")) return;

  const lines = content.split(/\r?\n/);
  // Sprint C bug fix (BUG-X): usar path absoluto em vez de relativo.
  // Paths relativos como "../../../../tmp/ck-test/app.ts" são longos e
  // confundem a IA, que fica em loop chamando buscar_texto repetidamente
  // porque não consegue interpretar o resultado. Path absoluto é mais claro.
  const relFile = file.replaceAll("\\", "/");

  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxResults) break;

    re.lastIndex = 0;
    if (re.test(lines[i])) {
      const match: GrepMatch = {
        file: relFile,
        line: i + 1,
        content: lines[i],
      };

      if (context > 0) {
        match.before = lines.slice(Math.max(0, i - context), i);
        match.after = lines.slice(i + 1, i + 1 + context);
      }

      results.push(match);
    }
  }
}

export function grepSearch(opts: GrepOptions): GrepMatch[] {
  const searchPath = opts.path ?? process.cwd();
  const ignore = opts.ignore ?? ["node_modules", ".git", "dist", ".next"];
  const maxResults = opts.maxResults ?? 200;
  const context = opts.contextLines ?? 0;

  log.toolCall("buscar_texto_no_projeto", { pattern: opts.pattern, path: searchPath });

  const re = buildGrepRegex(opts);
  if (!re) {
    log.toolResult("buscar_texto_no_projeto", false, "invalid regex");
    return [];
  }

  const files = resolveGrepFiles(opts, searchPath, ignore);
  const results: GrepMatch[] = [];

  for (const file of files) {
    if (results.length >= maxResults) break;
    searchFileForMatches(file, re, context, maxResults, results);
  }

  log.toolResult("buscar_texto_no_projeto", true, `${results.length} matches`);
  return results;
}

export function formatGrepResults(matches: GrepMatch[], maxDisplay: number = 50): string {
  if (matches.length === 0) return t("tool.no_results");

  const lines: string[] = [];
  const displayCount = Math.min(matches.length, maxDisplay);

  for (let i = 0; i < displayCount; i++) {
    const m = matches[i];
    // BUG FIX: previously used `m.before.indexOf(b)` / `m.after.indexOf(a)`
    // to compute line numbers. That had TWO bugs:
    //   1. `indexOf` returns the FIRST index of duplicate values, so repeated
    //      context lines all got the SAME line number (the first one's index).
    //   2. The before formula `m.line - indexOf(b) - 1` is mathematically
    //      backwards: it assigns line `m.line-1` to the FIRST context line
    //      (which is actually `m.line - before.length`) and line
    //      `m.line - before.length` to the LAST context line (which is
    //      actually `m.line - 1`). The displayed order was the reverse of
    //      the line numbers shown. Use explicit indices so each line gets
    //      the correct, monotonically-increasing line number.
    if (m.before?.length) {
      for (let j = 0; j < m.before.length; j++) {
        const b = m.before[j];
        lines.push(`  ${m.file}:${m.line - m.before.length + j}: ${b}`);
      }
    }
    lines.push(`-> ${m.file}:${m.line}: ${m.content}`);
    if (m.after?.length) {
      for (let j = 0; j < m.after.length; j++) {
        const a = m.after[j];
        lines.push(`  ${m.file}:${m.line + j + 1}: ${a}`);
      }
    }
  }

  if (matches.length > maxDisplay) {
    lines.push(`\n... e mais ${matches.length - maxDisplay} resultados.`);
  }

  return lines.join("\n");
}
