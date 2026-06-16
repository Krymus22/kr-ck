/**
 * parallelTools.test.ts — Tests for parallel tool execution module.
 */

import { describe, it, expect } from "vitest";
import { executeParallelTools, ToolExecutor, groupIndependentTools, type ParallelToolCall } from "../parallelTools.js";

describe("executeParallelTools", () => {
  it("should execute tools in parallel", async () => {
    const tools: ParallelToolCall[] = [
      {
        id: "1",
        name: "tool1",
        args: {},
        execute: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "result1";
        },
      },
      {
        id: "2",
        name: "tool2",
        args: {},
        execute: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return "result2";
        },
      },
    ];

    const results = await executeParallelTools(tools);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("should handle empty tools array", async () => {
    const results = await executeParallelTools([]);
    expect(results.length).toBe(0);
  });

  it("should handle tool failures gracefully", async () => {
    const tools: ParallelToolCall[] = [
      {
        id: "1",
        name: "success",
        args: {},
        execute: async () => "ok",
      },
      {
        id: "2",
        name: "failure",
        args: {},
        execute: async () => {
          throw new Error("tool failed");
        },
      },
    ];

    const results = await executeParallelTools(tools);
    expect(results.length).toBe(2);
    expect(results.find((r) => r.name === "success")!.success).toBe(true);
    expect(results.find((r) => r.name === "failure")!.success).toBe(false);
  });

  it("should respect concurrency limit", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const tools: ParallelToolCall[] = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      name: `tool${i}`,
      args: {},
      execute: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return `result${i}`;
      },
    }));

    await executeParallelTools(tools, 3);
    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("should track duration", async () => {
    const tools: ParallelToolCall[] = [
      {
        id: "1",
        name: "slow",
        args: {},
        execute: async () => {
          await new Promise((r) => setTimeout(r, 30));
          return "done";
        },
      },
    ];

    const results = await executeParallelTools(tools);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(20);
  });
});

describe("ToolExecutor", () => {
  it("should execute tasks with concurrency control", async () => {
    const executor = new ToolExecutor(2);
    let maxActive = 0;
    let active = 0;

    const tasks = Array.from({ length: 6 }, () =>
      executor.execute(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return "done";
      })
    );

    await Promise.all(tasks);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("should report active count and queue length", () => {
    const executor = new ToolExecutor(2);
    expect(executor.getActiveCount()).toBe(0);
    expect(executor.getQueueLength()).toBe(0);
  });

  it("should handle task failure", async () => {
    const executor = new ToolExecutor(2);
    await expect(
      executor.execute(async () => {
        throw new Error("fail");
      })
    ).rejects.toThrow("fail");
  });

  it("should handle concurrency of 1", async () => {
    const executor = new ToolExecutor(1);
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 4 }, () =>
      executor.execute(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return "ok";
      })
    );
    await Promise.all(tasks);
    expect(maxActive).toBe(1);
  });

  it("should handle large batch", async () => {
    const executor = new ToolExecutor(5);
    const tasks = Array.from({ length: 20 }, (_, i) =>
      executor.execute(async () => i * 2)
    );
    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
  });
});

describe("executeParallelTools edge cases", () => {
  it("should handle single tool", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "only", args: {}, execute: async () => "single" },
    ];
    const results = await executeParallelTools(tools);
    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].result).toBe("single");
  });

  it("should handle all failures", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "a", args: {}, execute: async () => { throw new Error("a"); } },
      { id: "2", name: "b", args: {}, execute: async () => { throw new Error("b"); } },
    ];
    const results = await executeParallelTools(tools);
    expect(results.every((r) => r.success)).toBe(false);
  });

  it("should handle tool returning undefined", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "void", args: {}, execute: async () => undefined },
    ];
    const results = await executeParallelTools(tools);
    expect(results[0].success).toBe(true);
  });

  it("should handle concurrency 0 (unlimited)", async () => {
    const tools: ParallelToolCall[] = Array.from({ length: 5 }, (_, i) => ({
      id: `${i}`, name: `t${i}`, args: {},
      execute: async () => i,
    }));
    const results = await executeParallelTools(tools, 0);
    expect(results.length).toBe(5);
  });

  it("should preserve result type", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "obj", args: {}, execute: async () => ({ key: "value" }) },
    ];
    const results = await executeParallelTools(tools);
    expect(results[0].result).toEqual({ key: "value" });
  });

  it("should return error message on throw", async () => {
    const tools: ParallelToolCall[] = [
      { id: "1", name: "err", args: {}, execute: async () => { throw new Error("boom"); } },
    ];
    const results = await executeParallelTools(tools);
    expect(results[0].error).toContain("boom");
    expect(results[0].success).toBe(false);
  });
});

describe("groupIndependentTools", () => {
  it("should group same-name same-file tools together", () => {
    const toolCalls = [
      { name: "edit", args: { caminho: "file.ts" } },
      { name: "edit", args: { caminho: "file.ts" } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
    expect(groups[0].every((t) => t.name === "edit")).toBe(true);
  });

  it("should separate different tools into different groups", () => {
    const toolCalls = [
      { name: "edit", args: { caminho: "a.ts" } },
      { name: "read", args: { caminho: "b.ts" } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups.length).toBe(2);
  });

  it("should handle empty array", () => {
    const groups = groupIndependentTools([]);
    expect(groups.length).toBe(0);
  });

  it("should separate same-name different-file tools", () => {
    const toolCalls = [
      { name: "edit", args: { caminho: "a.ts" } },
      { name: "edit", args: { caminho: "b.ts" } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups.length).toBe(2);
  });

  it("should group consecutive same-name same-file and separate others", () => {
    const toolCalls = [
      { name: "edit", args: { caminho: "a.ts" } },
      { name: "edit", args: { caminho: "a.ts" } },
      { name: "edit", args: { caminho: "b.ts" } },
      { name: "read", args: { caminho: "c.ts" } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups.length).toBe(3);
    expect(groups[0].length).toBe(2);
    expect(groups[1].length).toBe(1);
    expect(groups[2].length).toBe(1);
  });

  it("should create placeholder execute functions", () => {
    const toolCalls = [
      { name: "test", args: { x: 1 } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups[0][0].execute).toBeInstanceOf(Function);
    expect(typeof groups[0][0].id).toBe("string");
  });

  it("placeholder execute should return empty string", async () => {
    const toolCalls = [
      { name: "test", args: { x: 1 } },
    ];
    const groups = groupIndependentTools(toolCalls);
    const result = await groups[0][0].execute();
    expect(result).toBe("");
  });

  it("last group should contain remaining items", () => {
    const toolCalls = [
      { name: "edit", args: { caminho: "a.ts" } },
      { name: "edit", args: { caminho: "b.ts" } },
      { name: "read", args: { caminho: "c.ts" } },
    ];
    const groups = groupIndependentTools(toolCalls);
    expect(groups.length).toBe(3);
    expect(groups[2].length).toBe(1);
    expect(groups[2][0].name).toBe("read");
  });
});
