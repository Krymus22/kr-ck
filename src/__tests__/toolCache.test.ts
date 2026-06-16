/**
 * toolCache.test.ts — Tests for tool result caching module.
 */

import { describe, it, expect } from "vitest";
import { ToolCache, readOnlyCache, searchCache, shouldCacheResult, getCachedOrExecute } from "../toolCache.js";

describe("ToolCache", () => {
  it("should store and retrieve values", () => {
    const cache = new ToolCache(60000);
    cache.set("test_tool", { arg1: "val1" }, "result1");
    const result = cache.get("test_tool", { arg1: "val1" });
    expect(result).toBe("result1");
  });

  it("should return null for cache miss", () => {
    const cache = new ToolCache(60000);
    const result = cache.get("nonexistent", {});
    expect(result).toBeNull();
  });

  it("should respect TTL", async () => {
    const cache = new ToolCache(100); // 100ms TTL
    cache.set("tool", { x: 1 }, "result");
    expect(cache.get("tool", { x: 1 })).toBe("result");
    await new Promise((r) => setTimeout(r, 150));
    expect(cache.get("tool", { x: 1 })).toBeNull();
  });

  it("should invalidate specific entry", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { a: 1 }, "r1");
    cache.invalidate("tool", { a: 1 });
    expect(cache.get("tool", { a: 1 })).toBeNull();
  });

  it("should invalidate all entries for a tool", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { a: 1 }, "r1");
    cache.set("tool", { a: 2 }, "r2");
    cache.invalidate("tool");
    expect(cache.get("tool", { a: 1 })).toBeNull();
    expect(cache.get("tool", { a: 2 })).toBeNull();
  });

  it("should clear all entries", () => {
    const cache = new ToolCache(60000);
    cache.set("a", {}, "1");
    cache.set("b", {}, "2");
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("should handle different args as different entries", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { a: 1 }, "r1");
    cache.set("tool", { a: 2 }, "r2");
    expect(cache.get("tool", { a: 1 })).toBe("r1");
    expect(cache.get("tool", { a: 2 })).toBe("r2");
  });

  it("should build sorted keys for multiple args", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { z: 1, a: 2, m: 3 }, "multi");
    expect(cache.get("tool", { a: 2, m: 3, z: 1 })).toBe("multi");
    expect(cache.get("tool", { z: 1, a: 2, m: 3 })).toBe("multi");
  });

  it("should check has()", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { x: 1 }, "result");
    expect(cache.has("tool", { x: 1 })).toBe(true);
    expect(cache.has("tool", { x: 2 })).toBe(false);
  });

  it("should return stats", () => {
    const cache = new ToolCache(60000);
    cache.set("a", {}, "1");
    const stats = cache.getStats();
    expect(stats.entries).toBe(1);
  });
});

describe("shouldCacheResult", () => {
  it("should cache read-only tools", () => {
    expect(shouldCacheResult("ler_arquivo")).toBe(true);
    expect(shouldCacheResult("buscar_arquivos")).toBe(true);
    expect(shouldCacheResult("git_status")).toBe(true);
  });

  it("should not cache write tools", () => {
    expect(shouldCacheResult("aplicar_diff")).toBe(false);
    expect(shouldCacheResult("executar_comando")).toBe(false);
  });
});

describe("getCachedOrExecute", () => {
  it("should return cached value on hit", () => {
    const cache = new ToolCache(60000);
    cache.set("tool", { a: 1 }, "cached");
    const result = getCachedOrExecute(cache, "tool", { a: 1 }, () => "fresh");
    expect(result).toBe("cached");
  });

  it("should execute and cache on miss", () => {
    const cache = new ToolCache(60000);
    const result = getCachedOrExecute(cache, "tool", { a: 1 }, () => "fresh");
    expect(result).toBe("fresh");
    expect(cache.get("tool", { a: 1 })).toBe("fresh");
  });
});

describe("global caches", () => {
  it("readOnlyCache should be defined", () => {
    expect(readOnlyCache).toBeInstanceOf(ToolCache);
  });

  it("searchCache should be defined", () => {
    expect(searchCache).toBeInstanceOf(ToolCache);
  });
});
