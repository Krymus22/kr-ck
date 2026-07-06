/**
 * session-extended.test.ts — Testes para session.ts (save/load/list/delete/rename).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

vi.mock("../history.js", () => ({
  getHistory: vi.fn(() => [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]),
  getCavemanLevel: vi.fn(() => null),
  isPlanMode: vi.fn(() => false),
  resetHistory: vi.fn(),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  setPlanMode: vi.fn(),
  setCavemanLevel: vi.fn(),
}));

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// Dynamic import after HOME is set
async function loadSessionModule() {
  vi.resetModules();
  return await import("../session.js");
}

describe("session — extended", () => {
  it("saveSession retorna ID", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("saveSession cria arquivo", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    const sessionDir = path.join(tmpHome, ".claude-killer", "sessions");
    const files = fs.readdirSync(sessionDir);
    expect(files).toContain(`${id}.json`);
  });

  it("saveSession usa ID custom", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession("my-custom-id");
    expect(id).toBe("my-custom-id");
  });

  it("saveSession salva mensagens", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    const filePath = path.join(tmpHome, ".claude-killer", "sessions", `${id}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(data.messages).toBeDefined();
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("saveSession salva cavemanLevel e planMode", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    const filePath = path.join(tmpHome, ".claude-killer", "sessions", `${id}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(data).toHaveProperty("cavemanLevel");
    expect(data).toHaveProperty("planMode");
  });

  it("saveSession salva timestamps", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    const filePath = path.join(tmpHome, ".claude-killer", "sessions", `${id}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(data.createdAt).toBeDefined();
    expect(data.lastModified).toBeDefined();
  });

  it("saveSession salva messageCount", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession();
    const filePath = path.join(tmpHome, ".claude-killer", "sessions", `${id}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(typeof data.messageCount).toBe("number");
  });

  it("loadSession retorna true para sessão existente", async () => {
    const { saveSession, loadSession } = await loadSessionModule();
    const id = saveSession();
    const result = loadSession(id);
    expect(result).toBe(true);
  });

  it("loadSession retorna false para inexistente", async () => {
    const { loadSession } = await loadSessionModule();
    const result = loadSession("nonexistent-id-12345");
    expect(result).toBe(false);
  });

  it("listSessions retorna vazio quando não há sessões", async () => {
    const { listSessions } = await loadSessionModule();
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it("listSessions retorna 1 após salvar", async () => {
    const { saveSession, listSessions } = await loadSessionModule();
    saveSession();
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
  });

  it("listSessions retorna múltiplas", async () => {
    const { saveSession, listSessions } = await loadSessionModule();
    saveSession("s1");
    saveSession("s2");
    saveSession("s3");
    const sessions = listSessions();
    expect(sessions).toHaveLength(3);
  });

  it("listSessions tem metadados", async () => {
    const { saveSession, listSessions } = await loadSessionModule();
    saveSession("test-s");
    const sessions = listSessions();
    const s = sessions[0];
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("createdAt");
    expect(s).toHaveProperty("lastModified");
    expect(s).toHaveProperty("messageCount");
    expect(s).toHaveProperty("summary");
  });

  it("deleteSession retorna true para existente", async () => {
    const { saveSession, deleteSession } = await loadSessionModule();
    const id = saveSession();
    const result = deleteSession(id);
    expect(result).toBe(true);
  });

  it("deleteSession retorna false para inexistente", async () => {
    const { deleteSession } = await loadSessionModule();
    const result = deleteSession("nonexistent");
    expect(result).toBe(false);
  });

  it("deleteSession remove arquivo", async () => {
    const { saveSession, deleteSession } = await loadSessionModule();
    const id = saveSession();
    const filePath = path.join(tmpHome, ".claude-killer", "sessions", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    deleteSession(id);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("renameSession renomeia sessão", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("old-name");
    const result = renameSession("old-name", "new-name");
    expect(result).toBe(true);
  });

  it("renameSession retorna false para inexistente", async () => {
    const { renameSession } = await loadSessionModule();
    const result = renameSession("nonexistent", "new-name");
    expect(result).toBe(false);
  });

  it("renameSession retorna false se novo nome existe", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("a");
    saveSession("b");
    const result = renameSession("a", "b");
    expect(result).toBe(false);
  });

  it("renameSession remove arquivo antigo", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("old-name");
    renameSession("old-name", "new-name");
    const oldPath = path.join(tmpHome, ".claude-killer", "sessions", "old-name.json");
    expect(fs.existsSync(oldPath)).toBe(false);
  });

  it("renameSession cria arquivo novo", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("old-name");
    renameSession("old-name", "new-name");
    const newPath = path.join(tmpHome, ".claude-killer", "sessions", "new-name.json");
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it("renameSession preserva mensagens", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("old-name");
    renameSession("old-name", "new-name");
    const newPath = path.join(tmpHome, ".claude-killer", "sessions", "new-name.json");
    const data = JSON.parse(fs.readFileSync(newPath, "utf8"));
    expect(data.messages).toBeDefined();
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("renameSession atualiza id no conteúdo", async () => {
    const { saveSession, renameSession } = await loadSessionModule();
    saveSession("old-name");
    renameSession("old-name", "new-name");
    const newPath = path.join(tmpHome, ".claude-killer", "sessions", "new-name.json");
    const data = JSON.parse(fs.readFileSync(newPath, "utf8"));
    expect(data.id).toBe("new-name");
  });

  it("autoSave retorna ID", async () => {
    const { autoSave } = await loadSessionModule();
    const id = autoSave();
    expect(typeof id).toBe("string");
    expect(id).not.toBeNull();
  });

  it("autoSave retorna null em erro", async () => {
    process.env.HOME = "/nonexistent/path/that/does/not/exist";
    const { autoSave } = await loadSessionModule();
    const result = autoSave();
    expect(result).toBeNull();
  });

  it("saveSession com caracteres especiais no ID", async () => {
    const { saveSession } = await loadSessionModule();
    const id = saveSession("session-with-dashes_and_underscores");
    expect(id).toBe("session-with-dashes_and_underscores");
  });

  it("saveSession idempotente (mesmo ID sobrescreve)", async () => {
    const { saveSession, listSessions } = await loadSessionModule();
    saveSession("my-session");
    saveSession("my-session");
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
  });

  it("listSessions lida com JSON corrompido", async () => {
    const { listSessions } = await loadSessionModule();
    const sessionDir = path.join(tmpHome, ".claude-killer", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "corrupt.json"), "{invalid json");
    const sessions = listSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});
