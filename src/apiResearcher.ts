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
const MAX_CONTENT_LENGTH = 8000;
const SEARCH_TIMEOUT_MS = 10_000;   // reduced — fail fast instead of hanging
const READ_TIMEOUT_MS = 15_000;     // reduced
const MAX_SEARCH_RETRIES = 2;       // reduced from 3 — 2 attempts is enough
const MAX_READ_RETRIES = 2;
const RETRY_DELAY_MS = 1000;        // reduced from 2s — fail faster

// Rotating user agents to avoid rate limiting
const USER_AGENTS = [
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

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
  const p = getCachePath();
  try {
    if (!fs.existsSync(p)) return new Map();
    const raw = fs.readFileSync(p, "utf8");
    const obj = JSON.parse(raw) as Record<string, CacheEntry>;
    return new Map(Object.entries(obj));
  } catch (err) {
    // BUG FIX: previously this silently returned an empty cache on any error
    // (corrupt JSON, permission error, etc.). The user got no indication that
    // their cache was reset. Log a warning so the failure is visible.
    log.warn(`apiResearcher: cache load failed, starting fresh: ${(err as Error).message}`);
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

/**
 * Comprehensive HTML entity decoder.
 * Handles:
 *   - Named entities: &amp; &lt; &gt; &quot; &nbsp; &apos; &ccedil; &aacute; etc.
 *   - Numeric decimal entities: &#231; (ç) &#227; (ã) &#233; (é) etc.
 *   - Numeric hex entities: &#xE7; &#xE3; &#xE9; etc.
 *
 * This replaces the previous incomplete decoder that only handled a handful
 * of entities, causing bugs like "Fa&#231;a" appearing instead of "Faça".
 */
const NAMED_ENTITIES: Record<string, string> = {
  // Basic
  "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'",
  "nbsp": " ", "copy": "©", "reg": "®", "trade": "™", "mdash": "—",
  "ndash": "–", "hellip": "…", "laquo": "«", "raquo": "»",
  // Accented chars (Latin-1 Supplement)
  "agrave": "à", "aacute": "á", "acirc": "â", "atilde": "ã", "auml": "ä",
  "aring": "å", "aelig": "æ", "ccedil": "ç",
  "egrave": "è", "eacute": "é", "ecirc": "ê", "euml": "ë",
  "igrave": "ì", "iacute": "í", "icirc": "î", "iuml": "ï",
  "ntilde": "ñ",
  "ograve": "ò", "oacute": "ó", "ocirc": "ô", "otilde": "õ", "ouml": "ö",
  "ugrave": "ù", "uacute": "ú", "ucirc": "û", "uuml": "ü",
  "yacute": "ý", "yuml": "ÿ",
  // Uppercase accented
  "Agrave": "À", "Aacute": "Á", "Acirc": "Â", "Atilde": "Ã", "Auml": "Ä",
  "Ccedil": "Ç",
  "Egrave": "È", "Eacute": "É", "Ecirc": "Ê", "Euml": "Ë",
  "Iacute": "Í",
  "Ntilde": "Ñ",
  "Oacute": "Ó", "Otilde": "Õ",
  "Uacute": "Ú",
  // Symbols
  "deg": "°", "plusmn": "±", "times": "×", "divide": "÷",
  "euro": "€", "pound": "£", "cent": "¢", "yen": "¥",
  "bull": "•", "dagger": "†", "Dagger": "‡",
  "permil": "‰", "prime": "′", "Prime": "″",
  "lsaquo": "‹", "rsaquo": "›",
  "infin": "∞", "ne": "≠", "le": "≤", "ge": "≥",
  "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ",
  "pi": "π", "Sigma": "Σ", "sum": "∑",
};

function decodeHtmlEntities(text: string): string {
  if (!text || !text.includes("&")) return text;

  return text
    // Numeric decimal entities: &#NNN;
    .replace(/&#(\d{1,7});/g, (_, dec) => {
      try {
        const code = parseInt(dec, 10);
        if (code > 0 && code <= 0x10FFFF) return String.fromCodePoint(code);
      } catch { /* ignore */ }
      return "";
    })
    // Numeric hex entities: &#xHH; or &#XHH;
    .replace(/&#[xX]([0-9a-fA-F]{1,6});/g, (_, hex) => {
      try {
        const code = parseInt(hex, 16);
        if (code > 0 && code <= 0x10FFFF) return String.fromCodePoint(code);
      } catch { /* ignore */ }
      return "";
    })
    // Named entities: &name;
    .replace(/&(\w{2,15});/g, (full, name) => {
      return NAMED_ENTITIES[name] ?? full;
    });
}

