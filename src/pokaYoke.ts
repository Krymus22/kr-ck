/**
 * pokaYoke.ts - Error-proofing helpers for tool calls.
 *
 * Enforces invariants that prevent common model mistakes BEFORE
 * the tool actually runs:
 *
 *   1. File-path tools (aplicar_diff, editar_arquivo, desfazer_edicao,
 *      ler_arquivo, etc.) MUST receive a non-empty path.
 *   2. Edit tools (aplicar_diff, editar_arquivo) should resolve to
 *      absolute paths - relative paths work but are ambiguous when
 *      the agent's cwd differs from the user's mental model.
 *   3. aplicar_diff requires a non-empty `bloco_diff` with at least
 *      one `<<<<<<< SEARCH` / `>>>>>>> REPLACE` pair.
 *   4. editar_arquivo requires either `edits` (array) OR `search`+`replace`.
 *
 * Returns clear, actionable error messages telling the model exactly
 * what's wrong - inspired by Anthropic's poka-yoke approach.
 */

import * as path from "node:path";
import { t } from "./i18n.js";

// --- Types -------------------------------------------------------------------

export interface PokaYokeResult {
  ok: boolean;
  error?: string;
  /** Resolved absolute path (when applicable) */
  resolvedPath?: string;
}

// --- Tools that take a single file path --------------------------------------

const PATH_TAKING_TOOLS = new Set([
  "ler_arquivo",
  "ler_arquivo_avancado",
  "aplicar_diff",
  "editar_arquivo",
  "desfazer_edicao",
  "git_blame",
  "git_show",
  "parse_ast",
]);

// --- Helpers -----------------------------------------------------------------

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

// --- Public API --------------------------------------------------------------

/**
 * Validate a tool call's arguments against poka-yoke rules.
 * Returns { ok: true } if the call is safe to dispatch, or
 * { ok: false, error: "..." } with a clear message the model can act on.
 */
export function pokaYokeCheck(
  toolName: string,
  args: Record<string, unknown>
): PokaYokeResult {
  // -- Path-taking tools: must have a non-empty path ----------------------
  if (PATH_TAKING_TOOLS.has(toolName)) {
    const rawPath = args.caminho ?? args.path ?? args.filePath ?? args.file;
    if (!isNonEmptyString(rawPath)) {
      return {
        ok: false,
        error: t("poka.empty_path", toolName),
      };
    }
    // Null bytes em paths são PERIGOSOS: em bindings nativos/C, "\0" é
    // terminador de string — permite path injection (ex.: "/tmp/foo\0.txt"
    // pode virar "/tmp/foo" em certas chamadas C). Rejeitamos sempre.
    if (rawPath.includes("\0")) {
      return {
        ok: false,
        error:
          `[POKA-YOKE] Invalid path for "${toolName}": contains null byte (\\0). ` +
          `Null bytes in paths can cause path injection in native bindings ` +
          `(e.g. "/tmp/foo\\0.txt" may be interpreted as "/tmp/foo" in C). ` +
          `Remove the null character from the path and try again.`,
      };
    }
    // path is present and safe - fall through to tool-specific checks below
    // (we'll attach resolvedPath to the final return)
  }

  // -- Tool-specific structural checks ------------------------------------
  const toolCheck = TOOL_SPECIFIC_CHECKS.get(toolName);
  if (toolCheck) {
    const result = toolCheck(args);
    if (!result.ok) return result;
  }

  // All checks passed - return ok with resolved path (if applicable)
  if (PATH_TAKING_TOOLS.has(toolName)) {
    const rawPath = (args.caminho ?? args.path ?? args.filePath ?? args.file) as string;
    return { ok: true, resolvedPath: path.resolve(rawPath) };
  }
  return { ok: true };
}

// --- Tool-specific check functions -------------------------------------------

type ToolSpecificCheck = (args: Record<string, unknown>) => PokaYokeResult;

const TOOL_SPECIFIC_CHECKS = new Map<string, ToolSpecificCheck>([
  ["aplicar_diff", checkAplicarDiff],
  ["editar_arquivo", checkEditarArquivo],
  ["desfazer_edicao", checkDesfazerEdicao],
  ["executar_comando", checkExecutarComando],
  ["editar_multi_arquivos", checkEditarMultiArquivos],
]);

function checkAplicarDiff(args: Record<string, unknown>): PokaYokeResult {
  const bloco = args.bloco_diff;
  if (!isNonEmptyString(bloco)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] aplicar_diff requires non-empty "bloco_diff". ` +
        `Expected format:\n` +
        `<<<<<<< SEARCH\n[exact code from file]\n=======\n[new code]\n>>>>>>> REPLACE`,
    };
  }
  if (!bloco.includes("<<<<<<< SEARCH") || !bloco.includes(">>>>>>> REPLACE")) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] "bloco_diff" does not contain the expected structure. ` +
        `Each block must have "<<<<<<< SEARCH" at the start and ">>>>>>> REPLACE" at the end, ` +
        `separated by a "=======" line.`,
    };
  }
  return { ok: true };
}

function checkEditarArquivo(args: Record<string, unknown>): PokaYokeResult {
  const hasEditsArray = Array.isArray(args.edits) && args.edits.length > 0;
  const hasSearchReplace = isNonEmptyString(args.search) && typeof args.replace === "string";
  // Sprint C bug fix: createIfMissing com search vazio deve ser permitido.
  // A documentação (linha 240) diz: "Empty search string + createIfMissing=true
  // creates a new file with the replace content." Mas o poka-yoke exigia
  // search não-vazio — criando contradição. Agora: se createIfMissing=true
  // e replace é string, permite mesmo com search vazio.
  const isCreateIfMissing = args.createIfMissing === true && typeof args.replace === "string";
  // BUG-SS fix: also allow empty search + replace + createIfMissing (append mode).
  const isAppendMode = args.createIfMissing === true && typeof args.replace === "string" && args.search === "";
  if (!hasEditsArray && !hasSearchReplace && !isCreateIfMissing && !isAppendMode) {
    return {
      ok: false,
      error: t("poka.editar_requires_args"),
    };
  }
  return { ok: true };
}

function checkDesfazerEdicao(args: Record<string, unknown>): PokaYokeResult {
  if (!isNonEmptyString(args.caminho)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] desfazer_edicao requires "caminho" (non-empty string) ` +
        `pointing to the file whose last edit should be undone.`,
    };
  }
  return { ok: true };
}

function checkExecutarComando(args: Record<string, unknown>): PokaYokeResult {
  // Accept both 'comando' (PT) and 'command' (EN, alias)
  if (!isNonEmptyString(args.comando ?? args.command)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] executar_comando requires "comando" (or "command") as a non-empty string. ` +
        `Example: executar_comando({ comando: "npm test" })`,
    };
  }
  return { ok: true };
}

function checkEditarMultiArquivos(args: Record<string, unknown>): PokaYokeResult {
  if (!Array.isArray(args.requests) || args.requests.length === 0) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] editar_multi_arquivos requires "requests" as a non-empty array ` +
        `of { filePath, edits: [{search, replace, all?}], createIfMissing? }.`,
    };
  }
  return { ok: true };
}

// --- Expanded Tool Descriptions ----------------------------------------------
//
// These are appended to the existing tool descriptions in apiClient.ts to
// provide the model with concrete examples and edge-case guidance, in line
// with Anthropic's poka-yoke "make the right thing easy" philosophy.

export const EXPANDED_TOOL_DESCRIPTIONS: Record<string, string> = {};

