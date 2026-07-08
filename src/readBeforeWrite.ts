/**
 * readBeforeWrite.ts - Enforces read-before-write discipline.
 *
 * Inspired by Anthropic's poka-yoke approach: prevent the model from editing
 * files it hasn't read first. This eliminates the #1 source of hallucinations:
 * editing files based on assumed content.
 *
 * Tracks which files have been read via ler_arquivo or ler_arquivo_avancado.
 * When a write tool is called (aplicar_diff, editar_arquivo, editar_multi_arquivos),
 * checks if the path has been read in the current session.
 *
 * If not read: blocks the write and returns a clear error.
 * The model MUST call ler_arquivo first to see the actual content.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";
import { t } from "./i18n.js";

const READ_TOOLS = new Set([
  "ler_arquivo",
  "ler_arquivo_avancado",
  "buscar_texto",
  "buscar_arquivos",
  "git_diff",
  "git_blame",
  "git_show",
  "parse_ast",
]);

const WRITE_TOOLS = new Set([
  "aplicar_diff",
  "editar_arquivo",
  "editar_multi_arquivos",
]);

const readPaths = new Set<string>();
// Sprint C bug fix: inicializar `enabled` a partir da env var READ_BEFORE_WRITE
// (setada por applyMode quando o modo ativo tem readBeforeWrite: true/false).
// Antes, era hardcoded como `true` e nunca lia a env var — modo normal
// (readBeforeWrite: false) ainda bloqueava edições sem ler primeiro.
let enabled = process.env.READ_BEFORE_WRITE === "false" ? false : true;

/**
 * Concurrency Audit Part 2 — Race #2 / #3.
 *
 * `readPaths` is module-level mutable state shared between the agent loop
 * (which adds to it via recordRead/recordWrite and reads it via
 * checkReadBeforeWrite) and slash commands like `/reset` and `/session new`
 * (which clear it via clearReadPaths()).
 *
 * Race scenario:
 *   1. Agent loop is mid-turn. It has read /tmp/foo.ts and recorded the path.
 *   2. The IA's chat() call resolves with a tool_call to editar_arquivo.
 *   3. dispatchToolCall calls checkReadBeforeWrite() → passes (path is in set).
 *   4. dispatchToolCall awaits editFile (which is async).
 *   5. While awaiting, a programmatic caller (test, future code path) calls
 *      clearReadPaths() — wiping the Set.
 *   6. The in-progress edit completes successfully, but any LATER tool call
 *      in the SAME turn that touches the same file is now incorrectly blocked
 *      ("you haven't read this file") because the readPaths set was cleared
 *      out from under the running turn.
 *
 * The TUI guards against this via `isProcessing.current` (App.tsx), so the
 * user cannot trigger /reset mid-turn. But programmatic callers can bypass
 * that guard. To close the hole, clearReadPaths() refuses to run while the
 * agent loop is active. The agent loop itself resets readPaths at the START
 * of each turn (see runAgentLoop), so skipping a mid-turn clear is safe —
 * the next turn will start with a fresh set anyway.
 *
 * The checker is injected via setter (rather than a static import) to avoid
 * a circular module dependency between readBeforeWrite.ts and agent.ts.
 */
let agentLoopRunningChecker: (() => boolean) | null = null;

/**
 * Register a callback that returns true while the agent loop is running.
 * Called by agent.ts at module load. This avoids a circular import.
 */
export function setAgentLoopRunningChecker(fn: (() => boolean) | null): void {
  agentLoopRunningChecker = fn;
}

export function setReadBeforeWriteEnabled(on: boolean): void {
  enabled = on;
  // Sprint C: também atualizar a env var pra consistência
  process.env.READ_BEFORE_WRITE = on ? "true" : "false";
}

export function isReadBeforeWriteEnabled(): boolean {
  // Sprint C bug fix: ler a env var dinamicamente (applyMode seta ela quando
  // modo muda). Antes, só lia na inicialização do módulo — mudar de modo
  // roblox (readBeforeWrite: true) pra normal (false) não desativava.
  if (process.env.READ_BEFORE_WRITE === "false") return false;
  if (process.env.READ_BEFORE_WRITE === "true") return true;
  return enabled;  // fallback pra valor setado por setReadBeforeWriteEnabled
}

