/**
 * parallelTools-extended.test.ts — Cobertura adicional do módulo parallelTools.
 *
 * Foca em:
 *   - runParallel (executeParallelTools): 3 casos novos
 *   - limitConcurrency (ToolExecutor): 2 casos novos
 *   - collectResults (agregação de resultados): 2 casos novos
 *   - edge cases: 1 caso
 *
 * Não duplica testes do arquivo parallelTools.test.ts básico.
 */

import { describe, it, expect } from "vitest";
import {
  executeParallelTools,
  ToolExecutor,
  type ParallelToolCall,
  type ParallelResult,
} from "../parallelTools.js";

describe("parallelTools-extended: runParallel (executeParallelTools)", () => {
  it("executa N ferramentas em paralelo com tempo total menor que a soma serial", async () => {
    // 4 ferramentas, cada uma dorme 50ms. Em paralelo: ~50ms. Serial: ~200ms.
    const tools: ParallelToolCall[] = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      name: `tool${i}`,
      args: {},
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return `r${i}`;
      },
    }));

    const start = Date.now();
    const results = await executeParallelTools(tools, 5);
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(4);
    // Em paralelo deve ser bem menor que 4*50=200ms
    expect(elapsed).toBeLessThan(180);
  });

  it("preserva os IDs e nomes dos tools nos resultados", async () => {
    const tools: ParallelToolCall[] = [
      { id: "alpha", name: "ler_arquivo", args: {}, execute: async () => "a" },
      { id: "beta", name: "buscar_texto", args: {}, execute: async () => "b" },
      { id: "gamma", name: "git_status", args: {}, execute: async () => "c" },
    ];
    const results = await executeParallelTools(tools);
    const ids = results.map((r) => r.id).sort();
    const names = results.map((r) => r.name).sort();
    expect(ids).toEqual(["alpha", "beta", "gamma"]);
    expect(names).toEqual(["buscar_texto", "git_status", "ler_arquivo"]);
  });

  it("executa corretamente quando há mistura de sucesso, falha e undefined", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "ok", args: {}, execute: async () => "success" },
      { id: "2", name: "fail", args: {}, execute: async () => { throw new Error("kaboom"); } },
      { id: "3", name: "void", args: {}, execute: async () => undefined },
    ];
    const results = await executeParallelTools(tools);
    expect(results).toHaveLength(3);
    const byId = new Map(results.map((r) => [r.id, r]));
    expect(byId.get("1")!.success).toBe(true);
    expect(byId.get("2")!.success).toBe(false);
    expect(byId.get("2")!.error).toContain("kaboom");
    expect(byId.get("3")!.success).toBe(true);
  });
});

describe("parallelTools-extended: limitConcurrency (ToolExecutor)", () => {
  it("construtor sem argumentos usa maxConcurrency padrão = 5", () => {
    const executor = new ToolExecutor();
    // Não há getter público para maxConcurrency, mas podemos verificar o comportamento:
    // submetendo 10 tasks lentas, no máximo 5 rodam concorrentemente.
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 10 }, () =>
      executor.execute(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      })
    );
    return Promise.all(tasks).then(() => {
      expect(maxActive).toBeLessThanOrEqual(5);
      expect(maxActive).toBeGreaterThanOrEqual(1);
    });
  });

  it("tarefas excedentes aguardam em fila e executam em ordem FIFO quando slot libera", async () => {
    const executor = new ToolExecutor(2);
    const executionOrder: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) =>
      executor.execute(async () => {
        executionOrder.push(i);
        await new Promise((r) => setTimeout(r, 15));
        return i;
      })
    );
    const results = await Promise.all(tasks);
    // Todas as tarefas executaram
    expect(results).toEqual([0, 1, 2, 3, 4]);
    // A ordem de início deve ser preservada (FIFO)
    expect(executionOrder).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("parallelTools-extended: collectResults (agregação de resultados)", () => {
  it("resultado de erro contém todos os campos esperados (id, name, result, durationMs, success, error)", async () => {
    const tools: ParallelToolCall[] = [
      { id: "err1", name: "bad", args: {}, execute: async () => { throw new Error("fail-x"); } },
    ];
    const results = await executeParallelTools(tools);
    const r = results[0] as ParallelResult;
    expect(r.id).toBe("err1");
    expect(r.name).toBe("bad");
    expect(r.success).toBe(false);
    expect(r.error).toBe("fail-x");
    expect(r.result).toContain("[ERROR]");
    expect(r.result).toContain("fail-x");
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("resultado de sucesso contém todos os campos esperados (sem error)", async () => {
    const tools: ParallelToolCall[] = [
      { id: "ok1", name: "good", args: {}, execute: async () => "payload" },
    ];
    const results = await executeParallelTools(tools);
    const r = results[0] as ParallelResult;
    expect(r.id).toBe("ok1");
    expect(r.name).toBe("good");
    expect(r.success).toBe(true);
    expect(r.result).toBe("payload");
    expect(r.error).toBeUndefined();
    expect(typeof r.durationMs).toBe("number");
  });
});

describe("parallelTools-extended: edge cases", () => {
  it("tool que lança erro síncrono (não rejeita promise) é capturado como falha", async () => {
    const tools: ParallelToolCall[] = [
      {
        id: "sync-throw",
        name: "syncBad",
        args: {},
        // execute lança síncrono (não retorna Promise.reject)
        execute: (() => {
          throw new Error("sync boom");
        }) as () => Promise<string>,
      },
      {
        id: "ok",
        name: "ok",
        args: {},
        execute: async () => "fine",
      },
    ];
    const results = await executeParallelTools(tools);
    expect(results).toHaveLength(2);
    const syncThrow = results.find((r) => r.id === "sync-throw");
    expect(syncThrow).toBeDefined();
    expect(syncThrow!.success).toBe(false);
    expect(syncThrow!.error).toContain("sync boom");
  });
});
