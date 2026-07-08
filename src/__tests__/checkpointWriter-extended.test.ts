/**
 * checkpointWriter-extended.test.ts — Expandindo cobertura do checkpointWriter.
 *
 * O módulo checkpointWriter extrai estado estruturado da conversa em 3
 * checkpoints (20%, 45%, 70% do contexto). Este arquivo expande a cobertura
 * das funções writeCheckpoint, shouldCheckpoint, formatCheckpoint,
 * getLastCheckpointState, getLastCheckpointNumber e resetCheckpoints,
 * incluindo:
 *   - Escrita de checkpoints com state completo e vazio
 *   - Tratamento de JSON inválido e exceções do LLM
 *   - Checkpoints incrementais (usa estado anterior)
 *   - Thresholds em 20%, 45%, 70%
 *   - Metadados (checkpointNumber, contextPercent, durationMs)
 *   - formatação de estado completo e vazio
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("./../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("./../history.js", () => ({
  getHistory: vi.fn(() => []),
  // Bug Hunter #2: writeCheckpoint now calls estimateTokens() for contextPercent.
  estimateTokens: vi.fn(() => 0),
}));

describe("checkpointWriter — cobertura estendida", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockReset();
  });

  /** Gera um JSON de estado válido com overrides opcionais. */
  function makeStateJson(overrides: Record<string, unknown> = {}): string {
    const base = {
      intention: "Implementar feature X",
      nextAction: "Escrever testes",
      constraints: ["Não quebrar API", "Manter compatibilidade"],
      taskTree: ["Task 1", "Task 2", "Task 3"],
      currentWork: "Refatorando módulo Y",
      filesInvolved: [
        { path: "src/y.ts", change: "added foo()" },
        { path: "src/z.ts", change: "removed bar()" },
      ],
      crossTaskDiscoveries: ["Bug em auth afeta feature X"],
      errorsAndCorrections: [
        { error: "TypeError", fix: "cast to string" },
      ],
      runtimeState: "tests passing",
      designDecisions: [{ decision: "usar Option", rationale: "safer" }],
      miscNotes: "lembrar de atualizar docs",
      ...overrides,
    };
    return JSON.stringify(base);
  }

  // --- createCheckpoint (writeCheckpoint) ---

  it("createCheckpoint salva estado de arquivos modificados (state completo)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    const result = await writeCheckpoint(1);
    expect(result.checkpointNumber).toBe(1);
    expect(result.state.intention).toBe("Implementar feature X");
    expect(result.state.nextAction).toBe("Escrever testes");
    expect(result.state.filesInvolved).toHaveLength(2);
    expect(result.state.filesInvolved[0]!.path).toBe("src/y.ts");
    expect(result.state.filesInvolved[1]!.change).toBe("removed bar()");
    expect(result.state.runtimeState).toBe("tests passing");
    expect(result.state.constraints).toHaveLength(2);
  });

  it("createCheckpoint lida com lista de histórico vazia (contextPercent=0)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson({ intention: "empty-history" }) } }],
    });
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("empty-history");
    expect(result.contextPercent).toBe(0);
  });

  it("createCheckpoint lida com path inexistente (LLM retorna JSON inválido)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: "isto não é JSON válido" } }],
    });
    const result = await writeCheckpoint(2);
    // Fallback para estado vazio
    expect(result.state.intention).toBe("");
    expect(result.state.constraints).toEqual([]);
    expect(result.state.filesInvolved).toEqual([]);
    expect(result.state.taskTree).toEqual([]);
    expect(result.checkpointNumber).toBe(2);
  });

  it("createCheckpoint lida com exceção do chat() (fallback empty state)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockRejectedValue(new Error("network failure"));
    const result = await writeCheckpoint(3);
    expect(result.state.intention).toBe("");
    expect(result.state.taskTree).toEqual([]);
    expect(result.state.designDecisions).toEqual([]);
    expect(result.checkpointNumber).toBe(3);
  });

  it("createCheckpoint lida com response.choices ausente (content vazio)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({});
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("");
    expect(result.state.miscNotes).toBe("");
  });

  it("createCheckpoint usa estado anterior em checkpoint incremental", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValueOnce({
      choices: [{ message: { content: makeStateJson({ intention: "primeiro" }) } }],
    });
    await writeCheckpoint(1);
    expect(getLastCheckpointState()!.intention).toBe("primeiro");

    (chat as any).mockResolvedValueOnce({
      choices: [{ message: { content: makeStateJson({ intention: "segundo" }) } }],
    });
    await writeCheckpoint(2);
    expect(getLastCheckpointState()!.intention).toBe("segundo");
  });

  it("createCheckpoint extrai JSON de resposta com texto ao redor", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    // LLM pode envolver JSON em markdown ou texto
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: `Aqui está o estado:\n\`\`\`json\n${makeStateJson({ intention: "extraido" })}\n\`\`\`\nFim.`,
        },
      }],
    });
    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("extraido");
  });

  // --- shouldCheckpoint ---

  it("shouldCheckpoint retorna 3 em ~70% do contexto", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    // Pass 128000 explicitly to pin the historical context window used by
    // these regression tests (production uses config.contextWindowTokens =
    // 256_000 for Kimi K2.6 — see the "checkpoint-firing-too-early"
    // regression tests at the bottom of this file).
    await writeCheckpoint(1, 128000);
    await writeCheckpoint(2, 128000);
    expect(shouldCheckpoint(90000, 128000)).toBe(3); // ~70% of 128000
  });

  it("shouldCheckpoint retorna 0 quando contexto é muito pequeno", async () => {
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    expect(shouldCheckpoint(10)).toBe(0);
    expect(shouldCheckpoint(1000)).toBe(0);
    expect(shouldCheckpoint(5000)).toBe(0);
  });

  it("shouldCheckpoint não retrocede checkpoint já passado", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1, 128000);
    await writeCheckpoint(2, 128000);
    expect(shouldCheckpoint(26000, 128000)).toBe(0); // já passou checkpoint 1
    expect(shouldCheckpoint(58000, 128000)).toBe(0); // já passou checkpoint 2
  });

  // --- getLatestCheckpoint ---

  it("getLatestCheckpointNumber retorna número correto após writeCheckpoint", async () => {
    const { writeCheckpoint, getLastCheckpointNumber, resetCheckpoints } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    expect(getLastCheckpointNumber()).toBe(0);
    await writeCheckpoint(1, 128000);
    expect(getLastCheckpointNumber()).toBe(1);
    await writeCheckpoint(2, 128000);
    expect(getLastCheckpointNumber()).toBe(2);
    await writeCheckpoint(3, 128000);
    expect(getLastCheckpointNumber()).toBe(3);
  });

  it("getLatestCheckpointState retorna null quando nenhum checkpoint foi escrito", async () => {
    const { resetCheckpoints, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    resetCheckpoints();
    expect(getLastCheckpointState()).toBeNull();
  });

  it("getLatestCheckpointState retorna estado mais recente após writeCheckpoint", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson({ intention: "estado-atual" }) } }],
    });
    await writeCheckpoint(1);
    const state = getLastCheckpointState();
    expect(state).not.toBeNull();
    expect(state!.intention).toBe("estado-atual");
    expect(state!.filesInvolved).toHaveLength(2);
  });

  it("getLatestCheckpointState atualiza após cada checkpoint incremental", async () => {
    const { writeCheckpoint, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any)
      .mockResolvedValueOnce({
        choices: [{ message: { content: makeStateJson({ intention: "v1" }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: makeStateJson({ intention: "v2" }) } }],
      });
    await writeCheckpoint(1, 128000);
    expect(getLastCheckpointState()!.intention).toBe("v1");
    await writeCheckpoint(2, 128000);
    expect(getLastCheckpointState()!.intention).toBe("v2");
  });

  // --- Metadados ---

  it("Checkpoint inclui metadados (checkpointNumber, contextPercent, durationMs, state)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    const result = await writeCheckpoint(2, 128000);
    expect(result).toHaveProperty("checkpointNumber");
    expect(result).toHaveProperty("contextPercent");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("state");
    expect(typeof result.durationMs).toBe("number");
    expect(typeof result.contextPercent).toBe("number");
    expect(result.checkpointNumber).toBe(2);
  });

  // --- formatCheckpoint ---

  it("formatCheckpoint inclui todos os campos do estado", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const state = {
      intention: "Minha intenção",
      nextAction: "Próxima ação",
      constraints: ["regra1", "regra2"],
      taskTree: ["task1", "task2"],
      currentWork: "trabalho atual",
      filesInvolved: [{ path: "src/a.ts", change: "edit" }],
      crossTaskDiscoveries: ["descoberta"],
      errorsAndCorrections: [{ error: "err", fix: "fix" }],
      runtimeState: "all good",
      designDecisions: [{ decision: "decisão", rationale: "porquê" }],
      miscNotes: "notas importantes",
    };
    const out = formatCheckpoint(state as any);
    expect(out).toContain("CHECKPOINT STATE");
    expect(out).toContain("Minha intenção");
    expect(out).toContain("Próxima ação");
    expect(out).toContain("regra1");
    expect(out).toContain("regra2");
    expect(out).toContain("task1");
    expect(out).toContain("trabalho atual");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("err");
    expect(out).toContain("decisão");
    expect(out).toContain("all good");
    expect(out).toContain("notas importantes");
  });

  it("formatCheckpoint lida com estado vazio graciosamente", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const empty = {
      intention: "",
      nextAction: "",
      constraints: [],
      taskTree: [],
      currentWork: "",
      filesInvolved: [],
      crossTaskDiscoveries: [],
      errorsAndCorrections: [],
      runtimeState: "",
      designDecisions: [],
      miscNotes: "",
    };
    const out = formatCheckpoint(empty as any);
    expect(out).toContain("CHECKPOINT STATE");
    // Seções opcionais não devem aparecer quando vazias
    expect(out).not.toContain("Constraints:");
    expect(out).not.toContain("Remaining tasks:");
    expect(out).not.toContain("Files involved:");
    expect(out).not.toContain("Errors & corrections:");
    expect(out).not.toContain("Design decisions:");
    expect(out).not.toContain("Runtime:");
    expect(out).not.toContain("Notes:");
  });

  it("formatCheckpoint inclui runtimeState quando presente", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const state = {
      intention: "x",
      nextAction: "y",
      constraints: [],
      taskTree: [],
      currentWork: "z",
      filesInvolved: [],
      crossTaskDiscoveries: [],
      errorsAndCorrections: [],
      runtimeState: "build OK, 42 tests",
      designDecisions: [],
      miscNotes: "",
    };
    const out = formatCheckpoint(state as any);
    expect(out).toContain("Runtime: build OK, 42 tests");
  });

  // --- resetCheckpoints ---

  it("resetCheckpoints limpa estado e número do último checkpoint", async () => {
    const { writeCheckpoint, resetCheckpoints, getLastCheckpointNumber, getLastCheckpointState } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1, 128000);
    await writeCheckpoint(2, 128000);
    expect(getLastCheckpointNumber()).toBe(2);
    expect(getLastCheckpointState()).not.toBeNull();
    resetCheckpoints();
    expect(getLastCheckpointNumber()).toBe(0);
    expect(getLastCheckpointState()).toBeNull();
  });

  it("resetCheckpoints permite reescrever checkpoints após reset", async () => {
    const { writeCheckpoint, resetCheckpoints, getLastCheckpointNumber } = await import(
      "./../checkpointWriter.js"
    );
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJson() } }],
    });
    await writeCheckpoint(1, 128000);
    expect(getLastCheckpointNumber()).toBe(1);
    resetCheckpoints();
    expect(getLastCheckpointNumber()).toBe(0);
    // Após reset, deve permitir fazer checkpoint 1 novamente
    await writeCheckpoint(1, 128000);
    expect(getLastCheckpointNumber()).toBe(1);
  });
});

