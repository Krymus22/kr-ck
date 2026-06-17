/**
 * impactAnalyzer.ts - Pre-edit dependency analysis.
 *
 * Before the AI edits a file, this module finds all OTHER files in the project
 * that depend on symbols exported/defined by the file being edited. The AI
 * then knows: "if I rename/remove/change this, these N files will break."
 *
 * How it works:
 *   1. Extract exported symbols from the target file (functions, tables, classes)
 *      - For Luau: pattern matches like `function M.Foo(...)`, `M.Bar = ...`,
 *        `local Foo = ...` at module top level
 *      - For TypeScript: `export function`, `export const`, `export class`
 *      - For Python: `def`, `class` at column 0
 *   2. For each symbol, grep the project for usages (excluding the target file itself)
 *   3. Return a list of { file, line, symbol, lineContent }
 *
 * Performance:
 *   - Uses ripgrep (rg) when available for fast searching
 *   - Falls back to Node fs.readdirSync + regex matching
 *   - Only scans files matching the language's source extensions
 *   - Respects .gitignore when possible (via rg --no-ignore-vcs)
 *   - Caches results for 5 minutes per file (mtime-based)
 *
 * Integration:
 *   - Called by fileEdit.ts BEFORE the actual write
 *   - Result is injected as a "dependency hint" in the AI's context
 *   - Non-blocking (warnings only) - never aborts the write
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface SymbolUsage {
  /** File path (absolute) where the symbol is referenced */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** The symbol name that was matched */
  symbol: string;
  /** The full line content (trimmed) */
  lineContent: string;
}

export interface FileSymbol {
  /** Symbol name as it appears in source (e.g. "GetCoins", "InventoryService") */
  name: string;
  /** Best guess at how it's referenced externally */
  exportedAs: string;
  /** Line where it's defined (1-indexed) */
  definitionLine: number;
}

export interface ImpactReport {
  /** The file being edited */
  targetFile: string;
  /** Symbols found in the target file */
  symbols: FileSymbol[];
  /** Files that reference any of the symbols (deduplicated) */
  affectedFiles: string[];
  /** All usage details */
  usages: SymbolUsage[];
  /** Time spent analyzing (ms) */
  durationMs: number;
}

// --- Config -----------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
const MAX_USAGES_PER_SYMBOL = 20;     // don't return 500 matches for a common name
const MAX_TOTAL_USAGES = 100;         // hard cap on total usages returned
const MAX_FILE_SIZE_KB = 500;         // skip files larger than 500KB

const EXTENSIONS_BY_LANG: Record<string, string[]> = {
  roblox: [".luau", ".lua"],
  lua: [".luau", ".lua"],
  luau: [".luau", ".lua"],
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  rust: [".rs"],
  go: [".go"],
};

// --- Cache ------------------------------------------------------------------

interface CacheEntry {
  report: ImpactReport;
  fileMtime: number;
  cachedAt: number;
}
const cache = new Map<string, CacheEntry>();

// --- Helpers ----------------------------------------------------------------

/** Run a shell command synchronously with timeout. */
function runCmd(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = 10_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
  });
}

/** Detect language based on file extension. */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  for (const [lang, exts] of Object.entries(EXTENSIONS_BY_LANG)) {
    if (exts.includes(ext)) return lang;
  }
  return "unknown";
}

/** Check if ripgrep is available. */
let rgAvailable: boolean | null = null;
async function isRgAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  const result = await runCmd("rg", ["--version"], process.cwd(), 3000);
  rgAvailable = result.ok;
  return rgAvailable;
}

// --- Symbol extraction ------------------------------------------------------

/**
 * Extract exported symbols from a source file.
 * Returns list of { name, exportedAs, definitionLine }.
 *
 * For Luau:
 *   - `function M.Foo(args)` -> name="Foo", exportedAs="Foo"
 *   - `function Module.Foo(args)` -> name="Foo", exportedAs="Foo"
 *   - `M.Bar = ...` -> name="Bar", exportedAs="Bar"
 *   - `local Foo = function(...)` -> name="Foo", exportedAs="Foo"
 *   - `local function Foo(...)` -> name="Foo", exportedAs="Foo"
 *
 * For TypeScript/JavaScript:
 *   - `export function Foo(...)` -> name="Foo", exportedAs="Foo"
 *   - `export const Foo = ...` -> name="Foo", exportedAs="Foo"
 *   - `export class Foo` -> name="Foo", exportedAs="Foo"
 *
 * For Python:
 *   - `def foo(...)` at column 0 -> name="foo", exportedAs="foo"
 *   - `class Foo:` at column 0 -> name="Foo", exportedAs="Foo"
 */
