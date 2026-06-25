/**
 * fileValidator.ts — Generic pre-write validation for ANY file type.
 *
 * REPLACES luauValidator.ts (kept as a thin compat shim that re-exports).
 *
 * Sprint A refatoração (Sistema de Modos v2):
 *   - Não tem mais `switch` hardcoded por nome de tool.
 *   - Usa findToolBinary() (mode-aware) em vez de detectTool() (não mode-aware).
 *   - Suporta 3 modos de invocação (em ordem de prioridade):
 *       1. rule.command (string estilo "selene --quiet {file}")
 *       2. rule.toolName + manifest.validatorCommand (args estruturados)
 *       3. rule.toolName sozinho (binary path + "{file}" como único arg)
 *   - Checa stdout || stderr (não só stdout) for erros.
 *   - Não assume flags específicas de selene (ex: --no-global-check).
 *
 * Fluxo:
 *   1. AI chama editar_arquivo (fileEdit.ts) num arquivo
 *   2. fileEdit.ts chama validateFile(filePath, newContent, rules, projectRoot, modeName)
 *   3. Se retornar {ok: false, blockingError}, fileEdit aborta com o erro
 *   4. Se retornar {ok: true, warnings: [...]}, fileEdit prossegue (warnings logados)
 *
 * Performance:
 *   - Escreve num temp file, roda as tools nele, deleta o temp file
 *   - Se a tool não está instalada, a regra é pulada (não falha)
 *   - Timeout: 10 segundos por tool call
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface ValidationRule {
  /** Nome da tool (ex: "selene_lint", "ruff_lint", "terraform_validate"). */
  tool: string;
  /** Glob pattern (ex: "*.luau", "*.py", "*.tf"). Suporta "*" prefix. */
  filePattern: string;
  /** Se true, falha bloqueia o write. Se false, vira warning. */
  blocking: boolean;
  /**
   * Comando customizado estilo shell (ex: "ruff check --quiet {file}").
   * {file} é substituído pelo path do temp file. Se setado, TEM PRIORIDADE
   * sobre manifest.validatorCommand e sobre a invocação default.
   *
   * Permite validar QUALQUER linguagem sem precisar de manifest.
   */
  command?: string;
}

export interface ValidationResult {
  ok: boolean;
  blockingError?: string;
  warnings: string[];
  rulesApplied: string[];
  rulesSkipped: string[];
}

const TIMEOUT_MS = 10_000;

// --- Pattern matching -------------------------------------------------------

/**
 * Match a glob pattern against a filename.
 * Supports:
 *   - "*.ext" (most common)
 *   - "name.ext" (exact)
 *   - "*" (matches all)
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  const filename = path.basename(filePath);
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".luau"
    return filename.endsWith(ext);
  }
  return filename === pattern;
}

// --- Command execution ------------------------------------------------------

interface CmdResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = TIMEOUT_MS,
): Promise<CmdResult> {
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
        exitCode: code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: err.message,
        timedOut: false,
        exitCode: null,
      });
    });
  });
}

// --- Tool binary resolution (mode-aware) ------------------------------------

/**
 * Resolve o caminho do binary da tool usando findToolBinary() (mode-aware).
 * Retorna null se não encontrado.
 *
 * IMPORTANTE: NÃO usa detectTool() (API legacy não mode-aware) — isso era
 * o BUG-D: validators pulavam validação quando tools estavam em
 * modes/<mode>/tools/ ao invés de PATH global.
 */
async function resolveToolBinary(toolName: string, modeName: string | null): Promise<string | null> {
  try {
    const { findToolBinary } = await import("./toolDetector.js");
    const binaryPath = findToolBinary(toolName, modeName);
    if (binaryPath) {
      log.debug(`[FILE_VALIDATOR] Resolved "${toolName}" → ${binaryPath} (mode=${modeName ?? "none"})`);
      return binaryPath;
    }
  } catch (err) {
    log.debug(`[FILE_VALIDATOR] findToolBinary failed for "${toolName}": ${(err as Error).message}`);
  }
  return null;
}

