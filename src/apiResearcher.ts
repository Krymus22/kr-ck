/**
 * apiResearcher.ts - Sub-agent that researches current API info on demand.
 *
 * When the main agent is writing code and isn't sure if an API is current
 * (especially Roblox APIs that update frequently), it can call this tool.
 * The researcher:
 *   1. Gets today's date from the system (so it knows what "current" means)
 *   2. Searches the web for the API name + language
 *   3. Reads the top result (preferring official docs)
 *   4. Returns a structured summary: signature, parameters, returns, deprecation status
 *
 * Caching:
 *   Results are cached for 7 days by default (Roblox updates weekly).
 *   Cache lives at ~/.claude-killer/.api-research-cache.json
 *
 * Why this matters:
 *   - Roblox APIs change every week; selene/luau-lsp lag by weeks
 *   - Without this, the AI might write `instance:FindFirstChild(x)` (deprecated)
 *     instead of `instance:WaitForChild(x)` or `instance:GetAttribute(x)` (current)
 *   - With this, the AI can verify in real-time before writing
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface ResearchRequest {
  /** API name to research (e.g. "TweenService:Create", "FindFirstChild", "React.useState") */
  apiName: string;
  /** Programming language / platform (e.g. "roblox", "typescript", "python") */
  language: string;
  /** Optional context: what the user is trying to do */
  context?: string;
  /** Force fresh research (skip cache) */
  forceRefresh?: boolean;
}

export interface ResearchResult {
  apiName: string;
  language: string;
  /** Today's date when research was performed (ISO date) */
  researchedAt: string;
  /** Current signature of the API */
  signature: string;
  /** Brief summary of what the API does */
  summary: string;
  /** Whether the API is deprecated */
  deprecated: boolean;
  /** When the API was last updated (if known) */
  lastUpdated?: string;
  /** What replaced it (if deprecated) */
  replacement?: string;
  /** Source URLs consulted */
  sources: string[];
  /** Whether this came from cache */
  fromCache: boolean;
  /** Raw content extracted from sources (truncated) */
  rawContent: string;
}

export interface ResearchError {
  error: string;
  apiName: string;
  language: string;
}

// --- Config -----------------------------------------------------------------

const CACHE_TTL_DAYS = 7;
const MAX_CONTENT_LENGTH = 8000;  // truncate raw content to keep response size manageable
const SEARCH_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 20_000;

// Official docs sources we trust (in priority order)
const TRUSTED_SOURCES: Record<string, string[]> = {
  roblox: [
    "create.roblox.com/docs",
    "roblox.com/create",
    "developer.roblox.com",  // legacy, redirects to create
    "devforum.roblox.com",
  ],
  typescript: [
    "typescriptlang.org",
    "developer.mozilla.org",
    "nodejs.org/api",
  ],
  python: [
    "docs.python.org",
    "realpython.com",
    "pypi.org",
  ],
  rust: [
    "doc.rust-lang.org",
    "docs.rs",
    "crates.io",
  ],
  lua: [
    "lua.org",
    "luau.org",
    "luau-lang.org",
  ],
};

// --- Cache ------------------------------------------------------------------

interface CacheEntry {
  result: ResearchResult;
  cachedAt: string;
}

function getCachePath(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
    ".claude-killer",
    ".api-research-cache.json"
  );
}