export function recordRead(toolName: string, filePath: string): void {
  if (!READ_TOOLS.has(toolName)) return;
  const resolved = path.resolve(filePath);
  readPaths.add(resolved);
  log.debug(`[READ-BEFORE-WRITE] Recorded read: ${resolved}`);
}

export function recordWrite(toolName: string, filePath: string): void {
  if (!WRITE_TOOLS.has(toolName)) return;
  // Writes also count as having "seen" the file for subsequent writes
  const resolved = path.resolve(filePath);
  readPaths.add(resolved);
}

export function hasBeenRead(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return readPaths.has(resolved);
}

export function checkReadBeforeWrite(toolName: string, args: Record<string, unknown>): { allowed: boolean; message?: string } {
  // Sprint C bug fix: usar isReadBeforeWriteEnabled() (lê env var dinamicamente)
  // em vez da variável `enabled` (só lida na inicialização).
  if (!isReadBeforeWriteEnabled()) return { allowed: true };
  if (!WRITE_TOOLS.has(toolName)) return { allowed: true };

  if (toolName === "editar_multi_arquivos") {
    return checkMultiFileRead(args, toolName);
  }
  return checkSingleFileRead(args, toolName);
}

function checkMultiFileRead(args: Record<string, unknown>, toolName: string): { allowed: boolean; message?: string } {
  const requests = args.requests as Array<{ filePath?: string; createIfMissing?: boolean }> | undefined;
  if (!requests || !Array.isArray(requests)) return { allowed: true };

  const unreadPaths: string[] = [];
  for (const req of requests) {
    if (!req.filePath) continue;
    // BUG-GG2: skip read-before-write check for files that don't exist yet
    // AND have createIfMissing=true — you can't read a file that doesn't exist.
    if (req.createIfMissing === true && !fs.existsSync(req.filePath)) continue;
    if (!hasBeenRead(req.filePath)) {
      unreadPaths.push(path.resolve(req.filePath));
    }
  }
  if (unreadPaths.length === 0) return { allowed: true };

  const msg = t("gate.read_before_write", unreadPaths.map((p) => `  - ${p}`).join("\n"));
  log.warn(`[READ-BEFORE-WRITE] Blocked ${toolName} on unread files: ${unreadPaths.join(", ")}`);
  return { allowed: false, message: msg };
}

function checkSingleFileRead(args: Record<string, unknown>, toolName: string): { allowed: boolean; message?: string } {
  const filePath = asString(args.caminho ?? args.path ?? args.filePath ?? "");
  if (!filePath) return { allowed: true };
  if (hasBeenRead(filePath)) return { allowed: true };

  // BUG-GG2: skip read-before-write check for files that don't exist yet
  // AND have createIfMissing=true — you can't read a file that doesn't exist.
  // This was blocking the IA from creating new files, causing loops.
  if (args.createIfMissing === true && !fs.existsSync(filePath)) {
    return { allowed: true };
  }

  const resolved = path.resolve(filePath);
  const msg =
    `[ERRO: READ-BEFORE-WRITE] Você tentou editar "${resolved}" sem lê-lo primeiro.\n\n` +
    `REGRAS: SEMPRE use ler_arquivo ou ler_arquivo_avancado for ler o arquivo ANTES de editá-lo. ` +
    `Isso garante que você conhece o conteúdo atual e evita alucinações.\n` +
    `Exemplo:\n` +
    `  1. ler_arquivo({ caminho: "${resolved}" })\n` +
    `  2. Logo depois, aplicar_diff({ caminho: "${resolved}", bloco_diff: "..." })`;
  log.warn(`[READ-BEFORE-WRITE] Blocked ${toolName} on unread file: ${resolved}`);
  return { allowed: false, message: msg };
}

export function clearReadPaths(): void {
  // Concurrency Audit Part 2 — Race #2 / #3:
  // Refuse to clear while the agent loop is running. The loop relies on
  // readPaths being stable for the duration of a turn. The next turn will
  // start with a fresh set (runAgentLoop resets it), so skipping a mid-turn
  // clear does NOT leak stale state across turns.
  if (agentLoopRunningChecker?.()) {
    log.warn(
      "[READ-BEFORE-WRITE] clearReadPaths() skipped — agent loop is running. " +
      "Clearing readPaths mid-turn would cause later write tools in the SAME turn " +
      "to be incorrectly blocked. The next turn will start with a fresh readPaths set."
    );
    return;
  }
  readPaths.clear();
}

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  return "";
}
