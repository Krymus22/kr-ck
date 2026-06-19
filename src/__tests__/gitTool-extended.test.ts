/**
 * gitTool-extended.test.ts — Cobertura adicional do módulo gitTool.
 *
 * Foca em:
 *   - gitStatus (3): parsing de codes de status, branch sem upstream, fallback
 *   - gitCommit (2): escape de aspas, múltiplos arquivos
 *   - gitDiff (2): com staged+file, com file only
 *   - edge cases (1): erro do git retorna [GIT ERROR]
 *
 * Não duplica testes do arquivo gitTool.test.ts básico (que usa git real).
 * Aqui usamos mocks de runShell para cenários determinísticos.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock do logger para silenciar output
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// Mock controlável do runShell (gitTool depende de shell.ts)
const { runShellMock } = vi.hoisted(() => ({
  runShellMock: vi.fn(),
}));

vi.mock("../shell.js", () => ({
  runShell: runShellMock,
  runShellSync: vi.fn(),
}));

import { gitStatus, gitDiff, gitCommit } from "../gitTool.js";

function mockGitSequence(outputs: Array<{ stdout?: string; stderr?: string; exitCode?: number }>): void {
  runShellMock.mockImplementation(async () => {
    const next = outputs.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
    return {
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      exitCode: next.exitCode ?? 0,
      timedOut: false,
    };
  });
}

beforeEach(() => {
  runShellMock.mockReset();
});

describe("gitTool-extended: gitStatus", () => {
  it("classifica corretamente linhas staged (M), modified (M) e untracked (??)", async () => {
    // git rev-parse (branch), git status --porcelain, git rev-list (ahead/behind fallback)
    mockGitSequence([
      { stdout: "main\n" }, // branch
      {
        stdout:
          "M  staged-file.ts\n" +     // index=M, work=space => staged
          " M modified-file.ts\n" +   // index=space, work=M => modified
          "?? untracked-file.ts\n",   // index=?? => untracked
      },
      { stdout: "0\t0\n", exitCode: 0 }, // ahead/behind (0/0)
    ]);

    const status = await gitStatus("/repo");
    expect(status.branch).toBe("main");
    expect(status.staged).toContain("staged-file.ts");
    expect(status.modified).toContain("modified-file.ts");
    expect(status.untracked).toContain("untracked-file.ts");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it("detecta conflitos (UU) e (AA) corretamente", async () => {
    mockGitSequence([
      { stdout: "feature\n" },
      {
        stdout:
          "UU both-modified.ts\n" +   // both modified => conflicted
          "AA both-added.ts\n",       // both added => conflicted
      },
      { stdout: "0 0\n", exitCode: 0 },
    ]);

    const status = await gitStatus("/repo");
    expect(status.conflicted).toContain("both-modified.ts");
    expect(status.conflicted).toContain("both-added.ts");
    expect(status.staged).not.toContain("both-modified.ts");
  });

  it("lida com branch sem upstream: ahead/behind ficam 0 quando rev-list falha", async () => {
    mockGitSequence([
      { stdout: "no-upstream-branch\n" },
      { stdout: "" }, // status vazio
      { stdout: "", stderr: "fatal: no upstream", exitCode: 128 }, // rev-list falha -> cai no catch
    ]);

    const status = await gitStatus("/repo");
    expect(status.branch).toBe("no-upstream-branch");
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.staged).toEqual([]);
    expect(status.modified).toEqual([]);
  });
});

describe("gitTool-extended: gitCommit", () => {
  it("escapa aspas duplas na mensagem de commit", async () => {
    const calls: string[] = [];
    runShellMock.mockImplementation(async (opts: { command: string }) => {
      calls.push(opts.command);
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    });

    await gitCommit('feat: adiciona "x" e "y"', "/repo");
    // Verifica que as aspas foram escapadas e o commit tem -m "..."
    const commitCall = calls.find((c) => c.startsWith("git commit"));
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain('\\"x\\"');
    expect(commitCall).toContain('\\"y\\"');
  });

  it('executa "git add" antes do commit quando files é fornecido', async () => {
    const calls: string[] = [];
    runShellMock.mockImplementation(async (opts: { command: string }) => {
      calls.push(opts.command);
      return { stdout: "ok", stderr: "", exitCode: 0, timedOut: false };
    });

    await gitCommit("msg", "/repo", ["file1.ts", "file2.ts"]);
    const addCall = calls.find((c) => c.startsWith("git add"));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('"file1.ts"');
    expect(addCall).toContain('"file2.ts"');
    // Commit também foi chamado
    expect(calls.some((c) => c.startsWith("git commit"))).toBe(true);
  });
});

describe("gitTool-extended: gitDiff", () => {
  it('monta comando "diff --cached -- file.ts" quando staged=true e file fornecido', async () => {
    const calls: string[] = [];
    runShellMock.mockImplementation(async (opts: { command: string }) => {
      calls.push(opts.command);
      return { stdout: "diff content", stderr: "", exitCode: 0, timedOut: false };
    });

    const result = await gitDiff("/repo", "file.ts", true);
    expect(calls[0]).toContain("diff --cached");
    expect(calls[0]).toContain("-- file.ts");
    expect(result).toContain("diff content");
  });

  it('passa apenas o file quando staged=false (sem --cached)', async () => {
    const calls: string[] = [];
    runShellMock.mockImplementation(async (opts: { command: string }) => {
      calls.push(opts.command);
      return { stdout: "unstaged diff", stderr: "", exitCode: 0, timedOut: false };
    });

    const result = await gitDiff("/repo", "src/x.ts", false);
    expect(calls[0]).toBe("git diff -- src/x.ts");
    expect(result).toBe("unstaged diff");
  });
});

describe("gitTool-extended: edge cases", () => {
  it("retorna string com prefixo [GIT ERROR] quando git retorna exitCode != 0 com stderr", async () => {
    runShellMock.mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      exitCode: 128,
      timedOut: false,
    });

    // Qualquer função do gitTool chama gitCommand internamente; usamos gitDiff para testar
    const result = await gitDiff("/not-a-repo");
    expect(result).toContain("[GIT ERROR]");
    expect(result).toContain("fatal: not a git repository");
  });
});
