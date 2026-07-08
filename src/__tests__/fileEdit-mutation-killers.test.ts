/**
 * fileEdit-mutation-killers.test.ts — Targeted tests to kill survived
 * mutations in src/fileEdit.ts that are NOT covered by
 * fileEdit-mutation-checks.test.ts (which covers L97/L106/L115/L186).
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L181: `for (let i = 0; i < 4; i++)` → `i <= 4` (walks one extra level)
 *   - L192: `if (parent === dir) break` → `!==` (breaks immediately, never walks up)
 *   - L233: `if (!validation.ok && validation.blockingError)` → `&& → ||` or `! → remove`
 *   - L266: `if (fileExt === ".luau" || fileExt === ".lua")` → `=== → !==`
 *
 * FALSE POSITIVES (documented, NOT tested):
 *   - L249/L252: `.length > 0 → .length > 1` and `> → >=` on rulesApplied/
 *     rulesSkipped log messages. These are cosmetic log.success/log.debug
 *     calls that don't affect the write result.
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mock state (hoisted so factories can read it) ---------------------------
const honestyState = vi.hoisted(() => ({
  diffMatches: true, diffMessage: "",
  hallucinatedSymbols: [] as Array<{ name: string; line: number }>,
  hallucinationMessage: "",
}));
const importState = vi.hoisted(() => ({ ok: true, message: "" }));
const impactState = vi.hoisted(() => ({
  lastProjectRoot: null as string | null,
  lastResolved: null as string | null,
}));
const lockState = vi.hoisted(() => ({ acquired: true }));
const validationState = vi.hoisted(() => ({
  ok: true,
  blockingError: null as string | null,
  warnings: [] as string[],
  rulesApplied: [] as string[],
  rulesSkipped: [] as string[],
}));
const shouldValidateState = vi.hoisted(() => ({ shouldValidate: false }));
const safetyState = vi.hoisted(() => ({
  safetyReview: false,
  shouldReview: false,
  risk: "none" as "none" | "low" | "high",
  reviewedByLlm: false,
  patternsMatched: [] as string[],
  durationMs: 0,
  formatResult: "",
}));

// --- Mocks -------------------------------------------------------------------
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
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
    ok: importState.ok, message: importState.message, missingImports: [],
  })),
}));

vi.mock("../fileLock.js", () => ({
  acquireLock: vi.fn(async () => {
    if (lockState.acquired) return () => {};
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
  shouldValidateFile: vi.fn(async () => shouldValidateState.shouldValidate),
  validateLuauBeforeWrite: vi.fn(async () => ({
    ok: validationState.ok,
    blockingError: validationState.blockingError,
    warnings: validationState.warnings,
    rulesApplied: validationState.rulesApplied,
    rulesSkipped: validationState.rulesSkipped,
  })),
  getActiveValidationRules: vi.fn(async () => []),
}));

vi.mock("../modes.js", () => ({
  getActiveMode: vi.fn(() => ({
    name: "normal",
    safetyReview: safetyState.safetyReview,
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
  reviewCodeSafety: vi.fn(async () => ({
    risk: safetyState.risk,
    reviewedByLlm: safetyState.reviewedByLlm,
    patternsMatched: safetyState.patternsMatched,
    durationMs: safetyState.durationMs,
  })),
  formatSafetyReview: vi.fn(() => safetyState.formatResult),
  shouldReviewFile: vi.fn(() => safetyState.shouldReview),
}));

// --- Import AFTER mocks ------------------------------------------------------
import { editFile } from "../fileEdit.js";

// ─── L181: `i < 4` → `i <= 4` (project root walk) ────────────────────────────

describe("mutation-killers / fileEdit.ts — L181 project-root walk `i < 4 → i <= 4`", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-fe-loop-"));
    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;
    shouldValidateState.shouldValidate = false;
    safetyState.safetyReview = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Mutation: L181 `for (let i = 0; i < 4; i++)` → `i <= 4`
   *
   * The walk-up loop checks 4 levels (i=0..3) for package.json or src/.
   * With mutation `i <= 4`, it checks 5 levels (i=0..4) — one extra.
   *
   * Killing strategy: create a file 5 levels deep from tmpRoot, with
   * package.json at tmpRoot (level 5). Without mutation: loop ends at
   * i=3 (checks levels 0-3), doesn't find package.json → projectRoot
   * stays at dirname(file). With mutation: i=4 checks level 5 → finds
   * package.json at tmpRoot → projectRoot = tmpRoot.
   *
   * File: tmpRoot/a/b/c/d/file.ts (5 levels from tmpRoot)
   * package.json at: tmpRoot/package.json (checked at i=4)
   */
  it("project-root walk does NOT find package.json 5 levels up (kills `i < 4 → i <= 4` on L181)", async () => {
    // Create 5-level deep structure: tmpRoot/a/b/c/d/file.ts
    const deepDir = path.join(tmpRoot, "a", "b", "c", "d");
    fs.mkdirSync(deepDir, { recursive: true });
    const file = path.join(deepDir, "file.ts");
    fs.writeFileSync(file, "const x = 1;\n", "utf8");

    // package.json at tmpRoot (5 levels up from file's dirname)
    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"name":"root"}', "utf8");

    await editFile(file, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Without mutation: i < 4 → checks levels 0-3 (d, c, b, a) → no
    //   package.json there → projectRoot stays at dirname(file) = deepDir.
    // With mutation `i <= 4`: i=4 checks tmpRoot → finds package.json →
    //   projectRoot = tmpRoot. Test fails. ✓ KILLED.
    expect(impactState.lastProjectRoot).toBe(deepDir);
  });
});

