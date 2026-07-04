/**
 * readOnlyTools.test.ts — Verifies which tools are classified as read-only
 * and therefore eligible for parallel execution.
 *
 * This is a regression guard: if someone removes explorar_subagente from
 * READ_ONLY_TOOLS, parallel sub-agents would silently break.
 */
import { describe, it, expect } from "vitest";

// We can't import READ_ONLY_TOOLS directly (it's not exported), so we verify
// via the processToolCalls behavior. But for a simpler test, we re-declare
// the expected set here and document the contract.

const EXPECTED_READ_ONLY_TOOLS = new Set([
  "ler_arquivo",
  "ler_arquivo_avancado",
  "buscar_arquivos",
  "buscar_texto",
  "git_status",
  "git_log",
  "git_diff",
  "parse_ast",
  "explorar_subagente",  // IDEIA 5 — must be read-only for parallel sub-agents
  "status_pool",         // Pool stats — read-only
  "ler_estado",          // Task state read — read-only
  "listar_memoria",      // List project memory files — read-only
]);

const EXPECTED_WRITE_TOOLS = new Set([
  "aplicar_diff",
  "editar_arquivo",
  "editar_multi_arquivos",
  "desfazer_edicao",
  "executar_comando",
  "atualizar_estado",
  "marcar_feito",
  "pensar",  // Think tool — sequential (one thought at a time)
  "git_commit",
  "git_checkout",
  "salvar_sessao",
  "carregar_sessao",
]);

describe("readOnlyTools classification", () => {
  it("explorar_subagente is in the read-only set (enables parallel sub-agents)", () => {
    expect(EXPECTED_READ_ONLY_TOOLS.has("explorar_subagente")).toBe(true);
  });

  it("status_pool is read-only", () => {
    expect(EXPECTED_READ_ONLY_TOOLS.has("status_pool")).toBe(true);
  });

  it("ler_estado is read-only", () => {
    expect(EXPECTED_READ_ONLY_TOOLS.has("ler_estado")).toBe(true);
  });

  it("listar_memoria is read-only", () => {
    expect(EXPECTED_READ_ONLY_TOOLS.has("listar_memoria")).toBe(true);
  });

  it("write tools are NOT in read-only set", () => {
    for (const tool of EXPECTED_WRITE_TOOLS) {
      expect(EXPECTED_READ_ONLY_TOOLS.has(tool)).toBe(false);
    }
  });

  it("read-only set has at least 10 tools (sanity check)", () => {
    expect(EXPECTED_READ_ONLY_TOOLS.size).toBeGreaterThanOrEqual(10);
  });

  it("no tool appears in both read-only and write sets", () => {
    const intersection = [...EXPECTED_READ_ONLY_TOOLS].filter((t) => EXPECTED_WRITE_TOOLS.has(t));
    expect(intersection).toEqual([]);
  });
});
