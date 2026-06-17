/**
 * tddMode.ts - Test-Driven Development enforcement.
 *
 * Forces the AI to write tests BEFORE implementing the feature.
 * The tests become the oracle - the implementation must make them pass.
 *
 * Flow:
 *   1. User requests feature
 *   2. AI calls criar_tdd({ testFile, testCases }) to write tests first
 *   3. Tests are saved to disk
 *   4. AI implements the feature
 *   5. Before finish_reason, tests are run to verify they pass
 *   6. If tests fail, AI must fix the implementation (not the tests)
 *
 * Only activates for languages/frameworks that support automated testing:
 *   - TypeScript: vitest, jest
 *   - Python: pytest
 *   - Rust: cargo test
 *   - Go: go test
 *   - Luau: TestEZ (via lune or run-in-roblox)
 *
 * NOT activated for: config files, scripts, one-off utilities
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface TDDSpec {
  testFile: string;
  testCases: string[];
  implFile: string;
  language: string;
  createdAt: number;
}

// --- State ------------------------------------------------------------------

let currentTDD: TDDSpec | null = null;

// --- Testable languages -----------------------------------------------------

const TESTABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".py", ".rs", ".go", ".luau", ".lua"]);

/**
 * Check if a file extension is testable.
 */
export function isTestable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TESTABLE_EXTENSIONS.has(ext);
}

// --- Public API -------------------------------------------------------------

/**
 * Register a TDD spec. Called by the AI via criar_tdd tool.
 * The AI writes the test file to disk, then calls this to register it.
 */
export function registerTDD(testFile: string, implFile: string, language: string, testCases: string[]): TDDSpec {
  currentTDD = {
    testFile,
    implFile,
    language,
    testCases,
    createdAt: Date.now(),
  };
  log.info(`[TDD] Registered: ${testFile} for ${implFile} (${testCases.length} test cases)`);
  return currentTDD;
}

/**
 * Get the current TDD spec (or null).
 */
export function getTDD(): TDDSpec | null {
  return currentTDD;
}

/**
 * Check if TDD is active for the current task.
 */
export function hasTDD(): boolean {
  return currentTDD !== null;
}

/**
 * Check if the test file exists on disk.
 */
export function testFileExists(): boolean {
  if (!currentTDD) return false;
  return fs.existsSync(currentTDD.testFile);
}

/**
 * Clear the current TDD spec (for new task or /reset).
 */
export function clearTDD(): void {
  currentTDD = null;
}

/**
 * Format the TDD spec as a readable string for the AI.
 */
export function formatTDD(): string {
  if (!currentTDD) return "";

  const lines: string[] = [`[TDD ACTIVE]`];
  lines.push(`Test file: ${currentTDD.testFile}`);
  lines.push(`Implementation file: ${currentTDD.implFile}`);
  lines.push(`Language: ${currentTDD.language}`);

  if (currentTDD.testCases.length > 0) {
    lines.push(`Test cases that MUST pass:`);
    currentTDD.testCases.forEach((tc, i) => lines.push(`  ${i + 1}. ${tc}`));
  }

  lines.push(`\nImplementation must make ALL tests pass. Do NOT modify the tests.`);
  return lines.join("\n");
}

/**
 * Generate a test file path from an implementation file path.
 * Example: src/InventoryService.luau -> src/__tests__/InventoryService.spec.luau
 */
export function getTestFilePath(implFile: string): string {
  const dir = path.dirname(implFile);
  const ext = path.extname(implFile);
  const base = path.basename(implFile, ext);

  // Convention: __tests__/<name>.spec.<ext>
  return path.join(dir, "__tests__", `${base}.spec${ext}`);
}