// ─── Bug Hunter #2 — Bug F: writeCheckpoint contextPercent uses tokens ──────
//
// Bug F: writeCheckpoint() computed contextPercent from history_msgs.length
// (MESSAGE COUNT) / MAX_CONTEXT_TOKENS, which is meaningless — 50 messages
// / 128000 tokens = ~0.04%, so contextPercent was always ~0. The fix uses
// history.estimateTokens() (matching what agent.ts passes to shouldCheckpoint).
//
// These tests must live here (not in the regression-bug-hunter-2 file) because
// this file already mocks history.js with controllable estimateTokens/getHistory
// — required because ESM module exports cannot be mutated at runtime.

describe("Bug Hunter #2 — Bug F: writeCheckpoint contextPercent uses tokens", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
  });

  /** Local copy of makeStateJson (the one in the first describe block is scoped). */
  function makeStateJsonLocal(overrides: Record<string, unknown> = {}): string {
    const base = {
      intention: "Implementar feature X",
      nextAction: "Escrever testes",
      constraints: ["Não quebrar API"],
      taskTree: ["Task 1"],
      currentWork: "Refatorando",
      filesInvolved: [{ path: "src/y.ts", change: "added foo()" }],
      crossTaskDiscoveries: [],
      errorsAndCorrections: [],
      runtimeState: "tests passing",
      designDecisions: [],
      miscNotes: "",
      ...overrides,
    };
    return JSON.stringify(base);
  }

  it("contextPercent is 20 when estimateTokens returns 25600 (25600/128000)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    const historyMock = await import("./../history.js");

    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJsonLocal() } }],
    });
    // 25600 tokens = 20% of 128000. Pass 128000 explicitly so this test
    // doesn't depend on the production default (config.contextWindowTokens
    // = 256_000 for Kimi K2.6, which would make 25600 tokens = 10%).
    vi.mocked(historyMock.estimateTokens).mockReturnValue(25600);

    const result = await writeCheckpoint(1, 128000);
    // OLD BUG: would have been 0 (0 messages / 128000 = 0%).
    expect(result.contextPercent).toBe(20);
    // Verify estimateTokens was called (proving we use tokens, not message count).
    expect(historyMock.estimateTokens).toHaveBeenCalled();
  });

  it("contextPercent is 0 when estimateTokens returns 0 (empty history)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    const historyMock = await import("./../history.js");

    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJsonLocal() } }],
    });
    vi.mocked(historyMock.estimateTokens).mockReturnValue(0);

    const result = await writeCheckpoint(1, 128000);
    expect(result.contextPercent).toBe(0);
  });

  it("contextPercent scales with token count (not message count) — KEY regression", async () => {
    // This is the KEY regression: with 1 message but many tokens, contextPercent
    // should reflect tokens. OLD BUG: would be ~0% (1 / 128000).
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    const historyMock = await import("./../history.js");

    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJsonLocal() } }],
    });
    // 89600 tokens = 70% of 128000.
    vi.mocked(historyMock.estimateTokens).mockReturnValue(89600);
    // 1 message in history (would have given ~0% with old bug).
    vi.mocked(historyMock.getHistory).mockReturnValue([
      { role: "user", content: "x".repeat(358400) } as any,
    ]);

    const result = await writeCheckpoint(3, 128000);
    // Should be 70%, NOT ~0%.
    expect(result.contextPercent).toBe(70);
  });

  it("contextPercent is 45 when estimateTokens returns 57600 (57600/128000)", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    const historyMock = await import("./../history.js");

    (chat as any).mockResolvedValue({
      choices: [{ message: { content: makeStateJsonLocal() } }],
    });
    vi.mocked(historyMock.estimateTokens).mockReturnValue(57600);

    const result = await writeCheckpoint(2, 128000);
    expect(result.contextPercent).toBe(45);
  });
});

