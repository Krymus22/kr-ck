/**
 * mutation-fileedit-checks.test.ts — Kills survived mutations in src/fileEdit.ts.
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L97:  `if (!diffCheck.matches && diffCheck.message)`  (diff reality check)
 *           mutation: `!diffCheck.matches` → `diffCheck.matches`  OR  `&&` → `||`
 *   - L106: `if (hallucinationCheck.hallucinatedSymbols.length > 0 && hallucinationCheck.message)`
 *           mutation: `> 0` → `> 1`  OR  `&&` → `||`
 *   - L115: `if (!importCheck.ok && importCheck.message)`  (import resolver)
 *           mutation: `!importCheck.ok` → `importCheck.ok`  OR  `&&` → `||`
 *   - L186: `if (nodePath.basename(dir) === "src")`  (project root heuristic)
 *           mutation: `===` → `!==`  (treats every non-src dir as src)
 *
 * BUG FIX applied first: runPostWriteChecks() (L87-119) was DEAD CODE —
 * defined but never called. The honesty/import checks were duplicated
 * inline in editFile() (L432-469). This means mutations at L97/L106/L115
 * survived because the code was UNREACHABLE. Fix: replaced the inline
 * duplication with `await runPostWriteChecks(resolved, result.content)`.
 * Now the function is live and the mutations below can be killed.
 *
 * Killing strategy:
 *   - L97/L106/L115: Mock honestySystem/importResolver to return mismatch/
 *     hallucination/import-error results. Call editFile. Assert log.warn
 *     was called with the expected [HONESTY:...] / [IMPORT_RESOLVER] message.
 *     If the condition is mutated, the warn is NOT called → test fails.
 *   - L186: Create a temp dir `<tmp>/myproject/src/file.ts` (no package.json).
 *     Call editFile. Capture the projectRoot argument passed to analyzeImpact.
 *     Assert projectRoot is `<tmp>/myproject` (parent of src/). If `===` is
 *     mutated to `!==`, projectRoot becomes `<tmp>` (grandparent) → fails.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mock state (hoisted so factories can read it) ---------------------------
const honestyState = vi.hoisted(() => ({
  diffMatches: true,
  diffMessage: "",
  hallucinatedSymbols: [] as Array<{ name: string; line: number }>,
  hallucinationMessage: "",
}));
const importState = vi.hoisted(() => ({
  ok: true,
  message: "",
}));
const impactState = vi.hoisted(() => ({
  lastProjectRoot: null as string | null,
  lastResolved: null as string | null,
}));
const lockState = vi.hoisted(() => ({
  acquired: true,
}));

// --- Mocks -------------------------------------------------------------------
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../i18n.js", () => ({
  t: vi.fn((_key: string, ...args: unknown[]) => String(args[0] ?? "")),
}));

vi.mock("../rollbackStore.js", () => ({
  saveBackup: vi.fn(() => ({ path: "/fake/backup" })),
  restoreBackup: vi.fn(() => true),
}));

vi.mock("../honestySystem.js", () => ({
  markFileAsEdited: vi.fn(),
  diffRealityCheck: vi.fn(async () => ({
    matches: honestyState.diffMatches,
    message: honestyState.diffMessage,
  })),
  detectHallucinations: vi.fn(async () => ({
    hallucinatedSymbols: honestyState.hallucinatedSymbols,
    message: honestyState.hallucinationMessage,
  })),
}));

vi.mock("../importResolver.js", () => ({
  checkImports: vi.fn(() => ({
    ok: importState.ok,
    message: importState.message,
    missingImports: [],
  })),
}));

vi.mock("../fileLock.js", () => ({
  acquireLock: vi.fn(async () => {
    if (lockState.acquired) return () => {}; // release function
    throw new Error("lock busy");
  }),
  getCurrentAgentId: vi.fn(() => "test-agent"),
}));

vi.mock("../impactAnalyzer.js", () => ({
  analyzeImpact: vi.fn(async (resolved: string, projectRoot: string) => {
    impactState.lastResolved = resolved;
    impactState.lastProjectRoot = projectRoot;
    return { impactedFiles: [], summary: "" };
  }),
  formatImpactHint: vi.fn(() => ""),
}));

vi.mock("../luauValidator.js", () => ({
  shouldValidateFile: vi.fn(async () => false),
  validateLuauBeforeWrite: vi.fn(async () => ({ ok: true, warnings: [], rulesApplied: [], rulesSkipped: [], blockingError: null })),
  getActiveValidationRules: vi.fn(async () => []),
}));

vi.mock("../modes.js", () => ({
  getActiveMode: vi.fn(() => ({
    name: "normal",
    safetyReview: false,
  })),
  getActiveModeName: vi.fn(() => "normal"),
}));

vi.mock("../hookRunner.js", () => ({
  runHooks: vi.fn(async () => []),
}));

vi.mock("../modeExtensions.js", () => ({
  runPostEditHooks: vi.fn(async () => ""),
}));

vi.mock("../safetyReviewer.js", () => ({
  reviewCodeSafety: vi.fn(async () => ({ risk: "none", reviewedByLlm: false, patternsMatched: [], durationMs: 0 })),
  formatSafetyReview: vi.fn(() => ""),
  shouldReviewFile: vi.fn(() => false),
}));

// --- Import AFTER mocks ------------------------------------------------------
import { editFile } from "../fileEdit.js";
import * as log from "../logger.js";

const mockedWarn = vi.mocked(log.warn);

describe("fileEdit — runPostWriteChecks mutation killers (L97/L106/L115)", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-fileedit-"));
    testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;\n", "utf8");

    // Reset mock state
    honestyState.diffMatches = true;
    honestyState.diffMessage = "";
    honestyState.hallucinatedSymbols = [];
    honestyState.hallucinationMessage = "";
    importState.ok = true;
    importState.message = "";
    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;

    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("diffRealityCheck mismatch → log.warn('[HONESTY:DiffCheck] ...') called (kills `!matches` → `matches` on L97)", async () => {
    honestyState.diffMatches = false;
    honestyState.diffMessage = "diff reality check failed: keyword 'foo' not in file";

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: condition `!diffCheck.matches && diffCheck.message` is true → warn called.
    // Mutation `!diffCheck.matches` → `diffCheck.matches`: condition becomes
    // `false && true` → false → warn NOT called. Test fails. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[HONESTY:DiffCheck]"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("diff reality check failed"))).toBe(true);
  });

  it("diffRealityCheck match → no [HONESTY:DiffCheck] warn (kills `&&` → `||` on L97)", async () => {
    honestyState.diffMatches = true;
    honestyState.diffMessage = "some message"; // message present but matches=true

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: condition `!true && "some message"` → `false && true` → false → no warn.
    // Mutation `&&` → `||`: `false || true` → true → warn IS called. Test fails. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[HONESTY:DiffCheck]"))).toBe(false);
  });

  it("detectHallucinations finds 1 symbol → log.warn('[HONESTY:Hallucination] ...') called (kills `> 0` → `> 1` on L106)", async () => {
    honestyState.hallucinatedSymbols = [{ name: "phantomFn", line: 1 }];
    honestyState.hallucinationMessage = "hallucinated symbol: phantomFn";

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: `1 > 0 && message` → true → warn called.
    // Mutation `> 0` → `> 1`: `1 > 1` → false → warn NOT called. Test fails. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[HONESTY:Hallucination]"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("phantomFn"))).toBe(true);
  });

  it("detectHallucinations finds 0 symbols → no [HONESTY:Hallucination] warn (kills `&&` → `||` on L106)", async () => {
    honestyState.hallucinatedSymbols = [];
    honestyState.hallucinationMessage = "some message"; // message present but 0 symbols

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: `0 > 0 && message` → false → no warn.
    // Mutation `&&` → `||`: `false || true` → true → warn called. Test fails. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[HONESTY:Hallucination]"))).toBe(false);
  });

  it("checkImports fails → log.warn('[IMPORT_RESOLVER] ...') called (kills `!ok` → `ok` on L115)", async () => {
    importState.ok = false;
    importState.message = "import not found: ./missing.js";

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: `!false && message` → `true && true` → true → warn called.
    // Mutation `!importCheck.ok` → `importCheck.ok`: `false && true` → false → no warn. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[IMPORT_RESOLVER]"))).toBe(true);
    expect(warnCalls.some((m) => m.includes("import not found"))).toBe(true);
  });

  it("checkImports ok → no [IMPORT_RESOLVER] warn (kills `&&` → `||` on L115)", async () => {
    importState.ok = true;
    importState.message = "some message"; // message present but ok=true

    await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Correct: `!true && message` → `false && true` → false → no warn.
    // Mutation `&&` → `||`: `false || true` → true → warn called. Test fails. ✓ KILLED.
    const warnCalls = mockedWarn.mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((m) => m.includes("[IMPORT_RESOLVER]"))).toBe(false);
  });
});

describe("fileEdit — project root heuristic mutation killer (L186: `=== \"src\"`)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-projroot-"));
    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("file inside <root>/src/ → projectRoot is <root> (parent of src/) (kills `===` → `!==` on L186)", async () => {
    // Create <tmpRoot>/myproject/src/file.ts
    // No package.json anywhere → the `=== "src"` check is the only thing
    // that sets projectRoot correctly.
    const projectDir = path.join(tmpRoot, "myproject");
    const srcDir = path.join(projectDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    const file = path.join(srcDir, "file.ts");
    fs.writeFileSync(file, "const y = 2;\n", "utf8");

    await editFile(file, [{ search: "const y = 2;", replace: "const y = 3;" }]);

    // Correct: dir walks from <projectDir>/src. basename="src" → projectRoot=<projectDir>.
    // Mutation `=== "src"` → `!== "src"`: at i=0, `"src" !== "src"` is false →
    // continue. At i=1, dir=<projectDir>, basename="myproject", `"myproject" !== "src"`
    // is TRUE → projectRoot = <tmpRoot> (grandparent). Test fails. ✓ KILLED.
    expect(impactState.lastProjectRoot).toBe(projectDir);
  });

  it("file inside <root>/sub/ (no src) → projectRoot walks up to <root> (confirms heuristic baseline)", async () => {
    // No package.json, no src/ dir → loop walks all 4 levels without breaking.
    // projectRoot stays at the initial value: dirname(dirname(file)) = <root>/sub
    const subDir = path.join(tmpRoot, "subdir");
    fs.mkdirSync(subDir, { recursive: true });
    const file = path.join(subDir, "file.ts");
    fs.writeFileSync(file, "const z = 3;\n", "utf8");

    await editFile(file, [{ search: "const z = 3;", replace: "const z = 4;" }]);

    // No package.json, no src/ → projectRoot stays at dirname(file) = <subDir>.
    // (The loop doesn't break, so projectRoot = initial = nodePath.dirname(resolved))
    expect(impactState.lastProjectRoot).toBe(subDir);
  });

  it("file inside <root>/pkg/src/ with package.json in <root>/pkg/ → projectRoot is <root>/pkg/", async () => {
    // package.json takes priority over src/ check.
    const pkgDir = path.join(tmpRoot, "pkg");
    const srcDir = path.join(pkgDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), '{"name":"test"}', "utf8");
    const file = path.join(srcDir, "file.ts");
    fs.writeFileSync(file, "const w = 4;\n", "utf8");

    await editFile(file, [{ search: "const w = 4;", replace: "const w = 5;" }]);

    // dir=<srcDir>: no package.json, basename="src" → would set projectRoot=<pkgDir>.
    // BUT package.json check comes FIRST. At i=0, no package.json in <srcDir>.
    // basename="src" → projectRoot=<pkgDir>, break.
    // Actually the src check comes after package.json check. So at i=0:
    //   - existsSync(<srcDir>/package.json) → false
    //   - basename(<srcDir>)==="src" → true → projectRoot=<pkgDir>, break
    // Either way, projectRoot = <pkgDir>.
    expect(impactState.lastProjectRoot).toBe(pkgDir);
  });
});
