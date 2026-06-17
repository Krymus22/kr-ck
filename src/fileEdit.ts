/**
 * fileEdit.ts - Precise file editing by string match/replace with context awareness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

export interface EditOperation {
  search: string;
  replace: string;
  all?: boolean;  // replace all occurrences
}

export interface EditResult {
  success: boolean;
  replacements: number;
  content: string;
  error?: string;
}

/**
 * Apply one or more search/replace operations to a file.
 * Returns the result without writing to disk.
 */
export function applyEdits(content: string, edits: EditOperation[]): EditResult {
  let currentContent = content;
  let totalReplacements = 0;

  for (const edit of edits) {
    if (!edit.search) {
      // Empty search: if content is empty, set to replacement
      if (currentContent === "") {
        currentContent = edit.replace;
        totalReplacements += 1;
      }
      continue;
    }

    const occurrences = countOccurrences(currentContent, edit.search);
    if (occurrences === 0) {
      return {
        success: false,
        replacements: totalReplacements,
        content: currentContent,
        error: `SEARCH not found: "${edit.search.slice(0, 80)}${edit.search.length > 80 ? "..." : ""}"`,
      };
    }

    if (edit.all) {
      const parts = currentContent.split(edit.search);
      currentContent = parts.join(edit.replace);
      totalReplacements += parts.length - 1;
    } else {
      // Find first occurrence
      const idx = currentContent.indexOf(edit.search);
      currentContent = currentContent.slice(0, idx) + edit.replace + currentContent.slice(idx + edit.search.length);
      totalReplacements += 1;
    }
  }

  return { success: true, replacements: totalReplacements, content: currentContent };
}

/**
 * Edit a file on disk. Returns the result message.
 *
 * Luau/Lua files (when mode has luauValidation rules) are validated BEFORE
 * the write happens. If a blocking rule fails, the write is aborted and the
 * error is returned to the AI.
 */
export async function editFile(
  filePath: string,
  edits: EditOperation[],
  options?: { createIfMissing?: boolean; backup?: boolean }
): Promise<string> {
  const resolved = path.resolve(filePath);
  log.toolCall("editar_arquivo", { caminho: resolved, numEdits: edits.length });

  let content = "";
  if (fs.existsSync(resolved)) {
    content = fs.readFileSync(resolved, "utf8");
  } else if (options?.createIfMissing) {
    // content is already ""
  } else {
    return `[ERRO] Arquivo não encontrado: ${resolved}`;
  }

  const original = content;
  const result = applyEdits(content, edits);

  if (!result.success) {
    log.toolResult("editar_arquivo", false, result.error);
    return `[ERRO] Edição falhou: ${result.error}`;
  }

  // --- Luau pre-write validation (NEW) ---
  // If the file is .luau/.lua and the active mode has validation rules,
  // run them on the proposed new content BEFORE writing.
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".luau" || ext === ".lua") {
    try {
      const { shouldValidateFile, validateLuauBeforeWrite, getActiveValidationRules } =
        await import("./luauValidator.js");
      if (await shouldValidateFile(resolved)) {
        const rules = await getActiveValidationRules();
        const projectRoot = process.cwd();
        const validation = await validateLuauBeforeWrite(
          resolved,
          result.content,
          rules,
          projectRoot
        );

        if (!validation.ok && validation.blockingError) {
          log.toolResult("editar_arquivo", false, "validation blocked");
          return `[ERRO] Validação bloqueou a edição. Corrija os erros abaixo e tente novamente:\n\n${validation.blockingError}`;
        }

        // Log non-blocking warnings but proceed with the write
        for (const w of validation.warnings) {
          log.warn(`[luauValidator] ${w}`);
        }
      }
    } catch (err) {
      // Don't block writes if validator crashes - just log
      log.warn(`fileEdit: validator error (skipping): ${(err as Error).message}`);
    }
  }

  // Backup original
  if (options?.backup && fs.existsSync(resolved)) {
    const backupPath = resolved + ".bak";
    fs.writeFileSync(backupPath, original, "utf8");
  }

  // Write
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, result.content, "utf8");

  log.toolResult("editar_arquivo", true, `${result.replacements} replacements`);
  return `[SUCESSO] ${result.replacements}substituições(s) aplicada(s) em ${resolved}`;
}

function countOccurrences(text: string, search: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(search, idx)) !== -1) {
    count++;
    idx += search.length;
  }
  return count;
}
