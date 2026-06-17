/**
 * multiFileEdit.ts - Edit multiple files in one atomic operation with rollback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, type EditOperation } from "./fileEdit.js";
import * as log from "./logger.js";

export interface FileEditRequest {
  filePath: string;
  edits: EditOperation[];
  createIfMissing?: boolean;
}

export interface MultiEditResult {
  success: boolean;
  filesEdited: string[];
  errors: Array<{ file: string; error: string }>;
  rolledBack: boolean;
}

interface PreparedEdit {
  resolved: string;
  original: string;
  result: ReturnType<typeof applyEdits>;
}

function resolveFilePath(filePath: string, createIfMissing: boolean): string | null {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) return resolved;
  if (createIfMissing) return resolved;
  return null;
}

function prepareEdits(
  requests: FileEditRequest[],
  errors: Array<{ file: string; error: string }>
): PreparedEdit[] {
  const preparedEdits: PreparedEdit[] = [];

  for (const req of requests) {
    const resolved = resolveFilePath(req.filePath, !!req.createIfMissing);
    if (!resolved) {
      errors.push({ file: req.filePath, error: "File not found" });
      continue;
    }

    const content = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
    const result = applyEdits(content, req.edits);
    preparedEdits.push({ resolved, original: content, result });

    if (!result.success) {
      errors.push({ file: req.filePath, error: result.error ?? "Edit failed" });
    }
  }

  return preparedEdits;
}

function applyAllEdits(preparedEdits: PreparedEdit[]): string[] {
  const edited: string[] = [];

  for (const prepared of preparedEdits) {
    const dir = path.dirname(prepared.resolved);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(prepared.resolved, prepared.result.content, "utf8");
    edited.push(prepared.resolved);
  }

  return edited;
}

function rollbackEdits(backups: Array<{ path: string; original: string }>): void {
  for (const backup of backups) {
    try {
      fs.writeFileSync(backup.path, backup.original, "utf8");
    } catch {
      log.error(`Rollback failed for ${backup.path}`);
    }
  }
}

/**
 * Edit multiple files atomically. If any edit fails, all changes are rolled back.
 */
export { applyAllEdits };

export function multiFileEdit(requests: FileEditRequest[]): MultiEditResult {
  log.toolCall("editar_multi_arquivos", { count: requests.length });

  const errors: Array<{ file: string; error: string }> = [];
  const preparedEdits = prepareEdits(requests, errors);

  if (errors.length > 0) {
    return { success: false, filesEdited: [], errors, rolledBack: false };
  }

  const backups: Array<{ path: string; original: string }> = [];
  try {
    const edited = applyAllEditsWithBackup(preparedEdits, backups);
    log.toolResult("editar_multi_arquivos", true, `${edited.length} files`);
    return { success: true, filesEdited: edited, errors: [], rolledBack: false };
  } catch (err) {
    rollbackEdits(backups);
    log.toolResult("editar_multi_arquivos", false, "rollback");
    return {
      success: false,
      filesEdited: [],
      errors: [{ file: "system", error: (err as Error).message }],
      rolledBack: true,
    };
  }
}

function applyAllEditsWithBackup(
  preparedEdits: PreparedEdit[],
  backups: Array<{ path: string; original: string }>
): string[] {
  const edited: string[] = [];
  for (const prepared of preparedEdits) {
    if (fs.existsSync(prepared.resolved)) {
      backups.push({ path: prepared.resolved, original: prepared.original });
    }
    const dir = path.dirname(prepared.resolved);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(prepared.resolved, prepared.result.content, "utf8");
    edited.push(prepared.resolved);
  }
  return edited;
}