// ─── Bug Hunter: checkpoint firing too early (13% context after 2 messages) ──
//
// Root cause: checkpointWriter.ts had `MAX_CONTEXT_TOKENS = 128_000` hardcoded.
// But the default model (Kimi K2.6) has a 256_000-token context window
// (modelRegistry.ts), and `config.contextWindowTokens` already defaults to
// that value (config.ts §1.1). Using 128_000 made the 20% threshold fire at
// 25_600 tokens — which is only 10% of the actual 256_000 window. The user
// saw "Salvando checkpoint…" at ~13% context after just 2 messages.
//
// Fix: shouldCheckpoint / writeCheckpoint now read `config.contextWindowTokens`
// by default. Tests that pin to 128_000 (above) pass it explicitly. These
// regression tests verify the fix by NOT passing an override.

describe("Bug Hunter: checkpoint firing too early — uses config.contextWindowTokens", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockReset();
  });

  it("shouldCheckpoint uses config.contextWindowTokens (NOT hardcoded 128000) — proven by 25600 tokens", async () => {
    // This test proves the fix: 25600 tokens is EXACTLY 20% of 128000 (the
    // old hardcoded value). With the fix, shouldCheckpoint uses
    // config.contextWindowTokens — so:
    //   - If config.contextWindowTokens == 128000 (e.g., MODEL=mistral-medium-3.5-128b):
    //     25600 / 128000 = 20% → checkpoint 1 fires (returns 1).
    //   - If config.contextWindowTokens == 256000 (e.g., MODEL=kimi-k2.6):
    //     25600 / 256000 = 10% → NO checkpoint (returns 0).
    //
    // The KEY assertion: the result matches `25600 / config.contextWindowTokens
    // >= 0.20`, NOT `25600 / 128000 >= 0.20`. We verify this by computing the
    // expected result from config.contextWindowTokens directly.
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    const { config } = await import("./../config.js");
    const expectedResult = (25600 / config.contextWindowTokens) >= 0.20 ? 1 : 0;
    expect(shouldCheckpoint(25600)).toBe(expectedResult);
    // Sanity: if config.contextWindowTokens were the OLD hardcoded 128000,
    // the result would ALWAYS be 1 (20% threshold met). The fact that
    // expectedResult can be 0 (when contextWindow > 128000) proves we're
    // using the dynamic value, not the hardcoded one.
  });

  it("regression: user scenario — checkpoint does NOT fire below 20% of ACTUAL context window", async () => {
    // The user reported "fires at 13% context after 2 messages". This happens
    // when the checkpoint uses a SMALLER context window than the actual model.
    // With the fix, the checkpoint uses config.contextWindowTokens (the actual
    // model's context window), so it should NOT fire below 20% of that value.
    //
    // We pick a token count that is BELOW 20% of config.contextWindowTokens
    // but would have been ABOVE 20% of the old hardcoded 128000 (when
    // config.contextWindowTokens > 128000).
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    const { config } = await import("./../config.js");
    // 19% of the actual context window — below the 20% threshold.
    const belowThreshold = Math.floor(config.contextWindowTokens * 0.19);
    expect(shouldCheckpoint(belowThreshold)).toBe(0);
    // And 21% of the actual context window — above the 20% threshold.
    const aboveThreshold = Math.floor(config.contextWindowTokens * 0.21);
    expect(shouldCheckpoint(aboveThreshold)).toBe(1);
  });

  it("shouldCheckpoint fires at 20% of config.contextWindowTokens (not 128000)", async () => {
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    const { config } = await import("./../config.js");
    // 20% of the actual configured context window.
    const twentyPercent = Math.floor(config.contextWindowTokens * 0.20);
    expect(shouldCheckpoint(twentyPercent)).toBe(1);
  });

  it("shouldCheckpoint fires at 45% of config.contextWindowTokens", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { config } = await import("./../config.js");
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"intention":"x"}' } }],
    });
    // Complete checkpoint 1 first so checkpoint 2 can fire.
    await writeCheckpoint(1);
    const fortyFivePercent = Math.floor(config.contextWindowTokens * 0.45);
    expect(shouldCheckpoint(fortyFivePercent)).toBe(2);
  });

  it("shouldCheckpoint fires at 70% of config.contextWindowTokens", async () => {
    const { shouldCheckpoint, resetCheckpoints, writeCheckpoint } = await import(
      "./../checkpointWriter.js"
    );
    const { config } = await import("./../config.js");
    const { chat } = await import("./../apiClient.js");
    resetCheckpoints();
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"intention":"x"}' } }],
    });
    await writeCheckpoint(1);
    await writeCheckpoint(2);
    const seventyPercent = Math.floor(config.contextWindowTokens * 0.70);
    expect(shouldCheckpoint(seventyPercent)).toBe(3);
  });

  it("writeCheckpoint reports contextPercent based on config.contextWindowTokens", async () => {
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { config } = await import("./../config.js");
    const { chat } = await import("./../apiClient.js");
    const historyMock = await import("./../history.js");

    (chat as any).mockResolvedValue({
      choices: [{ message: { content: '{"intention":"x"}' } }],
    });
    // Use exactly 20% of the configured context window.
    const twentyPercent = Math.floor(config.contextWindowTokens * 0.20);
    vi.mocked(historyMock.estimateTokens).mockReturnValue(twentyPercent);

    const result = await writeCheckpoint(1);
    // With the fix, contextPercent should be 20 (20% of config.contextWindowTokens).
    // OLD BUG: would have been 10 (20% of 256000 / 128000 hardcoded = 10%).
    expect(result.contextPercent).toBe(20);
  });
});
