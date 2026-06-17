/**
 * modeExtensions.ts - Bridges active mode configuration with the safety/research/
 * validation/impact modules. Allows modes to extend built-in behavior without
 * modifying source code.
 *
 * Functions here read the active mode's custom patterns/sources and merge them
 * with the built-in defaults. This is what makes Claude-Killer fully
 * user-extensible: a user can create a mode that adds safety patterns for
 * their specific stack, trusted research sources, custom validators, etc.
 *
 * Used by:
 *   - safetyReviewer.ts: getActiveSafetyPatterns()
 *   - apiResearcher.ts: getActiveResearchSources()
 *   - impactAnalyzer.ts: getActiveSymbolPatterns()
 *   - luauValidator.ts: getActiveValidationRules() (already exists, kept for compat)
 *   - fileEdit.ts: getActivePostEditHooks() / runPostEditHooks()
 *   - gitTool.ts (future): getActivePreCommitHooks()
 */

import type {
  ModeDefinition,
  ModeSafetyPattern,
  ModeSymbolPattern,
  ModeHook,
  ModeValidationRule,
} from "./modes.js";
import * as log from "./logger.js";

// --- Active mode helper ----------------------------------------------------

/**
 * Get the active mode (lazy import to avoid circular deps).
 * Returns null if no mode is active or modes module fails.
 */
async function getActiveMode(): Promise<ModeDefinition | null> {
  try {
    const { getActiveMode: getActive } = await import("./modes.js");
    return getActive();
  } catch {
    return null;
  }
}

// --- Safety patterns -------------------------------------------------------

/**
 * Get the merged safety patterns for the active mode.
 *
 * Returns the built-in DANGEROUS_PATTERNS (from safetyReviewer.ts) PLUS any
 * custom patterns defined in the active mode's `safetyPatterns` field.
 *
 * This is used by safetyReviewer.ts to scan proposed code.
 */
export async function getActiveSafetyPatterns(): Promise<Array<{ regex: RegExp; description: string; severity: "low" | "medium" | "high" }>> {
  // Lazy import to avoid circular dep
  const { getDangerousPatterns } = await import("./safetyReviewer.js");
  const builtIn = getDangerousPatterns().map((p) => ({
    regex: p.regex,
    description: p.description,
    severity: p.severity,
  }));

  const mode = await getActiveMode();
  if (!mode?.safetyPatterns || mode.safetyPatterns.length === 0) {
    return builtIn;
  }

  // Merge: built-in + mode-specific
  const custom = mode.safetyPatterns.map((p: ModeSafetyPattern) => {
    try {
      return {
        regex: new RegExp(p.regex, "gi"),
        description: p.description,
        severity: p.severity,
      };
    } catch (err) {
      log.warn(`modeExtensions: invalid regex in safetyPatterns: "${p.regex}" - ${(err as Error).message}`);
      return null;
    }
  }).filter((p): p is { regex: RegExp; description: string; severity: "low" | "medium" | "high" } => p !== null);

  log.debug(`modeExtensions: merged ${builtIn.length} built-in + ${custom.length} custom safety patterns`);
  return [...builtIn, ...custom];
}

// --- Research sources ------------------------------------------------------

/**
 * Get the merged research sources for the active mode.
 *
 * Returns the built-in TRUSTED_SOURCES (from apiResearcher.ts) PLUS any custom
 * sources defined in the active mode's `researchSources` field.
 *
 * Used by apiResearcher.ts to pick the best source for a given language.
 */
export async function getActiveResearchSources(): Promise<Record<string, string[]>> {
  // Built-in sources are private to apiResearcher.ts, but we expose a getter.
  // For now, we return an empty record if no mode customizes; the researcher
  // module already has its own built-in list it uses as fallback.
  const mode = await getActiveMode();
  if (!mode?.researchSources) {
    return {};
  }
  return mode.researchSources;
}

// --- Symbol patterns -------------------------------------------------------

/**
 * Get custom symbol patterns for the active mode.
 *
 * These are MERGED with the built-in EXTENSIONS_BY_LANG and symbol extraction
 * patterns in impactAnalyzer.ts. Lets mode authors add support for new
 * languages (HCL, Elixir, Kotlin, etc) without modifying source code.
 *
 * Returns empty array if mode has no custom symbol patterns.
 */
export async function getActiveSymbolPatterns(): Promise<ModeSymbolPattern[]> {
  const mode = await getActiveMode();
  return mode?.symbolPatterns ?? [];
}

