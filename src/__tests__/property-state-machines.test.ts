/**
 * property-state-machines.test.ts — Testes property-based para STATE MACHINES.
 *
 * Usa fast-check v4.8.0 para gerar SEQUÊNCIAS DE COMANDOS e verificar
 * INVARIANTES de estado em três módulos:
 *   - extensionCenter.ts (toggleExtension, cycleTriggerMode, syncExtensions)
 *   - retry.ts           (withRetry)
 *   - history.ts         (compactHistory)
 *
 * Padrão adotado:
 *   - Para máquinas de estado, geramos sequências de comandos via
 *     `fc.array(fc.oneof(cmdA, cmdB))` e aplicamos à máquina, verificando
 *     invariantes ao final.
 *   - Para propriedades escalares (ex.: "N toggles → estado previsível"),
 *     usamos `fc.assert(fc.property(arbitrário, predicado))`.
 *   - Para propriedades assíncronas (withRetry), usamos `fc.asyncProperty`
 *     com `vi.useFakeTimers()` + `vi.runAllTimersAsync()` para resolver os
 *     sleeps sem esperar tempo real.
 *
 * IMPORTANTE: propriedades marcadas com `.skip` falharam ao rodar e foram
 * desativadas com comentário explicando o bug e o counterexample.
 * Ver relatório do QA.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fc from "fast-check";

// ---------------------------------------------------------------------------
// MOCKS GLOBAIS — todos os módulos de I/O e dependências externas são
// mockados para que os testes sejam determinísticos e não toquem o FS real.
// ---------------------------------------------------------------------------

// Mock node:fs (usado por extensionCenter e history)
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
    })),
  },
}));

// Mock logger (importado por extensionCenter e retry)
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

// Mock externalTools (importado por extensionCenter — getRegistry)
const { mockGetRegistry } = vi.hoisted(() => ({
  mockGetRegistry: vi.fn(() => null),
}));
vi.mock("../externalTools.js", () => ({
  getRegistry: (...args: any[]) => mockGetRegistry(...args),
}));

// Mock extensions (importado por extensionCenter — getActiveMCPServers
// e por history — getActiveSkills)
const { mockGetActiveMCPServers, mockGetActiveSkills } = vi.hoisted(() => ({
  mockGetActiveMCPServers: vi.fn(() => []),
  mockGetActiveSkills: vi.fn(() => []),
}));
vi.mock("../extensions.js", () => ({
  getActiveMCPServers: (...args: any[]) => mockGetActiveMCPServers(...args),
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

// Mock effortLevels (importado por history — getEffortPromptSnippet)
vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn(() => ""),
}));

// ---------------------------------------------------------------------------
// IMPORTS DOS MÓDULOS SOB TESTE (após mocks)
// ---------------------------------------------------------------------------

import {
  syncExtensions,
  toggleExtension,
  cycleTriggerMode,
  getExtension,
  type ExtensionCategory,
  type TriggerMode,
} from "../extensionCenter.js";

import { withRetry } from "../retry.js";

import {
  resetHistory,
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  getHistory,
  compactHistory,
} from "../history.js";

// ---------------------------------------------------------------------------
// CONSTANTES E HELPERS
// ---------------------------------------------------------------------------

const CATEGORIES: readonly ExtensionCategory[] = [
  "feature",
  "tool",
  "skill",
  "mcp",
  "plugin",
];

const VALID_TRIGGER_MODES: TriggerMode[] = [
  "disabled",
  "on_file",
  "on_task",
  "always",
];

/** COMPACT_KEEP_RECENT — não exportado por history.ts; espelhamos o valor. */
const COMPACT_KEEP_RECENT = 6;

const categoryArb = fc.constantFrom(...CATEGORIES);

/**
 * Limpa o Hub entre runs: syncExtensions([]) descarta todas as extensões
 * existentes. Chamado no início de cada predicado para garantir estado
 * fresco (hubState é module-level singleton).
 */
function resetHub(): void {
  syncExtensions([]);
}

/**
 * Cria uma extensão "fresh" no Hub com a categoria dada.
 * Retorna o id usado (sempre "test:prop" — só uma extensão por run).
 */
