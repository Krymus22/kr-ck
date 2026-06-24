/**
 * impactAnalyzer-extended.test.ts — Casos de borda para análise de impacto.
 *
 * O módulo impactAnalyzer.ts expõe `analyzeImpact`, `formatImpactHint`,
 * `formatImpactSummary`, `clearCache` e `extractSymbols`. Conceitos do roteiro:
 *
 *   - analyzeImpact (3): low (0 usages), medium (1-5 usages), high (muitos usages)
 *   - findDependents (2): comportamento ao incluir/excluir arquivos
 *   - computeRiskScore (2): proxy via número de arquivos afetados + usages
 *   - formatReport (1): formatImpactHint com cenário de alto impacto
 *
 * Evita duplicar testes do impactAnalyzer.test.ts básico.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("impactAnalyzer — extended", () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-impact-ext-"));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    vi.resetModules();
  });

  // === analyzeImpact — low / medium / high ====================================

  describe("analyzeImpact — níveis de impacto", () => {
    it("LOW impact: símbolos definidos mas nenhum consumidor externo", async () => {
      const { analyzeImpact, clearCache } = await import("./../impactAnalyzer.js");
      clearCache();

      const target = path.join(tmpProject, "Isolated.luau");
      fs.writeFileSync(
        target,
        `local M = {}
function M.Internal()
    return 42
end
return M
`,
        "utf8"
      );

      const report = await analyzeImpact(target, tmpProject);

      // Tem símbolo mas 0 usages externos
      expect(report.symbols.length).toBeGreaterThanOrEqual(1);
      expect(report.usages).toEqual([]);
      expect(report.affectedFiles).toEqual([]);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("MEDIUM impact: um consumidor com 1-3 usages", async () => {
      const { analyzeImpact, clearCache } = await import("./../impactAnalyzer.js");
      clearCache();

      const target = path.join(tmpProject, "Service.luau");
      fs.writeFileSync(
        target,
        `local M = {}
function M.DoWork(x)
    return x * 2
end
return M
`,
        "utf8"
      );

      const consumer = path.join(tmpProject, "Consumer.luau");
      fs.writeFileSync(
        consumer,
        `local Service = require(game.ReplicatedStorage.Service)
local result = Service.DoWork(5)
print(result)
`,
        "utf8"
      );

      const report = await analyzeImpact(target, tmpProject);

      expect(report.symbols.some((s) => s.name === "DoWork")).toBe(true);
      expect(report.usages.length).toBeGreaterThanOrEqual(1);
      expect(report.affectedFiles).toContain("Consumer.luau");
    });

    it("HIGH impact: múltiplos consumidores com muitos usages", async () => {
      const { analyzeImpact, clearCache } = await import("./../impactAnalyzer.js");
      clearCache();

      const target = path.join(tmpProject, "Core.luau");
      fs.writeFileSync(
        target,
        `local M = {}
function M.ImportantApi()
    return 42
end
return M
`,
        "utf8"
      );

      // Cria 10 consumidores, cada um usando M.ImportantApi() 2x
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(
          path.join(tmpProject, `consumer_${i}.luau`),
          `local Core = require(game.ReplicatedStorage.Core)
local a = Core.ImportantApi()
local b = Core.ImportantApi()
`,
          "utf8"
        );
      }

      const report = await analyzeImpact(target, tmpProject);

      // Alto impacto: 10 arquivos afetados (capped em MAX_TOTAL_USAGES=100)
      expect(report.affectedFiles.length).toBe(10);
      expect(report.usages.length).toBeGreaterThanOrEqual(10);
      expect(report.usages.length).toBeLessThanOrEqual(100);
    });
  });

  // === findDependents — comportamento de inclusão/exclusão ====================

  describe("findDependents (via analyzeImpact) — inclusão/exclusão", () => {
    it("inclui arquivos em subpastas (não só na raiz do projeto)", async () => {
      const { analyzeImpact, clearCache } = await import("./../impactAnalyzer.js");
      clearCache();

      const target = path.join(tmpProject, "Mod.luau");
      fs.writeFileSync(
        target,
        `local M = {}
function M.Useful()
    return 1
end
return M
`,
        "utf8"
      );

      // Consumidor em subpasta
      fs.mkdirSync(path.join(tmpProject, "src", "modules"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpProject, "src", "modules", "user.luau"),
        `local Mod = require(game.ReplicatedStorage.Mod)
local x = Mod.Useful()
`,
        "utf8"
      );

      const report = await analyzeImpact(target, tmpProject);
      expect(report.affectedFiles.some((f) => f.includes("modules"))).toBe(true);
      expect(report.affectedFiles.some((f) => f.includes("user.luau"))).toBe(true);
    });

    it("exclui .git directory dos resultados", async () => {
      const { analyzeImpact, clearCache } = await import("./../impactAnalyzer.js");
      clearCache();

      const target = path.join(tmpProject, "Target.luau");
      fs.writeFileSync(
        target,
        `local M = {}
function M.PublicApi()
    return 1
end
return M
`,
        "utf8"
      );

      // Cria um "consumidor" dentro de .git — deve ser ignorado
      fs.mkdirSync(path.join(tmpProject, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpProject, ".git", "config.luau"),
        `local x = M.PublicApi()
`,
        "utf8"
      );

      const report = await analyzeImpact(target, tmpProject);
      expect(report.affectedFiles.some((f) => f.includes(".git"))).toBe(false);
    });
  });

  // === computeRiskScore — proxy via números de usages =========================

  describe("computeRiskScore (proxy via formatImpactSummary)", () => {
    it("risco baixo: retorna 'no dependencies' quando 0 usages", async () => {
      const { formatImpactSummary } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/x.luau",
        symbols: [{ name: "Foo", exportedAs: "Foo", definitionLine: 1 }],
        affectedFiles: [],
        usages: [],
        durationMs: 10,
      };
      const summary = formatImpactSummary(report);
      expect(summary).toBe("no dependencies");
    });

    it("risco alto: summary reflete corretamente contagem de usages e arquivos", async () => {
      const { formatImpactSummary } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/x.luau",
        symbols: [],
        affectedFiles: ["a.luau", "b.luau", "c.luau"],
        usages: [
          { file: "a.luau", line: 1, symbol: "X", lineContent: "" },
          { file: "a.luau", line: 5, symbol: "X", lineContent: "" },
          { file: "b.luau", line: 2, symbol: "X", lineContent: "" },
          { file: "c.luau", line: 9, symbol: "X", lineContent: "" },
        ],
        durationMs: 10,
      };
      const summary = formatImpactSummary(report);
      // 4 usages em 3 arquivos
      expect(summary).toBe("4 usage(s) in 3 file(s)");
    });
  });

  // === formatReport — formatImpactHint com alto impacto =======================

  describe("formatReport (formatImpactHint) — cenário alto impacto", () => {
    it("formata relatório agrupando usages por arquivo e mostrando contagem", async () => {
      const { formatImpactHint } = await import("./../impactAnalyzer.js");
      const report = {
        targetFile: "/projeto/Core.luau",
        symbols: [
          { name: "PublicApi", exportedAs: "PublicApi", definitionLine: 3 },
          { name: "Helper", exportedAs: "Helper", definitionLine: 8 },
        ],
        affectedFiles: ["consumer_a.luau", "consumer_b.luau"],
        usages: [
          { file: "consumer_a.luau", line: 10, symbol: "PublicApi", lineContent: "local x = Core.PublicApi()" },
          { file: "consumer_a.luau", line: 20, symbol: "Helper", lineContent: "Core.Helper()" },
          { file: "consumer_b.luau", line: 5, symbol: "PublicApi", lineContent: "Core.PublicApi()" },
        ],
        durationMs: 42,
      };

      const hint = formatImpactHint(report);

      // Deve listar ambos arquivos afetados
      expect(hint).toContain("consumer_a.luau");
      expect(hint).toContain("consumer_b.luau");
      // Deve mostrar contagem de símbolos
      expect(hint).toContain("2 symbol(s)");
      // Deve mostrar contagem total de usages e arquivos
      expect(hint).toContain("3 usage(s)");
      expect(hint).toContain("2 file(s)");
      // Deve mostrar o nome do arquivo alvo (basename)
      expect(hint).toContain("Core.luau");
      // Deve incluir a instrução de cuidado
      expect(hint).toContain("RENAME or REMOVE");
    });
  });
});
