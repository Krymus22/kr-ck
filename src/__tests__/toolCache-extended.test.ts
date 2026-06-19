/**
 * toolCache-extended.test.ts — Casos edge / integração p/ toolCache.ts.
 * Foco: getCache (2), setCache (2), invalidate (2), TTL expiry (2).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ToolCache, shouldCacheResult, getCachedOrExecute } from "../toolCache.js";

describe("toolCache (extended) — getCache", () => {
  it("retorna null após clear() mesmo para chave que existia", () => {
    const cache = new ToolCache(60000);
    cache.set("ler_arquivo", { p: "x" }, "resultado");
    expect(cache.get("ler_arquivo", { p: "x" })).toBe("resultado");
    cache.clear();
    expect(cache.get("ler_arquivo", { p: "x" })).toBeNull();
  });

  it("retorna null para tool diferente com mesmos args (chaves distintas)", () => {
    const cache = new ToolCache(60000);
    cache.set("tool_a", { x: 1 }, "from_a");
    expect(cache.get("tool_b", { x: 1 })).toBeNull();
    // E vice-versa
    cache.set("tool_b", { x: 1 }, "from_b");
    expect(cache.get("tool_a", { x: 1 })).toBe("from_a");
    expect(cache.get("tool_b", { x: 1 })).toBe("from_b");
  });
});

describe("toolCache (extended) — setCache", () => {
  it("sobrescreve valor anterior para a mesma chave", () => {
    const cache = new ToolCache(60000);
    cache.set("t", { a: 1 }, "v1");
    cache.set("t", { a: 1 }, "v2");
    expect(cache.get("t", { a: 1 })).toBe("v2");
  });

  it("set com TTL customizado sobrescreve o default do constructor", async () => {
    const cache = new ToolCache(60_000); // default 60s
    cache.set("t", { x: 1 }, "r", 50); // 50ms
    expect(cache.get("t", { x: 1 })).toBe("r");
    await new Promise((r) => setTimeout(r, 80));
    // Expirou pelo TTL customizado (50ms) mesmo com default 60s
    expect(cache.get("t", { x: 1 })).toBeNull();
  });
});

describe("toolCache (extended) — invalidate", () => {
  it("invalidate chave inexistente não lança erro", () => {
    const cache = new ToolCache(60000);
    expect(() => cache.invalidate("nonexistent", { a: 1 })).not.toThrow();
    expect(() => cache.invalidate("nonexistent")).not.toThrow();
  });

  it("invalidate por tool não afeta outras tools", () => {
    const cache = new ToolCache(60000);
    cache.set("tool_a", { x: 1 }, "a1");
    cache.set("tool_b", { x: 1 }, "b1");
    cache.invalidate("tool_a");
    expect(cache.get("tool_a", { x: 1 })).toBeNull();
    expect(cache.get("tool_b", { x: 1 })).toBe("b1");
  });
});

describe("toolCache (extended) — TTL expiry", () => {
  it("TTL do constructor é respeitado quando set não especifica TTL", async () => {
    const cache = new ToolCache(40); // 40ms
    cache.set("t", { a: 1 }, "valor");
    expect(cache.get("t", { a: 1 })).toBe("valor");
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("t", { a: 1 })).toBeNull();
  });

  it("entrada expirada é removida do cache após get() detectar expiração", async () => {
    const cache = new ToolCache(30);
    cache.set("t", { a: 1 }, "r");
    expect(cache.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    cache.get("t", { a: 1 }); // dispara delete
    expect(cache.size()).toBe(0);
  });
});

describe("toolCache (extended) — shouldCacheResult e getCachedOrExecute", () => {
  it("shouldCacheResult cobre buscar_texto_no_projeto e git_log", () => {
    expect(shouldCacheResult("buscar_texto_no_projeto")).toBe(true);
    expect(shouldCacheResult("git_log")).toBe(true);
  });

  it("getCachedOrExecute só chama fn uma vez na 2ª chamada (cache hit)", () => {
    const cache = new ToolCache(60000);
    const fn = vi.fn(() => "fresh-result");
    const a1 = getCachedOrExecute(cache, "t", { x: 1 }, fn);
    const a2 = getCachedOrExecute(cache, "t", { x: 1 }, fn);
    expect(a1).toBe("fresh-result");
    expect(a2).toBe("fresh-result");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// Import vi aqui para o teste acima
import { vi } from "vitest";