// ─── L192: `parent === dir` → `parent !== dir` (root termination) ────────────

describe("mutation-killers / fileEdit.ts — L192 root-termination `=== → !==`", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-fe-root-"));
    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;
    shouldValidateState.shouldValidate = false;
    safetyState.safetyReview = false;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /**
   * Mutation: L192 `if (parent === dir) break` → `if (parent !== dir) break`
   *
   * The root-termination check: if parent === dir (at filesystem root),
   * stop walking. With mutation `!==`: breaks whenever parent is NOT dir
   * — which is almost always (except at root). So the loop breaks after
   * the FIRST iteration, never walking up to find package.json.
   *
   * Killing strategy: file at tmpRoot/sub/file.ts, package.json at
   * tmpRoot/. Without mutation: i=0 checks sub/ (no pkg), walks up;
   * i=1 checks tmpRoot/ → finds package.json → projectRoot=tmpRoot.
   * With mutation: i=0 checks sub/ (no pkg, no src), parent=tmpRoot ≠
   * sub → break immediately. projectRoot stays at dirname(file)=sub.
   * Test asserts projectRoot=tmpRoot → fails. ✓ KILLED.
   */
  it("project-root walk finds package.json 2 levels up (kills `=== → !==` on L192)", async () => {
    const subDir = path.join(tmpRoot, "sub");
    fs.mkdirSync(subDir, { recursive: true });
    const file = path.join(subDir, "file.ts");
    fs.writeFileSync(file, "const y = 2;\n", "utf8");

    // package.json at tmpRoot (2 levels up from file)
    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"name":"root"}', "utf8");

    await editFile(file, [{ search: "const y = 2;", replace: "const y = 3;" }]);

    // Without mutation: walks up from sub → tmpRoot → finds package.json.
    //   projectRoot = tmpRoot.
    // With mutation `parent !== dir`: breaks after first iteration
    //   (parent ≠ dir) → projectRoot stays at sub. Test fails. ✓ KILLED.
    expect(impactState.lastProjectRoot).toBe(tmpRoot);
  });
});

// ─── L233: `!validation.ok && validation.blockingError` mutations ────────────

