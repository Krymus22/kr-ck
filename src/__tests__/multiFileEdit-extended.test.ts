/**
 * multiFileEdit-extended.test.ts — Cobertura adicional do módulo multiFileEdit.
 *
 * Foca em:
 *   - applyEdits (multiFileEdit + applyAllEdits): 3 casos (múltiplos arquivos, atomicidade, rollback)
 *   - validateBatch (prepareEdits implícito): 2 casos (validação de arquivos e agregação de erros)
 *   - edge cases: 3 casos
 *
 * Não duplica testes do arquivo multiFileEdit.test.ts básico.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  multiFileEdit,
  applyAllEdits,
  type FileEditRequest,
} from "../multiFileEdit.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const origWrite = actual.writeFileSync;
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      if (args[0]?.toString().includes("__extfail__")) {
        throw new Error("disk error extended");
      }
      return origWrite(...args);
    },
  };
});

const TEST_DIR = path.join(process.cwd(), "__test_multiedit_ext__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "a.ts"), "const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "b.ts"), "const b = 2;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "c.ts"), "const c = 3;\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("multiFileEdit-extended: applyEdits (múltiplos arquivos / atomicidade / rollback)", () => {
  it("edita 3 arquivos atomicamente numa única chamada e todos refletem o novo conteúdo", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "const a = 1;", replace: "const a = 100;" }] },
      { filePath: path.join(TEST_DIR, "b.ts"), edits: [{ search: "const b = 2;", replace: "const b = 200;" }] },
      { filePath: path.join(TEST_DIR, "c.ts"), edits: [{ search: "const c = 3;", replace: "const c = 300;" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(result.filesEdited).toHaveLength(3);
    expect(result.rolledBack).toBe(false);
    expect(fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8")).toContain("a = 100");
    expect(fs.readFileSync(path.join(TEST_DIR, "b.ts"), "utf8")).toContain("b = 200");
    expect(fs.readFileSync(path.join(TEST_DIR, "c.ts"), "utf8")).toContain("c = 300");
  });

  it("rollback restaura conteúdo original de TODOS os arquivos já processados quando um falha", () => {
    // Prepara estado original conhecido
    fs.writeFileSync(path.join(TEST_DIR, "r1.ts"), "ORIGINAL_1\n", "utf8");
    fs.writeFileSync(path.join(TEST_DIR, "r2.ts"), "ORIGINAL_2\n", "utf8");

    const originalR1 = fs.readFileSync(path.join(TEST_DIR, "r1.ts"), "utf8");
    const originalR2 = fs.readFileSync(path.join(TEST_DIR, "r2.ts"), "utf8");

    // r1 vai ser modificado com sucesso, r2 vai falhar (search inexistente)
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "r1.ts"), edits: [{ search: "ORIGINAL_1", replace: "MODIFIED_1" }] },
      { filePath: path.join(TEST_DIR, "r2.ts"), edits: [{ search: "DOES_NOT_EXIST", replace: "x" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    // Como prepareEdits capturou o erro antes de aplicar, rolledBack é false (erros de validação não acionam rollback).
    // Mas é importante garantir que r1 NÃO foi modificado (nada foi aplicado).
    expect(fs.readFileSync(path.join(TEST_DIR, "r1.ts"), "utf8")).toBe(originalR1);
    expect(fs.readFileSync(path.join(TEST_DIR, "r2.ts"), "utf8")).toBe(originalR2);
  });

  it("rollback real (rolledBack=true) quando writeFileSync lança erro de disco no meio do apply", () => {
    const filePath = path.join(TEST_DIR, "__extfail__atomic.ts");
    // Usar appendFileSync (não interceptado pelo mock) para criar o arquivo de setup.
    fs.appendFileSync(filePath, "ORIGINAL_ATOMIC\n", "utf8");

    const requests: FileEditRequest[] = [
      { filePath, edits: [{ search: "ORIGINAL_ATOMIC", replace: "MODIFIED_ATOMIC" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.errors[0]?.error).toContain("disk error extended");
    // Arquivo permanece com conteúdo original após rollback (rollback usa try/catch e o mock lança)
    expect(fs.readFileSync(filePath, "utf8")).toBe("ORIGINAL_ATOMIC\n");

    fs.unlinkSync(filePath);
  });
});

describe("multiFileEdit-extended: validateBatch (validação interna do prepareEdits)", () => {
  it("retorna erro 'File not found' para cada arquivo inexistente quando createIfMissing=false", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "missing-1.ts"), edits: [{ search: "x", replace: "y" }] },
      { filePath: path.join(TEST_DIR, "missing-2.ts"), edits: [{ search: "x", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => e.error === "File not found")).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.filesEdited).toHaveLength(0);
  });

  it("agrega erros de múltiplas origens (arquivo inexistente + search não encontrado)", () => {
    const requests: FileEditRequest[] = [
      // Arquivo inexistente: "File not found"
      { filePath: path.join(TEST_DIR, "missing-3.ts"), edits: [{ search: "x", replace: "y" }] },
      // Arquivo existe, mas search não: erro vindo de applyEdits
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "WILL_NOT_MATCH", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    const errorMessages = result.errors.map((e) => e.error);
    expect(errorMessages).toContain("File not found");
    expect(errorMessages.some((m) => m !== "File not found")).toBe(true);
  });
});

describe("multiFileEdit-extended: edge cases", () => {
  it("lida com request cujo edit.search é string vazia em arquivo NÃO-VAZIO (append)", () => {
    fs.writeFileSync(path.join(TEST_DIR, "empty-search.ts"), "HELLO\n", "utf8");
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "empty-search.ts"), edits: [{ search: "", replace: "PREFIX_" }] },
    ];
    const result = multiFileEdit(requests);
    // Sprint C (BUG-V): search="" em arquivo não-vazio agora faz APPEND.
    // Antes era skip (0 replacements). Agora: "HELLO\n" + "PREFIX_" = "HELLO\nPREFIX_"
    expect(result.success).toBe(true);
    const content = fs.readFileSync(path.join(TEST_DIR, "empty-search.ts"), "utf8");
    expect(content).toBe("HELLO\nPREFIX_");
  });

  it("não altera arquivos quando request tem edits vazio (substituições vazias)", () => {
    const filePath = path.join(TEST_DIR, "no-edits.ts");
    fs.writeFileSync(filePath, "UNCHANGED\n", "utf8");
    const requests: FileEditRequest[] = [
      { filePath, edits: [] },
    ];
    const result = multiFileEdit(requests);
    // applyEdits com array vazio retorna sucesso (sem mudanças)
    expect(result.success).toBe(true);
    expect(result.filesEdited).toHaveLength(1);
    expect(fs.readFileSync(filePath, "utf8")).toBe("UNCHANGED\n");
  });

  it("applyAllEdits cria diretórios pai aninhados e retorna caminhos resolvidos", () => {
    const edits = [
      {
        resolved: path.join(TEST_DIR, "deep", "ext", "dir", "file.ts"),
        original: "",
        result: { success: true, content: "deep ext content", error: undefined },
      },
    ];
    const edited = applyAllEdits(edits as any);
    expect(edited).toHaveLength(1);
    expect(fs.existsSync(edited[0])).toBe(true);
    expect(fs.readFileSync(edited[0], "utf8")).toBe("deep ext content");
  });
});
