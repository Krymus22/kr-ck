/**
 * llmsTxtGrounding.ts - Fetch llms.txt documentation before using a library.
 *
 * The llms.txt standard (2026) is a file that libraries expose at their
 * website root (e.g. https://react.dev/llms.txt) with AI-optimized docs.
 *
 * When the AI is about to use a library/API, this module:
 *   1. Checks if we have cached llms.txt for that library
 *   2. If not, fetches https://[lib-domain]/llms.txt
 *   3. Extracts the relevant API section
 *   4. Injects into the AI's context
 *
 * Falls back to apiResearcher (web search) if llms.txt not available.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface LlmsTxtResult {
  library: string;
  url: string;
  content: string;
  fromCache: boolean;
  found: boolean;
}

// --- Config -----------------------------------------------------------------

const CACHE_TTL_DAYS = 30;  // llms.txt changes rarely
const MAX_CONTENT_LENGTH = 8000;
const FETCH_TIMEOUT_MS = 10_000;

// Known llms.txt locations for popular libraries
const KNOWN_LLMS_TXT: Record<string, string> = {
  "react": "https://react.dev/llms.txt",
  "next.js": "https://nextjs.org/llms.txt",
  "vue": "https://vuejs.org/llms.txt",
  "svelte": "https://svelte.dev/llms.txt",
  "astro": "https://astro.build/llms.txt",
  "tailwindcss": "https://tailwindcss.com/llms.txt",
  "typescript": "https://www.typescriptlang.org/llms.txt",
  "python": "https://docs.python.org/llms.txt",
  "rust": "https://www.rust-lang.org/llms.txt",
  "go": "https://go.dev/llms.txt",
  "roblox": "https://create.roblox.com/llms.txt",
};

// --- Cache ------------------------------------------------------------------

function getCacheDir(): string {
  // BUG FIX: previously used `process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()`.
  // `??` only falls through on null/undefined, NOT on empty string. If HOME
  // was set to `""` (some CI sandboxes), the result was a RELATIVE cache
  // path (`.claude-killer/llms-cache`) which broke cache reuse whenever
  // the agent changed cwd. Use `||` so any falsy env value falls through.
  // Also note that on POSIX, `os.homedir()` itself reads $HOME — so when
  // HOME="", os.homedir() ALSO returns "". Fall back to
  // `os.userInfo().homedir` (reads /etc/passwd on POSIX, ignoring $HOME)
  // before tmpdir as a last resort.
  return path.join(
    process.env.HOME ||
      process.env.USERPROFILE ||
      os.homedir() ||
      os.userInfo().homedir ||
      os.tmpdir(),
    ".claude-killer",
    "llms-cache"
  );
}

function getCachePath(library: string): string {
  return path.join(getCacheDir(), `${library.toLowerCase().replace(/[^a-z0-9]/g, "-")}.txt`);
}

/**
 * Check if a cached llms.txt file is fresh (within CACHE_TTL_DAYS).
 *
 * Exported so tests can verify the catch-block contract directly:
 * when the cache file does not exist (or statSync throws), this MUST
 * return `false` so the caller falls back to a fresh fetch. A mutation
 * that inverts the catch-block return to `true` would be masked by the
 * defensive readFileSync catch in fetchLlmsTxt, so we test it directly.
 */
export function isCacheFresh(cachePath: string): boolean {
  try {
    const stat = fs.statSync(cachePath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    return ageDays < CACHE_TTL_DAYS;
  } catch {
    return false;
  }
}

// --- Fetching ---------------------------------------------------------------

function runCmd(command: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout }); });
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, stdout: "" }); });
  });
}

/**
 * Fetch llms.txt for a library.
 *
 * @param library - Library name (e.g. "react", "roblox", "python")
 * @returns LlmsTxtResult with content (from cache or fresh fetch)
 */
export async function fetchLlmsTxt(library: string): Promise<LlmsTxtResult> {
  const libLower = library.toLowerCase();
  const url = KNOWN_LLMS_TXT[libLower] ?? `https://${libLower}.dev/llms.txt`;
  const cachePath = getCachePath(libLower);

  // Check cache first
  if (isCacheFresh(cachePath)) {
    try {
      const content = fs.readFileSync(cachePath, "utf8");
      log.info(`[LLMS_TXT] Cache hit for "${library}"`);
      return { library, url, content: content.slice(0, MAX_CONTENT_LENGTH), fromCache: true, found: true };
    } catch { /* cache read failed */ }
  }

  // Fetch fresh
  try {
    const result = await runCmd("curl", ["-sL", "--max-time", "10", url], FETCH_TIMEOUT_MS);
    if (result.ok && result.stdout && result.stdout.length > 100) {
      // Save to cache
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, result.stdout, "utf8");
      log.info(`[LLMS_TXT] Fetched ${url} (${result.stdout.length} bytes)`);
      return { library, url, content: result.stdout.slice(0, MAX_CONTENT_LENGTH), fromCache: false, found: true };
    }
  } catch { /* fetch failed */ }

  log.info(`[LLMS_TXT] Not found for "${library}" at ${url}`);
  return { library, url, content: "", fromCache: false, found: false };
}

/**
 * Format llms.txt content for context injection.
 */
export function formatLlmsTxt(result: LlmsTxtResult): string {
  if (!result.found) return "";
  return `[LLMS.TXT: ${result.library}]\nSource: ${result.url}\nCached: ${result.fromCache ? "yes" : "fresh"}\n\n${result.content}`;
}

/**
 * Get cache statistics.
 */
export function getLlmsCacheStats(): { entries: number; sizeBytes: number } {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return { entries: 0, sizeBytes: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
  let sizeBytes = 0;
  for (const f of files) {
    try { sizeBytes += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
  }
  return { entries: files.length, sizeBytes };
}

/**
 * Clear all cached llms.txt files.
 */
export function clearLlmsCache(): number {
  const dir = getCacheDir();
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
  for (const f of files) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* skip */ }
  }
  return files.length;
}
