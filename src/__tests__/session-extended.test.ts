/**
 * session-extended.test.ts — Testes para session.ts (new JSONL auto-persist API).
 *
 * session.ts agora usa append-only JSONL (como Claude Code):
 * - startSession() cria arquivo .jsonl
 * - appendMessage() adiciona mensagem imediatamente
 * - getLastSession() retorna última sessão do projeto
 * - loadSessionMessages() lê mensagens de uma sessão
 * - listSessions() lista sessões do projeto
 * - deleteSession() / renameSession() gerenciam
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

let tmpHome: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  try { process.chdir(originalCwd); } catch {}
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

async function loadSessionModule() {
  vi.resetModules();
  return await import("../session.js");
}

describe("session — JSONL auto-persist (Claude Code style)", () => {
  it("startSession cria arquivo .jsonl", async () => {
    const { startSession } = await loadSessionModule();
    const id = startSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("startSession cria header no arquivo", async () => {
    const { startSession, getLastSession } = await loadSessionModule();
    startSession();
    const last = getLastSession();
    expect(last).not.toBeNull();
    const content = fs.readFileSync(last!.path, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    expect(header.type).toBe("session-header");
    expect(header.id).toBeDefined();
    expect(header.createdAt).toBeDefined();
  });

  it("appendMessage adiciona mensagem ao arquivo", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "hello world" });
    const last = getLastSession();
    const content = fs.readFileSync(last!.path, "utf8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // header + 1 message
    const msg = JSON.parse(lines[1]!);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("hello world");
  });

  it("appendMessage adiciona múltiplas mensagens", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "msg 1" });
    appendMessage({ role: "assistant", content: "msg 2" });
    appendMessage({ role: "tool", content: "msg 3", tool_call_id: "tc1" });
    const last = getLastSession();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(4); // header + 3 messages
  });

  it("appendMessage auto-starta sessão se nenhuma ativa", async () => {
    const { appendMessage, getLastSession } = await loadSessionModule();
    appendMessage({ role: "user", content: "auto-start" });
    const last = getLastSession();
    expect(last).not.toBeNull();
  });

  it("getLastSession retorna null se não há sessões", async () => {
    const { getLastSession } = await loadSessionModule();
    const last = getLastSession();
    expect(last).toBeNull();
  });

  it("getLastSession retorna sessão mais recente", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "first" });
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.id).toBeDefined();
  });

  it("loadSessionMessages retorna mensagens (sem header)", async () => {
    const { startSession, appendMessage, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "hello" });
    appendMessage({ role: "assistant", content: "hi" });
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(2);
    // No compaction happened, so lastSnapshot should be null
    expect(loaded!.lastSnapshot).toBeNull();
  });

  it("loadSessionMessages retorna null para sessão inexistente", async () => {
    const { loadSessionMessages } = await loadSessionModule();
    const msgs = loadSessionMessages("nonexistent-id");
    expect(msgs).toBeNull();
  });

  it("listSessions retorna vazio se não há sessões", async () => {
    const { listSessions } = await loadSessionModule();
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it("listSessions retorna 1 após startSession", async () => {
    const { startSession, listSessions } = await loadSessionModule();
    startSession();
    const sessions = listSessions();
    expect(sessions.length).toBe(1);
  });

  it("listSessions tem metadados", async () => {
    const { startSession, appendMessage, listSessions } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "test message" });
    const sessions = listSessions();
    const s = sessions[0]!;
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("createdAt");
    expect(s).toHaveProperty("lastModified");
    expect(s).toHaveProperty("messageCount");
    expect(s).toHaveProperty("summary");
  });

  it("listSessions summary contém primeira mensagem do usuário", async () => {
    const { startSession, appendMessage, listSessions } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "crie um script de player data" });
    const sessions = listSessions();
    expect(sessions[0]!.summary).toContain("crie um script");
  });

  it("deleteSession remove arquivo", async () => {
    const { startSession, deleteSession, listSessions } = await loadSessionModule();
    const id = startSession();
    const ok = deleteSession(id);
    expect(ok).toBe(true);
    expect(listSessions().length).toBe(0);
  });

  it("deleteSession retorna false para inexistente", async () => {
    const { deleteSession } = await loadSessionModule();
    const ok = deleteSession("nonexistent");
    expect(ok).toBe(false);
  });

  it("renameSession renomeia", async () => {
    const { startSession, renameSession, listSessions } = await loadSessionModule();
    const oldId = startSession();
    const ok = renameSession(oldId, "new-name");
    expect(ok).toBe(true);
    const sessions = listSessions();
    expect(sessions.find(s => s.id === "new-name")).toBeDefined();
    expect(sessions.find(s => s.id === oldId)).toBeUndefined();
  });

  it("renameSession retorna false para inexistente", async () => {
    const { renameSession } = await loadSessionModule();
    const ok = renameSession("nonexistent", "new");
    expect(ok).toBe(false);
  });

  it("renameSession retorna false se novo nome existe", async () => {
    const { startSession, renameSession } = await loadSessionModule();
    startSession(undefined, "session-a");
    startSession(undefined, "session-b");
    const ok = renameSession("session-a", "session-b");
    expect(ok).toBe(false);
  });

  it("getActiveSessionId retorna null antes de startSession", async () => {
    const { getActiveSessionId } = await loadSessionModule();
    expect(getActiveSessionId()).toBeNull();
  });

  it("getActiveSessionId retorna ID após startSession", async () => {
    const { startSession, getActiveSessionId } = await loadSessionModule();
    const id = startSession();
    expect(getActiveSessionId()).toBe(id);
  });

  it("setActiveSession muda sessão ativa", async () => {
    const { startSession, setActiveSession, getActiveSessionId } = await loadSessionModule();
    startSession(undefined, "first");
    startSession(undefined, "second");
    setActiveSession("first");
    expect(getActiveSessionId()).toBe("first");
  });

  it("diferentes projetos têm sessões separadas", async () => {
    const { startSession, listSessions } = await loadSessionModule();
    // Sessão no cwd atual
    startSession();
    expect(listSessions().length).toBe(1);

    // Mudar cwd e criar outra sessão
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "other-project-"));
    process.chdir(otherDir);
    vi.resetModules();
    const { startSession: start2, listSessions: list2 } = await import("../session.js");
    start2();
    expect(list2().length).toBe(1); // 1 sessão no novo projeto (não vê a do outro)

    // Voltar
    process.chdir(originalCwd);
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it("appendMessage preserva tool_call_id", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();
    appendMessage({ role: "tool", tool_call_id: "call_abc123", content: "result" });
    const last = getLastSession();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    const msg = JSON.parse(lines[1]!);
    expect(msg.tool_call_id).toBe("call_abc123");
  });

  it("appendMessage adiciona timestamp", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "test" });
    const last = getLastSession();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    const msg = JSON.parse(lines[1]!);
    expect(msg.ts).toBeDefined();
    expect(typeof msg.ts).toBe("number");
  });

  it("loadSessionMessages lida com JSONL corrompido", async () => {
    const { startSession, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    const last = getLastSession();
    // Adiciona linha corrompida
    fs.appendFileSync(last!.path, "{invalid json\n", "utf8");
    const loaded = loadSessionMessages(last!.id);
    // Deve pular linha corrompida e retornar mensagens válidas
    expect(loaded).not.toBeNull();
    expect(Array.isArray(loaded!.messages)).toBe(true);
  });

  it("múltiplas sessões no mesmo projeto", async () => {
    const { startSession, listSessions } = await loadSessionModule();
    startSession(undefined, "s1");
    startSession(undefined, "s2");
    startSession(undefined, "s3");
    expect(listSessions().length).toBe(3);
  });

  // ─── Compaction snapshot tests (limite-historico fix) ─────────────────────

  it("appendCompactionSnapshot salva snapshot no JSONL", async () => {
    const { startSession, appendCompactionSnapshot, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    const snapshotMessages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "[CONVERSATION MEMORY - compacted]" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ];
    appendCompactionSnapshot(snapshotMessages, "llm");
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastSnapshot).not.toBeNull();
    expect(loaded!.lastSnapshot!.messages).toHaveLength(4);
    expect(loaded!.lastSnapshot!.method).toBe("llm");
  });

  it("loadSessionMessages retorna lastSnapshot=null quando não há snapshot", async () => {
    const { startSession, appendMessage, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "hello" });
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.lastSnapshot).toBeNull();
    expect(loaded!.messages.length).toBe(1);
  });

  it("snapshot não aparece no array de mensagens regulares", async () => {
    const { startSession, appendMessage, appendCompactionSnapshot, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "msg1" });
    appendCompactionSnapshot([{ role: "system", content: "compacted" }], "mechanical");
    appendMessage({ role: "user", content: "msg2" });
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    // Regular messages should NOT include the snapshot
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0]).toMatchObject({ role: "user", content: "msg1" });
    expect(loaded!.messages[1]).toMatchObject({ role: "user", content: "msg2" });
    // Snapshot should be separate
    expect(loaded!.lastSnapshot).not.toBeNull();
    expect(loaded!.lastSnapshot!.messages).toHaveLength(1);
  });
});

describe("session — effort level persistence (per-session)", () => {
  /**
   * These tests cover the feature where the thinking effort level
   * (low/medium/high/max) is persisted in the session header and restored
   * when the session is loaded. This makes effort per-session — switching
   * sessions restores each session's effort.
   */

  it("startSession escreve effortLevel atual no header", async () => {
    const { startSession, getLastSession } = await loadSessionModule();
    startSession();
    const last = getLastSession();
    expect(last).not.toBeNull();
    const content = fs.readFileSync(last!.path, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    // effortLevel field should be present and a valid level
    expect(header.effortLevel).toBeDefined();
    expect(["low", "medium", "high", "max"]).toContain(header.effortLevel);
  });

  it("getLastSession retorna effortLevel do header", async () => {
    const { startSession, getLastSession } = await loadSessionModule();
    startSession();
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.effortLevel).toBeDefined();
    expect(["low", "medium", "high", "max"]).toContain(last!.effortLevel);
  });

  it("loadSessionMessages retorna effortLevel do header", async () => {
    const { startSession, appendMessage, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "hello" });
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.effortLevel).toBeDefined();
    expect(["low", "medium", "high", "max"]).toContain(loaded!.effortLevel);
  });

  it("updateSessionEffortLevel reescreve o header com novo level", async () => {
    const { startSession, updateSessionEffortLevel, getLastSession } = await loadSessionModule();
    startSession();
    // Change to "max"
    updateSessionEffortLevel("max");
    const last = getLastSession();
    expect(last).not.toBeNull();
    expect(last!.effortLevel).toBe("max");
    // Verify by reading the file directly
    const content = fs.readFileSync(last!.path, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    expect(header.effortLevel).toBe("max");
  });

  it("updateSessionEffortLevel ignora level inválido", async () => {
    const { startSession, updateSessionEffortLevel, getLastSession } = await loadSessionModule();
    startSession();
    // Capture original level
    const lastBefore = getLastSession();
    const originalLevel = lastBefore!.effortLevel;
    // Try to set invalid level — should be a no-op
    updateSessionEffortLevel("extreme" as any);
    const lastAfter = getLastSession();
    expect(lastAfter!.effortLevel).toBe(originalLevel);
  });

  it("updateSessionEffortLevel é no-op quando não há sessão ativa", async () => {
    const { updateSessionEffortLevel } = await loadSessionModule();
    // Should not throw — just silently return
    expect(() => updateSessionEffortLevel("high")).not.toThrow();
  });

  it("updateSessionEffortLevel preserva outras mensagens do arquivo", async () => {
    const { startSession, appendMessage, updateSessionEffortLevel, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    appendMessage({ role: "user", content: "msg1" });
    appendMessage({ role: "assistant", content: "reply1" });
    updateSessionEffortLevel("high");
    const last = getLastSession();
    const loaded = loadSessionMessages(last!.id);
    // Messages should still be there (not corrupted by the header rewrite)
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0]).toMatchObject({ role: "user", content: "msg1" });
    expect(loaded!.messages[1]).toMatchObject({ role: "assistant", content: "reply1" });
    // And effort should be updated
    expect(loaded!.effortLevel).toBe("high");
  });

  it("sessões antigas sem effortLevel retornam null (backward compat)", async () => {
    const { startSession, getLastSession, loadSessionMessages, getProjectSessionDir } = await loadSessionModule();
    // Don't use startSession — manually create an old-style header without effortLevel
    startSession();
    const last = getLastSession();
    expect(last).not.toBeNull();
    // Rewrite the header to remove effortLevel (simulate old session)
    const content = fs.readFileSync(last!.path, "utf8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]!);
    delete header.effortLevel;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(last!.path, lines.join("\n"), "utf8");
    // Now load — effortLevel should be null (not crash, not default)
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.effortLevel).toBeNull();
    // getLastSession should also return null for effortLevel
    const last2 = getLastSession();
    expect(last2!.effortLevel).toBeNull();
    void getProjectSessionDir; // silence unused warning if any
  });

  it("valor inválido de effortLevel no header retorna null (defensive)", async () => {
    const { startSession, getLastSession, loadSessionMessages } = await loadSessionModule();
    startSession();
    const last = getLastSession();
    // Rewrite the header with an invalid effortLevel
    const content = fs.readFileSync(last!.path, "utf8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]!);
    header.effortLevel = "extreme"; // invalid
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(last!.path, lines.join("\n"), "utf8");
    // load should return null for effortLevel (not the invalid value)
    const loaded = loadSessionMessages(last!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.effortLevel).toBeNull();
  });
});