/** Fetch URL using Node.js native fetch (no curl dependency). */
async function fetchUrl(url: string, timeoutMs: number = 10000): Promise<{ ok: boolean; text: string; status: number }> {
  // BUG FIX: previously, `clearTimeout(timer)` ran right after `await fetch()`
  // (headers received) but BEFORE `await response.text()` (body read). Once
  // the timer was cleared, the AbortController could never fire — so a slow
  // or stalled body read (large HTML pages, slow servers) hung forever with
  // no timeout protection. The timer is now cleared in a finally block so
  // the abort signal stays armed for the ENTIRE fetch+body-read cycle.
  //
  // Also: the catch block used to silently return a bare {ok:false,...} with
  // no error info, so callers logged "fetch failed" with no reason. We now
  // log the actual error at debug level for diagnosability.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    const text = await response.text();
    return { ok: response.ok, text, status: response.status };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (err?.message ?? String(err));
    log.debug(`[WEB_SEARCH] fetchUrl failed for ${url.slice(0, 80)}: ${reason}`);
    return { ok: false, text: "", status: 0 };
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Parse Bing HTML search results.
 * Bing wraps URLs in redirect links (bing.com/ck/a?...&u=BASE64...) and
 * puts results in <li class="b_algo"> blocks with <h2><a> for title/link
 * and <p> for snippet.
 */
function parseBingResults(htmlRaw: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];

  // CRITICAL: Bing returns HTML entities (&amp; instead of &).
  // Must decode BEFORE parsing, otherwise regex for "u=a1" won't match
  // because the raw HTML has "&amp;u=a1".
  // Use comprehensive decoder that handles ALL entity types (named, numeric
  // decimal, numeric hex) — the old decoder missed numeric entities like
  // &#231; (ç), causing "Fa&#231;a" to appear instead of "Faça".
  const html = decodeHtmlEntities(htmlRaw);

  // Split by b_algo blocks
  const algoBlocks = html.split(/class="b_algo"/).slice(1);

  for (const block of algoBlocks) {
    if (results.length >= num) break;

    // Extract URL: Bing encodes real URL in base64url after &u=a1
    // Note: Bing uses base64URL (with - and _) not standard base64 (with + and /)
    const urlMatch = block.match(/u=a1([A-Za-z0-9+/=_-]+)/);
    if (!urlMatch) continue;

    let url = "";
    try {
      let encoded = urlMatch[1];
      // Convert base64url to standard base64
      encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
      // Add padding
      const padding = 4 - (encoded.length % 4);
      if (padding !== 4) encoded += "=".repeat(padding);
      url = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      continue;
    }
    // Skip Bing internal links
    if (!url.startsWith("http") || url.includes("bing.com/")) continue;

    // Extract title: <h2 ...><a ...>TITLE</a></h2>
    const titleMatch = block.match(/<h2[^>]*><a[^>]*>([\s\S]*?)<\/a><\/h2>/);
    if (!titleMatch) continue;
    const title = titleMatch[1]
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!title) continue;

    // Extract snippet: <p> after the title
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    let snippet = "";
    if (snippetMatch) {
      snippet = snippetMatch[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    results.push({ url, title, snippet });
  }

  return results;
}

/**
 * Parse Bing NEWS search results.
 * Bing News (bing.com/news/search) returns results in a different HTML
 * structure than regular Bing search. Results are in <div class="news-card">
 * or <div class="t_t"> blocks, with links in <a> tags and snippets in <p>.
 * This is used when the query looks like a news search (contains "news",
 * "latest", "today", "announcement", "2026", etc.) to get specific articles
 * instead of generic homepages.
 */
function parseBingNewsResults(htmlRaw: string, num: number): SearchResult[] {
  const results: SearchResult[] = [];
  const html = decodeHtmlEntities(htmlRaw);

  // Bing News uses <div class="news-card"> or <div class="t_t"> for results
  // Try multiple selectors since Bing changes their HTML structure frequently

  // Selector 1: news-card divs
  const cardBlocks = html.split(/class="news-card"/).slice(1);
  for (const block of cardBlocks) {
    if (results.length >= num) break;

    // Extract URL from <a href="...">
    const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>/);
    if (!linkMatch) continue;
    let url = linkMatch[1];
    // Bing news links may be wrapped in redirect
    if (url.includes("bing.com/ck/")) {
      const uMatch = url.match(/u=([A-Za-z0-9+/=_-]+)/);
      if (uMatch) {
        try {
          let encoded = uMatch[1].replace(/-/g, "+").replace(/_/g, "/");
          const padding = 4 - (encoded.length % 4);
          if (padding !== 4) encoded += "=".repeat(padding);
          url = Buffer.from(encoded, "base64").toString("utf8");
        } catch { /* ignore */ }
      }
    }
    if (!url.startsWith("http") || url.includes("bing.com/")) continue;

    // Extract title from <a>...</a> or <h3>...</h3>
    const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/) ??
                       block.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    if (!title || title.length < 5) continue;

    // Extract snippet
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
      : "";

    results.push({ url, title, snippet });
  }

  // Selector 2: if news-card didn't work, try general link extraction
  if (results.length === 0) {
    // Look for all <a> tags with href pointing to external news sites
    const linkRegex = /<a[^>]+href="(https?:\/\/(?!www\.bing\.com|bing\.com|m\.bing\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    const seen = new Set<string>();
    while ((m = linkRegex.exec(html)) !== null && results.length < num) {
      const url = m[1];
      if (seen.has(url)) continue;
      seen.add(url);
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      if (title.length < 10) continue;
      // Skip obvious navigation/social links
      if (/^(Home|Sign in|Login|Subscribe|Follow|Share|Menu)$/i.test(title)) continue;
      results.push({ url, title, snippet: "" });
    }
  }

  return results;
}

