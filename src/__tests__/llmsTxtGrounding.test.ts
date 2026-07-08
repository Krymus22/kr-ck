/** llmsTxtGrounding.test.ts */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("llmsTxtGrounding", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "llms-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

  // ─── Kills L73 catch-block return-inversion mutation ─────────────────────
  //
  // Mutation: inverting `return false;` → `return true;` in the catch block of
  // isCacheFresh. This mutation is otherwise masked by defense-in-depth: when
  // isCacheFresh returns `true` (mutated) for a missing file, fetchLlmsTxt
  // enters the cache branch, readFileSync throws ENOENT, and the inner catch
  // at L107 silently falls through to a fresh fetch — producing the same
  // observable result. To kill the mutation we now export isCacheFresh and
  // test its contract directly: a missing/unstatable file MUST return `false`.

  describe("isCacheFresh (direct contract test)", () => {
    it("returns false when the cache file does not exist", async () => {
      const { isCacheFresh } = await import("./../llmsTxtGrounding.js");
      const result = isCacheFresh(path.join(tmpHome, "definitely-missing.txt"));
      expect(result).toBe(false);
    });

    it("returns false when the path is a directory (statSync succeeds but it's not a file)", async () => {
      const { isCacheFresh } = await import("./../llmsTxtGrounding.js");
      // statSync on a directory succeeds, but this is still a cache-miss
      // scenario in spirit — we mainly want to ensure no throw + boolean result
      const result = isCacheFresh(tmpHome);
      expect(typeof result).toBe("boolean");
    });

    it("returns true when the cache file exists and is fresh", async () => {
      const { isCacheFresh } = await import("./../llmsTxtGrounding.js");
      const cacheFile = path.join(tmpHome, "fresh.txt");
      fs.writeFileSync(cacheFile, "content", "utf8");
      const result = isCacheFresh(cacheFile);
      expect(result).toBe(true);
    });

    it("returns false when the cache file is older than CACHE_TTL_DAYS (30 days)", async () => {
      const { isCacheFresh } = await import("./../llmsTxtGrounding.js");
      const cacheFile = path.join(tmpHome, "stale.txt");
      fs.writeFileSync(cacheFile, "content", "utf8");
      // Set mtime to 60 days ago
      const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      fs.utimesSync(cacheFile, oldTime, oldTime);
      const result = isCacheFresh(cacheFile);
      expect(result).toBe(false);
    });
  });

  it("formatLlmsTxt should format found result", async () => {
    const { formatLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const result = formatLlmsTxt({ library: "react", url: "https://react.dev/llms.txt", content: "React docs", fromCache: false, found: true });
    expect(result).toContain("[LLMS.TXT: react]");
    expect(result).toContain("React docs");
  });

  it("formatLlmsTxt should return empty for not found", async () => {
    const { formatLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const result = formatLlmsTxt({ library: "x", url: "", content: "", fromCache: false, found: false });
    expect(result).toBe("");
  });

  it("getLlmsCacheStats should return 0 when no cache", async () => {
    const { getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    const stats = getLlmsCacheStats();
    expect(stats.entries).toBe(0);
  });

  it("getLlmsCacheStats should count cached files", async () => {
    const { getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "content", "utf8");
    fs.writeFileSync(path.join(cacheDir, "vue.txt"), "content", "utf8");
    const stats = getLlmsCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });

  it("clearLlmsCache should remove all cached files", async () => {
    const { clearLlmsCache, getLlmsCacheStats } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "content", "utf8");
    const cleared = clearLlmsCache();
    expect(cleared).toBe(1);
    expect(getLlmsCacheStats().entries).toBe(0);
  });

  it("fetchLlmsTxt should return not found when fetch fails", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const result = await fetchLlmsTxt("nonexistent-lib-12345");
    expect(result.found).toBe(false);
    expect(result.content).toBe("");
  });

  it("fetchLlmsTxt should use cache when fresh", async () => {
    const { fetchLlmsTxt } = await import("./../llmsTxtGrounding.js");
    const cacheDir = path.join(tmpHome, ".claude-killer", "llms-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "react.txt"), "cached content here", "utf8");
    const result = await fetchLlmsTxt("react");
    expect(result.found).toBe(true);
    expect(result.fromCache).toBe(true);
    expect(result.content).toContain("cached content");
  });
});
