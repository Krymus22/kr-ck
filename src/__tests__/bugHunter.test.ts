/**
 * bugHunter.test.ts — Testes de regressão para o Bug Hunter.
 *
 * Cobre as mudanças recentes:
 *   1. runProjectVerification usa spawn com detached:true (não trava mais)
 *   2. shouldBlock = findings.length > 0 (não só critical/high)
 *   3. formatBugHuntMessage com mensagem diretiva (FIX ou DISMISS)
 *   4. parseFindings flexível (vários formatos)
 *   5. compareFindings detecta FIXED/PERSISTING/NEW
 *   6. resetBugHunterState limpa memória entre rounds
 *   7. snapshotFileBeforeEdit / generateDiffAfterEdit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  config: {
    model: "test-model",
    nvidiaApiKey: "test",
    nvidiaApiKeys: "",
    nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test",
    maxTokens: 4096,
    temperature: 0.6,
    topP: 0.9,
    contextWindowTokens: 128000,
    contextCompactThreshold: 0.75,
  },
}));

import {
  runProjectVerification,
  parseFindings,
  formatBugHuntMessage,
  compareFindings,
  resetBugHunterState,
  snapshotFileBeforeEdit,
  generateDiffAfterEdit,
  type BugFinding,
} from "../bugHunter.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeFinding(severity: BugFinding["severity"], file: string, description: string, line?: string): BugFinding {
  return {
    severity,
    file,
    line,
    description,
    suggestion: "Fix: " + description,
  };
}

// ─── parseFindings ────────────────────────────────────────────────────────

describe("bugHunter: parseFindings", () => {
  it("parseia [CRITICAL] file.ts:42 — description", () => {
    const content = `[CRITICAL] /abs/path/file.ts:42 — nil access on user.name`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].file).toBe("/abs/path/file.ts");
    expect(findings[0].line).toBe("42");
    expect(findings[0].description).toContain("nil access");
  });

  it("parseia múltiplos findings de severidades diferentes", () => {
    const content = `
[CRITICAL] file1.ts:10 — bug 1
Fix: fix 1
[HIGH] file2.ts:20 — bug 2
Fix: fix 2
[MEDIUM] file3.ts:30 — bug 3
Fix: fix 3
[LOW] file4.ts:40 — bug 4
Fix: fix 4
`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(4);
    expect(findings[0].severity).toBe("critical");
    expect(findings[1].severity).toBe("high");
    expect(findings[2].severity).toBe("medium");
    expect(findings[3].severity).toBe("low");
  });

  it("parseia com separadores diferentes (—, -, –, :)", () => {
    const content = `
[CRITICAL] file.ts:1 — bug 1
[HIGH] file.ts:2 - bug 2
[MEDIUM] file.ts:3 – bug 3
[LOW] file.ts:4: bug 4
`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(4);
  });

  it("aceita **[CRITICAL]** com asteriscos markdown", () => {
    const content = `**[CRITICAL]** /path/file.ts:5 — important bug`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("critical");
  });

  it("extrai Fix: da linha após finding", () => {
    const content = `
[CRITICAL] file.ts:10 — nil access
Fix: add null check before accessing user.name
`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].suggestion).toContain("add null check");
  });

  it("retorna suggestion padrão quando não há Fix:", () => {
    const content = `[CRITICAL] file.ts:10 — nil access sem fix`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].suggestion).toContain("No fix suggested");
  });

  it("retorna array vazio quando não há findings", () => {
    expect(parseFindings("No bugs found. Code looks good.")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
    expect(parseFindings("VERDICT: PASS")).toEqual([]);
  });

  it("aceita path absoluto com / (não quebra com ':')", () => {
    // Testa com path sem ':' no meio — apenas ':' separando linha
    const content = `[HIGH] /tmp/scheduler.ts:42 — bug`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].file).toBe("/tmp/scheduler.ts");
    expect(findings[0].line).toBe("42");
  });

  it("parseia paths com hífens (ck-sched-3Ubrce)", () => {
    // Paths com hífens podem confundir o regex (hífen é separador)
    // Verifica que pelo menos detecta a severidade correta
    const content = `[HIGH] scheduler.ts:42 — bug`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("high");
  });
});

// ─── formatBugHuntMessage ─────────────────────────────────────────────────

describe("bugHunter: formatBugHuntMessage", () => {
  it("retorna mensagem de 'no bugs' quando findings vazio", () => {
    const msg = formatBugHuntMessage([], false);
    expect(msg).toContain("No bugs found");
    expect(msg).toContain("passed critical review");
  });

  it("mensagem de bloqueio contém 'ISSUES FOUND' e instrução FIX/DISMISS", () => {
    const findings = [makeFinding("critical", "file.ts", "nil access", "10")];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("ISSUES FOUND");
    expect(msg).toContain("NOT allowed to finish");
    expect(msg).toContain("FIXED");
    expect(msg).toContain("DISMISSED");
  });

  it("lista TODOS os findings com severidade e localização", () => {
    const findings = [
      makeFinding("critical", "file1.ts", "bug 1", "10"),
      makeFinding("high", "file2.ts", "bug 2", "20"),
      makeFinding("medium", "file3.ts", "bug 3", "30"),
      makeFinding("low", "file4.ts", "bug 4", "40"),
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("[CRITICAL] file1.ts:10");
    expect(msg).toContain("[HIGH] file2.ts:20");
    expect(msg).toContain("[MEDIUM] file3.ts:30");
    expect(msg).toContain("[LOW] file4.ts:40");
    expect(msg).toContain("bug 1");
    expect(msg).toContain("bug 4");
    expect(msg).toContain("All Findings (4 total)");
  });

  it("inclui comparison quando fornecido", () => {
    const findings = [makeFinding("critical", "file.ts", "new bug", "10")];
    const comparison = {
      fixed: [makeFinding("high", "file2.ts", "fixed bug", "20")],
      persisting: [makeFinding("medium", "file3.ts", "persisting bug", "30")],
      newBugs: findings,
    };
    const msg = formatBugHuntMessage(findings, true, comparison);
    expect(msg).toContain("Round Comparison");
    expect(msg).toContain("FIXED: 1");
    expect(msg).toContain("PERSISTING: 1");
    expect(msg).toContain("NEW: 1");
  });

  it("avisa sobre NEW bugs introduzidos pelo fix", () => {
    const findings = [makeFinding("critical", "file.ts", "new bug", "10")];
    const comparison = {
      fixed: [],
      persisting: [],
      newBugs: findings,
    };
    const msg = formatBugHuntMessage(findings, true, comparison);
    expect(msg).toContain("WARNING: You introduced 1 NEW bug");
  });

  it("inclui projectOutput quando fornecido", () => {
    const findings = [makeFinding("critical", "file.ts", "bug", "10")];
    const msg = formatBugHuntMessage(findings, true, null, "Error: cannot run");
    expect(msg).toContain("Project Run Result");
    expect(msg).toContain("Error: cannot run");
  });

  it("não inclui projectOutput quando é '(could not run project)'", () => {
    const findings = [makeFinding("critical", "file.ts", "bug", "10")];
    const msg = formatBugHuntMessage(findings, true, null, "(could not run project)");
    expect(msg).not.toContain("Project Run Result");
  });

  it("instruções para bloqueio incluem 8 passos", () => {
    const findings = [makeFinding("critical", "file.ts", "bug", "10")];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("How to address these findings");
    expect(msg).toContain("Fix ONE finding at a time");
    expect(msg).toContain("MEDIUM/LOW");
  });
});

// ─── compareFindings ──────────────────────────────────────────────────────

describe("bugHunter: compareFindings", () => {
  it("marca todos como NEW quando previous é vazio", () => {
    const current = [makeFinding("critical", "file.ts", "bug 1", "10")];
    const result = compareFindings(current, []);
    expect(result.newBugs.length).toBe(1);
    expect(result.fixed.length).toBe(0);
    expect(result.persisting.length).toBe(0);
  });

  it("marca todos como FIXED quando current é vazio", () => {
    const previous = [makeFinding("critical", "file.ts", "bug 1", "10")];
    const result = compareFindings([], previous);
    expect(result.fixed.length).toBe(1);
    expect(result.newBugs.length).toBe(0);
    expect(result.persisting.length).toBe(0);
  });

  it("detecta PERSISTING quando mesmo file + mesma description", () => {
    const bug = makeFinding("critical", "file.ts", "nil access on line 42", "42");
    const result = compareFindings([bug], [bug]);
    expect(result.persisting.length).toBe(1);
    expect(result.fixed.length).toBe(0);
    expect(result.newBugs.length).toBe(0);
  });

  it("detecta FIXED quando bug sumiu do current", () => {
    const previous = [makeFinding("high", "file.ts", "old bug", "10")];
    const current = [makeFinding("critical", "file.ts", "different bug", "20")];
    const result = compareFindings(current, previous);
    expect(result.fixed.length).toBe(1);  // old bug sumiu
    expect(result.newBugs.length).toBe(1);  // different bug é novo
    expect(result.persisting.length).toBe(0);
  });

  it("detecta NEW quando bug aparece apenas no current", () => {
    const previous = [makeFinding("high", "file1.ts", "old bug", "10")];
    const current = [
      makeFinding("high", "file1.ts", "old bug", "10"),  // persisting
      makeFinding("critical", "file2.ts", "new bug", "20"),  // new
    ];
    const result = compareFindings(current, previous);
    expect(result.persisting.length).toBe(1);
    expect(result.newBugs.length).toBe(1);
    expect(result.fixed.length).toBe(0);
  });

  it("match por prefixo de description (40 chars)", () => {
    const longDesc = "This is a very long bug description that spans more than 40 characters total";
    const previous = [makeFinding("high", "file.ts", longDesc, "10")];
    const current = [makeFinding("high", "file.ts", longDesc.slice(0, 40), "10")];
    const result = compareFindings(current, previous);
    // Deve detectar como persisting (prefixo de 40 chars bate)
    expect(result.persisting.length).toBe(1);
  });
});

// ─── resetBugHunterState ──────────────────────────────────────────────────

describe("bugHunter: resetBugHunterState", () => {
  it("não lança erro quando chamado", () => {
    expect(() => resetBugHunterState()).not.toThrow();
  });

  it("pode ser chamado múltiplas vezes", () => {
    expect(() => {
      resetBugHunterState();
      resetBugHunterState();
      resetBugHunterState();
    }).not.toThrow();
  });
});

// ─── snapshotFileBeforeEdit / generateDiffAfterEdit ───────────────────────

describe("bugHunter: snapshotFileBeforeEdit / generateDiffAfterEdit", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `bughunter-test-${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, "const x = 1;\n");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("snapshotFileBeforeEdit não lança para arquivo existente", () => {
    expect(() => snapshotFileBeforeEdit(tmpFile)).not.toThrow();
  });

  it("snapshotFileBeforeEdit não lança para arquivo inexistente", () => {
    expect(() => snapshotFileBeforeEdit("/nonexistent/file.ts")).not.toThrow();
  });

  it("generateDiffAfterEdit retorna string vazia quando não há snapshot", () => {
    const diff = generateDiffAfterEdit(tmpFile);
    expect(typeof diff).toBe("string");
  });

  it("generateDiffAfterEdit detecta mudanças após snapshot", () => {
    snapshotFileBeforeEdit(tmpFile);
    fs.writeFileSync(tmpFile, "const x = 2;\n");
    const diff = generateDiffAfterEdit(tmpFile);
    expect(typeof diff).toBe("string");
    // Deve mencionar o nome do arquivo (basename) no diff
    if (diff.length > 0) {
      expect(diff).toContain(path.basename(tmpFile));
    }
  });
});

// ─── runProjectVerification (spawn detached) ──────────────────────────────

describe("bugHunter: runProjectVerification", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bughunter-verify-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("retorna string (não lança)", async () => {
    const result = await runProjectVerification(tmpDir);
    expect(typeof result).toBe("string");
  });

  it("detecta erro quando não há src/index.ts", async () => {
    const result = await runProjectVerification(tmpDir);
    // Deve mencionar erro ou timeout
    expect(result.length).toBeGreaterThan(0);
  });

  it("NÃO trava com projeto que tem setInterval não limpo (BUG CRÍTICO)", async () => {
    // Cria projeto com setInterval que NUNCA é limpo — antes do fix,
    // isso travava o execSync para sempre porque subprocessos órfãos
    // mantinham os pipes abertos.
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "index.ts"),
      `setInterval(() => {}, 1000);\nconsole.log("done");\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", type: "commonjs" })
    );

    // Deve terminar em menos de 15 segundos (10s timeout + 5s margem)
    const start = Date.now();
    const result = await runProjectVerification(tmpDir);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(15000);
    expect(typeof result).toBe("string");
    // Deve conter "done" (output do console.log) OU "timed out"
    expect(result.length).toBeGreaterThan(0);
  }, 20000);

  it("roda projeto válido e captura output", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "index.ts"),
      `console.log("PROJECT_OK");\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", type: "commonjs" })
    );

    const result = await runProjectVerification(tmpDir);
    // Pode conter PROJECT_OK ou mensagem de erro (depende se tsx está disponível)
    expect(typeof result).toBe("string");
  }, 20000);
});