// --- Validation rules ------------------------------------------------------

/**
 * Get merged validation rules for the active mode.
 *
 * Combines:
 *   - mode.luauValidation (legacy field, kept for roblox.json compat)
 *   - mode.validation (new generic field)
 *
 * Both are arrays of ModeValidationRule. If both are set, they're concatenated.
 * If only one is set, that one is returned.
 *
 * Used by luauValidator.ts (which we should rename to fileValidator.ts eventually)
 * to determine which validation rules to apply before a file write.
 */
export async function getActiveValidationRules(): Promise<ModeValidationRule[]> {
  const mode = await getActiveMode();
  if (!mode) return [];

  const rules: ModeValidationRule[] = [];
  if (mode.luauValidation && mode.luauValidation.length > 0) {
    rules.push(...mode.luauValidation);
  }
  if (mode.validation && mode.validation.length > 0) {
    rules.push(...mode.validation);
  }
  return rules;
}

// --- Hooks -----------------------------------------------------------------

/**
 * Get post-edit hooks for the active mode.
 *
 * These run after editar_arquivo writes a file. Typical use: auto-format
 * the file that was just written (e.g. `terraform fmt {file}`, `black {file}`).
 *
 * Returns empty array if mode has no post-edit hooks.
 */
export async function getActivePostEditHooks(): Promise<ModeHook[]> {
  const mode = await getActiveMode();
  return mode?.hooks?.postEdit ?? [];
}

/**
 * Get pre-commit hooks for the active mode.
 *
 * These run before git commit. Typical use: lint, test, type-check.
 * Returns empty array if mode has no pre-commit hooks.
 */
export async function getActivePreCommitHooks(): Promise<ModeHook[]> {
  const mode = await getActiveMode();
  return mode?.hooks?.preCommit ?? [];
}

/**
 * Match a file path against a glob pattern.
 * Simple implementation: only supports "*." prefix patterns (e.g. "*.tf", "*.py").
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  const filename = filePath.split("/").pop() ?? filePath;
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".tf"
    return filename.endsWith(ext);
  }
  return filename === pattern;
}

/**
 * Run a hook command on a file.
 *
 * Replaces {file} in the command with the file path, then runs it via spawn.
 * Returns { ok, stdout, stderr }.
 *
 * @param hook The hook definition
 * @param filePath The file to run the hook on
 */
export async function runHook(
  hook: ModeHook,
  filePath: string
): Promise<{ ok: boolean; stdout: string; stderr: string; command: string }> {
  // Replace {file} placeholder with actual file path (quoted for safety)
  const safePath = `"${filePath}"`;
  const command = hook.command.replace(/\{file\}/g, safePath);

  // Parse command into program + args (simple split on spaces)
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { ok: false, stdout: "", stderr: "Empty command", command };
  }

  const program = parts[0]!;
  const args = parts.slice(1);

  // Use dynamic import to avoid circular dep with fileLock/safetyReviewer
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, command });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, command });
    });
  });
}

/**
 * Run all matching post-edit hooks for a file.
 *
 * Called by fileEdit.ts after a successful write. Iterates through the active
 * mode's postEdit hooks, runs those whose filePattern matches, and collects
 * results. Non-blocking hooks log warnings but don't fail. Blocking hooks
 * return an error message that becomes part of the tool result.
 *
 * @returns string with hook results (empty if no hooks ran)
 */
export async function runPostEditHooks(filePath: string): Promise<string> {
  const hooks = await getActivePostEditHooks();
  if (hooks.length === 0) return "";

  const matching = hooks.filter((h) => matchesPattern(filePath, h.filePattern));
  if (matching.length === 0) return "";

  const results: string[] = [];
  for (const hook of matching) {
    log.info(`[HOOK:postEdit] Running: ${hook.command} on ${filePath}`);
    const result = await runHook(hook, filePath);
    if (result.ok) {
      results.push(`[HOOK OK] ${hook.command}: ${result.stdout.slice(0, 200).trim() || "(no output)"}`);
    } else {
      const msg = `[HOOK ${hook.blocking ? "BLOCK" : "WARN"}] ${hook.command} failed: ${result.stderr.slice(0, 200).trim()}`;
      if (hook.blocking) {
        results.push(msg);
      } else {
        log.warn(msg);
        results.push(msg);
      }
    }
  }
  return results.join("\n");
}
