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

import * as path from "node:path";
import * as log from "./logger.js";

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
  const requests = args.requests as Array<{ filePath?: string }> | undefined;
  if (!requests || !Array.isArray(requests)) return { allowed: true };

  const unreadPaths: string[] = [];
  for (const req of requests) {
    if (req.filePath && !hasBeenRead(req.filePath)) {
      unreadPaths.push(path.resolve(req.filePath));
    }
  }
  if (unreadPaths.length === 0) return { allowed: true };

  const msg =
    `[ERRO: READ-BEFORE-WRITE] Você tentou editar arquivos sem lê-los primeiro:\n` +
    unreadPaths.map((p) => `  - ${p}`).join("\n") +
    `\n\nREGRAS: SEMPRE use ler_arquivo ou ler_arquivo_avancado para ler um arquivo ANTES de editá-lo. ` +
    `Isso garante que você conhece o conteúdo atual e evita alucinações.\n` +
    `Chame ler_arquivo para cada arquivo acima e DEPOIS faça a edição.`;
  log.warn(`[READ-BEFORE-WRITE] Blocked ${toolName} on unread files: ${unreadPaths.join(", ")}`);
  return { allowed: false, message: msg };
}

function checkSingleFileRead(args: Record<string, unknown>, toolName: string): { allowed: boolean; message?: string } {
  const filePath = asString(args.caminho ?? args.path ?? args.filePath ?? "");
  if (!filePath) return { allowed: true };
  if (hasBeenRead(filePath)) return { allowed: true };

  const resolved = path.resolve(filePath);
  const msg =
    `[ERRO: READ-BEFORE-WRITE] Você tentou editar "${resolved}" sem lê-lo primeiro.\n\n` +
    `REGRAS: SEMPRE use ler_arquivo ou ler_arquivo_avancado para ler o arquivo ANTES de editá-lo. ` +
    `Isso garante que você conhece o conteúdo atual e evita alucinações.\n` +
    `Exemplo:\n` +
    `  1. ler_arquivo({ caminho: "${resolved}" })\n` +
    `  2. Logo depois, aplicar_diff({ caminho: "${resolved}", bloco_diff: "..." })`;
  log.warn(`[READ-BEFORE-WRITE] Blocked ${toolName} on unread file: ${resolved}`);
  return { allowed: false, message: msg };
}

export function clearReadPaths(): void {
  readPaths.clear();
}

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  return "";
}
