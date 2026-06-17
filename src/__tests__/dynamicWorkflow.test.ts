/** dynamicWorkflow.test.ts */
import { describe, it, expect, vi } from "vitest";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("./../subAgents.js", () => ({
  runSubAgent: vi.fn().mockResolvedValue("sub-agent result"),
}));

describe("dynamicWorkflow", () => {
  describe("validateWorkflow", () => {
    it("should accept valid script", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("const x = 1;");
      expect(result.valid).toBe(true);
    });

    it("should reject require()", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("require('fs')");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("require");
    });

    it("should reject import", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("import fs from 'fs'");
      expect(result.valid).toBe(false);
    });

    it("should reject process.*", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("process.exit(1)");
      expect(result.valid).toBe(false);
    });

    it("should reject fs.*", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("fs.readFileSync('test')");
      expect(result.valid).toBe(false);
    });

    it("should reject child_process", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("child_process.exec('rm -rf /')");
      expect(result.valid).toBe(false);
    });

    it("should reject syntax errors", async () => {
      const { validateWorkflow } = await import("./../dynamicWorkflow.js");
      const result = validateWorkflow("const x = ;");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Syntax");
    });
  });

  describe("executeWorkflow", () => {
    it("should execute simple workflow with log", async () => {
      const { executeWorkflow } = await import("./../dynamicWorkflow.js");
      const result = await executeWorkflow("log('hello world');");
      expect(result.success).toBe(true);
      expect(result.output).toContain("hello world");
    });

    it("should execute workflow with agent() call", async () => {
      const { executeWorkflow } = await import("./../dynamicWorkflow.js");
      const result = await executeWorkflow("const r = await agent('test question'); log(r);");
      expect(result.success).toBe(true);
      expect(result.stepsExecuted).toBe(1);
      expect(result.output).toContain("sub-agent result");
    });

    it("should execute workflow with parallel() call", async () => {
      const { executeWorkflow } = await import("./../dynamicWorkflow.js");
      const result = await executeWorkflow("const [a, b] = await parallel('q1', 'q2'); log(a + b);");
      expect(result.success).toBe(true);
      expect(result.stepsExecuted).toBe(2);
    });

    it("should handle workflow errors gracefully", async () => {
      const { executeWorkflow } = await import("./../dynamicWorkflow.js");
      const result = await executeWorkflow("throw new Error('test error');");
      expect(result.success).toBe(false);
      expect(result.error).toContain("test error");
    });
  });

  describe("getExampleWorkflow", () => {
    it("should return example script", async () => {
      const { getExampleWorkflow } = await import("./../dynamicWorkflow.js");
      const example = getExampleWorkflow();
      expect(example).toContain("agent(");
      expect(example).toContain("log(");
      expect(example).toContain("for");
    });
  });
});