export function extractSymbols(filePath: string, content: string): FileSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  const symbols: FileSymbol[] = [];
  const lines = content.split("\n");

  const patterns: RegExp[] = [];

  if (ext === ".luau" || ext === ".lua") {
    // Luau: function M.Foo, function Module.Foo, M.Foo =, local function Foo, local Foo = function
    patterns.push(
      /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*:/,  // method
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*=/,  // M.Foo = ...
      /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^\s*local\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\b/,
      /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(/,
      /^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/,
    );
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    patterns.push(
      /^\s*export\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^\s*export\s+const\s+([A-Za-z_][A-Za-z0-9_$]*)\s*=/,
      /^\s*export\s+let\s+([A-Za-z_][A-Za-z0-9_$]*)\s*=/,
      /^\s*export\s+class\s+([A-Za-z_][A-Za-z0-9_$]*)\b/,
      /^\s*export\s+type\s+([A-Za-z_][A-Za-z0-9_$]*)\s*=/,
      /^\s*export\s+interface\s+([A-Za-z_][A-Za-z0-9_$]*)\s*\{/,
      /^\s*export\s+default\s+function\s+([A-Za-z_][A-Za-z0-9_$]*)?\s*\(/,
    );
  } else if (ext === ".py") {
    patterns.push(
      /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,  // column 0
      /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]/,
    );
  } else if (ext === ".rs") {
    patterns.push(
      /^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^\s*pub\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
      /^\s*pub\s+enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
      /^\s*pub\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/,
    );
  } else if (ext === ".go") {
    patterns.push(
      /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s/,
    );
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        // For patterns like `function M.Foo`, the symbol name is in match[2]
        // For `local function Foo`, it's in match[1]
        const symbolName = match[2] ?? match[1];
        if (symbolName && !symbols.some((s) => s.name === symbolName)) {
          // Skip very short or common names that would over-match
          if (symbolName.length < 2) continue;
          if (["new", "init", "get", "set", "do", "if", "for", "while"].includes(symbolName.toLowerCase())) continue;
          symbols.push({
            name: symbolName,
            exportedAs: symbolName,
            definitionLine: i + 1,
          });
        }
      }
    }
  }

  return symbols;
}

// --- Usage search -----------------------------------------------------------

/**
 * Search the project for usages of a symbol, excluding the target file.
 *
 * Uses ripgrep if available, falls back to Node fs walk.
 *
 * @returns SymbolUsage[] - capped at MAX_USAGES_PER_SYMBOL per symbol
 */
