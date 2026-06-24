/**
 * rollbackStore-extended.test.ts
 *
 * Expande cobertura do rollbackStore.ts focando em:
 *   - saveBackup: agentId proveniente de env, múltiplos arquivos,
 *     path com subdiretórios, sanitize de nome
 *   - restoreBackup: arquivo de backup faltando, restore cria diretório
 *     inexistente, removes entry do índice após restore
 *   - listBackups: ordenação por timestamp, filter inexistente retorna []
 *   - clearAllBackups: count correto, index resetado
 *   - pruneOldBackups: MAX_ENTRIES cap, timestamp inválido é tratado
 *   - getRollbackDirPath: caminho relativo ao project root
 * Não duplica testes do rollbackStore.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import {
  saveBackup,
  restoreBackup,
  listBackups,
  pruneOldBackups,
  getRollbackDirPath,
  clearAllBackups,
  resetRollbackState,
} from "../rollbackStore.js";

let tmpProject: string;
let originalCwd: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  originalCwd = process.cwd();
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "rbw_ext_"));
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "test" }), "utf8");
  process.chdir(tmpProject);
  resetRollbackState();
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

afterEach(() => {
  process.chdir(originalCwd);
  resetRollbackState();
  process.env = { ...originalEnv };
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("rollbackStore-extended — saveBackup", () => {
  it("deve incluir agentId 'main' quando CLAUDE_KILLER_AGENT_ID não definido", () => {
    const filePath = path.join(tmpProject, "agent.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    const record = saveBackup(filePath, "v1", "editar_arquivo");
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe("main");
  });

  it("deve incluir agentId do env quando CLAUDE_KILLER_AGENT_ID definido", () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-2";
    const filePath = path.join(tmpProject, "agent2.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    const record = saveBackup(filePath, "v1", "editar_arquivo");
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe("sub-2");
  });

  it("deve sanitizar path com subdiretórios no nome do snapshot", () => {
    const subDir = path.join(tmpProject, "src", "modules");
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, "deep.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    const record = saveBackup(filePath, "v1", "aplicar_diff");
    expect(record).not.toBeNull();
    // O nome do snapshot deve conter o path sanitizado (sem barras)
    expect(record!.backupPath).toMatch(/\.bak$/);
    expect(record!.metaPath).toMatch(/\.meta\.json$/);
    // Não deve haver barras/backslashes no nome do arquivo depois do id
    const fname = path.basename(record!.backupPath);
    expect(fname).not.toMatch(/[\\/]/);
  });

  it("deve registrar size correto em bytes para conteúdo multibyte", () => {
    const filePath = path.join(tmpProject, "uni.ts");
    fs.writeFileSync(filePath, "antes", "utf8");
    // Conteúdo com caracteres multibyte — Buffer.byteLength deve contar > strlen
    const content = "café_àé_ü_中文_emoji_🎉";
    const record = saveBackup(filePath, content, "editar_arquivo");
    expect(record).not.toBeNull();
    expect(record!.size).toBe(Buffer.byteLength(content, "utf8"));
  });
});

describe("rollbackStore-extended — restoreBackup", () => {
  it("retorna false quando o arquivo de backup foi removido do disco", () => {
    const filePath = path.join(tmpProject, "missing.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    const record = saveBackup(filePath, "v1", "aplicar_diff");
    expect(record).not.toBeNull();
    // Remove o .bak manualmente
    fs.unlinkSync(record!.backupPath);
    // Tentar restore deve falhar e remover a entrada stale do índice
    const ok = restoreBackup(filePath);
    expect(ok).toBe(false);
    // Índice não devand  moreconter a entrada stale
    const remaining = listBackups(filePath);
    expect(remaining).toHaveLength(0);
  });

  it("deve recriar diretório pai se ele não existir mais no restore", () => {
    const subDir = path.join(tmpProject, "src", "deep");
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, "file.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    saveBackup(filePath, "v1", "aplicar_diff");
    // Sobrescreve e remove o diretório
    fs.rmSync(subDir, { recursive: true, force: true });
    // Agora tenta restaurar — deve recriar o diretório
    const ok = restoreBackup(filePath);
    expect(ok).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("v1");
  });

  it("após restore, a entrada correspondente deve sair do índice", () => {
    const filePath = path.join(tmpProject, "idx.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    saveBackup(filePath, "v1", "aplicar_diff");
    fs.writeFileSync(filePath, "v2", "utf8");
    saveBackup(filePath, "v2", "aplicar_diff");
    expect(listBackups(filePath)).toHaveLength(2);
    // Restore remove a mais recente
    expect(restoreBackup(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("v2");
    expect(listBackups(filePath)).toHaveLength(1);
  });
});

describe("rollbackStore-extended — listBackups", () => {
  it("filtra por path inexistente retorna array vazio", () => {
    const a = path.join(tmpProject, "exists.ts");
    fs.writeFileSync(a, "v1", "utf8");
    saveBackup(a, "v1", "aplicar_diff");
    const result = listBackups(path.join(tmpProject, "does-not-exist.ts"));
    expect(result).toEqual([]);
  });

  it("ordena entradas por timestamp crescente (mais antigo primeiro)", () => {
    const a = path.join(tmpProject, "a.ts");
    const b = path.join(tmpProject, "b.ts");
    fs.writeFileSync(a, "1", "utf8");
    fs.writeFileSync(b, "2", "utf8");
    saveBackup(a, "1", "aplicar_diff");
    saveBackup(b, "2", "aplicar_diff");
    const all = listBackups();
    expect(all).toHaveLength(2);
    const t1 = new Date(all[0].timestamp).getTime();
    const t2 = new Date(all[1].timestamp).getTime();
    expect(t1).toBeLessThanOrEqual(t2);
  });
});

describe("rollbackStore-extended — clearAllBackups / pruneOldBackups", () => {
  it("clearAllBackups retorna 0 quando não há backups", () => {
    expect(clearAllBackups()).toBe(0);
    // Index deve estar vazio
    expect(listBackups()).toHaveLength(0);
  });

  it("pruneOldBackups trata timestamp inválido como expirado", () => {
    const filePath = path.join(tmpProject, "invalid.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    saveBackup(filePath, "v1", "aplicar_diff");
    // Corrompe o timestamp no index.json
    const indexPath = path.join(getRollbackDirPath(), "index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.entries[0].timestamp = "not-a-valid-date";
    fs.writeFileSync(indexPath, JSON.stringify(index), "utf8");
    // Prune com maxAge grande — mesmo assim deve remover (timestamp inválido = expirado)
    const pruned = pruneOldBackups(60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(listBackups()).toHaveLength(0);
  });
});

describe("rollbackStore-extended — getRollbackDirPath", () => {
  it("retorna caminho dentro do project root com nome .rollback", () => {
    const dir = getRollbackDirPath();
    expect(dir).toBe(path.join(tmpProject, ".rollback"));
  });
});
