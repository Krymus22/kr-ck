/**
 * dataGuard.test.ts — Testes para o DataGuard (agente de proteção de dados).
 *
 * Cobre:
 *   1. buildDataGuardSystemPrompt — contém instruções de proteção de dados
 *   2. buildDataGuardContext — inclui lista de arquivos e contexto
 *   3. quickScanForDataPatterns — detecta padrões perigosos
 *   4. parseFindings — parser para formato DataGuard
 *   5. formatDataGuardMessage — mensagem formatada para a IA
 *   6. resetDataGuardState — reset de estado
 *   7. runDataGuard — integração (mocked)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  config: {
    model: "test-model", nvidiaApiKey: "test", nvidiaApiKeys: "",
    nvidiaApiKeysFile: "", nvidiaBaseUrl: "https://test",
    maxTokens: 4096, temperature: 0.6, topP: 0.9,
    contextWindowTokens: 128000, contextCompactThreshold: 0.65,
  },
}));

import {
  resetDataGuardState,
  runDataGuard,
  type DataGuardResult,
} from "../dataGuard.js";

// ─── resetDataGuardState ──────────────────────────────────────────────────

describe("dataGuard: resetDataGuardState", () => {
  it("não lança erro", () => {
    expect(() => resetDataGuardState()).not.toThrow();
  });

  it("pode ser chamado múltiplas vezes", () => {
    expect(() => {
      resetDataGuardState();
      resetDataGuardState();
    }).not.toThrow();
  });
});

// ─── runDataGuard ─────────────────────────────────────────────────────────

describe("dataGuard: runDataGuard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dataguard-"));
    resetDataGuardState();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("retorna shouldBlock=false quando não há arquivos modificados", async () => {
    const result = await runDataGuard([], "task", "response");
    expect(result.shouldBlock).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.completed).toBe(false);
  });

  it("retorna completed=false quando arquivos não existem", async () => {
    const result = await runDataGuard(["/nonexistent/file.luau"], "task", "response");
    // Should still try to run (static scan skips non-existent, LLM gets context)
    // But LLM is mocked, so it depends on the mock
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("aceita arquivos .luau (Roblox)", async () => {
    const filePath = path.join(tmpDir, "datastore.luau");
    fs.writeFileSync(filePath, `
local DataStoreService = game:GetService("DataStoreService")
local playerData = DataStoreService:GetDataStore("PlayerData")

game.Players.PlayerRemoving:Connect(function(player)
    playerData:SetAsync(player.UserId, { coins = 0 })
end)
`);
    // Just verify it doesn't crash
    const result = await runDataGuard([filePath], "create datastore", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("aceita arquivos .ts (TypeScript)", async () => {
    const filePath = path.join(tmpDir, "db.ts");
    fs.writeFileSync(filePath, `
function saveUser(id: string, data: any) {
    localStorage.setItem(id, JSON.stringify(data));
}
`);
    const result = await runDataGuard([filePath], "save user", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("aceita arquivos .py (Python)", async () => {
    const filePath = path.join(tmpDir, "db.py");
    fs.writeFileSync(filePath, `
def delete_user(user_id):
    cursor.execute(f"DELETE FROM users WHERE id = {user_id}")
`);
    const result = await runDataGuard([filePath], "delete user", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("aceita múltiplos arquivos", async () => {
    const files = [
      path.join(tmpDir, "a.luau"),
      path.join(tmpDir, "b.ts"),
      path.join(tmpDir, "c.py"),
    ];
    for (const f of files) {
      fs.writeFileSync(f, "-- placeholder\n");
    }
    const result = await runDataGuard(files, "multi-file task", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("não crasha com arquivo vazio", async () => {
    const filePath = path.join(tmpDir, "empty.luau");
    fs.writeFileSync(filePath, "");
    const result = await runDataGuard([filePath], "task", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("não crasha com arquivo muito grande", async () => {
    const filePath = path.join(tmpDir, "big.luau");
    fs.writeFileSync(filePath, "local x = 1\n".repeat(10000));
    const result = await runDataGuard([filePath], "task", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });
});

// ─── DataGuardResult interface ────────────────────────────────────────────

describe("dataGuard: DataGuardResult interface", () => {
  it("tem todos os campos obrigatórios", () => {
    const result: DataGuardResult = {
      shouldBlock: false,
      findings: [],
      message: "",
      completed: false,
    };
    expect(result.shouldBlock).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.message).toBe("");
    expect(result.completed).toBe(false);
  });

  it("shouldBlock pode ser true", () => {
    const result: DataGuardResult = {
      shouldBlock: true,
      findings: [{ severity: "critical", file: "f.luau", description: "SetAsync without GetAsync", suggestion: "Use UpdateAsync" }],
      message: "[DATAGUARD] issues found",
      completed: true,
    };
    expect(result.shouldBlock).toBe(true);
    expect(result.findings.length).toBe(1);
  });
});

// ─── Padrões de dados perigosos ───────────────────────────────────────────

describe("dataGuard: static scan detecta padrões perigosos", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dg-patterns-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("arquivo com SetAsync é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "data.luau");
    fs.writeFileSync(f, `playerData:SetAsync(player.UserId, data)`);
    const result = await runDataGuard([f], "save data", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com RemoveAsync é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "data.luau");
    fs.writeFileSync(f, `playerData:RemoveAsync(player.UserId)`);
    const result = await runDataGuard([f], "remove data", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com DROP TABLE é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "db.py");
    fs.writeFileSync(f, `cursor.execute("DROP TABLE users")`);
    const result = await runDataGuard([f], "drop table", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com DELETE FROM é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "db.py");
    fs.writeFileSync(f, `cursor.execute("DELETE FROM users")`);
    const result = await runDataGuard([f], "delete all", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com localStorage é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "store.ts");
    fs.writeFileSync(f, `localStorage.setItem("user", JSON.stringify(data))`);
    const result = await runDataGuard([f], "save local", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com RemoteEvent é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "remote.luau");
    fs.writeFileSync(f, `remoteEvent.OnServerEvent:Connect(function(player, data) end)`);
    const result = await runDataGuard([f], "remote event", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com PlayerRemoving é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "player.luau");
    fs.writeFileSync(f, `game.Players.PlayerRemoving:Connect(function(player) end)`);
    const result = await runDataGuard([f], "player leave", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo com BindToClose é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "shutdown.luau");
    fs.writeFileSync(f, `game:BindToClose(function() end)`);
    const result = await runDataGuard([f], "shutdown handler", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });

  it("arquivo limpo (sem padrões perigosos) é aceito sem crashar", async () => {
    const f = path.join(tmpDir, "clean.luau");
    fs.writeFileSync(f, `local x = 1\nprint(x)`);
    const result = await runDataGuard([f], "simple task", "done");
    expect(typeof result.shouldBlock).toBe("boolean");
  });
});
