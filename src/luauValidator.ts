/**
 * luauValidator.ts - Pre-write validation for .luau and .lua files.
 *
 * When the active mode has luauValidation rules enabled, this module intercepts
 * file writes BEFORE they hit disk and runs validation on the proposed content.
 *
 * If a blocking rule fails (e.g. selene finds errors), the write is REJECTED
 * and the error message is returned to the AI agent. The AI sees the error and
 * must fix the code before retrying.
 *
 * If a non-blocking rule fails (e.g. stylua format issues), the write proceeds
 * but the issue is logged as a warning.
 *
 * Flow:
 *   1. AI calls editar_arquivo (fileEdit.ts) on a .luau/.lua file
 *   2. fileEdit.ts calls validateLuauBeforeWrite(filePath, newContent)
 *   3. If returns {ok: false, blockingError}, fileEdit aborts with the error
 *   4. If returns {ok: true, warnings: [...]}, fileEdit proceeds (warnings logged)
 *
 * Validation tools used (if installed):
 *   - selene (linter) - blocking
 *   - stylua (formatter, --check mode) - non-blocking (auto-fix is separate)
 *   - luau-lsp (type checker, optional) - blocking
 *
 * Performance:
 *   - Writes to a temp file, runs tools on it, deletes temp file
 *   - If a tool is not installed, that rule is skipped (not failed)
 *   - Timeout: 10 seconds per tool call
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as log from "./logger.js";

export interface ValidationRule {
  tool: string;
  filePattern: string;
  blocking: boolean;
}

export interface ValidationResult {
  ok: boolean;
  blockingError?: string;
  warnings: string[];
  rulesApplied: string[];
  rulesSkipped: string[];
}

const TIMEOUT_MS = 10_000;

/** Match a glob pattern like "*.luau" or "*.lua" against a filename. */
function matchesPattern(filePath: string, pattern: string): boolean {
  const filename = path.basename(filePath);
  // Simple glob: only support "*" prefix patterns like "*.luau"
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".luau"
    return filename.endsWith(ext);
  }
  return filename === pattern;
}

/** Run a command synchronously with timeout. Returns {ok, stdout, stderr}. */
function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = TIMEOUT_MS
): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}

/** Check if a CLI binary is available on PATH. */
async function isToolInstalled(tool: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(cmd, [tool], process.cwd(), 3000);
  return result.ok;
}

/**
 * Validate a proposed Luau file write against the active mode's rules.
 *
 * @param filePath - Target file path (used to check pattern matching)
 * @param newContent - Proposed new content of the file
 * @param rules - Validation rules from the active mode (or empty array)
 * @param projectRoot - Project root for cwd context
 *
 * Returns ValidationResult. If ok=false, the write should be BLOCKED.
 */
