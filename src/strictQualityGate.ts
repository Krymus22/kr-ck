/**
 * strictQualityGate.ts - Deterministic post-write quality gate.
 *
 * When STRICT_MODE is enabled (default: true), every time the agent
 * is about to finish a turn (finish_reason === "stop"), the gate
 * runs `tsc --noEmit` and the project's lint command over the project.
 *
 * If either fails, the gate BLOCKS the finish and injects a synthetic
 * tool-call-style system message with the errors, forcing the model
 * to fix them. Up to MAX_CONSECUTIVE_BLOCKS (8) consecutive blocks
 * are allowed; after that the gate gives up and lets the turn finish.
 *
 * This mirrors the behavior Anthropic uses internally to ensure code
 * quality: validation is mandatory, not advisory.
 *
 * Config (env vars):
 *   STRICT_MODE=true|false         (default: true)
 *   STRICT_GATE_TSC=true|false     (default: true - run tsc --noEmit)
 *   STRICT_GATE_LINT=true|false    (default: true - run npm run lint)
 *   STRICT_GATE_MAX_BLOCKS=N       (default: 8)
 *   STRICT_GATE_SKIP_PATTERNS=     (comma-separated path globs to skip)
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";
import { parseErrors, formatStructuredErrors } from "./selfHealing.js";
import { pushActivity } from "./activityTracker.js";

// --- Config ------------------------------------------------------------------

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface QualityGateConfig {
  strictMode: boolean;
  runTsc: boolean;
  runLint: boolean;
  maxBlocks: number;
  skipPatterns: string[];
}

export function getQualityGateConfig(): QualityGateConfig {
  const skipRaw = process.env.STRICT_GATE_SKIP_PATTERNS ?? "";
  return {
    strictMode: envBool("STRICT_MODE", true),
    runTsc: envBool("STRICT_GATE_TSC", true),
    runLint: envBool("STRICT_GATE_LINT", true),
    maxBlocks: envInt("STRICT_GATE_MAX_BLOCKS", 8),
    skipPatterns: skipRaw ? skipRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
  };
}

// --- State -------------------------------------------------------------------

let consecutiveBlocks = 0;
let totalBlocks = 0;
let lastErrorLog = "";

export function resetGateState(): void {
  consecutiveBlocks = 0;
  totalBlocks = 0;
  lastErrorLog = "";
}

export function getGateState(): { consecutiveBlocks: number; totalBlocks: number; lastErrorLog: string } {
  return { consecutiveBlocks, totalBlocks, lastErrorLog };
}

// --- Helpers -----------------------------------------------------------------

/**
 * Find the project root by looking for package.json or default.project.json
 * in the CURRENT directory only (not walking up — that would find the
 * claude-killer's own package.json when working on Roblox projects).
 *
 * If neither exists, returns cwd (Roblox/Luau project without package.json).
 * This prevents the strict gate from running tsc/ESLint on the claude-killer
 * framework itself when the user is working on a different project.
 */
function findProjectRoot(): string {
  const cwd = process.cwd();
  // If cwd has package.json → TypeScript/Node project
  if (fs.existsSync(path.join(cwd, "package.json"))) return cwd;
  // If cwd has default.project.json → Roblox/Rojo project (NOT TypeScript)
  if (fs.existsSync(path.join(cwd, "default.project.json"))) return cwd;
  // If cwd has tsconfig.json → TypeScript project without package.json
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) return cwd;
  // Fallback: return cwd (could be any project type)
  return cwd;
}

/**
 * Run a command asynchronously and return its combined stdout+stderr + exit code.
 * Timeout: 60s. Never throws.
 */
