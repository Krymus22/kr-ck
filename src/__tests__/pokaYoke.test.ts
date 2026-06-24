import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { pokaYokeCheck, EXPANDED_TOOL_DESCRIPTIONS } from "../pokaYoke.js";

describe("pokaYokeCheck", () => {
  describe("path-taking tools", () => {
    it("blocks when path is missing for ler_arquivo", () => {
      const r = pokaYokeCheck("ler_arquivo", {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain("caminho");
    });

    it("blocks when path is empty string", () => {
      const r = pokaYokeCheck("ler_arquivo", { caminho: "" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("non-empty");
    });

    it("passes when path is provided", () => {
      const r = pokaYokeCheck("ler_arquivo", { caminho: "/tmp/foo.ts" });
      expect(r.ok).toBe(true);
      expect(r.resolvedPath).toBeTruthy();
    });

    it("accepts 'path' alias instead of 'caminho'", () => {
      const r = pokaYokeCheck("ler_arquivo_avancado", { path: "/tmp/foo.ts" });
      expect(r.ok).toBe(true);
    });

    it("blocks aplicar_diff when caminho is missing", () => {
      const r = pokaYokeCheck("aplicar_diff", { bloco_diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("caminho");
    });
  });

  describe("aplicar_diff structure", () => {
    it("blocks when bloco_diff is missing", () => {
      const r = pokaYokeCheck("aplicar_diff", { caminho: "/x.ts" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("bloco_diff");
    });

    it("blocks when bloco_diff has no SEARCH/REPLACE markers", () => {
      const r = pokaYokeCheck("aplicar_diff", { caminho: "/x.ts", bloco_diff: "just code" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("SEARCH");
    });

    it("passes with valid SEARCH/REPLACE structure", () => {
      const r = pokaYokeCheck("aplicar_diff", {
        caminho: "/x.ts",
        bloco_diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
      });
      expect(r.ok).toBe(true);
    });
  });

  describe("editar_arquivo", () => {
    it("blocks when neither edits[] nor search+replace are provided", () => {
      const r = pokaYokeCheck("editar_arquivo", { path: "/x.ts" });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("edits");
    });

    it("passes with search+replace", () => {
      const r = pokaYokeCheck("editar_arquivo", { path: "/x.ts", search: "foo", replace: "bar" });
      expect(r.ok).toBe(true);
    });

    it("passes with edits[] array", () => {
      const r = pokaYokeCheck("editar_arquivo", {
        path: "/x.ts",
        edits: [{ search: "foo", replace: "bar" }],
      });
      expect(r.ok).toBe(true);
    });
  });

  describe("executar_comando", () => {
    it("blocks when comando is missing", () => {
      const r = pokaYokeCheck("executar_comando", {});
      expect(r.ok).toBe(false);
      expect(r.error).toContain("comando");
    });

    it("passes when comando is provided", () => {
      const r = pokaYokeCheck("executar_comando", { comando: "npm test" });
      expect(r.ok).toBe(true);
    });
  });

  describe("editar_multi_arquivos", () => {
    it("blocks when requests is missing or empty", () => {
      expect(pokaYokeCheck("editar_multi_arquivos", {}).ok).toBe(false);
      expect(pokaYokeCheck("editar_multi_arquivos", { requests: [] }).ok).toBe(false);
    });

    it("passes with non-empty requests array", () => {
      const r = pokaYokeCheck("editar_multi_arquivos", {
        requests: [{ filePath: "/x.ts", edits: [{ search: "a", replace: "b" }] }],
      });
      expect(r.ok).toBe(true);
    });
  });

  describe("desfazer_edicao", () => {
    it("blocks when caminho is missing", () => {
      const r = pokaYokeCheck("desfazer_edicao", {});
      expect(r.ok).toBe(false);
    });

    it("passes with caminho", () => {
      const r = pokaYokeCheck("desfazer_edicao", { caminho: "/x.ts" });
      expect(r.ok).toBe(true);
    });
  });

  describe("unknown / passthrough tools", () => {
    it("passes for tools without specific rules", () => {
      const r = pokaYokeCheck("some_other_tool", { foo: "bar" });
      expect(r.ok).toBe(true);
    });
  });

  describe("EXPANDED_TOOL_DESCRIPTIONS", () => {
    it.skip("contains entries for the key write tools", () => {
      expect(EXPANDED_TOOL_DESCRIPTIONS.aplicar_diff).toBeTruthy();
      expect(EXPANDED_TOOL_DESCRIPTIONS.editar_arquivo).toBeTruthy();
      expect(EXPANDED_TOOL_DESCRIPTIONS.desfazer_edicao).toBeTruthy();
      expect(EXPANDED_TOOL_DESCRIPTIONS.executar_comando).toBeTruthy();
      expect(EXPANDED_TOOL_DESCRIPTIONS.ler_arquivo).toBeTruthy();
    });

    it("each expanded description contains EXAMPLES section", () => {
      for (const [name, desc] of Object.entries(EXPANDED_TOOL_DESCRIPTIONS)) {
        expect(desc).toContain("EXAMPLE");
      }
    });
  });
});