async function findUsages(
  symbolName: string,
  projectRoot: string,
  targetFile: string,
  language: string
): Promise<SymbolUsage[]> {
  const extensions = EXTENSIONS_BY_LANG[language] ?? [];
  if (extensions.length === 0) return [];

  // Build ripgrep glob patterns
  const globArgs = extensions.flatMap((ext) => ["--glob", `*${ext}`]);

  // Word-boundary regex to avoid matching substrings
  // For Luau symbols like "GetCoins", search for `\bGetCoins\b`
  // For symbols containing `:` or `.` (methods), escape them
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\b${escaped}\\b`;

  const targetAbs = path.resolve(targetFile);
  const targetRel = path.relative(projectRoot, targetAbs);

  let stdout = "";
  if (await isRgAvailable()) {
    // Use ripgrep
    const result = await runCmd(
      "rg",
      [
        "--no-heading",
        "--line-number",
        "--no-ignore-vcs",  // include files in .gitignore (project files often are)
        ...globArgs,
        "-e", pattern,
        projectRoot,
      ],
      projectRoot,
      10_000
    );
    if (!result.ok && result.stderr) {
      log.debug(`impactAnalyzer: rg error for "${symbolName}": ${result.stderr.slice(0, 200)}`);
    }
    stdout = result.stdout;
  } else {
    // Fallback: walk directory and grep manually
    stdout = await manualGrep(pattern, projectRoot, extensions);
  }

  const usages: SymbolUsage[] = [];
  const lines = stdout.split("\n").filter(Boolean);

  for (const line of lines) {
    // Parse "filepath:lineNumber:lineContent"
    // rg format: path/to/file.luau:23:local x = M.GetCoins()
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const [, filePath, lineStr, lineContent] = match;
    if (!filePath || !lineStr || lineContent === undefined) continue;

    const lineNum = parseInt(lineStr, 10);
    if (Number.isNaN(lineNum)) continue;

    const fileAbs = path.resolve(filePath);
    const fileRel = path.relative(projectRoot, fileAbs);

    // Skip the target file itself
    if (fileRel === targetRel) continue;
    // Skip files outside the project root
    if (fileRel.startsWith("..")) continue;
    // Skip common non-source directories
    const skipDirs = ["node_modules", ".git", "dist", "build", "target", "__pycache__", ".rollback"];
    const pathParts = fileRel.split(path.sep);
    const shouldSkip = pathParts.some((part) => skipDirs.includes(part));
    if (shouldSkip) continue;

    usages.push({
      file: fileRel,
      line: lineNum,
      symbol: symbolName,
      lineContent: lineContent.trim().slice(0, 120),  // cap line length
    });

    if (usages.length >= MAX_USAGES_PER_SYMBOL) break;
  }

  return usages;
}

/** Fallback grep when rg is not available. */
async function manualGrep(pattern: string, root: string, extensions: string[]): Promise<string> {
  const regex = new RegExp(pattern);
  const results: string[] = [];
  const visited = new Set<string>();

  function walk(dir: string) {
    if (visited.has(dir)) return;
    visited.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "dist", "build", "target", "__pycache__"].includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MAX_FILE_SIZE_KB * 1024) continue;
          const content = fs.readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i]!)) {
              results.push(`${fullPath}:${i + 1}:${lines[i]}`);
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(root);
  return results.join("\n");
}

// --- Main analyzer ----------------------------------------------------------

/**
 * Analyze the impact of editing a file. Returns the symbols defined in it
 * and all other files in the project that reference those symbols.
 *
 * @param targetFile - Absolute path of the file about to be edited
 * @param projectRoot - Project root (defaults to process.cwd())
 * @returns ImpactReport with symbols + usages, or empty report on error
 */
export async function analyzeImpact(
  targetFile: string,
  projectRoot: string = process.cwd()
): Promise<ImpactReport> {
  const start = Date.now();
  const empty: ImpactReport = {
    targetFile,
    symbols: [],
    affectedFiles: [],
    usages: [],
    durationMs: 0,
  };

  // Check cache (mtime-based)
  try {
    const stat = fs.statSync(targetFile);
    const cacheKey = targetFile;
    const cached = cache.get(cacheKey);
    if (cached && cached.fileMtime === stat.mtimeMs && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return { ...cached.report, durationMs: Date.now() - start };
    }
  } catch {
    return empty;
  }

  // Read target file content
  let content: string;
  try {
    content = fs.readFileSync(targetFile, "utf8");
  } catch {
    return empty;
  }

  // Detect language
  const language = detectLanguage(targetFile);
  if (language === "unknown") {
    return { ...empty, durationMs: Date.now() - start };
  }

  // Extract symbols
  const symbols = extractSymbols(targetFile, content);
  if (symbols.length === 0) {
    const report = { ...empty, durationMs: Date.now() - start };
    return report;
  }

  // Find usages of each symbol (cap total to MAX_TOTAL_USAGES)
  const allUsages: SymbolUsage[] = [];
  const affectedFilesSet = new Set<string>();

  for (const sym of symbols) {
    if (allUsages.length >= MAX_TOTAL_USAGES) break;
    const usages = await findUsages(sym.name, projectRoot, targetFile, language);
    for (const u of usages) {
      if (allUsages.length >= MAX_TOTAL_USAGES) break;
      allUsages.push(u);
      affectedFilesSet.add(u.file);
    }
  }

  const report: ImpactReport = {
    targetFile,
    symbols,
    affectedFiles: Array.from(affectedFilesSet).sort(),
    usages: allUsages,
    durationMs: Date.now() - start,
  };

  // Save to cache
  try {
    const stat = fs.statSync(targetFile);
    cache.set(targetFile, {
      report,
      fileMtime: stat.mtimeMs,
      cachedAt: Date.now(),
    });
  } catch {
    // ignore cache failures
  }

  log.debug(`impactAnalyzer: ${targetFile} - ${symbols.length} symbols, ${allUsages.length} usages in ${report.durationMs}ms`);
  return report;
}

// --- Formatter --------------------------------------------------------------

/**
 * Format an ImpactReport as a hint string for the AI agent.
 *
 * Returns empty string if no usages found (nothing to warn about).
 * Otherwise returns a multi-line message listing affected files and usages.
 */
export function formatImpactHint(report: ImpactReport): string {
  if (report.usages.length === 0) return "";

  const lines: string[] = [];
  lines.push(`[ANÁLISE DE IMPACTO] Antes de editar ${path.basename(report.targetFile)}:`);
  lines.push(`Encontrei ${report.symbols.length} símbolo(s) definidos neste arquivo.`);
  lines.push(`${report.usages.length} uso(s) encontrado(s) em ${report.affectedFiles.length} arquivo(s) do projeto:`);
  lines.push("");

  // Group usages by file
  const byFile = new Map<string, SymbolUsage[]>();
  for (const u of report.usages) {
    if (!byFile.has(u.file)) byFile.set(u.file, []);
    byFile.get(u.file)!.push(u);
  }

  for (const [file, usages] of byFile) {
    lines.push(`  ${file} (${usages.length} uso${usages.length > 1 ? "s" : ""}):`);
    for (const u of usages.slice(0, 5)) {  // max 5 lines per file
      lines.push(`    L${u.line}: ${u.lineContent}`);
    }
    if (usages.length > 5) {
      lines.push(`    ... e mais ${usages.length - 5} uso(s)`);
    }
  }

  lines.push("");
  lines.push(`Se você for RENOMEAR ou REMOVER algum desses símbolos, precisa editar`);
  lines.push(`todos os arquivos acima também. Caso contrário, vai quebrar em runtime.`);

  return lines.join("\n");
}

/**
 * Get a short summary (for status bar / quick display).
 */
export function formatImpactSummary(report: ImpactReport): string {
  if (report.usages.length === 0) return "sem dependências";
  return `${report.usages.length} uso(s) em ${report.affectedFiles.length} arquivo(s)`;
}

/** Clear the cache. Useful for tests. */
export function clearCache(): void {
  cache.clear();
}