/**
 * Detect if a query is news-related (should use Bing News instead of regular Bing).
 * Returns true for queries about recent events, announcements, launches, etc.
 *
 * ANTI-KEYWORDS: queries containing "documentation", "API", "docs", "reference",
 * "exemplo", "tutorial" are NEVER treated as news — even if they contain "2026".
 * This prevents API research queries like "TweenService roblox API documentation 2026"
 * from being routed to Bing News (which would return articles instead of docs).
 */
function isNewsQuery(query: string): boolean {
  const q = query.toLowerCase();

  // Anti-keywords: if present, this is a documentation/API search, not news.
  // These should ALWAYS use regular Bing Web (which prioritizes official docs).
  const antiKeywords = [
    "documentation", "documentação", "docs", "reference", "referência",
    "api ", "api,", "api", "tutorial", "exemplo", "example",
    "guia", "guide", "how to", "como usar", "como fazer",
    "signature", "assinatura", "parameter", "parâmetro",
    "syntax", "sintaxe", "usage", "uso",
  ];
  // Check anti-keywords first — if found, NOT a news query
  for (const ak of antiKeywords) {
    if (q.includes(ak)) return false;
  }

  const newsKeywords = [
    "news", "latest", "today", "announcement", "announced", "launched",
    "release", "released", "update", "updated", "2026", "2025", "2024",
    "recent", "current", "happening", "this week", "this month",
    "novo", "nova", "notícia", "noticias", "lançamento", "atualização",
    "recente", "hoje", "ontem",
  ];
  return newsKeywords.some(kw => q.includes(kw));
}

// ─── Search Source Tracking (for transparency/debugging) ────────────────────

/**
 * Tracks which search source was used for the most recent webSearch() call.
 * This is returned to the IA via getLastSearchSource() so it can diagnose
 * why results might be bad (e.g., "Bing returned generic anime sites instead
 * of Roblox game results — try adding 'roblox' to the query").
 */
let lastSearchSource = "none";

/**
 * Returns the source used for the most recent webSearch() call.
 * Possible values: "Official API (github/stackoverflow/npm/mdn)", "Searx",
 * "Bing News", "Bing", "z-ai CLI", "DuckDuckGo", "GitHub API", "none".
 */
export function getLastSearchSource(): string {
  return lastSearchSource;
}

/**
 * Cache for Searx availability check. We only probe once per session.
 * Values: "unknown" (not checked), "running" (available), "down" (not available)
 */
let searxStatus: "unknown" | "running" | "down" = "unknown";
let searxUrl = "";

/**
 * Check if Searx is running locally (Python: port 8888, Docker: port 8080).
 * Caches the result so we only probe once per session.
 *
 * Searx must be configured with JSON format enabled in settings.yml:
 *   search:
 *     formats:
 *       - html
 *       - json
 */
async function checkSearxAvailable(): Promise<boolean> {
  if (searxStatus === "running") return true;
  if (searxStatus === "down") return false;

  // Try Python default (8888) then Docker default (8080)
  const candidates = [
    "http://localhost:8888",
    "http://localhost:8080",
    "http://127.0.0.1:8888",
    "http://127.0.0.1:8080",
  ];

  for (const base of candidates) {
    // BUG FIX: clearTimeout was called after fetch() but before resp.json(),
    // so the JSON body read had no timeout protection. Moved to finally.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const testUrl = `${base}/search?q=test&format=json`;
      const resp = await fetch(testUrl, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        if (data && typeof data === "object" && "results" in data) {
          searxStatus = "running";
          searxUrl = base;
          console.log(`[WEB_SEARCH] Searx detected at ${base}`);
          return true;
        }
      }
    } catch {
      // Not running on this port, try next
    } finally {
      clearTimeout(timer);
    }
  }

  searxStatus = "down";
  return false;
}

/**
 * Search using local Searx instance.
 * Searx aggregates Google + Bing + DuckDuckGo + 70+ other engines.
 * Returns JSON with { results: [{ url, title, content, engine, score }] }
 */