describe("mutation-killers / fileEdit.ts — L233 validation blocking condition", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-fe-val-"));
    testFile = path.join(tmpDir, "test.luau");
    fs.writeFileSync(testFile, "local x = 1\n", "utf8");

    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;
    safetyState.safetyReview = false;

    // Enable validation for this test
    shouldValidateState.shouldValidate = true;
    validationState.ok = true;
    validationState.blockingError = null;
    validationState.warnings = [];
    validationState.rulesApplied = [];
    validationState.rulesSkipped = [];

    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Mutation: L233 `if (!validation.ok && validation.blockingError)`
   *           mutation: `! → (remove negation)` → `if (validation.ok && validation.blockingError)`
   *
   * Effect: with mutation, blocks when validation SUCCEEDS (ok=true) AND
   * has a blockingError. Inverted logic.
   *
   * Killing strategy: mock validator to return ok=true, blockingError="some
   * error". Without mutation: `!true && "some error"` → false → doesn't
   * block → write succeeds. With mutation: `true && "some error"` → true
   * → blocks → returns error. Test asserts success → fails. ✓ KILLED.
   */
  it("validation ok=true with blockingError does NOT block (kills `! → remove` on L233)", async () => {
    validationState.ok = true;
    validationState.blockingError = "some error message";

    const result = await editFile(testFile, [{ search: "local x = 1", replace: "local x = 2" }]);

    // Without mutation: !true && "some error" → false → write proceeds.
    // With mutation `! → remove`: true && "some error" → true → write blocked.
    expect(result).not.toContain("[ERROR]");
    expect(result).toContain("1");
  });

  /**
   * Mutation: L233 `if (!validation.ok && validation.blockingError)`
   *           mutation: `&& → ||` → `if (!validation.ok || validation.blockingError)`
   *
   * Effect: with mutation, blocks if EITHER !ok OR blockingError. So
   * ok=false with no blockingError would block (original doesn't).
   *
   * Killing strategy: mock validator to return ok=false, blockingError=null.
   * Without mutation: `!false && null` → `true && falsy` → false → doesn't
   * block. With mutation: `!false || null` → `true || falsy` → true → blocks.
   * Test asserts success → fails. ✓ KILLED.
   */
  it("validation ok=false with no blockingError does NOT block (kills `&& → ||` on L233)", async () => {
    validationState.ok = false;
    validationState.blockingError = null;

    const result = await editFile(testFile, [{ search: "local x = 1", replace: "local x = 2" }]);

    // Without mutation: !false && null → true && null(falsy) → false → proceeds.
    // With mutation `&& → ||`: !false || null → true || null → true → blocks.
    expect(result).not.toContain("[ERROR]");
  });
});

// ─── L266: `fileExt === ".luau"` → `!==` (safety review gating) ──────────────

describe("mutation-killers / fileEdit.ts — L266 safety-review file-ext gating", () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-fe-ext-"));
    testFile = path.join(tmpDir, "test.ts");
    fs.writeFileSync(testFile, "const x = 1;\n", "utf8");

    impactState.lastProjectRoot = null;
    impactState.lastResolved = null;
    lockState.acquired = true;
    shouldValidateState.shouldValidate = false;

    // Enable safety review
    safetyState.safetyReview = true;
    safetyState.shouldReview = true;
    safetyState.risk = "none";
    safetyState.reviewedByLlm = false;
    safetyState.patternsMatched = [];
    safetyState.durationMs = 0;
    safetyState.formatResult = "";

    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Mutation: L266 `if (fileExt === ".luau" || fileExt === ".lua")`
   *           mutation: `===` → `!==` on first `===`
   *
   * Effect: `fileExt !== ".luau" || fileExt === ".lua"`. For a .ts file:
   *   `".ts" !== ".luau"` → true → safety review runs (shouldn't for .ts).
   * For a .luau file: `".luau" !== ".luau"` → false → safety review skipped.
   *
   * Killing strategy: edit a .ts file with safetyReview=true and
   * shouldReview=true. Without mutation: fileExt=".ts" → outer check fails
   * → safety review skipped → write succeeds. With mutation: outer check
   * passes → shouldReview=true → reviewCodeSafety runs → risk="none" →
   * write still succeeds. Hmm, need risk="high" to block.
   *
   * Better: set risk="high". Without mutation: .ts → skip review → write
   * succeeds. With mutation: .ts → review runs → risk=high → write blocked.
   * Test asserts success → fails. ✓ KILLED.
   */
  it("safety review does NOT run on .ts files (kills `=== → !==` on L266)", async () => {
    // Set risk=high so that IF the review runs, it blocks
    safetyState.risk = "high";
    safetyState.formatResult = "High risk detected";

    const result = await editFile(testFile, [{ search: "const x = 1;", replace: "const x = 2;" }]);

    // Without mutation: fileExt=".ts" → ".ts" === ".luau" is false →
    //   ".ts" === ".lua" is false → skip safety review → write succeeds.
    // With mutation `=== → !==`: ".ts" !== ".luau" is true → enters block
    //   → shouldReview=true → reviewCodeSafety → risk=high → write blocked.
    expect(result).not.toContain("[ERROR]");
    expect(result).not.toContain("Revisor de segurança");
  });
});
