/**
 * fileWatcher-extended.test.ts — Cobertura adicional do módulo fileWatcher.
 *
 * Foca em:
 *   - watch (3 casos novos)
 *   - onChange (callbacks) (2 casos novos)
 *   - unwatch (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo fileWatcher.test.ts básico.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileWatcher, type FileChangeEvent } from "../fileWatcher.js";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// Mock do fs que controla watch/statSync mas delega o resto ao real.
const { watchMock, statSyncMock } = vi.hoisted(() => ({
  watchMock: vi.fn(),
  statSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as typeof fs;
  return {
    ...actual,
    watch: (...args: any[]) => {
      watchMock(...args);
      // Retorna um watcher fake com método close
      return { close: () => {} };
    },
  };
});

const TEST_DIR = path.join(process.cwd(), "__test_watchdir_ext__");

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  watchMock.mockReset();
  statSyncMock.mockReset();
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("fileWatcher-extended: watch", () => {
  it("chamar watch() no mesmo path duas vezes é idempotente (não chama fs.watch duas vezes)", () => {
    const watcher = new FileWatcher();
    watcher.watch(TEST_DIR);
    const firstCalls = watchMock.mock.calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(1);
    watcher.watch(TEST_DIR); // segunda chamada — deve ser no-op
    expect(watchMock.mock.calls.length).toBe(firstCalls);
    watcher.close();
  });

  it("watch() em arquivo (não diretório) chama fs.watch com path do arquivo", () => {
    const filePath = path.join(TEST_DIR, "single-file.txt");
    fs.writeFileSync(filePath, "content", "utf8");

    const watcher = new FileWatcher();
    watcher.watch(filePath);

    // fs.watch deve ter sido chamado com o caminho do arquivo
    expect(watchMock).toHaveBeenCalled();
    const lastCall = watchMock.mock.calls[watchMock.mock.calls.length - 1];
    expect(lastCall![0]).toBe(filePath);

    watcher.close();
  });

  it("watch() em diretório com recursive=true passa a flag para fs.watch", () => {
    const watcher = new FileWatcher();
    watcher.watch(TEST_DIR, true);

    // Verifica que fs.watch foi chamado com options.recursive=true
    const lastCall = watchMock.mock.calls[watchMock.mock.calls.length - 1];
    expect(lastCall).toBeDefined();
    // Segundo argumento deve ser objeto com recursive: true
    expect(lastCall![1]).toEqual(expect.objectContaining({ recursive: true }));

    watcher.close();
  });
});

describe("fileWatcher-extended: onChange (callbacks)", () => {
  it("múltiplos callbacks registrados recebem o mesmo evento durante polling", async () => {
    const testFile = path.join(TEST_DIR, "multi-cb.txt");
    fs.writeFileSync(testFile, "v1", "utf8");

    const watcher = new FileWatcher();
    const events1: FileChangeEvent[] = [];
    const events2: FileChangeEvent[] = [];
    const events3: FileChangeEvent[] = [];

    watcher.addCallback((e) => events1.push(e));
    watcher.addCallback((e) => events2.push(e));
    watcher.addCallback((e) => events3.push(e));

    watcher.watch(testFile);
    watcher.startPolling(50);
    await new Promise((r) => setTimeout(r, 150));

    fs.writeFileSync(testFile, "v2", "utf8");
    await new Promise((r) => setTimeout(r, 150));

    watcher.close();
    // Todos os 3 callbacks devem ter recebido pelo menos um evento de modificação
    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBe(events1.length);
    expect(events3.length).toBe(events1.length);
  });

  it("evento recebido tem estrutura correta (type, filePath, timestamp)", async () => {
    const testFile = path.join(TEST_DIR, "structure.txt");
    fs.writeFileSync(testFile, "x", "utf8");

    const watcher = new FileWatcher();
    const events: FileChangeEvent[] = [];
    watcher.addCallback((e) => events.push(e));

    watcher.watch(testFile);
    watcher.startPolling(50);
    await new Promise((r) => setTimeout(r, 150));

    watcher.close();
    expect(events.length).toBeGreaterThan(0);
    const e = events[0]!;
    expect(typeof e.type).toBe("string");
    expect(["created", "modified", "deleted", "renamed"]).toContain(e.type);
    expect(typeof e.filePath).toBe("string");
    expect(e.filePath).toBe(testFile);
    expect(e.timestamp).toBeInstanceOf(Date);
  });
});

describe("fileWatcher-extended: unwatch", () => {
  it("unwatch() em path não monitorado é no-op (não lança erro)", () => {
    const watcher = new FileWatcher();
    expect(() => watcher.unwatch("/never/watched/path/here")).not.toThrow();
    watcher.close();
  });

  it("unwatch() remove o path e eventos posteriores via polling não incluem esse path", async () => {
    const testFile = path.join(TEST_DIR, "unwatch-target.txt");
    fs.writeFileSync(testFile, "v1", "utf8");

    const watcher = new FileWatcher();
    const events: FileChangeEvent[] = [];
    watcher.addCallback((e) => events.push(e));

    watcher.watch(testFile);
    watcher.startPolling(50);
    await new Promise((r) => setTimeout(r, 150));

    watcher.unwatch(testFile);
    const eventsBefore = events.length;
    // Modifica o arquivo após unwatch — não deve gerar novos eventos para esse path
    fs.writeFileSync(testFile, "v2", "utf8");
    await new Promise((r) => setTimeout(r, 150));

    watcher.close();
    // Events count deve permanecer o mesmo (unwatch removeu o path do polling)
    expect(events.length).toBe(eventsBefore);
  });
});

describe("fileWatcher-extended: edge cases", () => {
  it("close() pode ser chamado múltiplas vezes sem lançar erro e limpa todo o estado", () => {
    const watcher = new FileWatcher();
    watcher.watch(TEST_DIR);
    watcher.startPolling(1000);

    expect(() => {
      watcher.close();
      watcher.close(); // segunda chamada
      watcher.close(); // terceira chamada
    }).not.toThrow();

    // Após close(), operações em estado vazio não devem lançar
    expect(() => watcher.startPolling(500)).not.toThrow();
    watcher.stopPolling();
    watcher.close();
  });
});
