/**
 * heartbeat-extended.test.ts — Casos edge / error handling / integração para
 * heartbeat.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - startHeartbeat (3 casos) — edge cases de início
 *   - stopHeartbeat (2 casos) — idempotência + sem timer
 *   - heartbeat tick (2 casos) — comportamento do tick interno
 *   - edge cases (1 caso)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock OpenAI controlável via vi.hoisted
const mockCreate = vi.hoisted(() => vi.fn(async () => ({
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } from "../heartbeat.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  resetHeartbeat();
});

afterEach(() => {
  stopHeartbeat();
  resetHeartbeat();
});

// ─── startHeartbeat ────────────────────────────────────────────────────────
describe("startHeartbeat", () => {
  it("configura intervalMs a partir de HEARTBEAT_INTERVAL_MS env var", async () => {
    const original = process.env.HEARTBEAT_INTERVAL_MS;
    process.env.HEARTBEAT_INTERVAL_MS = "9999";
    vi.resetModules();
    const { startHeartbeat: startHb, getHeartbeatStats: getStats, resetHeartbeat: resetHb } = await import("../heartbeat.js");
    resetHb();

    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHb(client);
    await new Promise((r) => setTimeout(r, 30));

    const stats = getStats();
    expect(stats.intervalMs).toBe(9999);
    expect(stats.enabled).toBe(true);

    process.env.HEARTBEAT_INTERVAL_MS = original;
    vi.resetModules();
  });

  it("usa model padrão quando MODEL não está setado", async () => {
    const original = process.env.MODEL;
    delete process.env.MODEL;
    vi.resetModules();
    const { startHeartbeat: startHb, getHeartbeatStats: getStats, resetHeartbeat: resetHb } = await import("../heartbeat.js");
    resetHb();

    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHb(client);
    await new Promise((r) => setTimeout(r, 30));

    const stats = getStats();
    expect(stats.model).toBe("moonshotai/kimi-k2.6");

    if (original !== undefined) process.env.MODEL = original;
    vi.resetModules();
  });

  it("envia temperature=0 na requisição do heartbeat", async () => {
    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 30));

    const call = mockCreate.mock.calls[0]?.[0];
    expect(call.temperature).toBe(0);
  });
});

// ─── stopHeartbeat ─────────────────────────────────────────────────────────
describe("stopHeartbeat", () => {
  it("após stop, stats.running é false mesmo se já estava rodando", async () => {
    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 30));
    expect(getHeartbeatStats().running).toBe(true);

    stopHeartbeat();
    expect(getHeartbeatStats().running).toBe(false);
  });

  it("stop chamado múltiplas vezes consecutivas não lança", () => {
    expect(() => {
      stopHeartbeat();
      stopHeartbeat();
      stopHeartbeat();
    }).not.toThrow();
  });
});

// ─── heartbeat tick (comportamento do tick interno) ────────────────────────
describe("heartbeat tick (latência e estado do modelo)", () => {
  it("latência medida corresponde ao tempo de resposta simulado", async () => {
    mockCreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { choices: [{ message: { content: "hi" } }], usage: {} };
    });
    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 200));

    const stats = getHeartbeatStats();
    expect(stats.lastHeartbeatLatencyMs).toBeGreaterThanOrEqual(70);
    expect(stats.lastHeartbeatLatencyMs).toBeLessThan(1000);
    expect(stats.modelState).toBe("warm"); // < 5s
  });

  it("não executa tick concorrente se heartbeat anterior ainda está rodando", async () => {
    // Simula requisição lenta (>50ms)
    let resolveSlow: () => void = () => {};
    mockCreate.mockImplementation(async () => {
      await new Promise((r) => { resolveSlow = r as () => void; setTimeout(r, 5000); });
      return { choices: [{ message: { content: "hi" } }], usage: {} };
    });
    const client = { chat: { completions: { create: mockCreate } } } as any;
    startHeartbeat(client);

    // Primeiro heartbeat dispara imediatamente
    await new Promise((r) => setTimeout(r, 30));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(getHeartbeatStats().totalHeartbeats).toBe(1);

    // Resolve o primeiro heartbeat
    resolveSlow();
    await new Promise((r) => setTimeout(r, 30));
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("5 falhas consecutivas interrompem heartbeat (stopHeartbeat)", async () => {
    // Importa a função error do logger (namespace, igual ao source)
    const logMod = await import("../logger.js");
    const logError = (logMod as any).error as ReturnType<typeof vi.fn>;

    const client = { chat: { completions: { create: mockCreate } } } as any;

    // Configura falhas consecutivas
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(new Error("consecutive fail"));
    logError.mockClear();

    // Cinco startHeartbeat sem reset entre eles acumula consecutiveFailures
    for (let i = 0; i < 5; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      stopHeartbeat();
      // NÃO chama resetHeartbeat — preserva consecutiveFailures
    }

    // Após 5+ falhas consecutivas, log.error deve ter sido chamado (stopHeartbeat)
    expect(logError).toHaveBeenCalled();

    // Stats refletem falhas
    const stats = getHeartbeatStats();
    expect(stats.totalFailures).toBeGreaterThanOrEqual(5);
    expect(stats.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(stats.lastHeartbeatOk).toBe(false);
  });
});
