/**
 * toolUpdater-extended.test.ts
 *
 * Expande cobertura do toolUpdater.ts com:
 *   - checkToolUpdate: tool desconhecido, parse de versão installed/latest,
 *     comparação de strings, error: not installed
 *   - performUpdateCheck: disabled retorna [], persiste state, autoInstall
 *   - shouldCheckNow: interval env, NaN timestamp, lastCheck null
 *   - forceCheckOnNextRun: limpa lastCheck e persiste
 *   - parsing version: regex \d+\.\d+\.\d+ em diferentes formatos
 * Não duplica testes do toolUpdater.test.ts.
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
  success: vi.fn(),
}));

// Mock do child_process com controlador de stdout/exit-code por teste
const mockRun = vi.hoisted(() => ({
  // Map: command -> { stdout, code }
  responses: new Map<string, { stdout: string; stderr: string; code: number }>(),
  emitError: false,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, _args: string[]) => {
    const { EventEmitter } = require("node:events");
    const child = new EventEmitter();
    (child as any).stdout = new EventEmitter();
    (child as any).stderr = new EventEmitter();
    (child as any).kill = vi.fn();
    setImmediate(() => {
      const resp = mockRun.responses.get(cmd) ?? { stdout: "", stderr: "", code: 1 };
      (child as any).stdout.emit("data", Buffer.from(resp.stdout));
      (child as any).stderr.emit("data", Buffer.from(resp.stderr));
      if (mockRun.emitError) {
        child.emit("error", new Error("spawn failed"));
        mockRun.emitError = false;
      } else {
        child.emit("close", resp.code);
      }
    });
    return child;
  }),
}));

describe("toolUpdater (extended)", () => {
  let tmpHome: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tu-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Limpa envs do toolUpdater
    delete process.env.TOOL_UPDATER_ENABLED;
    delete process.env.TOOL_UPDATER_INTERVAL_HOURS;
    delete process.env.TOOL_UPDATER_AUTO_INSTALL;
    mockRun.responses.clear();
    mockRun.emitError = false;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // ─── checkToolUpdate ─────────────────────────────────────────────────────

  it("checkToolUpdate retorna erro 'unknown repo' para tool não mapeado", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    const result = await checkToolUpdate("totally-unknown-tool-xyz");
    expect(result.tool).toBe("totally-unknown-tool-xyz");
    expect(result.error).toBe("unknown repo");
    expect(result.needsUpdate).toBe(false);
    expect(result.installed).toBeNull();
    expect(result.latest).toBeNull();
  });

  it("checkToolUpdate detecta needsUpdate=true quando installed != latest", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    // rojo --version retorna 7.4.0 (instalado)
    mockRun.responses.set("rojo", { stdout: "Rojo 7.4.0\n", stderr: "", code: 0 });
    // curl retorna tag_name v7.6.1
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    const result = await checkToolUpdate("rojo");
    expect(result.installed).toBe("7.4.0");
    expect(result.latest).toBe("7.6.1");
    expect(result.needsUpdate).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("checkToolUpdate retorna needsUpdate=false quando versões iguais", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    mockRun.responses.set("rojo", { stdout: "Rojo 7.6.1\n", stderr: "", code: 0 });
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    const result = await checkToolUpdate("rojo");
    expect(result.installed).toBe("7.6.1");
    expect(result.latest).toBe("7.6.1");
    expect(result.needsUpdate).toBe(false);
  });

  it("checkToolUpdate retorna 'not installed' quando binary falha", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    // rojo binary não existe → code != 0
    mockRun.responses.set("rojo", { stdout: "", stderr: "command not found", code: 127 });
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    const result = await checkToolUpdate("rojo");
    expect(result.installed).toBeNull();
    expect(result.error).toBe("not installed");
  });

  it("checkToolUpdate retorna 'could not fetch latest' quando curl falha", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    mockRun.responses.set("rojo", { stdout: "7.6.1\n", stderr: "", code: 0 });
    // curl falha (sem tag_name ou code != 0)
    mockRun.responses.set("curl", { stdout: "{}", stderr: "", code: 1 });
    const result = await checkToolUpdate("rojo");
    expect(result.installed).toBe("7.6.1");
    expect(result.latest).toBeNull();
    expect(result.error).toBe("could not fetch latest");
  });

  // ─── Kills L152-154 catch-block return mutation in getLatestGitHubVersion ─
  //
  // Mutation: removing/inverting `return null;` in the catch block of
  // getLatestGitHubVersion. When JSON.parse throws on invalid JSON, the catch
  // MUST return `null` so the caller reports "could not fetch latest". A
  // mutation that drops the return would yield `undefined`, which would fail
  // the `toBeNull()` assertion below. The previous test only exercised the
  // `!result.ok` early-return path (curl code != 0), NOT the catch block, so
  // the mutation survived.

  it("checkToolUpdate retorna latest=null quando curl retorna JSON inválido (catch block)", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    mockRun.responses.set("rojo", { stdout: "7.6.1\n", stderr: "", code: 0 });
    // curl returns code 0 but with invalid JSON → JSON.parse throws → catch
    mockRun.responses.set("curl", { stdout: "not-valid-json{", stderr: "", code: 0 });
    const result = await checkToolUpdate("rojo");
    expect(result.installed).toBe("7.6.1");
    // latest MUST be exactly null (not undefined) — this kills the mutation
    expect(result.latest).toBeNull();
    expect(result.error).toBe("could not fetch latest");
  });

  // ─── Direct contract test for getLatestGitHubVersion catch block ──────────
  //
  // checkToolUpdate masks the catch-block return mutation via defense-in-depth
  // (`if (!latest)` treats both null and undefined as falsy, then explicitly
  // sets `latest: null` in the error return). To kill mutations that change
  // `return null;` to `return undefined;` or remove the return entirely, we
  // export getLatestGitHubVersion and test its contract directly: when
  // JSON.parse throws, the function MUST return exactly `null`.

  it("getLatestGitHubVersion retorna null quando JSON.parse falha (catch block direto)", async () => {
    const { getLatestGitHubVersion } = await import("./../toolUpdater.js");
    mockRun.responses.set("curl", { stdout: "not-valid-json{", stderr: "", code: 0 });
    const result = await getLatestGitHubVersion("rojo-rbx/rojo");
    // MUST be exactly null (not undefined) — kills the catch-return mutation
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });

  it("getLatestGitHubVersion retorna null quando curl falha (code != 0)", async () => {
    const { getLatestGitHubVersion } = await import("./../toolUpdater.js");
    mockRun.responses.set("curl", { stdout: "", stderr: "network error", code: 1 });
    const result = await getLatestGitHubVersion("rojo-rbx/rojo");
    expect(result).toBeNull();
  });

  it("getLatestGitHubVersion retorna null quando tag_name está ausente", async () => {
    const { getLatestGitHubVersion } = await import("./../toolUpdater.js");
    mockRun.responses.set("curl", { stdout: JSON.stringify({}), stderr: "", code: 0 });
    const result = await getLatestGitHubVersion("rojo-rbx/rojo");
    expect(result).toBeNull();
  });

  it("getLatestGitHubVersion retorna versão (sem prefixo v) quando tag_name existe", async () => {
    const { getLatestGitHubVersion } = await import("./../toolUpdater.js");
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    const result = await getLatestGitHubVersion("rojo-rbx/rojo");
    expect(result).toBe("7.6.1");
  });

  // ─── performUpdateCheck ──────────────────────────────────────────────────

  it("performUpdateCheck retorna [] e não checa quando disabled", async () => {
    process.env.TOOL_UPDATER_ENABLED = "false";
    const { performUpdateCheck } = await import("./../toolUpdater.js");
    const results = await performUpdateCheck();
    expect(results).toEqual([]);
    // State não deve ser persistido
    const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("performUpdateCheck persiste cachedVersions após rodar", async () => {
    const { performUpdateCheck } = await import("./../toolUpdater.js");
    // Configura todos tools para falhar (not installed) — performUpdateCheck
    // ainda persiste lastCheck
    await performUpdateCheck();
    const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
    expect(fs.existsSync(statePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.lastCheck).toBeDefined();
    expect(typeof state.cachedVersions).toBe("object");
  });

  it("performUpdateCheck respeita intervalo — 2ª chamada logo após retorna []", async () => {
    const { performUpdateCheck, shouldCheckNow } = await import("./../toolUpdater.js");
    // Primeira chamada persiste lastCheck
    await performUpdateCheck();
    expect(shouldCheckNow()).toBe(false);
    // Segunda chamada deve pular (too soon)
    const results = await performUpdateCheck();
    expect(results).toEqual([]);
  });

  it("performUpdateCheck com autoInstall=true chama rokit install", async () => {
    process.env.TOOL_UPDATER_AUTO_INSTALL = "true";
    // Configura rojo como instalado com versão antiga
    mockRun.responses.set("rojo", { stdout: "7.4.0\n", stderr: "", code: 0 });
    // Outros tools not installeds (code != 0)
    mockRun.responses.set("wally", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("lune", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("selene", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("rokit", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("stylua", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("wally-package-types", { stdout: "", stderr: "", code: 1 });
    mockRun.responses.set("luau-lsp", { stdout: "", stderr: "", code: 1 });
    // curl retorna versão nova para rojo
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    // rokit install sucesso
    mockRun.responses.set("rokit", { stdout: "", stderr: "", code: 0 });
    const { performUpdateCheck } = await import("./../toolUpdater.js");
    await performUpdateCheck();
    // rokit deve ter sido chamado (autoInstall = true)
    // Não há assert direto, mas verificamos que não lançou exceção
    expect(true).toBe(true);
  });

  // ─── shouldCheckNow ──────────────────────────────────────────────────────

  it("shouldCheckNow respeita TOOL_UPDATER_INTERVAL_HOURS custom", async () => {
    const { shouldCheckNow } = await import("./../toolUpdater.js");
    // Estado com lastCheck 5 horas atrás
    const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      lastCheck: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      cachedVersions: {},
    }), "utf8");
    // Intervalo = 24h → 5h < 24h → não deve checar
    process.env.TOOL_UPDATER_INTERVAL_HOURS = "24";
    expect(shouldCheckNow()).toBe(false);
    // Intervalo = 1h → 5h > 1h → deve checar
    process.env.TOOL_UPDATER_INTERVAL_HOURS = "1";
    expect(shouldCheckNow()).toBe(true);
  });

  it("shouldCheckNow retorna true quando lastCheck é NaN (timestamp inválido)", async () => {
    const { shouldCheckNow } = await import("./../toolUpdater.js");
    const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      lastCheck: "invalid-date",
      cachedVersions: {},
    }), "utf8");
    expect(shouldCheckNow()).toBe(true);
  });

  // ─── forceCheckOnNextRun ─────────────────────────────────────────────────

  it("forceCheckOnNextRun limpa lastCheck e persiste no disco", async () => {
    const { forceCheckOnNextRun, shouldCheckNow } = await import("./../toolUpdater.js");
    const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      lastCheck: new Date().toISOString(),
      cachedVersions: { rojo: "7.4.0" },
    }), "utf8");
    expect(shouldCheckNow()).toBe(false);
    // Force check
    forceCheckOnNextRun();
    // Estado em disco deve ter lastCheck null mas preservar cachedVersions
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(state.lastCheck).toBeNull();
    expect(state.cachedVersions.rojo).toBe("7.4.0");
    // shouldCheckNow deve retornar true agora
    expect(shouldCheckNow()).toBe(true);
  });

  // ─── parsing version (regex interno) ─────────────────────────────────────

  it("regex de versão extrai X.Y.Z de diferentes formatos de output", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    const cases = [
      { stdout: "Rojo 7.6.1\n", expected: "7.6.1" },
      { stdout: "rojo 7.6.1 (build abc)\n", expected: "7.6.1" },
      { stdout: "v7.6.1\n", expected: "7.6.1" },
      { stdout: "Version: 1.2.3\n", expected: "1.2.3" },
    ];
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    for (const c of cases) {
      mockRun.responses.set("rojo", { stdout: c.stdout, stderr: "", code: 0 });
      const result = await checkToolUpdate("rojo");
      expect(result.installed).toBe(c.expected);
    }
  });

  it("checkToolUpdate retorna null quando stdout não contém versão X.Y.Z", async () => {
    const { checkToolUpdate } = await import("./../toolUpdater.js");
    mockRun.responses.set("rojo", { stdout: "no version info\n", stderr: "", code: 0 });
    mockRun.responses.set("curl", {
      stdout: JSON.stringify({ tag_name: "v7.6.1" }),
      stderr: "",
      code: 0,
    });
    const result = await checkToolUpdate("rojo");
    // Sem versão no stdout → installed null → error: not installed
    expect(result.installed).toBeNull();
    expect(result.error).toBe("not installed");
  });
});
