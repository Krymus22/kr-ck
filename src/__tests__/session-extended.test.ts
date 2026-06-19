/**
 * session-extended.test.ts — Cobertura adicional do módulo session.
 *
 * Foca em:
 *   - saveSession (3 casos novos)
 *   - loadSession (2 casos novos)
 *   - listSessions (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo session.test.ts básico.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveSession, loadSession, listSessions, deleteSession } from "../session.js";
import * as history from "../history.js";

const SESSION_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".claude-killer",
  "sessions"
);

beforeAll(() => {
  history.resetHistory();
});

afterAll(() => {
  // Limpa sessões criadas por estes testes
  for (const id of [
    "ext_save_struct",
    "ext_save_no_history",
    "ext_load_caveman",
    "ext_list_sort_a",
    "ext_list_sort_b",
    "ext_list_no_count",
    "ext_edge_missing_messages",
  ]) {
    try { deleteSession(id); } catch { /* ok */ }
  }
});

describe("session-extended: saveSession", () => {
  it("salva um arquivo JSON com id, createdAt, lastModified e messageCount preenchidos", () => {
    history.resetHistory();
    history.addUserMessage("hello extended");
    const id = saveSession("ext_save_struct");

    const filePath = path.join(SESSION_DIR, `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(data.id).toBe("ext_save_struct");
    expect(typeof data.createdAt).toBe("string");
    expect(typeof data.lastModified).toBe("string");
    expect(data.messageCount).toBeGreaterThan(0);
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it("salva cavemanLevel e planMode retornados do history", () => {
    history.resetHistory();
    history.setCavemanLevel(3);
    history.setPlanMode(true);
    history.addUserMessage("with state");
    const id = saveSession("ext_save_state");

    const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${id}.json`), "utf8"));
    expect(data.cavemanLevel).toBe(3);
    expect(data.planMode).toBe(true);

    // Reset estado para não interferir em outros testes
    history.setCavemanLevel(0);
    history.setPlanMode(false);
    deleteSession(id);
  });

  it("salva sessão mesmo sem novas mensagens do usuário (apenas system prompt)", () => {
    history.resetHistory();
    const id = saveSession("ext_save_no_history");
    const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${id}.json`), "utf8"));
    // resetHistory reinicia com o system prompt; messageCount reflete esse estado
    expect(data.messageCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages.some((m: { role: string }) => m.role === "system")).toBe(true);
  });
});

describe("session-extended: loadSession", () => {
  it("restaura mensagens do usuário e do assistente após resetHistory", () => {
    history.resetHistory();
    history.addUserMessage("pergunta");
    history.addRawAssistantMessage({
      role: "assistant",
      content: "resposta",
    });
    saveSession("ext_load_restore");

    history.resetHistory();
    expect(history.getHistory().filter((m) => m.role !== "system")).toHaveLength(0);

    const ok = loadSession("ext_load_restore");
    expect(ok).toBe(true);
    const restored = history.getHistory();
    const userMsgs = restored.filter((m) => m.role === "user");
    const assistantMsgs = restored.filter((m) => m.role === "assistant");
    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("restaura cavemanLevel e planMode a partir dos campos salvos", () => {
    history.resetHistory();
    history.setCavemanLevel(0);
    history.setPlanMode(false);
    history.addUserMessage("x");
    const filePath = path.join(SESSION_DIR, "ext_load_caveman.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        id: "ext_load_caveman",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        messageCount: 1,
        messages: [{ role: "user", content: "x" }],
        cavemanLevel: 5,
        planMode: true,
      }),
      "utf8"
    );

    const ok = loadSession("ext_load_caveman");
    expect(ok).toBe(true);
    expect(history.getCavemanLevel()).toBe(5);
    expect(history.isPlanMode()).toBe(true);

    // Limpa
    history.setCavemanLevel(0);
    history.setPlanMode(false);
  });
});

describe("session-extended: listSessions", () => {
  it("ordena sessões por lastModified decrescente (mais recente primeiro)", () => {
    // Cria duas sessões com timestamps conhecidos
    const filePathA = path.join(SESSION_DIR, "ext_list_sort_a.json");
    const filePathB = path.join(SESSION_DIR, "ext_list_sort_b.json");
    fs.writeFileSync(
      filePathA,
      JSON.stringify({
        id: "ext_list_sort_a",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastModified: "2024-01-01T10:00:00.000Z",
        messageCount: 1,
      }),
      "utf8"
    );
    fs.writeFileSync(
      filePathB,
      JSON.stringify({
        id: "ext_list_sort_b",
        createdAt: "2024-01-02T00:00:00.000Z",
        lastModified: "2024-01-02T10:00:00.000Z",
        messageCount: 1,
      }),
      "utf8"
    );

    const sessions = listSessions();
    const aIdx = sessions.findIndex((s) => s.id === "ext_list_sort_a");
    const bIdx = sessions.findIndex((s) => s.id === "ext_list_sort_b");
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    // b é mais recente, deve vir antes de a
    expect(bIdx).toBeLessThan(aIdx);
  });

  it("gera summary com contagem de mensagens e usa 'unknown' quando createdAt/lastModified ausentes", () => {
    const filePath = path.join(SESSION_DIR, "ext_list_no_count.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        id: "ext_list_no_count",
        // Sem createdAt/lastModified/messageCount
      }),
      "utf8"
    );

    const sessions = listSessions();
    const found = sessions.find((s) => s.id === "ext_list_no_count");
    expect(found).toBeDefined();
    expect(found!.createdAt).toBe("unknown");
    expect(found!.lastModified).toBe("unknown");
    expect(found!.messageCount).toBe(0);
    expect(found!.summary).toContain("0 messages");
  });
});

describe("session-extended: edge cases", () => {
  it("loadSession pula entradas com mensagens ausentes (messages não-array) sem quebrar", () => {
    const filePath = path.join(SESSION_DIR, "ext_edge_missing_messages.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        id: "ext_edge_missing_messages",
        createdAt: new Date().toISOString(),
        lastModified: new Date().toISOString(),
        messageCount: 0,
        // messages omitido de propósito
      }),
      "utf8"
    );

    // Deve retornar false (TypeError ao iterar undefined) sem lançar exceção
    history.resetHistory();
    const ok = loadSession("ext_edge_missing_messages");
    expect(typeof ok).toBe("boolean");
  });
});