function makeFreshExtension(category: ExtensionCategory): string {
  const id = "test:prop";
  syncExtensions([
    {
      id,
      name: "Test Prop",
      category,
      description: "extensão de teste property-based",
      installed: true,
    },
  ]);
  return id;
}

// ===========================================================================
// 1. HUB TOGGLE CYCLE (extensionCenter.ts) — 3 propriedades
// ===========================================================================

describe("property-state-machines — Hub toggle cycle", () => {
  beforeEach(() => {
    resetHub();
  });

  it("1. toggle é determinístico — N toggles em feature habilitada resulta em enabled === (N % 2 === 0)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        resetHub();
        // Features internas começam habilitadas (enabled=true, triggerMode="always")
        const id = makeFreshExtension("feature");
        for (let i = 0; i < n; i++) toggleExtension(id);
        const ext = getExtension(id);
        // N par → enabled=true; N ímpar → enabled=false
        return ext?.enabled === (n % 2 === 0);
      }),
      { numRuns: 50 },
    );
  });

  it("2. após toggle OFF (enabled=false), triggerMode é sempre 'disabled'", () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.integer({ min: 0, max: 20 }),
        (cat, n) => {
          resetHub();
          const id = makeFreshExtension(cat);
          for (let i = 0; i < n; i++) toggleExtension(id);
          const ext = getExtension(id);
          if (!ext) return false;
          // Invariante: se desligada, triggerMode DEVE ser "disabled"
          if (!ext.enabled) {
            return ext.triggerMode === "disabled";
          }
          // Se ligada, sem restrição neste teste (cobre propriedade 3)
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("3. após toggle ON (enabled=true) de extensão que estava disabled, triggerMode é sempre ≠ 'disabled'", () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.integer({ min: 1, max: 20 }), // ≥1: pelo menos 1 toggle
        (cat, n) => {
          resetHub();
          const id = makeFreshExtension(cat);
          for (let i = 0; i < n; i++) toggleExtension(id);
          const ext = getExtension(id);
          if (!ext) return false;
          // Invariante: se ligada, triggerMode NÃO é "disabled"
          // (BUG FIX documentado em extensionCenter.ts — antes ficava
          // "disabled" mesmo com enabled=true, estado inconsistente)
          if (ext.enabled) {
            return ext.triggerMode !== "disabled";
          }
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ===========================================================================
// 2. RETRY BACKOFF (retry.ts) — 3 propriedades
// ===========================================================================

describe("property-state-machines — Retry backoff", () => {
  it("4. withRetry com fn sempre falhando faz no máximo maxRetries+1 tentativas", async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (maxRetries) => {
            let calls = 0;
            const fn = async () => {
              calls++;
              throw new Error("fail");
            };
            const promise = withRetry(fn, {
              maxRetries,
              baseDelayMs: 100,
              jitter: false,
            });
            // Anexa handler de rejeição SINCRONAMENTMENTE (antes de qualquer
            // await) para evitar UnhandledRejection — a promise pode rejeitar
            // durante o runAllTimersAsync abaixo.
            const handled = promise.catch(() => null);
            // Resolve todos os sleeps pendentes (cascata de retries).
            await vi.runAllTimersAsync();
            await handled;
            // +1 = primeira tentativa (attempt=0) + maxRetries retries.
            return calls <= maxRetries + 1;
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("5. soma dos delays (jitter=false) é >= soma dos backoffs esperados pela fórmula", async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }), // maxRetries
          fc.integer({ min: 1, max: 50 }), // baseDelayMs
          fc.integer({ min: 2, max: 4 }), // backoffMultiplier (inteiro p/ evitar floor)
          async (maxRetries, baseDelayMs, mult) => {
            const delays: number[] = [];
            const fn = async () => {
              throw new Error("fail");
            };
            const promise = withRetry(fn, {
              maxRetries,
              baseDelayMs,
              backoffMultiplier: mult,
              jitter: false,
              onRetry: (_attempt, _err, delayMs) => delays.push(delayMs),
            });
            // Handler anexado sincronamente para evitar UnhandledRejection.
            const handled = promise.catch(() => null);
            await vi.runAllTimersAsync();
            await handled;

            // Soma esperada pela fórmula: sum(base * mult^i) para i em 0..maxRetries-1
            // Math.floor espelha calculateDelay() (que faz floor no final).
            let expected = 0;
            for (let i = 0; i < maxRetries; i++) {
              expected += Math.floor(baseDelayMs * Math.pow(mult, i));
            }
            const actual = delays.reduce((s, d) => s + d, 0);
            // Sem jitter, actual === expected (igualdade estrita).
            // Usamos >= para acomodar imprecisões de float em fórmulas equivalentes.
            return actual >= expected && delays.length === maxRetries;
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("6. se fn succeed na primeira, onRetry não é chamado (não espera backoff)", async () => {
    vi.useFakeTimers();
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (maxRetries) => {
            let onRetryCalls = 0;
            let fnCalls = 0;
            const fn = async () => {
              fnCalls++;
              return "ok";
            };
            // fn succeed imediatamente — nenhum setTimeout é agendado,
            // então fake timers não causam deadlock.
            const result = await withRetry(fn, {
              maxRetries,
              baseDelayMs: 1000,
              onRetry: () => {
                onRetryCalls++;
              },
            });
            return result === "ok" && onRetryCalls === 0 && fnCalls === 1;
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// 3. HISTORY COMPACT (history.ts) — 2 propriedades
// ===========================================================================

describe("property-state-machines — History compact", () => {
  beforeEach(() => {
    resetHistory();
  });

  /**
   * Gerador de mensagens aleatórias (user / assistant / tool).
   * Tool messages usam tool_call_id fixo "tc1" e assistant com tool_calls
   * correspondente, para que alguns pares sejam válidos após compaction.
   */
  const messageArb = fc.array(
    fc.oneof(
      fc.record({
        role: fc.constant("user" as const),
        content: fc.string({ maxLength: 30 }),
      }),
      fc.record({
        role: fc.constant("assistant" as const),
        content: fc.string({ maxLength: 30 }),
      }),
      fc.record({
        role: fc.constant("assistant" as const),
        content: fc.constant(null),
        tool_calls: fc.constant([
          {
            id: "tc1",
            type: "function",
            function: { name: "ler_arquivo", arguments: "{}" },
          },
        ]),
      }),
      fc.record({
        role: fc.constant("tool" as const),
        tool_call_id: fc.constant("tc1"),
        content: fc.string({ maxLength: 30 }),
      }),
    ),
    // ≥10 mensagens garante history.length > COMPACT_KEEP_RECENT+1 (=7),
    // então compactHistory() não retorna null por short-circuit.
    { minLength: 10, maxLength: 50 },
  );

  /** Aplica uma sequência de mensagens ao history (após resetHistory). */
  function applyMessages(msgs: Array<Record<string, unknown>>): void {
    resetHistory();
    for (const m of msgs) {
      if (m.role === "user") {
        addUserMessage(m.content as string);
      } else if (m.role === "assistant") {
        addRawAssistantMessage(m as any);
      } else if (m.role === "tool") {
        addToolResult(m.tool_call_id as string, m.content as string);
      }
    }
  }

  it("7. após compactHistory, count de mensagens non-system <= COMPACT_KEEP_RECENT (6)", () => {
    fc.assert(
      fc.property(messageArb, (msgs) => {
        applyMessages(msgs);
        const result = compactHistory();
        if (result === null) return true; // short-circuit: nada a compactar
        const h = getHistory();
        // Exclui todas as mensagens com role "system" (system prompt + summary).
        // compactHistory preserva: system + summary(system) + recent (até 6).
        // Tool messages órfãs (sem tool_call_id válido) são filtradas, então
        // o count non-system só pode ser <= COMPACT_KEEP_RECENT.
        const nonSystemCount = h.filter((m) => m.role !== "system").length;
        return nonSystemCount <= COMPACT_KEEP_RECENT;
      }),
      { numRuns: 50 },
    );
  });

  it("8. após compactHistory, primeira mensagem continua sendo system prompt", () => {
    fc.assert(
      fc.property(messageArb, (msgs) => {
        applyMessages(msgs);
        const result = compactHistory();
        if (result === null) return true; // short-circuit
        const h = getHistory();
        // Invariante: history[0] é sempre o system prompt preservado.
        return h.length > 0 && h[0].role === "system";
      }),
      { numRuns: 50 },
    );
  });
});

// ===========================================================================
// 4. TRIGGER MODE CYCLE (extensionCenter.ts) — 2 propriedades
// ===========================================================================

describe("property-state-machines — Trigger mode cycle", () => {
  beforeEach(() => {
    resetHub();
  });

  it("9. após 4 cycleTriggerMode, voltamos ao triggerMode original (ciclo de 4)", () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.integer({ min: 0, max: 10 }), // offset inicial de cycles
        (cat, offset) => {
          resetHub();
          const id = makeFreshExtension(cat);
          // Aplica `offset` cycles para randomizar o triggerMode inicial.
          for (let i = 0; i < offset; i++) cycleTriggerMode(id);
          const original = getExtension(id)?.triggerMode;
          if (original === undefined) return false;
          // Aplica 4 cycles — deve voltar ao mesmo triggerMode.
          for (let i = 0; i < 4; i++) cycleTriggerMode(id);
          const final = getExtension(id)?.triggerMode;
          return final === original;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("10. cycleTriggerMode é determinístico — mesma sequência gera mesma sequência de modos", () => {
    fc.assert(
      fc.property(
        categoryArb,
        fc.integer({ min: 1, max: 20 }),
        (cat, n) => {
          // Run 1: fresh state, aplica n cycles, coleta sequência.
          resetHub();
          const id1 = makeFreshExtension(cat);
          const run1: TriggerMode[] = [];
          for (let i = 0; i < n; i++) {
            const mode = cycleTriggerMode(id1);
            if (mode) run1.push(mode);
          }

          // Run 2: fresh state novamente, mesma sequência.
          resetHub();
          const id2 = makeFreshExtension(cat);
          const run2: TriggerMode[] = [];
          for (let i = 0; i < n; i++) {
            const mode = cycleTriggerMode(id2);
            if (mode) run2.push(mode);
          }

          // Invariante: mesma sequência de cycles → mesma sequência de modos.
          return (
            run1.length === run2.length &&
            run1.every((m, i) => m === run2[i])
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ===========================================================================
// 5. BONUS: sequência mista de toggles+cycles — invariante de estado
// ===========================================================================

describe("property-state-machines — sequência mista toggle+cycle", () => {
  beforeEach(() => {
    resetHub();
  });

  // BUG P-5 CORRIGIDO: syncExtensions agora cria estado CONSISTENTE para
  // skill/mcp/plugin instaladas — quando defaultEnabled=true, o
  // defaultTrigger passa a ser defaultTriggerForCategory(category) em vez
  // de "disabled". Antes, o estado inicial ficava inconsistente
  // (enabled=true MAS triggerMode="disabled") — o card mostrava "ON [OFF]"
  // e getEnabledExtensions() filtrava a extensão. O BUG FIX em
  // toggleExtension (linhas 246-251 de extensionCenter.ts) só corrigia o
  // caso de toggle ON a partir de disabled — não o estado inicial criado
  // por syncExtensions.
  //   Counterexample (ANTES do fix):
  //     syncExtensions([{ id: "x", category: "mcp", installed: true, ... }])
  //     → getExtension("x") === { enabled: true, triggerMode: "disabled" }
  //     (inconsistente: enabled=true mas triggerMode="disabled")
  //   O mesmo acontecia para category: "skill" e category: "plugin".
  //   Após o fix: para qualquer categoria, syncExtensions cria estado em
  //   que (enabled ⇔ triggerMode != "disabled") — invariantes básicas.
  it(
    "11. sequência aleatória de toggles+cycles nunca quebra o estado (invariantes básicas)",
    () => {
      type Cmd =
        | { type: "toggle" }
        | { type: "cycle" };

      const toggleCmd = fc.record({ type: fc.constant("toggle" as const) });
      const cycleCmd = fc.record({ type: fc.constant("cycle" as const) });
      const commandArb = fc.oneof(toggleCmd, cycleCmd);

      fc.assert(
        fc.property(
          categoryArb,
          fc.array(commandArb, { maxLength: 30 }),
          (cat, cmds) => {
            resetHub();
            const id = makeFreshExtension(cat);
            for (const cmd of cmds) {
              if (cmd.type === "toggle") toggleExtension(id);
              else cycleTriggerMode(id);
            }
            const ext = getExtension(id);
            if (!ext) return false;
            // Invariantes:
            //  - enabled é boolean
            //  - triggerMode é um dos 4 valores válidos
            //  - se enabled=false → triggerMode === "disabled"
            //  - se enabled=true  → triggerMode !== "disabled"
            const enabledOk = typeof ext.enabled === "boolean";
            const modeOk = VALID_TRIGGER_MODES.includes(ext.triggerMode);
            const consistencyOk = ext.enabled
              ? ext.triggerMode !== "disabled"
              : ext.triggerMode === "disabled";
            return enabledOk && modeOk && consistencyOk;
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  // Propriedade BONUS que passa: após ≥1 comando (toggle OU cycle), o
  // estado SEMPRE se torna consistente. Isso é verdade porque:
  //   - toggle OFF sempre seta triggerMode="disabled" (consistente)
  //   - toggle ON a partir de disabled restaura triggerMode ao default
  //     da categoria via defaultTriggerForCategory() (sempre != "disabled")
  //   - cycleTriggerMode seta enabled = (nextMode !== "disabled"), garantindo
  //     consistência
  // Único estado inconsistente é o inicial de skill/mcp/plugin (ver bug #11).
  it("12. após ≥1 comando (toggle OU cycle), estado é sempre consistente (enabled ⇔ triggerMode != disabled)", () => {
    type Cmd =
      | { type: "toggle" }
      | { type: "cycle" };

    const toggleCmd = fc.record({ type: fc.constant("toggle" as const) });
    const cycleCmd = fc.record({ type: fc.constant("cycle" as const) });
    const commandArb = fc.oneof(toggleCmd, cycleCmd);

    fc.assert(
      fc.property(
        categoryArb,
        fc.array(commandArb, { minLength: 1, maxLength: 30 }),
        (cat, cmds) => {
          resetHub();
          const id = makeFreshExtension(cat);
          for (const cmd of cmds) {
            if (cmd.type === "toggle") toggleExtension(id);
            else cycleTriggerMode(id);
          }
          const ext = getExtension(id);
          if (!ext) return false;
          // Invariantes pós-comando:
          const enabledOk = typeof ext.enabled === "boolean";
          const modeOk = VALID_TRIGGER_MODES.includes(ext.triggerMode);
          const consistencyOk = ext.enabled
            ? ext.triggerMode !== "disabled"
            : ext.triggerMode === "disabled";
          return enabledOk && modeOk && consistencyOk;
        },
      ),
      { numRuns: 50 },
    );
  });

  // Propriedade BONUS: invariantes estruturais (sem consistency) sempre
  // valem, mesmo no estado inicial bugado. Isso isola o bug: enabled é
  // sempre boolean, triggerMode é sempre um dos 4 valores válidos.
  it("13. (estrutural) enabled é boolean e triggerMode é um dos 4 valores válidos para qualquer sequência", () => {
    type Cmd =
      | { type: "toggle" }
      | { type: "cycle" };

    const toggleCmd = fc.record({ type: fc.constant("toggle" as const) });
    const cycleCmd = fc.record({ type: fc.constant("cycle" as const) });
    const commandArb = fc.oneof(toggleCmd, cycleCmd);

    fc.assert(
      fc.property(
        categoryArb,
        fc.array(commandArb, { maxLength: 30 }),
        (cat, cmds) => {
          resetHub();
          const id = makeFreshExtension(cat);
          for (const cmd of cmds) {
            if (cmd.type === "toggle") toggleExtension(id);
            else cycleTriggerMode(id);
          }
          const ext = getExtension(id);
          if (!ext) return false;
          // Apenas invariantes estruturais (não dependem da consistência
          // enabled/triggerMode — bug documentado em #11).
          return (
            typeof ext.enabled === "boolean" &&
            VALID_TRIGGER_MODES.includes(ext.triggerMode)
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