function loadCache(): Map<string, CacheEntry> {
  try {
    const p = getCachePath();
    if (!fs.existsSync(p)) return new Map();
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveCache(cache: Map<string, CacheEntry>): void {
  try {
    const dir = path.dirname(getCachePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of cache.entries()) obj[k] = v;
    fs.writeFileSync(getCachePath(), JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    log.warn(`apiResearcher: failed to save cache: ${(err as Error).message}`);
  }
}

function cacheKey(req: ResearchRequest): string {
  return `${req.language}::${req.apiName.toLowerCase()}`;
}

function isCacheFresh(entry: CacheEntry): boolean {
  const cachedAt = new Date(entry.cachedAt).getTime();
  if (Number.isNaN(cachedAt)) return false;
  const ageDays = (Date.now() - cachedAt) / (1000 * 60 * 60 * 24);
  return ageDays < CACHE_TTL_DAYS;
}

// --- Helpers ----------------------------------------------------------------

/** Get today's date in YYYY-MM-DD format (system local time). */
export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0]!;
}

/** Get current timestamp in ISO format. */
function now(): string {
  return new Date().toISOString();
}

/** Run a shell command with timeout. Returns {ok, stdout, stderr}. */
function runCmd(
  command: string,
  args: string[],
  timeout: number
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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

/**
 * Search the web for a query using the z-ai CLI (if available).
 * Falls back to a GitHub-only search if z-ai is not installed.
 *
 * Returns array of {url, title, snippet}.
 */
interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

async function webSearch(query: string, num: number = 5): Promise<SearchResult[]> {
  // Try z-ai CLI first (we know it's installed in this env)
  try {
    const tmpFile = path.join(os.tmpdir(), `claude-killer-search-${Date.now()}.json`);
    const result = await runCmd(
      "z-ai",
      ["function", "-n", "web_search", "-a", JSON.stringify({ query, num }), "-o", tmpFile],
      SEARCH_TIMEOUT_MS
    );

    if (result.ok && fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
      fs.unlinkSync(tmpFile);
      if (Array.isArray(data)) {
        return data.slice(0, num).map((r: any) => ({
          url: r.url ?? "",
          title: r.name ?? "",
          snippet: r.snippet ?? "",
        }));
      }
    }
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch {
    // z-ai CLI not available, fall through
  }

  // Fallback: use GitHub search API for code-related queries
  if (query.toLowerCase().includes("roblox") || query.toLowerCase().includes("api")) {
    try {
      const ghResult = await runCmd(
        "curl",
        ["-sL", "-H", "Accept: application/vnd.github+json",
         `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${num}`],
        SEARCH_TIMEOUT_MS
      );
      if (ghResult.ok) {
        const data = JSON.parse(ghResult.stdout);
        return (data.items ?? []).slice(0, num).map((r: any) => ({
          url: r.html_url,
          title: r.full_name,
          snippet: r.description ?? "",
        }));
      }
    } catch {
      // ignore
    }
  }

  return [];
}

/**
 * Read a web page and extract its text content.
 * Uses z-ai CLI's page_reader function if available.
 */
async function webRead(url: string): Promise<string> {
  try {
    const tmpFile = path.join(os.tmpdir(), `claude-killer-page-${Date.now()}.json`);
    const result = await runCmd(
      "z-ai",
      ["function", "-n", "page_reader", "-a", JSON.stringify({ url }), "-o", tmpFile],
      READ_TIMEOUT_MS
    );

    if (result.ok && fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
      fs.unlinkSync(tmpFile);
      // page_reader returns {data: {html, title, ...}}
      const html = data?.data?.html ?? data?.html ?? "";
      // Strip HTML tags for plain text
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, MAX_CONTENT_LENGTH);
    }
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch {
    // ignore
  }

  return "";
}

/**
 * Build the search query for an API research request.
 * Includes the current date so search engines prefer recent content.
 */
function buildSearchQuery(req: ResearchRequest): string {
  const today = getTodayDate();
  const year = today.split("-")[0];
  const parts = [req.apiName, req.language, "API", "documentation", year];
  if (req.context) parts.push(req.context);
  return parts.join(" ");
}

/**
 * Pick the best source from search results.
 * Prefers trusted sources for the given language, then falls back to top result.
 */
function pickBestSource(results: SearchResult[], language: string): SearchResult | null {
  if (results.length === 0) return null;

  const trusted = TRUSTED_SOURCES[language.toLowerCase()] ?? [];
  for (const domain of trusted) {
    const match = results.find((r) => r.url.includes(domain));
    if (match) return match;
  }
  return results[0]!;
}

/**
 * Parse raw text content to extract API info.
 * This is a simple heuristic parser - in production we'd use an LLM here
 * to extract structured data, but for now we use keyword matching.
 */
function parseApiInfo(rawText: string, apiName: string): Partial<ResearchResult> {
  const lower = rawText.toLowerCase();
  const apiLower = apiName.toLowerCase();

  // Check for deprecation indicators
  const deprecatedKeywords = ["deprecated", "deprecation", "no longer recommended", "use instead", "replaced by"];
  const isDeprecated = deprecatedKeywords.some((k) => lower.includes(k));

  // Try to find replacement
  let replacement: string | undefined;
  if (isDeprecated) {
    const replacePatterns = [
      new RegExp(`${apiLower}\\s*(?:is\\s+)?(?:deprecated|replaced)\\s+(?:by|with)\\s+([\\w.:]+)`, "i"),
      new RegExp(`use\\s+([\\w.:]+)\\s+instead\\s+of\\s+${apiLower}`, "i"),
      new RegExp(`${apiLower}.*?replaced by\\s+([\\w.:]+)`, "i"),
    ];
    for (const p of replacePatterns) {
      const m = rawText.match(p);
      if (m && m[1]) {
        replacement = m[1];
        break;
      }
    }
  }

  // Try to extract signature (heuristic - look for function-like patterns near the API name)
  let signature: string | undefined;
  const sigPatterns = [
    // Lua/Roblox style: ClassName:MethodName(args) or FunctionName(args)
    new RegExp(`((?:[A-Z]\\w+[:.])?${apiLower.replace(/[.:]/g, "[.:]")}\\s*\\([^)]*\\))`, "i"),
    // TypeScript/JS style: function name(args): ReturnType
    new RegExp(`(function\\s+${apiLower}\\s*\\s*\\([^)]*\\)\\s*:\\s*[\\w<>]+)`, "i"),
  ];
  for (const p of sigPatterns) {
    const m = rawText.match(p);
    if (m && m[1]) {
      signature = m[1].trim();
      break;
    }
  }

  // Extract first 300 chars of relevant content as summary
  const apiIdx = lower.indexOf(apiLower);
  let summary: string;
  if (apiIdx >= 0) {
    const start = Math.max(0, apiIdx - 50);
    summary = rawText.slice(start, start + 400).trim();
  } else {
    summary = rawText.slice(0, 400).trim();
  }

  return {
    signature: signature ?? "(not found in source - see rawContent)",
    summary,
    deprecated: isDeprecated,
    replacement,
  };
}

// --- Main research function -------------------------------------------------

/**
 * Research a specific API across the web.
 *
 * @returns ResearchResult if successful, ResearchError if not.
 *
 * The result is cached for CACHE_TTL_DAYS (7 days). Pass forceRefresh=true
 * to bypass cache.
 *
 * The result includes:
 *   - signature: current function/method signature
 *   - deprecated: whether the API is marked as deprecated
 *   - replacement: what to use instead (if deprecated)
 *   - summary: brief description from the docs
 *   - sources: URLs consulted
 *   - rawContent: truncated text extracted from sources
 *   - researchedAt: today's date (system date)
 */
export async function researchApi(req: ResearchRequest): Promise<ResearchResult | ResearchError> {
  const today = getTodayDate();
  log.info(`apiResearcher: researching "${req.apiName}" (${req.language}) on ${today}`);

  // 1. Check cache first
  const cache = loadCache();
  const key = cacheKey(req);
  if (!req.forceRefresh) {
    const cached = cache.get(key);
    if (cached && isCacheFresh(cached)) {
      log.info(`apiResearcher: cache hit for "${req.apiName}" (age: ${Math.round((Date.now() - new Date(cached.cachedAt).getTime()) / (1000 * 60 * 60 * 24))}d)`);
      return { ...cached.result, fromCache: true };
    }
  }

  // 2. Search the web
  const query = buildSearchQuery(req);
  const searchResults = await webSearch(query, 5);
  if (searchResults.length === 0) {
    return {
      error: `No search results found for "${req.apiName}" in ${req.language}`,
      apiName: req.apiName,
      language: req.language,
    };
  }

  // 3. Pick best source and read it
  const best = pickBestSource(searchResults, req.language);
  const sources = [best!.url];
  let rawContent = await webRead(best!.url);

  // If first source has too little content, try second source
  if (rawContent.length < 200 && searchResults.length > 1) {
    const second = searchResults[1]!;
    const secondContent = await webRead(second.url);
    if (secondContent.length > rawContent.length) {
      rawContent = secondContent;
      sources.unshift(second.url);
    }
  }

  if (rawContent.length === 0) {
    return {
      error: `Could not extract content from any source for "${req.apiName}"`,
      apiName: req.apiName,
      language: req.language,
    };
  }

  // 4. Parse the content to extract API info
  const parsed = parseApiInfo(rawContent, req.apiName);

  // 5. Build the result
  const result: ResearchResult = {
    apiName: req.apiName,
    language: req.language,
    researchedAt: today,
    signature: parsed.signature ?? "(not found)",
    summary: parsed.summary ?? "",
    deprecated: parsed.deprecated ?? false,
    replacement: parsed.replacement,
    sources,
    fromCache: false,
    rawContent: rawContent.slice(0, MAX_CONTENT_LENGTH),
  };

  // 6. Save to cache
  cache.set(key, { result, cachedAt: now() });
  saveCache(cache);

  log.info(`apiResearcher: research complete for "${req.apiName}" - deprecated=${result.deprecated}, sources=${sources.length}`);
  return result;
}

/**
 * Format a research result as a readable string for the AI agent.
 * This is what gets returned to the agent when it calls pesquisar_api_atualizada.
 */
export function formatResearchResult(result: ResearchResult | ResearchError): string {
  if ("error" in result) {
    return `[ERRO] Pesquisa de API falhou para "${result.apiName}" (${result.language}):\n${result.error}`;
  }

  const lines: string[] = [];
  lines.push(`[PESQUISA DE API] ${result.apiName} (${result.language})`);
  lines.push(`Data da pesquisa: ${result.researchedAt}`);
  lines.push(`Origem: ${result.fromCache ? "CACHE (até 7 dias)" : "WEB (fresh)"}`);
  lines.push("");
  lines.push(`Assinatura atual: ${result.signature}`);
  lines.push(`Status: ${result.deprecated ? "DEPRECATED" : "ATIVO"}`);
  if (result.replacement) {
    lines.push(`Substituto recomendado: ${result.replacement}`);
  }
  lines.push("");
  lines.push(`Resumo:`);
  lines.push(result.summary);
  lines.push("");
  lines.push(`Fontes consultadas:`);
  for (const src of result.sources) {
    lines.push(`  - ${src}`);
  }
  lines.push("");
  lines.push(`Conteúdo bruto (truncado):`);
  lines.push(result.rawContent);
  return lines.join("\n");
}

/**
 * Get cache statistics (for debugging/UI).
 */
export function getCacheStats(): { entries: number; oldestEntry: string | null; sizeBytes: number } {
  const cache = loadCache();
  let oldest: number | null = null;
  for (const entry of cache.values()) {
    const t = new Date(entry.cachedAt).getTime();
    if (!Number.isNaN(t) && (oldest === null || t < oldest)) oldest = t;
  }
  let sizeBytes = 0;
  try {
    if (fs.existsSync(getCachePath())) {
      sizeBytes = fs.statSync(getCachePath()).size;
    }
  } catch {
    // ignore
  }
  return {
    entries: cache.size,
    oldestEntry: oldest ? new Date(oldest).toISOString() : null,
    sizeBytes,
  };
}

/** Clear the entire research cache. */
export function clearCache(): number {
  const cache = loadCache();
  const count = cache.size;
  saveCache(new Map());
  return count;
}
