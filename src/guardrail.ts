/**
 * guardrail.ts — Post-write syntax validation for generated code.
 *
 * IMPORTANT: This module is now advisory-only.
 * - For TypeScript/JavaScript: runs validators AFTER the file has been written
 *   to disk, in the real project scope (no temp files).
 * - A failed validation does NOT prevent the file from being saved.
 *   The error log is captured and returned to the agent as context so it can
 *   decide autonomously whether to fix the code or treat the error as a false positive.
 *
 * Supported extensions:
 *   .ts  .tsx         → npx tsc --noEmit in the real project root
 *   .js  .mjs  .cjs   → node --check on a temp copy (no project context needed)
 *   .json             → JSON.parse()
 *   .py               → python -m py_compile on a temp copy
 *   .java             → javac on a temp copy
 *   .css  .html       → best-effort heuristic
 *   everything else   → passthrough (no check)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as log from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ValidationResult {
  /** true = no issues found; false = errors captured (file was already saved) */
  valid: boolean;
  /** Human-readable description of what failed (compiler stderr / parse error) */
  errorMessage?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a shell command synchronously and capture stdout+stderr.
 * Returns { ok, output } — never throws.
 */
function runCommand(
  command: string,
  cwd?: string
): { ok: boolean; output: string } {
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });
    return { ok: true, output: output ?? "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    return { ok: false, output };
  }
}

/**
 * Write content to a temporary file in the OS temp dir, returning its path.
 * Only used for languages that don't need project context (JS, Python, Java).
 * Caller is responsible for unlinking it afterwards.
 */
function writeTempFile(content: string, suffix: string): string {
  const tmpPath = path.join(
    os.tmpdir(),
    `claudekiller_${Date.now()}_${Math.random().toString(36).slice(2)}${suffix}`
  );
  fs.writeFileSync(tmpPath, content, "utf8");
  return tmpPath;
}

/**
 * Walk up from filePath looking for the nearest directory that contains
 * a tsconfig.json. Falls back to the file's own directory if none is found.
 */
function findProjectRoot(filePath: string): string {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(filePath));
}

// ─── Per-language Validators ─────────────────────────────────────────────────

/**
 * TypeScript — runs `npx tsc --noEmit` in the REAL project root.
 * The file must already be written to disk before this is called.
 * No temp files are created.
 */
function validateTs(filePath: string): ValidationResult {
  const projectRoot = findProjectRoot(filePath);
  const tscCmd = `npx --yes tsc --noEmit`;
  log.debug(`Running full-project TypeScript check in: ${projectRoot}`);
  const { ok, output } = runCommand(tscCmd, projectRoot);
  if (ok) return { valid: true };
  return {
    valid: false,
    errorMessage: `TypeScript compilation error (full project — ${projectRoot}):\n${output}`,
  };
}

/** JavaScript / CommonJS / ESM — uses Node.js built-in parser on a temp copy */
function validateJs(content: string): ValidationResult {
  const tmp = writeTempFile(content, ".mjs");
  try {
    const res = runCommand(`node --check "${tmp}"`);
    if (res.ok) return { valid: true };
    return {
      valid: false,
      errorMessage: `JavaScript syntax error:\n${res.output}`,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** JSON — uses native JSON.parse */
function validateJson(content: string): ValidationResult {
  try {
    JSON.parse(content);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      errorMessage: `JSON parse error: ${(err as Error).message}`,
    };
  }
}

/** Python — uses `python -m py_compile` on a temp copy (requires python in PATH) */
function validatePython(content: string): ValidationResult {
  const tmp = writeTempFile(content, ".py");
  try {
    const pythonBin = process.platform === "win32" ? "python" : "python3";
    const { ok, output } = runCommand(`${pythonBin} -m py_compile "${tmp}"`);
    if (ok) return { valid: true };
    return {
      valid: false,
      errorMessage: `Python syntax error:\n${output}`,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Java — uses `javac` on a temp copy (requires JDK in PATH) */
function validateJava(content: string): ValidationResult {
  const classMatch = /public\s+class\s+(\w+)/.exec(content);
  const className = classMatch ? classMatch[1] : "__ClaudeKillerCheck";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudekiller_java_"));
  const javaFile = path.join(tmpDir, `${className}.java`);
  try {
    fs.writeFileSync(javaFile, content, "utf8");
    const { ok, output } = runCommand(`javac "${javaFile}"`, tmpDir);
    if (ok) return { valid: true };
    return {
      valid: false,
      errorMessage: `Java compilation error:\n${output}`,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** HTML — heuristic tag-balance check */
function validateHtml(content: string): ValidationResult {
  const openCount = (content.match(/<[a-zA-Z][^/!][^>]*>/g) ?? []).length;
  const closeCount = (content.match(/<\/[a-zA-Z][^>]*>/g) ?? []).length;
  const delta = Math.abs(openCount - closeCount);
  if (delta > 5) {
    return {
      valid: false,
      errorMessage:
        `HTML structure warning: ${openCount} open tags vs ${closeCount} close tags ` +
        `(delta=${delta}). Possible unclosed or mismatched elements.`,
    };
  }
  return { valid: true };
}

/** CSS — heuristic brace-balance check */
function validateCss(content: string): ValidationResult {
  const open = (content.match(/\{/g) ?? []).length;
  const close = (content.match(/\}/g) ?? []).length;
  if (open !== close) {
    return {
      valid: false,
      errorMessage:
        `CSS brace mismatch: ${open} opening braces, ${close} closing braces.`,
    };
  }
  return { valid: true };
}

// ─── Public Validate Function ─────────────────────────────────────────────────

/**
 * Run the appropriate post-write validator for `filePath`.
 *
 * For TypeScript files the file MUST already be written to disk before calling
 * this function — validation runs `npx tsc --noEmit` over the real project.
 *
 * @param filePath  Path of the file that was just saved (used for extension + project root detection).
 * @param content   File content (used by validators that don't need project context).
 * @returns         ValidationResult — { valid, errorMessage? }
 */
export async function validateSyntax(
  filePath: string,
  content: string
): Promise<ValidationResult> {
  const ext = path.extname(filePath).toLowerCase();
  log.debug(`Post-write validation for extension: ${ext}`);

  switch (ext) {
    case ".ts":
    case ".tsx":
      return validateTs(filePath);

    case ".js":
    case ".mjs":
    case ".cjs":
      return validateJs(content);

    case ".json":
      return validateJson(content);

    case ".py":
      return validatePython(content);

    case ".java":
      return validateJava(content);

    case ".html":
    case ".htm":
      return validateHtml(content);

    case ".css":
    case ".scss":
    case ".less":
      return validateCss(content);

    default:
      log.debug(`No validator for extension "${ext}" — skipping syntax check.`);
      return { valid: true };
  }
}