// --- Manifest lookup (for validatorCommand) ---------------------------------

/**
 * Procura o manifest da tool pelo nome em todos os manifests do modo ativo.
 * Retorna o manifest se encontrado, null caso contrário.
 *
 * Sprint A: validators podem usar validatorArgs do manifest em vez de
 * hardcoded switch. Isso permite que novos modos definam validators sem
 * modificar código-fonte.
 */
async function findManifestForTool(
  toolName: string,
  modeName: string | null,
): Promise<{ command: string; args: string[]; validatorArgs?: string[] } | null> {
  try {
    const { loadActiveManifests } = await import("./manifestLoader.js");
    const manifests = loadActiveManifests();
    const manifest = manifests.find((m) => m.name === toolName);
    if (!manifest) return null;

    return {
      command: manifest.command,
      args: manifest.args ?? [],
      validatorArgs: manifest.validatorArgs,
    };
  } catch {
    return null;
  }
}

// --- Build command args from rule/manifest ----------------------------------

/**
 * Parse shell-style command string into tokens, respecting single and double
 * quotes. This is needed because `cmdWithFile.split(/\s+/)` would split
 * `grep -q 'TODO' file` into `["grep", "-q", "'TODO'", "file"]` — passing
 * the literal `'TODO'` (with quotes) to grep, which then doesn't match.
 *
 * Examples:
 *   "grep -q 'TODO' {file}" → ["grep", "-q", "TODO", "{file}"]
 *   'echo "hello world"' → ["echo", "hello world"]
 *   "ruff check --quiet /tmp/x.py" → ["ruff", "check", "--quiet", "/tmp/x.py"]
 */
