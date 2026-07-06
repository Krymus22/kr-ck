/**
 * dynamicWorkflow-extended.test.ts — Extended tests for dynamicWorkflow.ts
 *
 * Covers 30+ tests across:
 *   - validateWorkflow (forbidden patterns, syntax validation)
 *   - getExampleWorkflow (returns string with expected structure)
 *   - executeWorkflow (basic success/error paths via mocked subAgents)
 *
 * Mocks logger and subAgents (runSubAgent) to keep tests deterministic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

// Mock subAgents so executeWorkflow doesn't spawn real sub-agents
vi.mock("../subAgents.js", () => ({
  runSubAgent: vi.fn().mockResolvedValue("ok"),
}));

import { validateWorkflow, getExampleWorkflow, executeWorkflow } from "../dynamicWorkflow.js";

describe("validateWorkflow (extended)", () => {
  it("accepts an empty script", () => {
    const result = validateWorkflow("");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("accepts a simple log() call", () => {
    const result = validateWorkflow('log("hello");');
    expect(result.valid).toBe(true);
  });

  it("accepts an async script with await", () => {
    const result = validateWorkflow('const x = await agent("hello");\nlog(x);');
    expect(result.valid).toBe(true);
  });

  it("rejects require()", () => {
    const result = validateWorkflow('require("fs");');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/require/);
  });

  it("rejects import statement", () => {
    const result = validateWorkflow('import { x } from "y";');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/import/);
  });

  it("rejects process.*", () => {
    const result = validateWorkflow('process.exit(0);');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/process/);
  });

  it("rejects fs.*", () => {
    const result = validateWorkflow('fs.readFileSync("a");');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/fs/);
  });

  it("rejects child_process", () => {
    // Use child_process without triggering other forbidden patterns first
    const result = validateWorkflow('const cp = "child_process";');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/child_process/);
  });

  it("rejects a script with syntax error", () => {
    const result = validateWorkflow('const x = ;');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Syntax error/);
  });

  it("rejects unclosed brace", () => {
    const result = validateWorkflow('function foo() {');
    expect(result.valid).toBe(false);
  });

  it("accepts a for loop with valid syntax", () => {
    const result = validateWorkflow('for (let i = 0; i < 10; i++) { log(i); }');
    expect(result.valid).toBe(true);
  });

  it("accepts a script using parallel()", () => {
    const result = validateWorkflow('await parallel("a", "b", "c");');
    expect(result.valid).toBe(true);
  });

  it("accepts variable declarations", () => {
    const result = validateWorkflow('const x = 1;\nlet y = 2;\nvar z = 3;');
    expect(result.valid).toBe(true);
  });

  it("accepts arrow functions", () => {
    const result = validateWorkflow('const f = (x) => x + 1;');
    expect(result.valid).toBe(true);
  });

  it("accepts if/else statements", () => {
    const result = validateWorkflow('if (true) { log("y"); } else { log("n"); }');
    expect(result.valid).toBe(true);
  });

  it("returns valid:true with no error property for valid scripts", () => {
    const result = validateWorkflow('log("test");');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects import statement with whitespace after 'import'", () => {
    // The pattern /import\s+/ requires whitespace after 'import'
    const result = validateWorkflow('import fs from "fs";');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/import/);
  });

  it("accepts nested function calls", () => {
    const result = validateWorkflow('log(await agent("q1"));');
    expect(result.valid).toBe(true);
  });

  it("rejects process.env access", () => {
    const result = validateWorkflow('const x = process.env.HOME;');
    expect(result.valid).toBe(false);
  });
});

describe("getExampleWorkflow (extended)", () => {
  it("returns a string", () => {
    const ex = getExampleWorkflow();
    expect(typeof ex).toBe("string");
    expect(ex.length).toBeGreaterThan(0);
  });

  it("contains an agent() call", () => {
    const ex = getExampleWorkflow();
    expect(ex).toContain("agent(");
  });

  it("contains a log() call", () => {
    const ex = getExampleWorkflow();
    expect(ex).toContain("log(");
  });

  it("contains a for loop", () => {
    const ex = getExampleWorkflow();
    expect(ex).toContain("for");
  });

  it("starts with a comment", () => {
    const ex = getExampleWorkflow();
    expect(ex.startsWith("//")).toBe(true);
  });

  it("passes validateWorkflow", () => {
    const ex = getExampleWorkflow();
    const result = validateWorkflow(ex);
    expect(result.valid).toBe(true);
  });

  it("contains example with file iteration", () => {
    const ex = getExampleWorkflow();
    expect(ex).toContain("fileList");
  });

  it("contains selene reference", () => {
    const ex = getExampleWorkflow();
    expect(ex.toLowerCase()).toContain("selene");
  });
});

describe("executeWorkflow (extended)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes an empty script successfully", async () => {
    const result = await executeWorkflow("");
    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(result.stepsExecuted).toBe(0);
  });

  it("executes a log() call and includes output", async () => {
    const result = await executeWorkflow('log("hello world");');
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  it("executes console.log()", async () => {
    const result = await executeWorkflow('console.log("from console");');
    expect(result.success).toBe(true);
    expect(result.output).toContain("from console");
  });

  it("executes an agent() call (mocked)", async () => {
    const result = await executeWorkflow('const x = await agent("what is 1+1?");');
    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(1);
  });

  it("returns failure on syntax error", async () => {
    const result = await executeWorkflow('const x = ;');
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("returns a WorkflowResult with all required fields", async () => {
    const result = await executeWorkflow('log("x");');
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("stepsExecuted");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.output).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.stepsExecuted).toBe("number");
  });

  it("durationMs is non-negative", async () => {
    const result = await executeWorkflow('log("x");');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles async for loop", async () => {
    const result = await executeWorkflow(`
      for (let i = 0; i < 3; i++) {
        log("iteration " + i);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.output).toContain("iteration 0");
    expect(result.output).toContain("iteration 2");
  });

  it("handles parallel() calls (mocked)", async () => {
    const result = await executeWorkflow('await parallel("a", "b");');
    expect(result.success).toBe(true);
    // Each parallel call adds 2 steps (one per question)
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(2);
  });

  it("error result still has stepsExecuted count", async () => {
    const result = await executeWorkflow('const x = ;');
    expect(typeof result.stepsExecuted).toBe("number");
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(0);
  });

  it("handles errors thrown in agent() gracefully", async () => {
    // Override runSubAgent to throw
    const { runSubAgent } = await import("../subAgents.js");
    vi.mocked(runSubAgent).mockRejectedValueOnce(new Error("agent crashed"));
    const result = await executeWorkflow('const x = await agent("q");');
    expect(result.success).toBe(true); // workflow itself didn't crash
    expect(result.output).toContain("AGENT ERROR");
  });

  it("preserves order of log outputs", async () => {
    const result = await executeWorkflow(`
      log("first");
      log("second");
      log("third");
    `);
    expect(result.success).toBe(true);
    const firstIdx = result.output.indexOf("first");
    const secondIdx = result.output.indexOf("second");
    const thirdIdx = result.output.indexOf("third");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("handles large workflow with many log calls", async () => {
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push(`log("line ${i}");`);
    const result = await executeWorkflow(lines.join("\n"));
    expect(result.success).toBe(true);
    expect(result.output).toContain("line 0");
    expect(result.output).toContain("line 49");
  });

  it("executes a script that uses variables and conditionals", async () => {
    const script = `
      const x = 5;
      if (x > 3) {
        log("big");
      } else {
        log("small");
      }
    `;
    const result = await executeWorkflow(script);
    expect(result.success).toBe(true);
    expect(result.output).toContain("big");
    expect(result.output).not.toContain("small");
  });
});
