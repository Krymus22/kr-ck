/**
 * tools-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: parseDiffBlocks (3 extras), applyDiffs (2 extras), executarComando (2),
 * desfazerEdicao/listarBackups (1) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDiffBlocks, applyDiffs } from "../tools.js";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../hooks.js", () => ({
  executePreFileWriteHooks: vi.fn().mockResolvedValue({ block: false }),
  executePostFileWriteHooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../diffPreview.js", () => ({
  previewAndApprove: vi.fn().mockResolvedValue(true),
}));

vi.mock("../guardrail.js", () => ({
  validateSyntax: vi.fn().mockResolvedValue({ valid: true }),
}));

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  get spawn() { return mockSpawn; },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual };
});

import { EventEmitter } from "node:events";
import { executarComando } from "../tools.js";

/** Cria child fake para simular spawn(). */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}): { child: any } {
  const child = new EventEmitter() as any;
  const stdout = new EventEmitter() as any;
  const stderr = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};
  setTimeout(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    child.emit("close", opts.exitCode ?? 0);
  }, 5);
  return { child };
}

describe("tools — extended", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ─── parseDiffBlocks (3 extras) ────────────────────────────────────────────

  describe("parseDiffBlocks — extras", () => {
    it("ignora texto solto fora dos marcadores SEARCH/REPLACE", () => {
      const diff = `texto antes
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
texto depois`;
      const blocks = parseDiffBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe("old");
      expect(blocks[0].replace).toBe("new");
    });

    it("lida com marcadores indentados (whitespace antes)", () => {
      const diff = `  <<<<<<< SEARCH
  old indented
  =======
  new indented
  >>>>>>> REPLACE`;
      const blocks = parseDiffBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe("  old indented");
      expect(blocks[0].replace).toBe("  new indented");
    });

    it("bloco SEARCH vazio seguido de REPLACE com várias linhas", () => {
      const diff = `<<<<<<< SEARCH
=======
linha 1
linha 2
linha 3
>>>>>>> REPLACE`;
      const blocks = parseDiffBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe("");
      expect(blocks[0].replace).toBe("linha 1\nlinha 2\nlinha 3");
    });
  });

  // ─── applyDiffs (2 extras) ─────────────────────────────────────────────────

  describe("applyDiffs — extras", () => {
    it("normaliza whitespace ao buscar (tabs vs espaços)", () => {
      const original = "function foo() {\n\treturn 1;\n}";
      const blocks = parseDiffBlocks(`<<<<<<< SEARCH
return 1;
=======
return 2;
>>>>>>> REPLACE`);
      const r = applyDiffs(original, blocks);
      expect(r.success).toBe(true);
      expect(r.content).toContain("return 2;");
    });

    it("falha se o segundo bloco de uma sequência não for encontrado", () => {
      const original = "alpha beta";
      const blocks = parseDiffBlocks(`<<<<<<< SEARCH
alpha
=======
ALPHA
>>>>>>> REPLACE
<<<<<<< SEARCH
zzz_nao_existe
=======
zzz
>>>>>>> REPLACE`);
      const r = applyDiffs(original, blocks);
      expect(r.success).toBe(false);
      expect(r.errorBlock).toBe("zzz_nao_existe");
    });
  });

  // ─── executarComando (2) ───────────────────────────────────────────────────

  describe("executarComando — extras", () => {
    it("respeita timeout e mata o processo (killed=true)", async () => {
      // Cria child que nunca emite close por padrão — só se for morto
      const child = new EventEmitter() as any;
      const stdout = new EventEmitter() as any;
      const stderr = new EventEmitter() as any;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = vi.fn(() => {
        // Emite 'close' quando morto
        setTimeout(() => child.emit("close", null), 2);
      });
      mockSpawn.mockImplementation(() => child);

      const r = await executarComando({ comando: "sleep 30", timeoutMs: 50 });
      expect(r).toContain("TIMEOUT");
      expect(r).toContain("[TIMEOUT after 50ms]");
    });

    it("envia stdout + stderr combinados quando há ambos", async () => {
      mockSpawn.mockImplementation(() => makeFakeChild({
        stdout: "OUT_LINE\n",
        stderr: "ERR_LINE\n",
        exitCode: 1,
      }).child);
      const r = await executarComando({ comando: "echo" });
      expect(r).toContain("OUT_LINE");
      expect(r).toContain("ERR_LINE");
      expect(r).toContain("[ERROR]");
    });
  });

  // ─── desfazerEdicao / listarBackups (1) + edge cases ──────────────────────

  describe("edge cases", () => {
    it("executarComando retorna '[OK]' quando não há stdout/stderr e exit=0", async () => {
      mockSpawn.mockImplementation(() => makeFakeChild({ exitCode: 0 }).child);
      const r = await executarComando({ comando: "true" });
      expect(r).toContain("[OK]");
    });

    it("executarComando propaga erro do evento 'error' do spawn", async () => {
      mockSpawn.mockImplementation(() => makeFakeChild({
        error: new Error("ENOENT: binário not found"),
      }).child);
      const r = await executarComando({ comando: "binario_inexistente_xyz" });
      expect(r).toContain("[ERROR]");
      expect(r).toContain("ENOENT");
    });

    it("parseDiffBlocks com entrada vazia retorna array vazio", () => {
      expect(parseDiffBlocks("")).toHaveLength(0);
      expect(parseDiffBlocks("   \n  ")).toHaveLength(0);
    });
  });
});
