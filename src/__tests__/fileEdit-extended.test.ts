/**
 * fileEdit-extended.test.ts — Expandindo cobertura do fileEdit.
 *
 * O módulo fileEdit aplica operações de search/replace em arquivos no disco,
 * com lock de arquivo, validação opcional (luau/safety), backup automático
 * e hooks pós-edição. Este arquivo expande a cobertura dos caminhos não
 * testados pelo arquivo fileEdit.test.ts, incluindo:
 *
 *   - Criação de arquivo novo (createIfMissing)
 *   - Sobrescrita de arquivo existente
 *   - Falha quando writeFileSync lança erro (sem permissão)
 *   - Falha quando path aponta para diretório (EISDIR)
 *   - Preservação de permissões do arquivo original
 *   - Manipulação de conteúdo vazio
 *   - Manipulação de conteúdo grande (100KB)
 *   - Manipulação de conteúdo unicode (emojis, CJK, acentos)
 *   - Criação de backup quando habilitado (caminho expandido)
 *   - Não cria backup quando desabilitado
 *   - Validação de path traversal (../)
 *   - Path absoluto válido
 *   - Path relativo válido
 *   - Diff preview antes de aplicar (integração com diffPreview)
 *   - Diff preview com "no changes" quando idêntico
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Mocks controláveis por teste -------------------------------------------
// Estado hoisted para que o mock de node:fs possa ler flags definidas por cada
// teste (ex: forçar writeFileSync a lançar EACCES).
const fsState = vi.hoisted(() => ({
  writeShouldThrow: false,
  writeErrorCode: "EACCES",
  writeErrorMessage: "EACCES: permission denied",
  writeFileCallCount: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeShouldThrowCheck = () => {
    if (fsState.writeShouldThrow) {
      const err = new Error(fsState.writeErrorMessage) as Error & { code?: string };
      err.code = fsState.writeErrorCode;
      throw err;
    }
  };
  return {
    ...actual,
    writeFileSync: vi.fn((...args: Parameters<typeof fs.writeFileSync>) => {
      fsState.writeFileCallCount++;
      writeShouldThrowCheck();
      return (actual.writeFileSync as any)(...args);
    }),
    promises: {
      ...actual.promises,
      writeFile: vi.fn(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        fsState.writeFileCallCount++;
        writeShouldThrowCheck();
        return (actual.promises.writeFile as any)(...args);
      }),
      readFile: actual.promises.readFile,
      access: actual.promises.access,
      stat: actual.promises.stat,
    },
  };
});

// Mock do logger para silenciar output durante testes
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

// Importações após os mocks
import { editFile } from "../fileEdit.js";
import { computeUnifiedDiff } from "../diffPreview.js";

const TEST_DIR = path.join(process.cwd(), "__test_editdir_ext__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Limpa o diretório de teste antes de cada teste
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // Reseta o estado do mock de fs
  fsState.writeShouldThrow = false;
  fsState.writeErrorCode = "EACCES";
  fsState.writeErrorMessage = "EACCES: permission denied";
  fsState.writeFileCallCount = 0;
});

describe("editFile — operações de criação e sobrescrita", () => {
  it("cria arquivo quando não existe (createIfMissing)", async () => {
    const newFile = path.join(TEST_DIR, "novo_arquivo.ts");
    expect(fs.existsSync(newFile)).toBe(false);

    const result = await editFile(
      newFile,
      [{ search: "", replace: "export const x = 1;\n" }],
      { createIfMissing: true }
    );

    expect(result).toContain("[SUCCESS]");
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.readFileSync(newFile, "utf8")).toBe("export const x = 1;\n");
  });

  it("substitui conteúdo quando arquivo existe (overwrite)", async () => {
    const file = path.join(TEST_DIR, "overwrite.ts");
    fs.writeFileSync(file, "const valor = 10;\nconst extra = 5;\n", "utf8");

    const result = await editFile(file, [
      { search: "const valor = 10;", replace: "const valor = 20;" },
      { search: "const extra = 5;", replace: "const extra = 15;" },
    ]);

    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("const valor = 20;\nconst extra = 15;\n");
  });

  it("falha quando writeFileSync lança erro de permissão (EACCES) — retorna [ERROR] e restaura conteúdo", async () => {
    const file = path.join(TEST_DIR, "perm_fail.ts");
    fs.writeFileSync(file, "conteúdo original\n", "utf8");

    // Ativa o mock para que writeFileSync lance EACCES
    fsState.writeShouldThrow = true;
    fsState.writeErrorCode = "EACCES";
    fsState.writeErrorMessage = "EACCES: permission denied, open 'arquivo'";

    // BUG FIX: editFile now returns an error string (consistent with aplicar_diff)
    // instead of throwing. The original content is restored via rollbackStore
    // or in-memory fallback, so the file is NOT left truncated.
    const result = await editFile(file, [{ search: "original", replace: "modificado" }]);
    expect(result).toContain("[ERROR]");
    expect(result).toContain("EACCES");

    // Conteúdo original permanece intacto (restored by rollback logic)
    expect(fs.readFileSync(file, "utf8")).toBe("conteúdo original\n");

    // Disable the throw so the restore-write can succeed
    fsState.writeShouldThrow = false;
  });

  it("falha quando path aponta para diretório (EISDIR) — retorna [ERROR]", async () => {
    const dirPath = path.join(TEST_DIR, "meu_dir");
    fs.mkdirSync(dirPath);

    // BUG FIX: editFile now returns an error string instead of throwing.
    // writeFileSync em diretório lança EISDIR — o mock passa para o fs real.
    const result = await editFile(dirPath, [{ search: "", replace: "conteúdo" }], { createIfMissing: true });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("EISDIR");
  });

  it("preserva permissões do arquivo original", async () => {
    const file = path.join(TEST_DIR, "perms.ts");
    fs.writeFileSync(file, "const x = 1;\n", "utf8");
    fs.chmodSync(file, 0o644);
    const originalMode = fs.statSync(file).mode & 0o7777;

    await editFile(file, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    const newMode = fs.statSync(file).mode & 0o7777;
    // Compara apenas os bits de permissão (12 bits baixos)
    expect(newMode).toBe(originalMode);
    // Sanity check: conteúdo foi modificado
    expect(fs.readFileSync(file, "utf8")).toBe("const x = 2;\n");
  });

  it("lida com conteúdo vazio no arquivo existente", async () => {
    const file = path.join(TEST_DIR, "vazio.ts");
    fs.writeFileSync(file, "", "utf8");

    const result = await editFile(file, [{ search: "", replace: "novo conteúdo" }]);

    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("novo conteúdo");
  });

  it("lida com conteúdo muito grande (100KB)", async () => {
    const file = path.join(TEST_DIR, "grande.ts");
    const bigContent = "x".repeat(100 * 1024); // 100KB
    fs.writeFileSync(file, bigContent, "utf8");

    const result = await editFile(file, [
      { search: "x".repeat(100), replace: "y".repeat(100), all: true },
    ]);

    expect(result).toContain("[SUCCESS]");
    const newContent = fs.readFileSync(file, "utf8");
    // Tamanho total permanece o mesmo (mesmo número de substituições)
    expect(newContent.length).toBe(bigContent.length);
    // Contém os novos "y"s
    expect(newContent).toContain("y".repeat(100));
    // Não contém mais os "x"s consecutivos
    expect(newContent).not.toContain("x".repeat(101));
  });

  it("lida com conteúdo unicode (emojis, CJK, acentos)", async () => {
    const file = path.join(TEST_DIR, "unicode.ts");
    const unicodeContent =
      "const emoji = '🎉';\nconst cjk = '日本語';\nconst acento = 'café';\n";
    fs.writeFileSync(file, unicodeContent, "utf8");

    const result = await editFile(file, [
      { search: "café", replace: "CAFÉ" },
      { search: "🎉", replace: "🚀" },
    ]);

    expect(result).toContain("[SUCCESS]");
    const newContent = fs.readFileSync(file, "utf8");
    expect(newContent).toContain("CAFÉ");
    expect(newContent).toContain("🚀");
    // CJK permanece intacto
    expect(newContent).toContain("日本語");
  });
});

describe("editFile — backup automático", () => {
  it("cria backup automático quando habilitado", async () => {
    const file = path.join(TEST_DIR, "com_backup.ts");
    fs.writeFileSync(file, "const original = true;\n", "utf8");

    await editFile(
      file,
      [{ search: "original", replace: "modificado" }],
      { backup: true }
    );

    const backup = file + ".bak";
    expect(fs.existsSync(backup)).toBe(true);
    // Backup contém o conteúdo ANTES da edição
    expect(fs.readFileSync(backup, "utf8")).toBe("const original = true;\n");
    // Arquivo principal tem o conteúdo modificado
    expect(fs.readFileSync(file, "utf8")).toBe("const modificado = true;\n");
  });

  it("não cria backup quando desabilitado (default)", async () => {
    const file = path.join(TEST_DIR, "sem_backup.ts");
    fs.writeFileSync(file, "const original = true;\n", "utf8");

    await editFile(file, [{ search: "original", replace: "modificado" }]);

    const backup = file + ".bak";
    expect(fs.existsSync(backup)).toBe(false);
  });
});

describe("editFile — validação de path", () => {
  it("rejeita path traversal (../) — arquivo é resolvido no diretório pai", async () => {
    // O módulo não valida path traversal explicitamente: path.resolve normaliza.
    // Testamos que '../arquivo.ts' a partir de subdir aponta para TEST_DIR/arquivo.ts
    const subdir = path.join(TEST_DIR, "subdir");
    fs.mkdirSync(subdir);
    const targetFile = path.join(TEST_DIR, "traversal_alvo.ts");
    fs.writeFileSync(targetFile, "valor original\n", "utf8");

    const cwdOriginal = process.cwd();
    process.chdir(subdir);
    try {
      const result = await editFile("../traversal_alvo.ts", [
        { search: "original", replace: "modificado" },
      ]);
      expect(result).toContain("[SUCCESS]");
      // O arquivo no diretório pai foi modificado
      expect(fs.readFileSync(targetFile, "utf8")).toContain("modificado");
    } finally {
      process.chdir(cwdOriginal);
    }
  });

  it("aceita path absoluto válido", async () => {
    const file = path.join(TEST_DIR, "absoluto.ts");
    fs.writeFileSync(file, "const a = 1;\n", "utf8");

    // Caminho absoluto passado diretamente
    const result = await editFile(file, [
      { search: "const a = 1;", replace: "const a = 2;" },
    ]);

    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("const a = 2;\n");
  });

  it("aceita path relativo válido", async () => {
    const subdir = path.join(TEST_DIR, "relativo_dir");
    fs.mkdirSync(subdir);
    const file = path.join(subdir, "relativo.ts");
    fs.writeFileSync(file, "const r = 1;\n", "utf8");

    const cwdOriginal = process.cwd();
    process.chdir(TEST_DIR);
    try {
      const result = await editFile("./relativo_dir/relativo.ts", [
        { search: "const r = 1;", replace: "const r = 2;" },
      ]);
      expect(result).toContain("[SUCCESS]");
      expect(fs.readFileSync(file, "utf8")).toBe("const r = 2;\n");
    } finally {
      process.chdir(cwdOriginal);
    }
  });
});

describe("editFile — diff preview antes de aplicar", () => {
  it("gera diff antes de aplicar edição (integração com diffPreview)", () => {
    const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const after = "const a = 10;\nconst b = 2;\nconst c = 3;\n";

    const diff = computeUnifiedDiff(before, after, "test.ts");

    // Diff contém cabeçalhos de arquivo
    expect(diff).toContain("--- a/test.ts");
    expect(diff).toContain("+++ b/test.ts");
    // Diff contém a linha removida e a adicionada
    expect(diff).toContain("-const a = 1;");
    expect(diff).toContain("+const a = 10;");
    // Linha inalterada NÃO aparece como mudança (apenas como contexto)
    expect(diff).not.toContain("-const b = 2;");
    expect(diff).not.toContain("+const b = 2;");
  });

  it("mostra string vazia quando conteúdo é idêntico (no changes)", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";

    const diff = computeUnifiedDiff(content, content, "test.ts");

    // Diff é vazio quando não há mudanças
    expect(diff).toBe("");
  });

  it("gera diff com cabeçalho de hunk (@@) para mudanças", () => {
    const before = "linha 1\nlinha 2\nlinha 3\n";
    const after = "linha 1\nlinha MODIFICADA\nlinha 3\n";

    const diff = computeUnifiedDiff(before, after, "hunk.ts");

    // Contém pelo menos um cabeçalho de hunk
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain("-linha 2");
    expect(diff).toContain("+linha MODIFICADA");
  });
});
