/**
 * parallelTools.ts — Parallel tool execution with concurrency control.
 */

import * as log from "./logger.js";

export interface ParallelToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  execute: () => Promise<string>;
}

export interface ParallelResult {
  id: string;
  name: string;
  result: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

export async function executeParallelTools(
  tools: ParallelToolCall[],
  maxConcurrency: number = 5
): Promise<ParallelResult[]> {
  if (tools.length === 0) return [];

  log.debug(`Executing ${tools.length} tools in parallel (max concurrency: ${maxConcurrency})`);

  const results: ParallelResult[] = [];
  const executing: Set<Promise<void>> = new Set();

  for (const tool of tools) {
    const promise = executeOne(tool).then((result) => {
      results.push(result);
      executing.delete(promise);
    });

    executing.add(promise);

    // If we've hit the concurrency limit, wait for one to finish
    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  // Wait for all remaining
  await Promise.all(executing);

  return results;
}

async function executeOne(tool: ParallelToolCall): Promise<ParallelResult> {
  const start = Date.now();
  try {
    const result = await tool.execute();
    const durationMs = Date.now() - start;
    log.debug(`Tool ${tool.name} completed in ${durationMs}ms`);
    return { id: tool.id, name: tool.name, result, durationMs, success: true };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = (err as Error).message;
    log.error(`Tool ${tool.name} failed: ${error}`);
    return { id: tool.id, name: tool.name, result: `[ERROR] ${error}`, durationMs, success: false, error };
  }
}

export function groupIndependentTools(toolCalls: Array<{ name: string; args: Record<string, unknown> }>): ParallelToolCall[][] {
  // Group tools that can run in parallel (different tools or different files)
  const groups: ParallelToolCall[][] = [];
  let currentGroup: ParallelToolCall[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    currentGroup.push({
      id: `tool_${i}`,
      name: tc.name,
      args: tc.args,
      execute: async () => "", // placeholder
    });

    // If next tool is the same type on same file, keep in same group (sequential)
    const next = toolCalls[i + 1];
    if (next?.name === tc.name && next?.args?.caminho === tc.args?.caminho) {
      continue;
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export class ToolExecutor {
  private readonly maxConcurrency: number;
  private activeCount = 0;
  private readonly queue: Array<() => void> = [];

  constructor(maxConcurrency: number = 5) {
    this.maxConcurrency = maxConcurrency;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.activeCount++;
        resolve();
      });
    });
  }

  private release(): void {
    this.activeCount--;
    const next = this.queue.shift();
    if (next) next();
  }

  getActiveCount(): number { return this.activeCount; }
  getQueueLength(): number { return this.queue.length; }
}