function runCommandAsync(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 60_000
): Promise<{ ok: boolean; output: string; exitCode: number }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        shell: true,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, output: `Failed to spawn ${command}: ${(err as Error).message}`, exitCode: -1 });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch (err) { log.debug(`[STRICT_GATE] kill failed: ${(err as Error).message}`); }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Spawn error: ${err.message}`, exitCode: -1 });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (killed) {
        resolve({ ok: false, output: `[TIMEOUT after ${timeoutMs}ms]\n${combined}`, exitCode: -1 });
        return;
      }
      resolve({ ok: code === 0, output: combined, exitCode: code ?? -1 });
    });
  });
}

/** Check if a path matches any of the skip patterns (simple glob-style). */
function shouldSkip(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/");
  for (const pat of patterns) {
    const regex = new RegExp("^" + pat.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (regex.test(normalized)) return true;
  }
  return false;
}

// --- Public Gate API ---------------------------------------------------------

export interface GateResult {
  /** true = task may finish; false = must inject errors and continue */
  allowed: boolean;
  /** Error log to inject into history if blocked */
  errorLog?: string;
  /** Number of consecutive blocks so far */
  consecutiveBlocks: number;
  /** Reason for the gate decision */
  reason: string;
}

/**
 * Run the quality gate. Should be called when finish_reason === "stop"
 * and STRICT_MODE is on.
 *
 * @param filesTouched  Paths the agent touched in this turn (for skip-pattern checks)
 */
export async function runQualityGate(filesTouched: string[] = []): Promise<GateResult> {
  const cfg = getQualityGateConfig();

  const skipReason = shouldSkipGate(cfg, filesTouched);
  if (skipReason) return skipReason;

  // Surface quality gate activity in the TUI so the user sees why the agent
  // appears to be "doing nothing" between sending a message and getting a
  // reply. tsc + lint can take 5-30s on a large project.
  const checks: string[] = [];
  if (cfg.runTsc) checks.push("tsc");
  if (cfg.runLint) checks.push("lint");
  const done = pushActivity("quality_gate", checks.join(" + "));

  try {
    const errors = await collectValidatorErrors(cfg);
    if (errors.length === 0) return passGate();
    return blockGate(cfg, errors);
  } finally {
    done();
  }
}

/** Returns a "skip" GateResult if the gate should not run, otherwise null. */
function shouldSkipGate(cfg: QualityGateConfig, filesTouched: string[]): GateResult | null {
  if (!cfg.strictMode) {
    return { allowed: true, reason: "STRICT_MODE disabled", consecutiveBlocks };
  }
  if (filesTouched.length === 0) {
    return { allowed: true, reason: "no files touched this turn", consecutiveBlocks };
  }
  if (filesTouched.every((f) => shouldSkip(f, cfg.skipPatterns))) {
    return { allowed: true, reason: "all touched files match skip patterns", consecutiveBlocks };
  }
  if (consecutiveBlocks >= cfg.maxBlocks) {
    log.warn(`[STRICT_GATE] Max consecutive blocks (${cfg.maxBlocks}) reached - giving up.`);
    return {
      allowed: true,
      reason: `max consecutive blocks (${cfg.maxBlocks}) reached - letting turn finish`,
      consecutiveBlocks,
    };
  }
  return null;
}

/** Run tsc + lint + rojo build (roblox) and return any errors collected. */
async function collectValidatorErrors(cfg: QualityGateConfig): Promise<string[]> {
  const projectRoot = findProjectRoot();
  const errors: string[] = [];
  errors.push(...(await runTscCheck(cfg, projectRoot)));
  errors.push(...(await runLintCheck(cfg, projectRoot)));
  errors.push(...(await runRojoBuildCheck(cfg, projectRoot)));
  return errors;
}

/**
 * ROJO BUILD GATE: If the project has a default.project.json (Roblox project),
 * run `rojo build` to verify it compiles. Blocks finish if the build fails.
 * This catches Luau syntax errors, missing modules, and invalid project structure.
 */
async function runRojoBuildCheck(cfg: QualityGateConfig, projectRoot: string): Promise<string[]> {
  // Only run if there's a Roblox project file
  const projectFile = path.join(projectRoot, "default.project.json");
  if (!fs.existsSync(projectFile)) return [];

  // Check if rojo binary is available
  try {
    const { execSync } = require("node:child_process");
    execSync("which rojo 2>/dev/null || where rojo 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // rojo not found — warn but don't block (can't verify build without it)
    log.warn("[STRICT_GATE] Rojo build gate skipped — 'rojo' binary not found. Install rojo to enable build verification.");
    return [];
  }

  log.debug(`[STRICT_GATE] Running rojo build in ${projectRoot}`);
  const buildResult = await runCommandAsync("rojo", ["build", "--output", "/tmp/rojo-build-test.rbxlx", projectFile], projectRoot, 60_000);
  if (!buildResult.ok) {
    return [`=== Rojo build errors ===\nThe Roblox project failed to build. This means there are syntax errors, missing modules, or invalid project structure.\n${buildResult.output}\nFix these errors before finishing.`];
  }

  // Clean up the test build file
  try { fs.unlinkSync("/tmp/rojo-build-test.rbxlx"); } catch { /* ignore */ }
  return [];
}

async function runTscCheck(cfg: QualityGateConfig, projectRoot: string): Promise<string[]> {
  if (!cfg.runTsc || !fs.existsSync(path.join(projectRoot, "tsconfig.json"))) return [];
  log.debug(`[STRICT_GATE] Running tsc --noEmit in ${projectRoot}`);
  const tscResult = await runCommandAsync("npx", ["--yes", "tsc", "--noEmit"], projectRoot, 60_000);
  if (!tscResult.ok) return [`=== TypeScript errors (tsc --noEmit) ===\n${tscResult.output}`];
  return [];
}

async function runLintCheck(cfg: QualityGateConfig, projectRoot: string): Promise<string[]> {
  if (!cfg.runLint || !fs.existsSync(path.join(projectRoot, "package.json"))) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
    if (!pkg.scripts || typeof pkg.scripts.lint !== "string") return [];
    log.debug(`[STRICT_GATE] Running npm run lint in ${projectRoot}`);
    const lintResult = await runCommandAsync("npm", ["run", "lint"], projectRoot, 60_000);
    if (!lintResult.ok) return [`=== Lint errors (npm run lint) ===\n${lintResult.output}`];
    return [];
  } catch (err) {
    log.debug(`[STRICT_GATE] Skipping lint - package.json unreadable: ${(err as Error).message}`);
    return [];
  }
}

function passGate(): GateResult {
  if (consecutiveBlocks > 0) {
    log.success(`[STRICT_GATE] All checks passed - counter reset (was ${consecutiveBlocks}).`);
  }
  consecutiveBlocks = 0;
  return { allowed: true, reason: "all checks passed", consecutiveBlocks };
}

function blockGate(cfg: QualityGateConfig, errors: string[]): GateResult {
  consecutiveBlocks++;
  totalBlocks++;

  // IDEIA 20: Self-healing - parse raw errors into structured format
  // before injecting into context. Structured errors are easier for the
  // model to act on than raw text walls.
  let structuredErrors = "";
  try {
    // parseErrors and formatStructuredErrors imported at top of file
    const allParsed: any[] = [];
    for (const rawError of errors) {
      const parsed = parseErrors(rawError);
      if (parsed.length > 0) allParsed.push(...parsed);
    }
    if (allParsed.length > 0) {
      structuredErrors = formatStructuredErrors(allParsed);
    }
  } catch {
    // selfHealing module not available - use raw errors
  }

  const errorContent = structuredErrors || errors.join("\n\n");
  const errorLog = errorContent;
  lastErrorLog = errorLog;

  const msg =
    `[STRICT_GATE BLOCK ${consecutiveBlocks}/${cfg.maxBlocks}] A tarefa NÃO pode terminar ainda.\n` +
    `Os validadores determinísticos encontraram erros. Corrija TODOS os erros abaixo e continue trabalhando.\n` +
    `Não responda ao usuário até que tsc e lint passem sem erros.\n\n` +
    `${errorLog}\n\n` +
    `PRÓXIMOS PASSOS:\n` +
    `1. Leia cada arquivo mencionado nos erros.\n` +
    `2. Use aplicar_diff for corrigir cada erro.\n` +
    `3. Rode executar_comando("npx tsc --noEmit") for confirmar.\n` +
    `4. Se um erro for falso positivo (ex.: dependência faltando), explique brevemente no final da resposta.`;

  log.warn(`[STRICT_GATE] Blocked turn ${consecutiveBlocks}/${cfg.maxBlocks} - ${errors.length} validator(s) failed`);
  return {
    allowed: false,
    errorLog: msg,
    consecutiveBlocks,
    reason: `${errors.length} validator(s) failed`,
  };
}

/**
 * Convenience helper to check whether the gate is enabled at all.
 */
export function isStrictModeEnabled(): boolean {
  return getQualityGateConfig().strictMode;
}
