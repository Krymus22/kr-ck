/**
 * toolCache.ts - Tool result caching to avoid redundant calls.
 */

import * as log from "./logger.js";

interface CacheEntry {
  key: string;
  result: string;
  timestamp: number;
  ttlMs: number;
}

/**
 * Maximum number of entries kept in a single ToolCache instance.
 *
 * PERF FIX (Round 4 — memory + perf): previously the cache Map grew
 * without bound — every `set()` added a new entry and the only way an
 * entry left was via explicit `invalidate()` / `clear()` or by being
 * lazily evicted on the next `get()` for the SAME key (which might never
 * happen). In a long-running TUI session this meant the read-only cache
 * and the search cache accumulated entries for every file/search the IA
 * had ever touched, holding their (potentially large) result strings
 * forever. We now cap the cache at MAX_ENTRIES and evict the oldest
 * entries (insertion order = LRU-ish) when the cap is exceeded. We also
 * proactively drop expired entries on every `set()` so TTL-expired
 * results don't linger until someone happens to `get()` them.
 */
const MAX_ENTRIES = 200;

export class ToolCache {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs: number = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  private makeKey(toolName: string, args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => `${k}=${JSON.stringify(args[k])}`)
      .join("&");
    return `${toolName}:${sorted}`;
  }

  /**
   * Drop all entries whose TTL has expired.
   *
   * Called from `set()` so expired entries don't accumulate. Map iteration
   * with in-place deletion is spec-safe (the spec guarantees iterators see
   * deletions correctly during iteration).
   */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > entry.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Enforce MAX_ENTRIES by evicting the oldest entries.
   * Map preserves insertion order, so the first entries are the oldest
   * (least recently inserted). This is a coarse LRU — good enough for a
   * tool-result cache where old results are unlikely to be re-requested.
   */
  private evictOldest(): void {
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  get(toolName: string, args: Record<string, unknown>): string | null {
    const key = this.makeKey(toolName, args);
    const entry = this.cache.get(key);

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    log.debug(`Cache hit: ${toolName}`);
    return entry.result;
  }

  set(toolName: string, args: Record<string, unknown>, result: string, ttlMs?: number): void {
    const key = this.makeKey(toolName, args);
    // Opportunistic cleanup: drop TTL-expired entries before adding a new
    // one so we don't accumulate dead entries that nobody will ever `get()`.
    // Cheap when the cache is small; bounded by MAX_ENTRIES otherwise.
    if (this.cache.size > 0) this.pruneExpired();
    this.cache.set(key, {
      key,
      result,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
    });
    this.evictOldest();
  }

  invalidate(toolName: string, args?: Record<string, unknown>): void {
    if (args) {
      const key = this.makeKey(toolName, args);
      this.cache.delete(key);
    } else {
      // Invalidate all entries for this tool
      for (const [key] of this.cache) {
        if (key.startsWith(`${toolName}:`)) {
          this.cache.delete(key);
        }
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  has(toolName: string, args: Record<string, unknown>): boolean {
    return this.get(toolName, args) !== null;
  }

  getStats(): { entries: number; hitRate: number } {
    return { entries: this.cache.size, hitRate: 0 };
  }
}

// Singleton cache for read-only tools (ler_arquivo, buscar_arquivos, etc.)
export const readOnlyCache = new ToolCache(30_000); // 30 second TTL

// Cache for search results (longer TTL since search results are more stable)
export const searchCache = new ToolCache(120_000); // 2 minute TTL

export function shouldCacheResult(toolName: string): boolean {
  // BUG FIX: the list previously contained only "buscar_texto_no_projeto"
  // (an internal log identifier used by contentSearch.ts), but the actual
  // tool name exposed to the model via TOOL_DEFINITIONS in apiClient.ts is
  // "buscar_texto". The agent's dispatchToolCall invokes
  // shouldCacheResult(name) with the model-facing name, so buscar_texto
  // results were NEVER cached. We now include BOTH the model-facing name
  // (buscar_texto) and the legacy internal alias (buscar_texto_no_projeto)
  // so existing callers/tests that use the alias still work.
  const cacheableTools = [
    "ler_arquivo",
    "buscar_arquivos",
    "buscar_texto",            // model-facing name (apiClient TOOL_DEFINITIONS)
    "buscar_texto_no_projeto", // legacy internal alias (contentSearch.ts log)
    "git_status",
    "git_log",
  ];
  return cacheableTools.includes(toolName);
}

export function getCachedOrExecute<T>(
  cache: ToolCache,
  toolName: string,
  args: Record<string, unknown>,
  fn: () => T
): T {
  const cached = cache.get(toolName, args);
  if (cached !== null) {
    return cached as unknown as T;
  }

  const result = fn();
  cache.set(toolName, args, result as unknown as string);
  return result;
}
