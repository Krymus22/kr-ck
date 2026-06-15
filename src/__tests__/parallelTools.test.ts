/**
 * parallelTools.test.ts — Tests for parallel tool execution module.
 */

import { describe, it, expect } from "vitest";
import { executeParallelTools, ToolExecutor, type ParallelToolCall } from "../parallelTools.js";

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
});
