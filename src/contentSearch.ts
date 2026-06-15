/**
 * contentSearch.ts — Content search (Grep) with regex support.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as glob from "./fileSearch.js";
import * as log from "./logger.js";

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
  const stat = fs.statSync(searchPath);
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
  const relFile = path.relative(process.cwd(), file).replaceAll("\\", "/");

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
  if (matches.length === 0) return "Nenhum resultado encontrado.";

  const lines: string[] = [];
  const displayCount = Math.min(matches.length, maxDisplay);

  for (let i = 0; i < displayCount; i++) {
    const m = matches[i];
    if (m.before?.length) {
      for (const b of m.before) {
        lines.push(`  ${m.file}:${m.line - m.before.indexOf(b) - 1}: ${b}`);
      }
    }
    lines.push(`→ ${m.file}:${m.line}: ${m.content}`);
    if (m.after?.length) {
      for (const a of m.after) {
        lines.push(`  ${m.file}:${m.line + m.after.indexOf(a) + 1}: ${a}`);
      }
    }
  }

  if (matches.length > maxDisplay) {
    lines.push(`\n... e mais ${matches.length - maxDisplay} resultados.`);
  }

  return lines.join("\n");
}