function shellParse(cmd: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    // skip whitespace
    while (i < cmd.length && /\s/.test(cmd[i]!)) i++;
    if (i >= cmd.length) break;

    let token = "";
    while (i < cmd.length && !/\s/.test(cmd[i]!)) {
      const ch = cmd[i]!;
      if (ch === "'" || ch === '"') {
        // quoted string — read until matching quote
        const quote = ch;
        i++; // skip opening quote
        while (i < cmd.length && cmd[i] !== quote) {
          token += cmd[i];
          i++;
        }
        i++; // skip closing quote (if present)
      } else {
        token += ch;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

interface BuiltCommand {
  binaryPath: string;
  args: string[];
}

/**
 * Constrói o comando a executar for uma rule.
 *
 * Prioridade:
 *   1. rule.command (string shell-style, {file} substituído, com shellParse)
 *   2. rule.tool → manifest.validatorArgs (args estruturados)
 *   3. rule.tool → manifest.args (args base)
 *   4. rule.tool sozinho + [tmpFile] (fallback default)
 *
 * Lança Error se o binary não for encontrado.
 */
async function buildCommandForRule(
  rule: ValidationRule,
  tmpFile: string,
  modeName: string | null,
): Promise<BuiltCommand | { error: string }> {
  // 1. rule.command (string shell-style)
  if (rule.command) {
    const cmdWithFile = rule.command.replace(/\{file\}/g, tmpFile);
    // Sprint A: usar shellParse (respeita aspas) em vez de split(/\s+/)
    // split(/\s+/) passaria 'TODO' (com aspas literais) for o binary,
    // que não encontraria o pattern — bug sutil.
    const parts = shellParse(cmdWithFile);
    if (parts.length === 0) return { error: `rule.command vazio for ${rule.tool}` };

    // O primeiro token pode ser um nome de tool (resolvido via findToolBinary)
    // ou um path absoluto. Tenta resolver como tool primeiro.
    const program = parts[0]!;
    const restArgs = parts.slice(1);

    const binaryPath = await resolveToolBinary(program, modeName);
    if (binaryPath) {
      return { binaryPath, args: [...restArgs] };
    }
    // Se não é uma tool registrada, assume que é path/programa direto
    // (ex: /usr/bin/python3, terraform, etc.)
    return { binaryPath: program, args: restArgs };
  }

  // 2-4. Precisa resolver a tool pelo nome (rule.tool)
  // Remove sufixos comuns (_lint, _format, _run) for achar o binary
  const binaryToolName = rule.tool
    .replace(/_lint$/i, "")
    .replace(/_format$/i, "")
    .replace(/_run$/i, "")
    .replace(/_check$/i, "")
    .replace(/_validate$/i, "");

  const binaryPath = await resolveToolBinary(binaryToolName, modeName);
  if (!binaryPath) {
    return { error: `binary "${binaryToolName}" not found (not installed) (mode=${modeName ?? "none"})` };
  }

  // 2. Tenta manifest.validatorArgs
  const manifest = await findManifestForTool(rule.tool, modeName);
  if (manifest?.validatorArgs) {
    // Substitui {file} em cada arg
    const args = manifest.validatorArgs.map((a: string) => a.replace(/\{file\}/g, tmpFile));
    return { binaryPath, args };
  }

  // 3. Tenta manifest.args (args base, anexa tmpFile)
  if (manifest && manifest.args.length > 0) {
    return { binaryPath, args: [...manifest.args, tmpFile] };
  }

  // 4. Fallback: só tmpFile como arg
  return { binaryPath, args: [tmpFile] };
}

// --- Main validation function -----------------------------------------------

/**
 * Validate a proposed file write against the active mode's rules.
 *
 * @param filePath - Target file path (used to check pattern matching + ext)
 * @param newContent - Proposed new content of the file
 * @param rules - Validation rules from the active mode (or empty array)
 * @param projectRoot - Project root for cwd context
 * @param modeName - Active mode name (for findToolBinary mode-aware resolution)
 *
 * Returns ValidationResult. If ok=false, the write should be BLOCKED.
 */
export async function validateFile(
  filePath: string,
  newContent: string,
  rules: ValidationRule[],
  projectRoot: string,
  modeName?: string | null,
): Promise<ValidationResult> {
  const result: ValidationResult = {
    ok: true,
    warnings: [],
    rulesApplied: [],
    rulesSkipped: [],
  };

  if (rules.length === 0) {
    return result;
  }

  // Resolve modeName se não passado
  let activeMode = modeName ?? null;
  if (activeMode === null) {
    try {
      const { getActiveModeName } = await import("./modes.js");
      activeMode = getActiveModeName();
    } catch {
      // ignore
    }
  }

  // Filter rules that match this file pattern
  const applicableRules = rules.filter((r) => matchesPattern(filePath, r.filePattern));
  if (applicableRules.length === 0) {
    return result;
  }

  // Check if auto-research is enabled (default true)
  let autoResearchEnabled = true;
  try {
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    if (mode && mode.autoResearch === false) {
      autoResearchEnabled = false;
    }
  } catch {
    // keep default
  }

  // Write proposed content to a temp file for validation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-validator-"));
  const ext = path.extname(filePath) || ".txt";
  const tmpFile = path.join(tmpDir, `validation${ext}`);
  try {
    fs.writeFileSync(tmpFile, newContent, "utf8");

    for (const rule of applicableRules) {
      // Build command (resolves binary via findToolBinary — mode-aware)
      const built = await buildCommandForRule(rule, tmpFile, activeMode);
      if ("error" in built) {
        result.rulesSkipped.push(`${rule.tool} (${built.error})`);
        // BUG-VALIDATORS: If the rule is blocking but the binary is missing,
        // BLOCK the write instead of skipping. This prevents buggy Luau code
        // from being written without validation in roblox mode.
        if (rule.blocking) {
          result.ok = false;
          result.blockingError = `${rule.tool} is configured as blocking but binary not found: ${built.error}. Install it or remove the blocking flag from mode config.`;
          return result;
        }
        log.warn(`[FILE_VALIDATOR] ${rule.tool} PULADO — ${built.error}`);
        continue;
      }

      result.rulesApplied.push(rule.tool);
      log.debug(`[FILE_VALIDATOR] ${rule.tool} executando em ${path.basename(filePath)}: ${built.binaryPath} ${built.args.join(" ")}`);

      const cmdResult = await runCommand(built.binaryPath, built.args, projectRoot);

      if (cmdResult.timedOut) {
        const errMsg = `${rule.tool} timed out after ${TIMEOUT_MS}ms for ${path.basename(filePath)}`;
        if (rule.blocking) {
          result.ok = false;
          result.blockingError = errMsg;
          return result;
        } else {
          result.warnings.push(errMsg);
        }
        continue;
      }

      // BUG FIX (BUG-C): checar stdout OU stderr (não só stdout).
      // Selene 0.28.0+ manda diagnósticos for stderr; ruff manda for stdout;
      // terraform validate manda for stdout. Checar ambos é universal.
      const output = (cmdResult.stdout.trim() || cmdResult.stderr.trim());

      if (!cmdResult.ok) {
        // Tool failed (exit non-zero). Se tem output, inclui na mensagem.
        // Se NÃO tem output (ex: grep -q pattern file → exit 1 sem output),
        // ainda assim bloqueia com mensagem genérica — o exit code é suficiente.
        let errMsg: string;
        if (output) {
          errMsg = `${rule.tool} failed for ${path.basename(filePath)}:\n${output}`;

          // Hint for falso positivo de API desconhecida (Roblox/selene)
          const mightBeNewApi = /undefined (global|variable)|unknown global/i.test(output);
          if (mightBeNewApi && autoResearchEnabled) {
            errMsg += `\n\n[HINT] Este erro pode ser um FALSO POSITIVO - a tool pode não conhecer uma API nova. Considere chamar pesquisar_api_atualizada({ nome: "<api_name>", linguagem: "<linguagem>" }) for verificar se a API existe antes de "corrigir" o código.`;
          }
        } else {
          errMsg = `${rule.tool} failed for ${path.basename(filePath)} (exit code ${cmdResult.exitCode}, no output)`;
        }

        if (rule.blocking) {
          result.ok = false;
          result.blockingError = errMsg;
          return result;
        } else {
          result.warnings.push(errMsg);
        }
      }
    }
  } catch (err) {
    log.warn(`fileValidator: error during validation: ${(err as Error).message}`);
    result.warnings.push(`Validator error: ${(err as Error).message}`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return result;
}

// --- Public helpers (kept for backwards compat) -----------------------------

/**
 * Get the validation rules for the currently active mode.
 * Returns empty array if no mode active, or mode has no validation rules.
 *
 * Merges:
 *   - mode.luauValidation (legacy field)
 *   - mode.validation (new generic field)
 *   - mode.validators (new config.json field, Sprint 4)
 */
export async function getActiveValidationRules(): Promise<ValidationRule[]> {
  try {
    const { getActiveValidationRules: getMergedRules } = await import("./modeExtensions.js");
    return await getMergedRules();
  } catch {
    return [];
  }
}

/**
 * Convenience wrapper: should this file path be validated?
 *
 * GENERIC: returns true if ANY active validation rule's file pattern matches.
 * Works for any language (.luau, .lua, .py, .tf, .rs, .go, ...) as long as
 * the mode defines a validation rule with a matching filePattern.
 *
 * OPT-IN por design: retorna false quando nenhum modo ativo tem regras,
 * mesmo for .luau/.lua. Evita bloquear writes em ambientes sem tools.
 */
export async function shouldValidateFile(filePath: string): Promise<boolean> {
  const rules = await getActiveValidationRules();
  return rules.some((r) => matchesPattern(filePath, r.filePattern));
}
