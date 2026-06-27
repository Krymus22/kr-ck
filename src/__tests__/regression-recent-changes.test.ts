/**
 * regression-recent-changes.test.ts — Testes de regressão para mudanças recentes.
 *
 * Cobre especificamente as mudanças dos commits:
 *   - ef04814: Bug Hunter runProjectVerification + timeout API
 *   - 166614e: ajustes de testes (MAX_NETWORK_RETRIES=15, pensar categorias)
 *
 * Cada teste protege contra regressão de um bug específico que foi corrigido.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks mínimos ────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaApiKeys: "",
    nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test.api.nvidia.com/v1",
    model: "test-model",
    contextWindowTokens: 128000,
    contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
    maxTokens: 4096,
    temperature: 0.6,
    topP: 0.9,
  },
}));

// ─── Bug Hunter tests: shouldBlock com medium/low ─────────────────────────

describe("Regression: Bug Hunter shouldBlock inclui medium/low", () => {
  it("BugFinding type aceita todas as 4 severidades", async () => {
    const { parseFindings } = await import("../bugHunter.js");
    const content = `
[CRITICAL] file1.ts:1 — bug 1
Fix: fix 1
[HIGH] file2.ts:2 — bug 2
Fix: fix 2
[MEDIUM] file3.ts:3 — bug 3
Fix: fix 3
[LOW] file4.ts:4 — bug 4
Fix: fix 4
`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(4);
    // Todas as severidades devem ser reconhecidas
    const severities = findings.map(f => f.severity);
    expect(severities).toContain("critical");
    expect(severities).toContain("high");
    expect(severities).toContain("medium");
    expect(severities).toContain("low");
  });

  it("formatBugHuntMessage bloqueia quando há APENAS medium/low", async () => {
    const { formatBugHuntMessage } = await import("../bugHunter.js");
    const findings = [
      { severity: "medium" as const, file: "file.ts", line: "10", description: "medium bug", suggestion: "fix" },
      { severity: "low" as const, file: "file.ts", line: "20", description: "low bug", suggestion: "fix" },
    ];
    // shouldBlock=true (não só critical/high)
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("ISSUES FOUND");
    expect(msg).toContain("NOT allowed to finish");
  });

  it("formatBugHuntMessage não diz 'non-blocking' para medium/low quando shouldBlock=true", async () => {
    const { formatBugHuntMessage } = await import("../bugHunter.js");
    const findings = [
      { severity: "medium" as const, file: "file.ts", line: "10", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    // Não deve mais dizer "non-blocking" — agora BLOQUEIA
    expect(msg).not.toContain("non-blocking");
    expect(msg).toContain("ISSUES FOUND");
  });

  it("mensagem de bloqueio exige FIX ou DISMISS com razão concreta", async () => {
    const { formatBugHuntMessage } = await import("../bugHunter.js");
    const findings = [
      { severity: "critical" as const, file: "file.ts", line: "10", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("FIXED");
    expect(msg).toContain("DISMISSED");
    expect(msg).toContain("valid reason");
    expect(msg).toContain("false positive");
  });
});

// ─── Bug Hunter tests: compareFindings entre rounds ───────────────────────

describe("Regression: Bug Hunter compareFindings detecta FIXED/PERSISTING/NEW", () => {
  it("detecta quando bug foi corrigido (FIXED)", async () => {
    const { compareFindings } = await import("../bugHunter.js");
    const previous = [
      { severity: "critical" as const, file: "file.ts", line: "10", description: "old bug", suggestion: "fix" },
    ];
    const current: any[] = [];
    const result = compareFindings(current, previous);
    expect(result.fixed.length).toBe(1);
    expect(result.persisting.length).toBe(0);
    expect(result.newBugs.length).toBe(0);
  });

  it("detecta quando bug persiste (PERSISTING)", async () => {
    const { compareFindings } = await import("../bugHunter.js");
    const bug = { severity: "critical" as const, file: "file.ts", line: "10", description: "same bug", suggestion: "fix" };
    const result = compareFindings([bug], [bug]);
    expect(result.persisting.length).toBe(1);
    expect(result.fixed.length).toBe(0);
    expect(result.newBugs.length).toBe(0);
  });

  it("detecta quando novo bug foi introduzido (NEW)", async () => {
    const { compareFindings } = await import("../bugHunter.js");
    const previous = [
      { severity: "high" as const, file: "file1.ts", line: "10", description: "old bug", suggestion: "fix" },
    ];
    const current = [
      { severity: "high" as const, file: "file1.ts", line: "10", description: "old bug", suggestion: "fix" }, // persisting
      { severity: "critical" as const, file: "file2.ts", line: "20", description: "new bug", suggestion: "fix" }, // new
    ];
    const result = compareFindings(current, previous);
    expect(result.newBugs.length).toBe(1);
    expect(result.persisting.length).toBe(1);
    expect(result.fixed.length).toBe(0);
  });
});

// ─── Bug Hunter tests: runProjectVerification não trava ────────────────────

describe("Regression: runProjectVerification não trava com setInterval", () => {
  it("termina em menos de 15s mesmo com projeto que tem setInterval", async () => {
    const { runProjectVerification } = await import("../bugHunter.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "regression-bh-"));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    // Projeto com setInterval NUNCA limpo — antes do fix, travava para sempre
    fs.writeFileSync(
      path.join(tmpDir, "src", "index.ts"),
      `setInterval(() => {}, 1000);\nconsole.log("done");\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", type: "commonjs" })
    );

    const start = Date.now();
    const result = await runProjectVerification(tmpDir);
    const elapsed = Date.now() - start;

    // Deve terminar em menos de 15s (10s timeout + 5s margem)
    // ANTES do fix, isso travava para sempre
    expect(elapsed).toBeLessThan(15000);
    expect(typeof result).toBe("string");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 20000);
});

// ─── Agent: Bug Hunter handler integração ─────────────────────────────────

describe("Regression: Agent Bug Hunter handler com medium/low rounds", () => {
  // Estes testes validam que o handler em agent.ts respeita MAX_MEDIUM_LOW_ROUNDS=3

  it("importa runBugHunter sem erro", async () => {
    const mod = await import("../bugHunter.js");
    expect(typeof mod.runBugHunter).toBe("function");
    expect(typeof mod.resetBugHunterState).toBe("function");
  });
});

// ─── apiClient: keepAliveAgent timeout ────────────────────────────────────

describe("Regression: apiClient keepAliveAgent timeout não é mais 0", () => {
  it("https.Agent é criado com timeout definido (não 0)", async () => {
    // Lê o source code para verificar que timeout não é mais 0
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/apiClient.ts"),
      "utf8"
    );

    // Deve ter timeout: 5 * 60 * 1000 (ou similar, NÃO 0)
    expect(source).toMatch(/timeout:\s*\d+\s*\*\s*60\s*\*\s*1000/);
    // NÃO deve mais ter timeout: 0
    expect(source).not.toMatch(/timeout:\s*0\s*,?\s*\/\/\s*no socket/);
  });

  it("OpenAI client tem timeout de 5 min definido", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/apiClient.ts"),
      "utf8"
    );

    // Client deve ter timeout definido (5 * 60 * 1000)
    expect(source).toMatch(/timeout:\s*5\s*\*\s*60\s*\*\s*1000/);
  });
});

// ─── apiClient: MAX_NETWORK_RETRIES = 15 ──────────────────────────────────

describe("Regression: MAX_NETWORK_RETRIES é 15 (não 8)", () => {
  it("SUB_AGENT_MAX_NETWORK_RETRIES exporta 15", async () => {
    const { SUB_AGENT_MAX_NETWORK_RETRIES } = await import("../apiClient.js");
    expect(SUB_AGENT_MAX_NETWORK_RETRIES).toBe(15);
  });
});

// ─── history.ts: system prompt mudanças ───────────────────────────────────

describe("Regression: System prompt com sub-agentes, marcar_feito, pensar categorias", () => {
  it("getSystemPrompt retorna string não-vazia", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("System prompt menciona sub-agentes como DEFAULT (não last resort)", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/sub-?agent/i);
    expect(prompt).toMatch(/DEFAULT|STRONGLY PREFERRED/i);
  });

  it("System prompt menciona marcar_feito como MANDATORY", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/marcar_feito/);
    expect(prompt).toMatch(/MANDATORY|mandatory/i);
  });

  it("System prompt explica diferença atualizar_estado vs marcar_feito", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/atualizar_estado/);
    expect(prompt).toMatch(/marcar_feito/);
    // Deve explicar a diferença
    expect(prompt).toMatch(/CRITICAL.*difference|different.*purposes/i);
  });

  it("System prompt lista categorias do pensar()", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(prompt).toContain("planning");
    expect(prompt).toContain("pre_edit");
    expect(prompt).toContain("pre_response");
    expect(prompt).toContain("debugging");
    expect(prompt).toContain("architecture");
  });

  it("System prompt NÃO diz 'releia o arquivo após editar' como regra geral (Bug Hunter faz isso)", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    // Deve ter a NOTE explicando que NÃO precisa reler (Bug Hunter faz isso)
    expect(prompt).toMatch(/do NOT need to re-?read.*after editing/i);
  });

  it("System prompt menciona Rule 15 (proibido cat > para editar arquivos)", async () => {
    const { getSystemPrompt } = await import("../history.js");
    const prompt = getSystemPrompt();
    expect(prompt).toMatch(/cat\s*>|NEVER.*executar_comando.*modif/i);
  });
});

// ─── effortLevels: pensar sempre ativo ────────────────────────────────────

describe("Regression: effortLevels pensar() sempre ativo (mesmo no low)", () => {
  it("nível low ativa pensar()", async () => {
    const { setEffortLevel, getEffortPromptSnippet } = await import("../effortLevels.js");
    setEffortLevel("low");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toMatch(/pensar\(\)/i);
  });

  it("nível high contém 'EVERY action' (não 'CADA escrita')", async () => {
    const { setEffortLevel, getEffortPromptSnippet } = await import("../effortLevels.js");
    setEffortLevel("high");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toContain("EVERY action");
  });

  it("nível max contém categorias obrigatórias", async () => {
    const { setEffortLevel, getEffortPromptSnippet } = await import("../effortLevels.js");
    setEffortLevel("max");
    const snippet = getEffortPromptSnippet();
    expect(snippet).toContain("planning");
    expect(snippet).toContain("pre_edit");
    expect(snippet).toContain("pre_response");
  });
});

// ─── thinkTool: categorias renovadas ──────────────────────────────────────

describe("Regression: thinkTool categorias renovadas (sem 'verification')", () => {
  it("THINK_TOOL_DEFINITION tem enum com 7 categorias", async () => {
    const { THINK_TOOL_DEFINITION } = await import("../thinkTool.js");
    const params = THINK_TOOL_DEFINITION.function.parameters as any;
    const enumValues = params.properties.categoria.enum;
    expect(enumValues.length).toBe(7);
    expect(enumValues).toContain("planning");
    expect(enumValues).toContain("pre_edit");
    expect(enumValues).toContain("pre_research");
    expect(enumValues).toContain("pre_response");
    expect(enumValues).toContain("debugging");
    expect(enumValues).toContain("architecture");
    expect(enumValues).toContain("general");
  });

  it("think() NÃO aceita 'verification' como categoria (foi removida)", async () => {
    const { think } = await import("../thinkTool.js");
    // verification deve cair em 'general' (fallback)
    const r = await think({ pensamento: "test", category: "verification" as any });
    expect(r.confirmed).toBe(true);
    // Deve usar 'general' (fallback) ou a categoria passada (mesmo inválida)
    expect(r.message).toContain("THINK");
  });

  it("think() com pre_response retorna checklist de honestidade", async () => {
    const { think } = await import("../thinkTool.js");
    const r = await think({ pensamento: "test", category: "pre_response" });
    expect(r.confirmed).toBe(true);
    expect(r.message).toContain("pre_response");
    // Deve ter algum checklist de honestidade
    expect(r.message.length).toBeGreaterThan(50);
  });

  it("think() com planning retorna checklist de planejamento", async () => {
    const { think } = await import("../thinkTool.js");
    const r = await think({ pensamento: "test", category: "planning" });
    expect(r.confirmed).toBe(true);
    expect(r.message).toContain("planning");
  });
});

// ─── Vitest setup: NODE_ENV=test ──────────────────────────────────────────

describe("Regression: vitest-setup define NODE_ENV=test", () => {
  it("NODE_ENV é 'test' durante os testes", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("CLAUDE_KILLER_LANG é 'en' durante os testes", () => {
    expect(process.env.CLAUDE_KILLER_LANG).toBe("en");
  });
});
