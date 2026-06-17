/**
 * planExecutor.test.ts - Tests for plan-then-execute system.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("planExecutor", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  describe("createPlan", () => {
    it("should create a plan with steps", async () => {
      const { createPlan, getPlan } = await import("./../planExecutor.js");
      const plan = createPlan(["Step 1", "Step 2", "Step 3"]);
      expect(plan.steps.length).toBe(3);
      expect(plan.steps[0]!.description).toBe("Step 1");
      expect(plan.steps[0]!.done).toBe(false);
      expect(plan.completedAt).toBeNull();
      expect(getPlan()).not.toBeNull();
    });

    it("should replace existing plan", async () => {
      const { createPlan, getPlan } = await import("./../planExecutor.js");
      createPlan(["Old step"]);
      createPlan(["New step 1", "New step 2"]);
      expect(getPlan()!.steps.length).toBe(2);
      expect(getPlan()!.steps[0]!.description).toBe("New step 1");
    });
  });

  describe("markStep", () => {
    it("should mark a step as done", async () => {
      const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
      createPlan(["Step 1", "Step 2"]);
      const ok = markStep(0, true);
      expect(ok).toBe(true);
      expect(getPlan()!.steps[0]!.done).toBe(true);
      expect(getPlan()!.steps[1]!.done).toBe(false);
    });

    it("should return false for invalid index", async () => {
      const { createPlan, markStep } = await import("./../planExecutor.js");
      createPlan(["Step 1"]);
      expect(markStep(5, true)).toBe(false);
      expect(markStep(-1, true)).toBe(false);
    });

    it("should return false when no plan exists", async () => {
      const { markStep } = await import("./../planExecutor.js");
      expect(markStep(0, true)).toBe(false);
    });

    it("should set completedAt when all steps are done", async () => {
      const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
      createPlan(["Step 1", "Step 2"]);
      markStep(0, true);
      expect(getPlan()!.completedAt).toBeNull();
      markStep(1, true);
      expect(getPlan()!.completedAt).not.toBeNull();
    });
  });

  describe("hasIncompletePlan", () => {
    it("should return false when no plan exists", async () => {
      const { hasIncompletePlan } = await import("./../planExecutor.js");
      expect(hasIncompletePlan()).toBe(false);
    });

    it("should return true when plan has incomplete steps", async () => {
      const { createPlan, hasIncompletePlan } = await import("./../planExecutor.js");
      createPlan(["Step 1", "Step 2"]);
      expect(hasIncompletePlan()).toBe(true);
    });

    it("should return false when all steps are done", async () => {
      const { createPlan, markStep, hasIncompletePlan } = await import("./../planExecutor.js");
      createPlan(["Step 1"]);
      markStep(0, true);
      expect(hasIncompletePlan()).toBe(false);
    });
  });

  describe("getIncompleteSteps", () => {
    it("should return only incomplete steps", async () => {
      const { createPlan, markStep, getIncompleteSteps } = await import("./../planExecutor.js");
      createPlan(["A", "B", "C"]);
      markStep(1, true);  // mark B as done
      const incomplete = getIncompleteSteps();
      expect(incomplete.length).toBe(2);
      expect(incomplete[0]!.description).toBe("A");
      expect(incomplete[1]!.description).toBe("C");
    });
  });

  describe("formatPlan", () => {
    it("should return empty string when no plan", async () => {
      const { formatPlan } = await import("./../planExecutor.js");
      expect(formatPlan()).toBe("");
    });

    it("should format plan with step numbers and status", async () => {
      const { createPlan, markStep, formatPlan } = await import("./../planExecutor.js");
      createPlan(["Read file", "Edit file", "Run tests"]);
      markStep(0, true);
      const formatted = formatPlan();
      expect(formatted).toContain("[PLAN");
      expect(formatted).toContain("1. [DONE] Read file");
      expect(formatted).toContain("2. [PENDING] Edit file");
      expect(formatted).toContain("2 step(s) remaining");
    });

    it("should show all complete message when done", async () => {
      const { createPlan, markStep, formatPlan } = await import("./../planExecutor.js");
      createPlan(["Step 1"]);
      markStep(0, true);
      const formatted = formatPlan();
      expect(formatted).toContain("All steps completed");
    });
  });

  describe("getPlanAsTodos", () => {
    it("should return empty array when no plan", async () => {
      const { getPlanAsTodos } = await import("./../planExecutor.js");
      expect(getPlanAsTodos()).toEqual([]);
    });

    it("should return steps as todo items", async () => {
      const { createPlan, markStep, getPlanAsTodos } = await import("./../planExecutor.js");
      createPlan(["Task A", "Task B"]);
      markStep(0, true);
      const todos = getPlanAsTodos();
      expect(todos.length).toBe(2);
      expect(todos[0]!.done).toBe(true);
      expect(todos[1]!.done).toBe(false);
    });
  });

  describe("clearPlan", () => {
    it("should clear the plan", async () => {
      const { createPlan, clearPlan, getPlan } = await import("./../planExecutor.js");
      createPlan(["Step 1"]);
      clearPlan();
      expect(getPlan()).toBeNull();
    });
  });
});
