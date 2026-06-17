/** toolReduction.test.ts */
import { describe, it, expect } from "vitest";

describe("toolReduction", () => {
  describe("detectIntent", () => {
    it("should detect read intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("show me the file")).toBe("read");
      expect(detectIntent("ler o arquivo")).toBe("read");
    });

    it("should detect write intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("edit the function")).toBe("write");
      expect(detectIntent("fix the bug")).toBe("write");
      expect(detectIntent("create new file")).toBe("write");
    });

    it("should detect search intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("find all usages")).toBe("search");
      expect(detectIntent("buscar no projeto")).toBe("search");
    });

    it("should detect test intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("run the tests")).toBe("test");
      expect(detectIntent("rodar testes")).toBe("test");
    });

    it("should detect git intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("git commit")).toBe("git");
      expect(detectIntent("fazer push")).toBe("git");
    });

    it("should detect explore intent", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("explore the codebase")).toBe("explore");
      expect(detectIntent("investigate the issue")).toBe("explore");
    });

    it("should default to general", async () => {
      const { detectIntent } = await import("./../toolReduction.js");
      expect(detectIntent("hello world")).toBe("general");
      expect(detectIntent("")).toBe("general");
    });
  });

  describe("filterToolsByIntent", () => {
    const mockTools = [
      { type: "function" as const, function: { name: "ler_arquivo", parameters: {} } },
      { type: "function" as const, function: { name: "ler_arquivo_avancado", parameters: {} } },
      { type: "function" as const, function: { name: "aplicar_diff", parameters: {} } },
      { type: "function" as const, function: { name: "editar_arquivo", parameters: {} } },
      { type: "function" as const, function: { name: "executar_testes", parameters: {} } },
      { type: "function" as const, function: { name: "git_commit", parameters: {} } },
      { type: "function" as const, function: { name: "pensar", parameters: {} } },
      { type: "function" as const, function: { name: "buscar_conteudo", parameters: {} } },
      { type: "function" as const, function: { name: "buscar_arquivos", parameters: {} } },
      { type: "function" as const, function: { name: "tool:rojo_build", parameters: {} } },
    ];

    it("should return all tools for general intent", async () => {
      const { filterToolsByIntent } = await import("./../toolReduction.js");
      const filtered = filterToolsByIntent(mockTools, "general");
      expect(filtered.length).toBe(mockTools.length);
    });

    it("should reduce tools for read intent", async () => {
      const { filterToolsByIntent } = await import("./../toolReduction.js");
      const filtered = filterToolsByIntent(mockTools, "read");
      // Should include: ler_arquivo, pensar, buscar_texto, tool:rojo_build (external)
      // Should exclude: aplicar_diff, editar_arquivo, executar_testes, git_commit
      const names = filtered.map((t) => t.function.name);
      expect(names).toContain("ler_arquivo");
      expect(names).toContain("pensar");
      expect(names).toContain("buscar_conteudo");
      expect(names).toContain("tool:rojo_build");
      expect(names).not.toContain("aplicar_diff");
      expect(names).not.toContain("git_commit");
    });

    it("should reduce tools for test intent", async () => {
      const { filterToolsByIntent } = await import("./../toolReduction.js");
      const filtered = filterToolsByIntent(mockTools, "test");
      const names = filtered.map((t) => t.function.name);
      expect(names).toContain("executar_testes");
      expect(names).not.toContain("aplicar_diff");
      expect(names).not.toContain("git_commit");
    });

    it("should always include core tools", async () => {
      const { filterToolsByIntent } = await import("./../toolReduction.js");
      const filtered = filterToolsByIntent(mockTools, "git");
      const names = filtered.map((t) => t.function.name);
      expect(names).toContain("ler_arquivo");  // core
      expect(names).toContain("pensar");      // core
    });

    it("should always include external tools (tool:*)", async () => {
      const { filterToolsByIntent } = await import("./../toolReduction.js");
      const filtered = filterToolsByIntent(mockTools, "read");
      const names = filtered.map((t) => t.function.name);
      expect(names).toContain("tool:rojo_build");
    });
  });

  describe("getFilterSummary", () => {
    it("should format summary correctly", async () => {
      const { getFilterSummary } = await import("./../toolReduction.js");
      const summary = getFilterSummary(20, 8, "read");
      expect(summary).toContain("read");
      expect(summary).toContain("8/20");
      expect(summary).toContain("-60%");
    });
  });
});