async function searchWithSearx(query: string, num: number): Promise<SearchResult[]> {
  if (searxStatus !== "running") return [];

  // BUG FIX: clearTimeout was called after fetch() but before resp.json(),
  // so the JSON body read had no timeout protection. Moved to finally.
  // Also: the catch block was bare, swallowing the error with no debug info.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const searchUrl = `${searxUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=1`;
    const resp = await fetch(searchUrl, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    if (!data?.results || !Array.isArray(data.results)) return [];

    const results: SearchResult[] = data.results
      .slice(0, num)
      .filter((r: any) => r.url && r.title)
      .map((r: any) => ({
        url: r.url as string,
        title: decodeHtmlEntities(String(r.title).replace(/<[^>]+>/g, "").trim()),
        snippet: decodeHtmlEntities(String(r.content ?? "").replace(/<[^>]+>/g, "").trim()),
      }));

    if (results.length > 0) {
      console.log(`[WEB_SEARCH] Searx: ${results.length} results for "${query.slice(0, 50)}" (engines: ${data.unresponsive_engines?.length ?? 0} down)`);
      lastSearchSource = "Searx";
    }
    return results;
  } catch (err) {
    log.debug(`[WEB_SEARCH] Searx query failed: ${(err as Error).message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ─── Official API Integrations ──────────────────────────────────────────────

/**
 * Detect if a query is code-related and should use official APIs.
 * Returns the type of API to use, or null if not applicable.
 *
 * Official APIs are 100% free, stable, and more precise than scraping:
 *   - GitHub: for repositories, code, libraries
 *   - StackOverflow: for "how to", examples, error messages
 *   - NPM: for npm packages
 *   - MDN: for web API docs (JavaScript, CSS, HTML)
 */
type OfficialApiType = "github" | "stackoverflow" | "npm" | "mdn" | null;

function detectOfficialApi(query: string): OfficialApiType {
  const q = query.toLowerCase();

  // NPM package: "npm express", "npmjs react", "package lodash"
  if (/\bnpm\b/.test(q) || q.includes("npmjs") || q.includes("node package")) {
    return "npm";
  }

  // MDN: "mdn array.map", "javascript fetch", "css flexbox", "html canvas"
  if (q.includes("mdn") ||
      (/\b(javascript|js|typescript|css|html|dom|web api)\b/.test(q) &&
       !q.includes("roblox") && !q.includes("lua"))) {
    return "mdn";
  }

  // StackOverflow: "how to", "error", "exception", "stackoverflow", questions
  if (q.includes("stackoverflow") ||
      q.includes("how to") || q.includes("como fazer") ||
      q.includes("como usar") || q.includes("error ") ||
      q.includes("exception") || q.includes("undefined is not")) {
    return "stackoverflow";
  }

  // GitHub: "github", "repository", "library", "framework"
  if (q.includes("github") || q.includes("repository") ||
      q.includes("repositório") || q.includes("library") ||
      q.includes("biblioteca") || q.includes("framework")) {
    return "github";
  }

  return null;
}

/**
 * Search GitHub repositories via official API (no auth needed, 60 req/hour).
 * https://docs.github.com/en/rest/search
 */
async function searchGitHubApi(query: string, num: number): Promise<SearchResult[]> {
  // BUG FIX: clearTimeout was after fetch() but before resp.json() — body
  // read had no timeout protection. Moved to finally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    // Extract search terms — remove "github", "repository", etc.
    const searchTerms = query
      .replace(/\b(github|repository|repositório|library|biblioteca|framework)\b/gi, "")
      .trim();
    if (!searchTerms) return [];

    const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchTerms)}&sort=stars&order=desc&per_page=${num}`;
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": "claude-killer/1.0",
      },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    if (!data?.items || !Array.isArray(data.items)) return [];

    const results: SearchResult[] = data.items.slice(0, num).map((r: any) => ({
      url: r.html_url as string,
      title: r.full_name as string,
      snippet: `${r.description ?? ""} ⭐ ${r.stargazers_count ?? 0} stars · ${r.language ?? "N/A"}`,
    }));

    console.log(`[WEB_SEARCH] GitHub API: ${results.length} results for "${searchTerms.slice(0, 50)}"`);
    lastSearchSource = "Official API (github)";
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search StackOverflow via official API (no auth needed, unlimited).
 * https://api.stackexchange.com/docs/search
 */
async function searchStackOverflowApi(query: string, num: number): Promise<SearchResult[]> {
  // BUG FIX: clearTimeout was after fetch() but before resp.json() — body
  // read had no timeout protection. Moved to finally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    // StackOverflow search: use intitle for title-based search
    const searchTerms = query
      .replace(/\b(how to|como fazer|como usar|error|exception|stackoverflow)\b/gi, "")
      .trim();
    if (!searchTerms) return [];

    const apiUrl = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=votes&q=${encodeURIComponent(searchTerms)}&site=stackoverflow&pagesize=${num}`;
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    if (!data?.items || !Array.isArray(data.items)) return [];

    const results: SearchResult[] = data.items.slice(0, num).map((r: any) => ({
      url: r.link as string,
      title: decodeHtmlEntities(r.title),
      snippet: `Score: ${r.score} · ${r.answer_count} answers · Tags: ${(r.tags ?? []).slice(0, 5).join(", ")}`,
    }));

    console.log(`[WEB_SEARCH] StackOverflow API: ${results.length} results for "${searchTerms.slice(0, 50)}"`);
    lastSearchSource = "Official API (stackoverflow)";
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search NPM registry for packages (no auth needed, unlimited).
 * https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
 */
async function searchNpmApi(query: string, num: number): Promise<SearchResult[]> {
  try {
    // Extract package name from query
    const packageName = query
      .replace(/\b(npm|npmjs|node package|package)\b/gi, "")
      .trim()
      .split(/\s+/)[0]; // take first word as package name

    if (!packageName) return [];

    // Try exact package first
    // BUG FIX: clearTimeout was after fetch() but before resp.json() — body
    // read had no timeout protection. Moved to finally.
    const exactUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    let resp: any;
    try {
      resp = await fetch(exactUrl, {
        signal: controller.signal,
        headers: { "Accept": "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp?.ok) {
      const data = await resp.json() as any;
      const latest = data["dist-tags"]?.latest;
      const version = data.versions?.[latest];
      if (data.name && latest) {
        lastSearchSource = "Official API (npm)";
        console.log(`[WEB_SEARCH] NPM API: 1 result (exact) for "${packageName}"`);
        return [{
          url: `https://www.npmjs.com/package/${data.name}`,
          title: `${data.name} v${latest}`,
          snippet: `${data.description ?? ""} · License: ${version?.license ?? "N/A"} · Keywords: ${(data.keywords ?? []).slice(0, 5).join(", ")}`,
        }];
      }
    }

    // If exact match fails, use the search endpoint
    const searchUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${num}`;
    const controller2 = new AbortController();
    const timer2 = setTimeout(() => controller2.abort(), SEARCH_TIMEOUT_MS);
    let resp2: any;
    try {
      resp2 = await fetch(searchUrl, {
        signal: controller2.signal,
        headers: { "Accept": "application/json" },
      });
    } finally {
      clearTimeout(timer2);
    }

    if (!resp2?.ok) return [];
    const data2 = await resp2.json() as any;
    if (!data2?.objects) return [];

    const results: SearchResult[] = data2.objects.slice(0, num).map((o: any) => ({
      url: `https://www.npmjs.com/package/${o.package.name}`,
      title: `${o.package.name} v${o.package.version}`,
      snippet: `${o.package.description ?? ""} · Keywords: ${(o.package.keywords ?? []).slice(0, 5).join(", ")}`,
    }));

    console.log(`[WEB_SEARCH] NPM API: ${results.length} results for "${packageName}"`);
    lastSearchSource = "Official API (npm)";
    return results;
  } catch {
    return [];
  }
}

