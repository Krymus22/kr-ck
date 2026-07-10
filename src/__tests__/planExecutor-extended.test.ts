/**
 * planExecutor-extended.test.ts — Cobertura adicional do módulo planExecutor.
 *
 * Foca em:
 *   - createPlan (3 casos novos)
 *   - executeStep (markStep) (2 casos novos)
 *   - updatePlan (manipulação de estado) (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo planExecutor.test.ts básico.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

describe("planExecutor-extended: createPlan", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  it("cria plano com array de steps vazio sem erro", async () => {
    const { createPlan, getPlan } = await import("./../planExecutor.js");
    const plan = createPlan([]);
    expect(plan.steps).toEqual([]);
    expect(getPlan()!.steps.length).toBe(0);
    expect(plan.completedAt).toBeNull();
  });

  it("preserva a ordem das etapas fornecidas", async () => {
    const { createPlan, getPlan } = await import("./../planExecutor.js");
    const plan = createPlan(["primeiro", "segundo", "terceiro"]);
    expect(getPlan()!.steps.map((s) => s.description)).toEqual([
      "primeiro",
      "segundo",
      "terceiro",
    ]);
    // Garante que o objeto retornado é o mesmo estado interno
    expect(plan).toBe(getPlan());
  });

  it("define createdAt como timestamp numérico recente", async () => {
    const { createPlan } = await import("./../planExecutor.js");
    const before = Date.now();
    const plan = createPlan(["x"]);
    const after = Date.now();
    expect(typeof plan.createdAt).toBe("number");
    expect(plan.createdAt).toBeGreaterThanOrEqual(before);
    expect(plan.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("planExecutor-extended: executeStep (markStep)", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  it("desmarca uma etapa previamente concluída (markStep false depois de true)", async () => {
    const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
    createPlan(["a", "b"]);
    markStep(0, true);
    expect(getPlan()!.steps[0]!.done).toBe(true);
    markStep(0, false);
    expect(getPlan()!.steps[0]!.done).toBe(false);
  });

  it("retorna false para índice igual a length (limite superior exclusivo)", async () => {
    const { createPlan, markStep } = await import("./../planExecutor.js");
    createPlan(["only"]);
    // index === length deve falhar (out of bounds)
    expect(markStep(1, true)).toBe(false);
  });
});

describe("planExecutor-extended: updatePlan (manipulação de estado)", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  it("recriar plano após completar o anterior zera completedAt", async () => {
    const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
    createPlan(["x"]);
    markStep(0, true);
    expect(getPlan()!.completedAt).not.toBeNull();

    // Recria: novo plano deve ter completedAt null
    const newPlan = createPlan(["y", "z"]);
    expect(newPlan.completedAt).toBeNull();
    expect(getPlan()!.steps.length).toBe(2);
    expect(getPlan()!.steps[0]!.description).toBe("y");
  });

  it("marcar etapa como pendente APÓS todas concluídas DESFAZ completedAt (FIX-MISC BH15 HIGH 2)", async () => {
    const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
    createPlan(["a"]);
    markStep(0, true);
    expect(getPlan()!.completedAt).not.toBeNull();

    // Desmarca — completedAt deve ser resetado (FIX-MISC)
    markStep(0, false);
    expect(getPlan()!.completedAt).toBeNull();
    // hasIncompletePlan volta a ser true (plan re-aberto)
    const { hasIncompletePlan } = await import("./../planExecutor.js");
    expect(hasIncompletePlan()).toBe(true);
  });
});

describe("planExecutor-extended: edge cases", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  it("getIncompleteSteps retorna array vazio quando não há plano", async () => {
    const { getIncompleteSteps } = await import("./../planExecutor.js");
    expect(getIncompleteSteps()).toEqual([]);
  });
});
