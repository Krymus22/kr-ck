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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    const text = await response.text();
    return { ok: response.ok, text, status: response.status };
  } catch (err: any) {
    return { ok: false, text: "", status: 0 };
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

export async function webSearch(query: string, num: number = 5, newsMode?: boolean): Promise<SearchResult[]> {
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
      const html = data?.data?.html ?? data?.html ?? "";
      const text = extractTextFromHtml(html);
      if (text.length > 100) return text.slice(0, MAX_CONTENT_LENGTH);
    }
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch { /* z-ai not available */ }

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