/**
 * Search MDN (Mozilla Developer Network) via official API.
 * Uses the public search endpoint.
 */
async function searchMdnApi(query: string, num: number): Promise<SearchResult[]> {
  // BUG FIX: clearTimeout was after fetch() but before resp.json() — body
  // read had no timeout protection. Moved to finally.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const searchTerms = query
      .replace(/\b(mdn|javascript|js|typescript|css|html|dom|web api)\b/gi, "")
      .trim();
    if (!searchTerms) return [];

    const apiUrl = `https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(searchTerms)}&locale=en-US&size=${num}`;
    const resp = await fetch(apiUrl, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    if (!data?.documents) return [];

    const results: SearchResult[] = data.documents.slice(0, num).map((d: any) => ({
      url: d.mdn_url?.startsWith("http") ? d.mdn_url : `https://developer.mozilla.org${d.mdn_url}`,
      title: d.title,
      snippet: d.summary ?? "",
    }));

    console.log(`[WEB_SEARCH] MDN API: ${results.length} results for "${searchTerms.slice(0, 50)}"`);
    lastSearchSource = "Official API (mdn)";
    return results;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try the appropriate official API based on query type.
 * Returns empty array if no official API applies or if it fails.
 */
async function searchWithOfficialApi(query: string, num: number): Promise<SearchResult[]> {
  const apiType = detectOfficialApi(query);
  if (!apiType) return [];

  switch (apiType) {
    case "github": return searchGitHubApi(query, num);
    case "stackoverflow": return searchStackOverflowApi(query, num);
    case "npm": return searchNpmApi(query, num);
    case "mdn": return searchMdnApi(query, num);
    default: return [];
  }
}

export async function webSearch(query: string, num: number = 5, newsMode?: boolean): Promise<SearchResult[]> {
  // ════════════════════════════════════════════════════════════════════════
  // SEARCH PRIORITY (all free, no API keys required):
  //
  // 1. Official APIs (GitHub, StackOverflow, NPM, MDN)
  //    → For code-related queries: 100% stable, 100% free, most precise
  //    → Only triggers when query matches patterns (e.g., "npm express",
  //      "how to fix error", "javascript fetch")
  //
  // 2. Searx Local (if running)
  //    → User-installed via `python3 scripts/setup-searx.py`
  //    → Aggregates Google + Bing + DDG, no rate limits, no blocking
  //    → Auto-detected on first call (checks localhost:8888 and :8080)
  //
  // 3. Bing News (for news queries only)
  //    → When query contains "news", "latest", "2026", "announcement"
  //    → AND no anti-keywords ("documentation", "api", "tutorial")
  //
  // 4. Bing Web (primary scraping fallback)
  //    → For general queries and API documentation
  //
  // 5. z-ai CLI (only in Super Z environment)
  //
  // 6. DuckDuckGo (last resort, often CAPTCHA-blocked)
  //
  // 7. GitHub API (old curl-based, kept for backwards compat)
  // ════════════════════════════════════════════════════════════════════════

  // ── Layer 1: Official APIs (highest priority for code queries) ───────────
  // Only applies when newsMode is not explicitly true (news queries skip this)
  if (newsMode !== true) {
    const officialResults = await searchWithOfficialApi(query, num);
    if (officialResults.length > 0) {
      return officialResults;
    }
  }

  // ── Layer 2: Searx Local (if available) ──────────────────────────────────
  // Searx aggregates Google + Bing + DDG, giving better quality than scraping.
  // It's auto-detected — if not running, this is a no-op (skipped after first check).
  if (newsMode !== true) {  // Searx works for both news and general, but skip for explicit news
    const searxAvailable = await checkSearxAvailable();
    if (searxAvailable) {
      const searxResults = await searchWithSearx(query, num);
      if (searxResults.length > 0) {
        return searxResults;
      }
    }
  }

  // Determine whether to use Bing News. The `newsMode` parameter lets callers
  // explicitly override the auto-detection:
  //   - newsMode === true  → always use Bing News (even if isNewsQuery is false)
  //   - newsMode === false → never use Bing News (even if isNewsQuery is true)
  //   - newsMode === undefined → auto-detect via isNewsQuery()
  // This is important because API research queries ("TweenService API docs 2026")
  // contain "2026" which would trigger news mode, but they should use regular
  // Bing Web to get official documentation instead of articles.
  const useNews = newsMode ?? isNewsQuery(query);

  // If the query looks like a news search, try Bing News FIRST to get
  // specific articles instead of generic homepages.
  if (useNews) {
    for (let attempt = 0; attempt < MAX_SEARCH_RETRIES; attempt++) {
      try {
        // Bing News search with date filter (last 7 days = interval="7")
        const newsUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&qft=interval%3d%227%22&form=PTFNR&count=${num}`;
        const newsResult = await fetchUrl(newsUrl, SEARCH_TIMEOUT_MS);
        if (newsResult.ok && newsResult.text) {
          const results = parseBingNewsResults(newsResult.text, num);
          if (results.length > 0) {
            lastSearchSource = "Bing News";
            console.log(`[WEB_SEARCH] Bing News: ${results.length} results for "${query.slice(0, 50)}"`);
            return results;
          }
        }
        if (attempt < MAX_SEARCH_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      } catch {
        if (attempt < MAX_SEARCH_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }
  }

  // PRIMARY: Bing search via native fetch (no curl dependency, works on Windows + Linux + Mac)
  for (let attempt = 0; attempt < MAX_SEARCH_RETRIES; attempt++) {
    try {
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${num}&setlang=en`;
      const bingResult = await fetchUrl(searchUrl, SEARCH_TIMEOUT_MS);
      if (bingResult.ok && bingResult.text) {
        const results = parseBingResults(bingResult.text, num);
        if (results.length > 0) {
          lastSearchSource = "Bing";
          console.log(`[WEB_SEARCH] Bing: ${results.length} results for "${query.slice(0, 50)}"`);
          return results;
        }
        // DEBUG: save HTML when parse fails
        try {
          const debugFile = path.join(os.tmpdir(), `claude-killer-bing-debug-${Date.now()}.html`);
          fs.writeFileSync(debugFile, bingResult.text.slice(0, 50000));
          console.log(`[WEB_SEARCH] Bing: 0 results. HTML saved to ${debugFile} (${bingResult.text.length} bytes, b_algo: ${(bingResult.text.match(/class="b_algo"/g) || []).length})`);
        } catch { /* ignore */ }
      } else {
        console.log(`[WEB_SEARCH] Bing attempt ${attempt+1}: fetch failed (ok=${bingResult.ok}, status=${bingResult.status})`);
      }
      if (attempt < MAX_SEARCH_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    } catch (err) {
      console.log(`[WEB_SEARCH] Bing attempt ${attempt+1}: error ${(err as Error).message?.slice(0, 80)}`);
      if (attempt < MAX_SEARCH_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  // Fallback 1: z-ai CLI (only in Super Z environment)
  // BUG FIX: previously, if JSON.parse threw (malformed output from z-ai),
  // the catch block swallowed the error AND the tmpFile was never deleted —
  // leaking a temp file per failed attempt. We now use a finally block to
  // guarantee cleanup regardless of whether parse succeeds or fails.
  const tmpFile = path.join(os.tmpdir(), `claude-killer-search-${Date.now()}.json`);
  try {
    const result = await runCmd(
      "z-ai",
      ["function", "-n", "web_search", "-a", JSON.stringify({ query, num }), "-o", tmpFile],
      SEARCH_TIMEOUT_MS
    );
    if (result.ok && fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
      if (Array.isArray(data)) {
        return data.slice(0, num).map((r: any) => ({
          url: r.url ?? "",
          title: r.name ?? "",
          snippet: r.snippet ?? "",
        }));
      }
    }
  } catch {
    // z-ai CLI not available or returned malformed output, fall through
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  // Fallback 2: DuckDuckGo via native fetch (last resort)
  try {
    const ddgResult = await fetchUrl(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      SEARCH_TIMEOUT_MS
    );
    if (ddgResult.ok && ddgResult.text) {
      if (ddgResult.text.includes("anomaly-modal") || ddgResult.text.includes("Unfortunately, bots")) {
        console.log("[WEB_SEARCH] DuckDuckGo: CAPTCHA detected, skipping");
      } else {
        const results: SearchResult[] = [];
        const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        const snippets: string[] = [];
        let sm;
        while ((sm = snippetRegex.exec(ddgResult.text)) !== null) {
          snippets.push(decodeHtmlEntities(sm[1].replace(/<[^>]+>/g, "").trim()));
        }
        let m;
        let i = 0;
        while ((m = linkRegex.exec(ddgResult.text)) !== null && i < num) {
          let url = m[1];
          const uddgMatch = url.match(/uddg=([^&]+)/);
          if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
          if (url.startsWith("//")) url = "https:" + url;
          const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, "").trim());
          results.push({ url, title, snippet: decodeHtmlEntities(snippets[i] ?? "") });
          i++;
        }
        if (results.length > 0) {
          console.log(`[WEB_SEARCH] DuckDuckGo: ${results.length} results`);
          lastSearchSource = "DuckDuckGo";
          return results;
        }
      }
    }
  } catch {
    // DuckDuckGo unavailable
  }

  // Fallback 3: GitHub search API for code-related queries
  if (query.toLowerCase().includes("roblox") || query.toLowerCase().includes("api") ||
      query.toLowerCase().includes("github") || query.toLowerCase().includes("library")) {
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
 * Extract readable text from HTML — prioritizes <article>, <main>, and content
 * divs over navigation/menu HTML.
 */
function extractTextFromHtml(html: string): string {
  // Try to extract from <article> first (most news sites use this)
  let content = "";
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) content = articleMatch[1];

  // If no <article>, try <main>
  if (!content) {
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) content = mainMatch[1];
  }

  // If still no content, try common content divs
  if (!content) {
    const contentDiv = html.match(/<div[^>]*(?:class|id)="[^"]*(?:content|article|post-body|entry-content|story-body|article-body)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (contentDiv) content = contentDiv[1];
  }

  // Fall back to full HTML if no content section found
  if (!content) content = html;

  // Strip scripts, styles, and HTML tags
  let text = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
  // Comprehensive entity decoding (numeric + named, handles ç ã é etc.)
  text = decodeHtmlEntities(text);
  text = text.replace(/\s+/g, " ").trim();

  // If extracted text is too short (JS-rendered SPA with minimal HTML),
  // try meta tags as fallback. Many news sites (g1.com.br, interestingengineering.com)
  // render content via JS and only have meta description in the static HTML.
  if (text.length < 100) {
    const metaFallback = extractMetaTags(html);
    if (metaFallback.length > text.length) {
      return metaFallback;
    }
  }

  // Last resort: collect all <p> tags from the full HTML
  if (text.length < 100) {
    const paragraphs = html.match(/<p[^>]*>[\s\S]*?<\/p>/gi) ?? [];
    if (paragraphs.length > 0) {
      const pText = paragraphs
        .map(p => p.replace(/<[^>]+>/g, " "))
        .map(p => decodeHtmlEntities(p))
        .map(p => p.replace(/\s+/g, " ").trim())
        .filter(p => p.length > 30)
        .join(" ");
      if (pText.length > text.length) return pText;
    }
  }

  return text;
}

/**
 * Extract text from HTML meta tags (og:description, description, twitter:description).
 * Used as fallback for JS-rendered sites that have minimal static HTML.
 */
function extractMetaTags(html: string): string {
  const tags: string[] = [];

  // og:description
  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (ogDesc?.[1]) tags.push(decodeHtmlEntities(ogDesc[1]));

  // meta description
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (metaDesc?.[1]) tags.push(decodeHtmlEntities(metaDesc[1]));

  // twitter:description
  const twDesc = html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i);
  if (twDesc?.[1]) tags.push(decodeHtmlEntities(twDesc[1]));

  // og:title as a last resort
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle?.[1]) tags.push(decodeHtmlEntities(ogTitle[1]));

  // <title> tag
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleTag?.[1]) tags.push(decodeHtmlEntities(titleTag[1]));

  return tags.join(" ").trim();
}

/**
 * Check if a URL is from a site that supports .md (markdown) versions
 * and return the markdown URL if available.
 */
function tryMarkdownUrl(url: string): string | null {
  // Roblox docs: create.roblox.com/docs/... → create.roblox.com/docs/en-us/...md
  if (url.includes("create.roblox.com/docs/")) {
    // Remove any existing locale prefix and add en-us + .md
    const cleanUrl = url.replace(/\/docs\/(en-us\/)?/, "/docs/en-us/");
    return cleanUrl.endsWith(".md") ? cleanUrl : cleanUrl + ".md";
  }
  return null;
}

/**
 * Read a web page and extract its text content.
 * Uses z-ai CLI's page_reader function if available, then falls back to curl.
 * For JS-rendered sites (like Roblox docs), automatically tries .md version.
 */
export async function webRead(url: string): Promise<string> {
  // Try z-ai CLI first (only in Super Z environment)
  // BUG FIX: previously, if JSON.parse threw (malformed output from z-ai),
  // the catch block swallowed the error AND the tmpFile was never deleted —
  // leaking a temp file per failed attempt. We now use a finally block to
  // guarantee cleanup regardless of whether parse succeeds or fails.
  const tmpFile = path.join(os.tmpdir(), `claude-killer-page-${Date.now()}.json`);
  try {
    const result = await runCmd(
      "z-ai",
      ["function", "-n", "page_reader", "-a", JSON.stringify({ url }), "-o", tmpFile],
      READ_TIMEOUT_MS
    );
    if (result.ok && fs.existsSync(tmpFile)) {
      const data = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
      const html = data?.data?.html ?? data?.html ?? "";
      const text = extractTextFromHtml(html);
      if (text.length > 100) return text.slice(0, MAX_CONTENT_LENGTH);
    }
  } catch { /* z-ai not available */ }
  finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  // Primary: native fetch with retry and content extraction
  for (let attempt = 0; attempt < MAX_READ_RETRIES; attempt++) {
    try {
      const pageResult = await fetchUrl(url, READ_TIMEOUT_MS);
      if (pageResult.ok && pageResult.text) {
        const text = extractTextFromHtml(pageResult.text);
        if (text.length > 100) return text.slice(0, MAX_CONTENT_LENGTH);
      }
      if (attempt < MAX_READ_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    } catch {
      if (attempt < MAX_READ_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  // JS-rendered site fallback: try .md version if available
  const mdUrl = tryMarkdownUrl(url);
  if (mdUrl && mdUrl !== url) {
    try {
      const mdResult = await fetchUrl(mdUrl, READ_TIMEOUT_MS);
      if (mdResult.ok && mdResult.text && mdResult.text.length > 100) {
        return mdResult.text.slice(0, MAX_CONTENT_LENGTH);
      }
    } catch { /* .md not available */ }
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
 *
 * ASYNC: merges built-in TRUSTED_SOURCES with any custom researchSources
 * defined in the active mode. This lets mode authors add their preferred
 * docs sites (e.g. terraform.io/docs for DevOps mode).
 */
async function pickBestSource(results: SearchResult[], language: string): Promise<SearchResult | null> {
  if (results.length === 0) return null;

  // Built-in trusted sources
  const builtIn = TRUSTED_SOURCES[language.toLowerCase()] ?? [];

  // Merge with mode-specific custom sources (if any)
  let custom: string[] = [];
  try {
    const { getActiveResearchSources } = await import("./modeExtensions.js");
    const allSources = await getActiveResearchSources();
    custom = allSources[language.toLowerCase()] ?? [];
  } catch {
    // modeExtensions not available - use built-in only
  }

  const trusted = [...builtIn, ...custom];

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
  // CRITICAL: pass newsMode=false explicitly. The query contains the current
  // year ("2026") which would trigger isNewsQuery() → Bing News. But API
  // documentation should use regular Bing Web, which prioritizes official
  // docs sites (create.roblox.com, react.dev, etc.) instead of articles.
  const searchResults = await webSearch(query, 5, false);
  if (searchResults.length === 0) {
    return {
      error: `No search results found for "${req.apiName}" in ${req.language}`,
      apiName: req.apiName,
      language: req.language,
    };
  }

  // 3. Pick best source and read it (async - merges built-in + mode sources)
  const best = await pickBestSource(searchResults, req.language);
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
    return `[ERROR] API search failed for "${result.apiName}" (${result.language}):\n${result.error}`;
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
