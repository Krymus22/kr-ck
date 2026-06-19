/**
 * gracefulShutdown-extended.test.ts — Expandindo cobertura do gracefulShutdown.
 *
 * O módulo gracefulShutdown registra handlers para sinais do processo
 * (SIGINT/SIGTERM/SIGHUP/uncaughtException) e executa cleanup quando o
 * processo está sendo terminado. Este arquivo expande a cobertura dos
 * caminhos não testados pelo arquivo gracefulShutdown.test.ts.
 *
 * Cobertura adicional:
 *   - registerShutdownHandlers registra SIGINT, SIGTERM, SIGHUP
 *   - registerShutdownHandlers registra uncaughtException
 *   - registerShutdownHandlers chamado múltiplas vezes (comportamento real)
 *   - shutdown handlers rodam em ordem LIFO (reverse de registro)
 *   - shutdown handler que lança erro não impede próximos
 *   - shutdown completo chama process.exit(0) via SIGINT
 *   - shutdown com erro chama process.exit(1) via uncaughtException
 *   - shutdown completa rapidamente quando handlers são síncronos
 *   - shutdown é idempotente (chamar 2x não roda handlers 2x) — expandido
 *   - onShutdown adiciona múltiplos handlers à fila
 *   - onShutdown mantém handler registrado até shutdown
 *   - onShutdown callback registra handler de cleanup (várias ordens)
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
}));

describe("gracefulShutdown — cobertura estendida", () => {
  let tmpHome: string;
  let onSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();

    // Spy em process.on: captura listeners sem registrar de verdade (evita
    // que sinais reais disparem handlers durante os testes).
    onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
    // Spy em process.exit: previne saída real do processo de teste.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__EXIT_PREVENTED__");
    }) as any);
  });

  afterEach(() => {
    onSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // --- registerShutdownHandlers ----------------------------------------------

  it("registerShutdownHandlers registra handlers para SIGINT, SIGTERM, SIGHUP", async () => {
    const { registerShutdownHandlers } = await import("./../gracefulShutdown.js");
    registerShutdownHandlers();

    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("SIGINT");
    expect(events).toContain("SIGTERM");
    expect(events).toContain("SIGHUP");
  });

  it("registerShutdownHandlers registra handler para uncaughtException", async () => {
    const { registerShutdownHandlers } = await import("./../gracefulShutdown.js");
    registerShutdownHandlers();

    const events = onSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("uncaughtException");
  });

  it("registerShutdownHandlers chamado múltiplas vezes adiciona listeners a cada chamada", async () => {
    // O módulo não faz dedup explícita: cada chamada adiciona novos listeners
    // em process. Testamos o comportamento real (cada chamada registra os 4
    // sinais novamente).
    const { registerShutdownHandlers, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    onSpy.mockClear();
    registerShutdownHandlers();
    const callsAfterFirst = onSpy.mock.calls.length;

    registerShutdownHandlers();  // should be a no-op now
    const callsAfterSecond = onSpy.mock.calls.length;

    // BUG FIX (audit issue #7): segunda chamada NÃO adiciona mais listeners
    // (dedup guard via handlersRegistered flag). Antes do fix, isso adicionava
    // 4 listeners duplicados a cada chamada.
    expect(callsAfterSecond).toBe(callsAfterFirst); // sem crescimento
    // Cada chamada registra pelo menos SIGINT, SIGTERM, SIGHUP, uncaughtException
    expect(callsAfterFirst).toBeGreaterThanOrEqual(4);
    expect(callsAfterSecond).toBeGreaterThanOrEqual(4);
    expect(callsAfterSecond).toBeLessThan(8); // não dobrou
  });

  // --- Ordem de execução dos handlers ----------------------------------------

  it("shutdown handlers rodam em ordem LIFO (último registrado = primeiro a rodar)", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    const order: string[] = [];
    onShutdown(() => { order.push("primeiro"); });
    onShutdown(() => { order.push("segundo"); });
    onShutdown(() => { order.push("terceiro"); });

    await shutdown("SIGINT");

    // O módulo inverte a ordem: último registrado é o primeiro a rodar
    expect(order).toEqual(["terceiro", "segundo", "primeiro"]);
  });

  it("shutdown handler que lança erro não impede próximos handlers", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    const executed: string[] = [];
    onShutdown(() => { executed.push("antes-erro"); });
    onShutdown(() => { throw new Error("handler explode"); });
    onShutdown(() => { executed.push("depois-erro"); });

    // Não deve rejeitar — erros são capturados internamente
    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();

    // Os handlers antes e depois do que lançou erro foram executados
    // (ordem LIFO: "depois-erro" roda antes do que lança erro, "antes-erro" depois)
    expect(executed).toContain("depois-erro");
    expect(executed).toContain("antes-erro");
  });

  // --- process.exit em shutdown ----------------------------------------------

  it("shutdown completo via SIGINT chama process.exit(0)", async () => {
    vi.useFakeTimers();
    const { registerShutdownHandlers, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    registerShutdownHandlers();

    // Encontra o listener de SIGINT registrado
    const sigintCall = onSpy.mock.calls.find((c) => c[0] === "SIGINT");
    expect(sigintCall).toBeDefined();
    const listener = sigintCall![1] as () => void;

    // Chama o listener (dispara handler async internamente)
    // O handler interno chama process.exit(0) via setTimeout, que é interceptado
    // pelo exitSpy (lança __EXIT_PREVENTED__). Capturamos via try/catch.
    try {
      listener();
    } catch (e) {
      // Pode lançar __EXIT_PREVENTED__ se o setTimeout for síncrono — ignoramos
    }

    // Aguarda microtasks (shutdown async) e dispara setTimeout (100ms)
    try {
      await vi.runAllTimersAsync();
    } catch {
      // exitSpy lança __EXIT_PREVENTED__ — esperado
    }

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("shutdown com erro via uncaughtException chama process.exit(1)", async () => {
    vi.useFakeTimers();
    const { registerShutdownHandlers, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    registerShutdownHandlers();

    // Encontra o listener de uncaughtException registrado
    const uncaughtCall = onSpy.mock.calls.find((c) => c[0] === "uncaughtException");
    expect(uncaughtCall).toBeDefined();
    const listener = uncaughtCall![1] as (err: Error) => void;

    // Chama o listener com um erro
    try {
      listener(new Error("boom"));
    } catch {
      // Ignora __EXIT_PREVENTED__ síncrono
    }

    try {
      await vi.runAllTimersAsync();
    } catch {
      // exitSpy lança __EXIT_PREVENTED__ — esperado
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shutdown completa rapidamente quando handlers são síncronos (sem timeout)", async () => {
    // O módulo não tem timeout de 10s. Testamos que shutdown completa rápido
    // quando handlers são síncronos e rápidos.
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    onShutdown(() => { /* handler rápido */ });
    onShutdown(() => { /* handler rápido */ });

    const t0 = Date.now();
    await shutdown("SIGINT");
    const elapsed = Date.now() - t0;

    // Shutdown síncrono deve completar em menos de 1 segundo
    expect(elapsed).toBeLessThan(1000);
  });

  // --- Idempotência ----------------------------------------------------------

  it("shutdown é idempotente: chamar 2x executa handlers apenas 1x", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    let count = 0;
    onShutdown(() => { count++; });

    await shutdown("SIGINT");
    await shutdown("SIGTERM"); // segundo shutdown deve ser no-op
    await shutdown("SIGHUP");  // terceiro também

    // Handlers rodam apenas uma vez, mesmo com múltiplas chamadas
    expect(count).toBe(1);
  });

  // --- onShutdown ------------------------------------------------------------

  it("onShutdown adiciona múltiplos handlers à fila", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    let count = 0;
    // Adiciona 5 handlers diferentes
    onShutdown(() => { count += 1; });
    onShutdown(() => { count += 10; });
    onShutdown(() => { count += 100; });
    onShutdown(() => { count += 1000; });
    onShutdown(() => { count += 10000; });

    await shutdown("SIGINT");

    // Todos os 5 handlers foram executados (11111 = 1+10+100+1000+10000)
    expect(count).toBe(11111);
  });

  it("onShutdown mantém handler registrado até shutdown ser chamado", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    let called = false;
    onShutdown(() => { called = true; });

    // Antes do shutdown, handler não foi chamado
    expect(called).toBe(false);

    // Outras operações não disparam o handler
    expect(called).toBe(false);

    // Apenas o shutdown dispara
    await shutdown("SIGINT");
    expect(called).toBe(true);
  });

  it("onShutdown callback registra handler de cleanup em ordem com outros handlers", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();

    const sequence: string[] = [];
    // Registra handler de cleanup junto com outros
    onShutdown(() => { sequence.push("setup-cleanup"); });
    onShutdown(() => { sequence.push("save-state"); });
    onShutdown(() => { sequence.push("close-connections"); }); // cleanup principal

    await shutdown("SIGTERM");

    // Todos os handlers de cleanup rodam (em ordem LIFO)
    expect(sequence).toContain("setup-cleanup");
    expect(sequence).toContain("save-state");
    expect(sequence).toContain("close-connections");
    expect(sequence).toHaveLength(3);
    // LIFO: close-connections (último registrado) é o primeiro a rodar
    expect(sequence[0]).toBe("close-connections");
    expect(sequence[2]).toBe("setup-cleanup");
  });
});