export async function validateLuauBeforeWrite(
  filePath: string,
  newContent: string,
  rules: ValidationRule[],
  projectRoot: string
): Promise<ValidationResult> {
  const result: ValidationResult = {
    ok: true,
    warnings: [],
    rulesApplied: [],
    rulesSkipped: [],
  };

  if (rules.length === 0) {
    return result; // no rules = no validation
  }

  // Filter rules that match this file pattern
  const applicableRules = rules.filter((r) => matchesPattern(filePath, r.filePattern));
  if (applicableRules.length === 0) {
    return result; // no rules apply to this file type
  }

  // Check if auto-research is enabled (mode has autoResearch flag).
  // When true, selene false positives (unknown globals) include a hint
  // telling the AI to call pesquisar_api_atualizada before "fixing".
  let autoResearchEnabled = false;
  try {
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    autoResearchEnabled = !!mode?.autoResearch;
  } catch {
    // ignore - if modes module fails, default to false
  }

  // Write proposed content to a temp file for validation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-luau-"));
  const ext = path.extname(filePath) || ".luau";
  const tmpFile = path.join(tmpDir, `validation${ext}`);
  try {
    fs.writeFileSync(tmpFile, newContent, "utf8");

    for (const rule of applicableRules) {
      // Check if tool is installed
      const installed = await isToolInstalled(rule.tool);
      if (!installed) {
        result.rulesSkipped.push(`${rule.tool} (not installed)`);
        continue;
      }

      result.rulesApplied.push(rule.tool);

      let cmdResult: { ok: boolean; stdout: string; stderr: string; timedOut: boolean };

      switch (rule.tool) {
        case "selene_lint":
        case "selene": {
          // Selene returns non-zero on lint errors
          cmdResult = await runCommand("selene", ["--no-global-check", "--quiet", tmpFile], projectRoot);
          if (!cmdResult.ok && cmdResult.stdout.trim()) {
            // Check if this might be a false positive from a new Roblox API
            // that selene doesn't know about yet (selene's std lib lags behind Roblox updates)
            const seleneOutput = cmdResult.stdout.trim();
            const mightBeNewApi = /undefined (global|variable)|unknown global/i.test(seleneOutput);

            let errMsg = `Selene lint failed for ${path.basename(filePath)}:\n${seleneOutput}`;

            // If auto-research is enabled and this looks like an unknown global,
            // add a hint to the AI to research the API before assuming it's an error
            if (mightBeNewApi && autoResearchEnabled) {
              errMsg += `\n\n[HINT] Este erro pode ser um FALSO POSITIVO - selene pode não conhecer uma API nova do Roblox. Considere chamar pesquisar_api_atualizada({ nome: "<api_name>", linguagem: "roblox" }) para verificar se a API existe antes de "corrigir" o código.`;
            }

            if (rule.blocking) {
              result.ok = false;
              result.blockingError = errMsg;
              return result;
            } else {
              result.warnings.push(errMsg);
            }
          }
          break;
        }

        case "stylua_format":
        case "stylua": {
          // StyLua --check returns non-zero if file would be reformatted
          cmdResult = await runCommand("stylua", ["--check", tmpFile], projectRoot);
          if (!cmdResult.ok) {
            const errMsg = `StyLua format check failed for ${path.basename(filePath)} (run 'stylua ${path.basename(filePath)}' to fix)`;
            if (rule.blocking) {
              result.ok = false;
              result.blockingError = errMsg;
              return result;
            } else {
              result.warnings.push(errMsg);
            }
          }
          break;
        }

        case "luau_lsp":
        case "luau-lsp": {
          // luau-lsp has a CLI mode for type checking
          cmdResult = await runCommand("luau-lsp", ["check", tmpFile], projectRoot);
          if (!cmdResult.ok && cmdResult.stdout.trim()) {
            const errMsg = `luau-lsp type check failed for ${path.basename(filePath)}:\n${cmdResult.stdout.trim()}`;
            if (rule.blocking) {
              result.ok = false;
              result.blockingError = errMsg;
              return result;
            } else {
              result.warnings.push(errMsg);
            }
          }
          break;
        }

        default:
          result.rulesSkipped.push(`${rule.tool} (unknown tool)`);
      }
    }
  } catch (err) {
    log.warn(`luauValidator: error during validation: ${(err as Error).message}`);
    result.warnings.push(`Validator error: ${(err as Error).message}`);
  } finally {
    // Cleanup temp file
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return result;
}

/**
 * Get the validation rules for the currently active mode.
 * Returns empty array if no mode active, or mode has no luauValidation rules.
 *
 * This is the main entry point used by fileEdit.ts.
 */
export async function getActiveValidationRules(): Promise<ValidationRule[]> {
  try {
    // Lazy import to avoid circular dep
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    if (!mode || !mode.luauValidation) return [];
    return mode.luauValidation;
  } catch {
    return [];
  }
}

/**
 * Convenience wrapper: should this file path be validated?
 * Returns true if the path ends in .luau or .lua AND there are active rules.
 */
export async function shouldValidateFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== ".luau" && ext !== ".lua") return false;
  const rules = await getActiveValidationRules();
  return rules.some((r) => matchesPattern(filePath, r.filePattern));
}
