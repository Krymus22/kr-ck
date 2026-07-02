/**
 * bugHunter-extended.test.ts — Testes estendidos do Bug Hunter
 *
 * Cobre funções não testadas:
 *   - parseFindings (parsing de findings do LLM)
 *   - compareFindings (fixed/persisting/newBugs)
 *   - formatBugHuntMessage
 *   - allCriticalHighTestsPass
 *   - snapshotFileBeforeEdit / generateDiffAfterEdit
 *   - resetBugHunterState
 *   - runBugHunter (com mock de chat)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock apiClient
const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
}));
vi.mock("../apiClient.js", () => ({ chat: chatMock }));

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// Mock testRunner
vi.mock("../testRunner.js", () => ({
  detectLanguage: vi.fn((file: string) => {
    if (file.endsWith(".lua") || file.endsWith(".luau")) return "lua";
    if (file.endsWith(".py")) return "python";
    return "unknown";
  }),
  isTestRunnerAvailable: vi.fn((lang: string) => lang === "lua" || lang === "python"),
  getTestFilePath: vi.fn((file: string) => file.replace(/\.(lua|luau)$/, ".test.$1")),
  runBugTest: vi.fn(() => ({ passed: true, ran: true, output: "" })),
}));

import {
  parseFindings,
  compareFindings,
  formatBugHuntMessage,
  allCriticalHighTestsPass,
  snapshotFileBeforeEdit,
  generateDiffAfterEdit,
  resetBugHunterState,
  runBugHunter,
  runTestsForFindings,
} from "../bugHunter.js";

describe("bugHunter (extended)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBugHunterState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseFindings", () => {
    it("parseia finding [CRITICAL] com arquivo e linha", () => {
      const content = `[CRITICAL] src/main.lua:42 — nil access on global 'x'
Fix: Add local x = x or {} before use`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe("critical");
      expect(findings[0].file).toBe("src/main.lua");
      expect(findings[0].line).toBe("42");
      expect(findings[0].description).toContain("nil access");
      expect(findings[0].suggestion).toContain("local x");
    });

    it("parseia múltiplos findings de severidades diferentes", () => {
      const content = `[CRITICAL] file1.lua:10 — crash bug
[HIGH] file2.lua:20 — logic error
[MEDIUM] file3.lua:30 — code smell
[LOW] file4.lua:40 — minor issue`;
      const findings = parseFindings(content);
      expect(findings.length).toBeGreaterThanOrEqual(3);
      expect(findings[0].severity).toBe("critical");
      const severities = findings.map(f => f.severity); expect(severities).toContain("high");
    });

    it("parseia finding sem número de linha", () => {
      const content = `[HIGH] src/config.lua — missing pcall around DataStore`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].file).toBe("src/config.lua");
      expect(findings[0].line).toBeUndefined();
    });

    it("parseia finding com path absoluto", () => {
      const content = `[CRITICAL] /home/user/project/file.ts:100 — type mismatch`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].file).toContain("file.ts");
    });

    it("parseia finding com **bold** markdown", () => {
      const content = `**[CRITICAL]** file.lua:5 — description here`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe("critical");
    });

    it("parseia finding com separador ':' em vez de '—'", () => {
      const content = `[HIGH] file.py:10: division by zero`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].description).toContain("division by zero");
    });

    it("retorna array vazio para conteúdo sem findings", () => {
      const content = "NO_BUGS_FOUND: All good!";
      const findings = parseFindings(content);
      expect(findings).toEqual([]);
    });

    it("extrai Fix: suggestion corretamente", () => {
      const content = `[CRITICAL] file.lua:1 — bug here
Fix: Use pcall to wrap the call`;
      const findings = parseFindings(content);
      expect(findings[0].suggestion).toContain("pcall");
    });

    it("usa 'No fix suggested' quando não há Fix:", () => {
      const content = `[LOW] file.lua:1 — minor issue without fix`;
      const findings = parseFindings(content);
      expect(findings[0].suggestion).toBe("No fix suggested.");
    });

    it("fallback: parseia linha simples sem separador", () => {
      const content = `[MEDIUM] some issue description here`;
      const findings = parseFindings(content);
      expect(findings.length).toBe(1);
      expect(findings[0].severity).toBe("medium");
    });
  });

  describe("compareFindings", () => {
    it("identifica bugs fixed (estavam antes, não estão mais)", () => {
      const previous = [
        { severity: "critical" as const, file: "a.lua", description: "bug A", suggestion: "" },
      ];
      const current: typeof previous = [];
      const result = compareFindings(current, previous);
      expect(result.fixed.length).toBe(1);
      expect(result.persisting.length).toBe(0);
      expect(result.newBugs.length).toBe(0);
    });

    it("identifica bugs persisting (ainda existem)", () => {
      const bug = { severity: "high" as const, file: "b.lua", description: "bug B", suggestion: "" };
      const result = compareFindings([bug], [bug]);
      expect(result.persisting.length).toBe(1);
      expect(result.fixed.length).toBe(0);
    });

    it("identifica newBugs (não estavam antes)", () => {
      const newBug = { severity: "medium" as const, file: "c.lua", description: "new bug", suggestion: "" };
      const result = compareFindings([newBug], []);
      expect(result.newBugs.length).toBe(1);
    });

    it("mistura: 1 fixed, 1 persisting, 1 new", () => {
      const previous = [
        { severity: "critical" as const, file: "a.lua", description: "old bug fixed", suggestion: "" },
        { severity: "high" as const, file: "b.lua", description: "persisting bug", suggestion: "" },
      ];
      const current = [
        { severity: "high" as const, file: "b.lua", description: "persisting bug", suggestion: "" },
        { severity: "low" as const, file: "d.lua", description: "brand new bug", suggestion: "" },
      ];
      const result = compareFindings(current, previous);
      expect(result.fixed.length).toBe(1);
      expect(result.persisting.length).toBe(1);
      expect(result.newBugs.length).toBe(1);
    });

    it("detecta persisting por similaridade de descrição (primeiros 40 chars)", () => {
      const previous = [
        { severity: "high" as const, file: "x.lua", description: "This is a long description that describes the bug in detail", suggestion: "" },
      ];
      const current = [
        { severity: "high" as const, file: "x.lua", description: "This is a long description that describes the bug with extra", suggestion: "" },
      ];
      const result = compareFindings(current, previous);
      expect(result.persisting.length).toBe(1);
    });
  });

  describe("formatBugHuntMessage", () => {
    it("formata mensagem com findings e shouldBlock=true", () => {
      const findings = [
        { severity: "critical" as const, file: "main.lua", line: "42", description: "crash", suggestion: "fix it" },
      ];
      const msg = formatBugHuntMessage(findings, true);
      expect(msg).toContain("CRITICAL");
      expect(msg).toContain("main.lua");
      expect(msg).toContain("42");
      expect(msg).toContain("crash");
    });

    it("inclui comparison quando fornecido", () => {
      const findings = [
        { severity: "high" as const, file: "f.lua", description: "bug", suggestion: "" },
      ];
      const comparison = {
        fixed: [],
        persisting: [findings[0]],
        newBugs: [],
      };
      const msg = formatBugHuntMessage(findings, true, comparison);
      expect(msg).toContain("f.lua");
    });

    it("retorna string vazia para findings vazio", () => {
      const msg = formatBugHuntMessage([], false);
      expect(msg).not.toContain("CRITICAL");
    });
  });

  describe("allCriticalHighTestsPass", () => {
    it("retorna true quando não há critical/high findings", () => {
      const findings = [
        { severity: "medium" as const, file: "a.lua", description: "x", suggestion: "" },
        { severity: "low" as const, file: "b.lua", description: "y", suggestion: "" },
      ];
      expect(allCriticalHighTestsPass(findings)).toBe(true);
    });

    it("retorna true quando critical/high passaram", () => {
      const findings = [
        { severity: "critical" as const, file: "a.lua", description: "x", suggestion: "", testStatus: "passed" as const },
      ];
      expect(allCriticalHighTestsPass(findings)).toBe(true);
    });

    it("retorna false quando critical falhou", () => {
      const findings = [
        { severity: "critical" as const, file: "a.lua", description: "x", suggestion: "", testStatus: "failed" as const },
      ];
      expect(allCriticalHighTestsPass(findings)).toBe(false);
    });

    it("retorna false quando high falhou mesmo com critical passed", () => {
      const findings = [
        { severity: "critical" as const, file: "a.lua", description: "x", suggestion: "", testStatus: "passed" as const },
        { severity: "high" as const, file: "b.lua", description: "y", suggestion: "", testStatus: "failed" as const },
      ];
      expect(allCriticalHighTestsPass(findings)).toBe(false);
    });
  });

  describe("snapshotFileBeforeEdit / generateDiffAfterEdit", () => {
    it("generateDiffAfterEdit retorna vazio quando não há snapshot", () => {
      const tmpFile = path.join(os.tmpdir(), `bh-nosnap-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('hello')\n");
      try {
        const diff = generateDiffAfterEdit(tmpFile);
        expect(diff).toBe("");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("generateDiffAfterEdit retorna diff quando arquivo mudou", () => {
      const tmpFile = path.join(os.tmpdir(), `bh-snap-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "local x = 1\nprint(x)\n");
      try {
        snapshotFileBeforeEdit(tmpFile);
        fs.writeFileSync(tmpFile, "local x = 2\nprint(x)\n");
        const diff = generateDiffAfterEdit(tmpFile);
        expect(diff).not.toBe("");
        // Diff deve mencionar a mudança
        expect(diff.length).toBeGreaterThan(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("snapshotFileBeforeEdit não quebra para arquivo inexistente", () => {
      expect(() => snapshotFileBeforeEdit("/nonexistent/file.lua")).not.toThrow();
    });
  });

  describe("runTestsForFindings", () => {
    it("pula findings non-critical/non-high", () => {
      const findings = [
        { severity: "low" as const, file: "a.lua", description: "x", suggestion: "" },
        { severity: "medium" as const, file: "b.lua", description: "y", suggestion: "" },
      ];
      const result = runTestsForFindings(findings, "/tmp");
      expect(result[0].testStatus).toBeUndefined();
    });

    it("pula findings com linguagem unknown", () => {
      const findings = [
        { severity: "critical" as const, file: "a.txt", description: "x", suggestion: "" },
      ];
      const result = runTestsForFindings(findings, "/tmp");
      expect(result[0].testStatus).toBe("skipped");
    });
  });

  describe("runBugHunter", () => {
    it("retorna shouldBlock=false quando nenhum arquivo modificado", async () => {
      const result = await runBugHunter([], "user request", "agent response");
      expect(result.shouldBlock).toBe(false);
      expect(result.findings).toEqual([]);
      expect(result.completed).toBe(false);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("retorna shouldBlock=false quando LLM encontra NO_BUGS", async () => {
      const tmpFile = path.join(os.tmpdir(), `bh-run-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "local x = 1\nprint(x)\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_BUGS_FOUND: Code looks good.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        const result = await runBugHunter([tmpFile], "create script", "created");
        expect(result.shouldBlock).toBe(false);
        expect(result.completed).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("retorna shouldBlock=true quando LLM encontra CRITICAL bugs", async () => {
      const tmpFile = path.join(os.tmpdir(), `bh-bug-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "store:SetAsync('key', nil)\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: {
              content: `FINDINGS:
[CRITICAL] ${tmpFile}:1 — SetAsync with nil value
Fix: Validate data before saving`,
              tool_calls: undefined,
            },
            finish_reason: "stop",
          }],
        });

        const result = await runBugHunter([tmpFile], "save data", "saved");
        expect(result.shouldBlock).toBe(true);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.findings[0].severity).toBe("critical");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("retorna shouldBlock=false quando API falha", async () => {
      const tmpFile = path.join(os.tmpdir(), `bh-err-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('test')\n");

      try {
        chatMock.mockRejectedValue(new Error("API error"));
        const result = await runBugHunter([tmpFile], "test", "test");
        expect(result.shouldBlock).toBe(false);
        expect(result.completed).toBe(false);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("resetBugHunterState", () => {
    it("não lança exceção", () => {
      expect(() => resetBugHunterState()).not.toThrow();
    });
  });
});
