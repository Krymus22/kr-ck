/**
 * fileEdit.ts - Precise file editing by string match/replace with context awareness.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";
import { t } from "./i18n.js";
import { saveBackup, restoreBackup } from "./rollbackStore.js";

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
      } else {
        // Sprint C bug fix (BUG-V): se search é vazio mas o arquivo tem
        // conteúdo, fazer APPEND do replace ao final. Antes, o código
        // fazia `continue` (pula) e nada era adicionado — a IA achava
        // que funcionou mas o arquivo não mudava.
        currentContent = currentContent.replace(/\n?$/, "\n") + edit.replace;
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
 *
 * File lock: acquires a lock on the target file before editing, so multiple
 * agents (main + sub-agents in powerful mode) can't edit the same file
 * simultaneously. Lock auto-releases after 30s TTL (or on function exit).
 */

// --- Post-write checks (extracted to reduce cognitive complexity) ---
async function runPostWriteChecks(resolved: string, content: string): Promise<void> {
  // Honesty: Mark file as edited (for Read-Back Verification)
  try {
    const { markFileAsEdited } = await import("./honestySystem.js");
    markFileAsEdited(resolved);
  } catch { /* honestySystem not available */ }

  // Honesty: Diff Reality Check
  try {
    const { diffRealityCheck } = await import("./honestySystem.js");
    const diffCheck = await diffRealityCheck(resolved, content);
    if (!diffCheck.matches && diffCheck.message) {
      log.warn(`[HONESTY:DiffCheck] ${diffCheck.message}`);
    }
  } catch { /* honestySystem not available */ }

  // Honesty: Hallucination Detector
  try {
    const { detectHallucinations } = await import("./honestySystem.js");
    const hallucinationCheck = await detectHallucinations(resolved, content);
    if (hallucinationCheck.hallucinatedSymbols.length > 0 && hallucinationCheck.message) {
      log.warn(`[HONESTY:Hallucination] ${hallucinationCheck.message}`);
    }
  } catch { /* honestySystem not available */ }

  // Import Resolver
  try {
    const { checkImports } = await import("./importResolver.js");
    const importCheck = checkImports(resolved, content);
    if (!importCheck.ok && importCheck.message) {
      log.warn(`[IMPORT_RESOLVER] ${importCheck.message}`);
    }
  } catch { /* importResolver not available */ }
}

export async function editFile(
  filePath: string,
  edits: EditOperation[],
  options?: { createIfMissing?: boolean; backup?: boolean }
): Promise<string> {
  // Guard: null/undefined/empty filePath (edge case hunter fix)
  if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
    return "[ERROR] filePath is required (received " + String(filePath) + ")";
  }
  // Guard: non-array edits
  if (!Array.isArray(edits)) {
    return "[ERROR] edits must be an array (received " + typeof edits + ")";
  }
  const resolved = path.resolve(filePath);
  log.toolCall("editar_arquivo", { caminho: resolved, numEdits: edits.length });

  // --- File lock (acquire before any work) ---
  // Prevents race conditions when main + sub-agents edit the same file.
  // Lock auto-releases on TTL or function exit (via finally block).
  const { acquireLock, getCurrentAgentId } = await import("./fileLock.js");
  const holderId = getCurrentAgentId();
  let releaseLock: (() => void) | null = null;
  try {
    releaseLock = await acquireLock(resolved, holderId, 30_000, 60_000);
  } catch (err) {
    log.warn(`fileEdit: could not acquire lock for ${resolved}: ${(err as Error).message}`);
    return t("tool.file_lock_failed", (err as Error).message);
  }

  try {
    let content = "";
    try {
      content = await fs.promises.readFile(resolved, "utf8");
    } catch {
      if (options?.createIfMissing) {
        // content is already ""
      } else {
        return `[ERROR] File not found: ${resolved}`;
      }
    }

    const original = content;
    const result = applyEdits(content, edits);

    if (!result.success) {
      log.toolResult("editar_arquivo", false, result.error);
      return `[ERROR] Edit failed: ${result.error}`;
    }

  // --- Impact analysis (NEW) ---
  // Before writing, find all OTHER files in the project that reference
  // symbols defined in this file. Inject as a hint to the AI.
  // Non-blocking - never aborts the write, just adds context.
  let impactHint = "";
  try {
    const { analyzeImpact, formatImpactHint } = await import("./impactAnalyzer.js");
    // CRITICAL FIX: use the directory of the file being edited as projectRoot,
    // NOT process.cwd(). When the test script does process.chdir(), cwd is
    // the claude-killer dir, not the project being edited. This caused
    // impactAnalyzer to search 200+ files of claude-killer itself, polluting
    // context with irrelevant matches.
    // Walk up from the file to find a reasonable project root (closest
    // package.json or src/ dir, or just the file's parent directory).
    const nodePath = await import("node:path");
    let projectRoot = nodePath.dirname(resolved);
    // Walk up max 3 levels looking for package.json or src/
    let dir = projectRoot;
    for (let i = 0; i < 4; i++) {
      const nodeFs = await import("node:fs");
      if (nodeFs.existsSync(nodePath.join(dir, "package.json"))) {
        projectRoot = dir;
        break;
      }
      if (nodePath.basename(dir) === "src") {
        projectRoot = nodePath.dirname(dir);
        break;
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    const report = await analyzeImpact(resolved, projectRoot);
    impactHint = formatImpactHint(report);
    if (impactHint) {
      log.info(`[IMPACT] ${impactHint}`);
    }
  } catch (err) {
    // Don't block writes if impact analyzer crashes
    log.debug(`fileEdit: impact analysis skipped: ${(err as Error).message}`);
  }

  // --- Pre-write validation (Sprint 4: generalized for any language) ---
  // If the active mode has validation rules that match this file's pattern,
  // run them on the proposed new content BEFORE writing.
  // Previously this was hardcoded to .luau/.lua only. Now it works for
  // ANY language (.py, .ts, .rs, .go, etc) as long as the mode has
  // validators with matching filePattern.
  try {
    const { shouldValidateFile, validateLuauBeforeWrite, getActiveValidationRules } =
      await import("./luauValidator.js");
    if (await shouldValidateFile(resolved)) {
      const rules = await getActiveValidationRules();
      const projectRoot = process.cwd();
      // Sprint A: pass modeName so validator can use findToolBinary() (mode-aware)
      let modeName: string | null = null;
      try {
        const { getActiveModeName } = await import("./modes.js");
        modeName = getActiveModeName();
      } catch {
        // ignore
      }
      const validation = await validateLuauBeforeWrite(
        resolved,
        result.content,
        rules,
        projectRoot,
        modeName
      );

      if (!validation.ok && validation.blockingError) {
        log.toolResult("editar_arquivo", false, "validation blocked");
        return `[ERROR] Validação bloqueou a edição. Corrija os erros abaixo e tente novamente:\n\n${validation.blockingError}`;
      }

      // Log non-blocking warnings but proceed with the write
      for (const w of validation.warnings) {
        log.warn(`[validator] ${w}`);
      }

      // BUG FIX: NÃO adicionar mensagem de validação ao conteúdo do arquivo.
      // Antes, result.content += `\n\n[VALIDAÇÃO] ${summary}` — isso escrevia
      // "[VALIDAÇÃO] validado por: selene_lint, stylua_format" DENTRO do arquivo
      // no disco. Quando o Rojo sincronizava pro Studio, essa mensagem aparecia
      // como texto no final do script, quebrando o código e revelando uso de IA.
      // Agora a validação é logada (visível no terminal) mas NÃO escrita no arquivo.
      if (validation.rulesApplied.length > 0) {
        log.success(`[VALIDAÇÃO] validado por: ${validation.rulesApplied.join(", ")}`);
      }
      if (validation.rulesSkipped.length > 0) {
        log.debug(`[VALIDAÇÃO] pulado: ${validation.rulesSkipped.join(", ")}`);
      }
    }
  } catch (err) {
    // Don't block writes if validator crashes - just log
    log.warn(`fileEdit: validator error (skipping): ${(err as Error).message}`);
  }

  // --- Safety review (NEW) ---
  // If the active mode has safetyReview=true, run LLM-based review on .luau/.lua
  // files. Heuristics first (regex for dangerous patterns), LLM only if patterns
  // match. High-risk writes are BLOCKED.
  const fileExt = path.extname(resolved).toLowerCase();
  if (fileExt === ".luau" || fileExt === ".lua") {
    try {
      const { getActiveMode } = await import("./modes.js");
      const mode = getActiveMode();
      if (mode?.safetyReview) {
        const { reviewCodeSafety, formatSafetyReview, shouldReviewFile } =
          await import("./safetyReviewer.js");
        if (shouldReviewFile(resolved)) {
          const review = await reviewCodeSafety(result.content, resolved);
          log.info(`[SAFETY] risk=${review.risk} reviewedByLlm=${review.reviewedByLlm} patterns=${review.patternsMatched.length} (${review.durationMs}ms)`);

          if (review.risk === "high") {
            const msg = formatSafetyReview(review);
            log.toolResult("editar_arquivo", false, "safety review blocked");
            return `[ERROR] Revisor de segurança bloqueou a edição.\n\n${msg}`;
          }

          // Log low/none reviews as info (not blocking)
          const reviewMsg = formatSafetyReview(review);
          if (reviewMsg) {
            log.info(`[SAFETY] ${reviewMsg}`);
          }
        }
      }
    } catch (err) {
      // Don't block writes if safety reviewer crashes
      log.warn(`fileEdit: safety review skipped: ${(err as Error).message}`);
    }
  }

  // Backup original — ASYNC to avoid blocking event loop
  if (options?.backup) {
    try {
      await fs.promises.access(resolved);
      const backupPath = resolved + ".bak";
      await fs.promises.writeFile(backupPath, original, "utf8");
    } catch { /* file doesn't exist yet, no backup needed */ }
  }

  // --- Rollback store backup (ALWAYS saved when file exists) ----------------
  // The rollbackStore.ts header documents: "Before EVERY successful write via
  // aplicar_diff / editar_arquivo / editar_multi_arquivos, the original content
  // is snapshotted into a .rollback/ directory". Without this, desfazer_edicao
  // can't restore the file if the write fails (disk full, permissions, etc.).
  // BUG FIX: previously this was missing — only the conditional .bak above was
  // saved (and only when options.backup was set, which the agent never sets).
  let savedRollbackBackup = false;
  if (original.length > 0) {
    try {
      const backup = saveBackup(resolved, original, "editar_arquivo");
      savedRollbackBackup = !!backup;
    } catch (err) {
      // Don't block the write if rollback store fails (disk full, etc.) —
      // but log it so the user knows desfazer_edicao won't be available.
      log.warn(`fileEdit: rollback backup failed: ${(err as Error).message}`);
    }
  }

  // --- Sprint 8: before_write hooks (Worker-Thread sandbox) ---
  // Runs user-provided JS snippets in isolated Worker Threads before the
  // write happens. Hooks may BLOCK the write, MODIFY the content, or just
  // emit a warning. Best-effort — never breaks the write on hook errors.
  try {
    const { runHooks } = await import("./hookRunner.js");
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    const hookResults = await runHooks(
      "before_write",
      {
        filePath: resolved,
        content: result.content,
        mode: mode?.name,
      },
      mode?.name ?? null,
    );

    for (const hr of hookResults) {
      if (hr.blocking) {
        log.toolResult("editar_arquivo", false, "hook blocked");
        return `[ERROR] Hook bloqueou: ${hr.message ?? "(no message)"}`;
      }
      if (hr.modifiedContent) {
        result.content = hr.modifiedContent;
      }
      if (hr.warning) {
        log.warn(`[HOOK] ${hr.warning}`);
      }
    }
  } catch (err) {
    log.warn(`fileEdit: before_write hook error: ${(err as Error).message}`);
  }

  // Write — wrapped in try/catch so we can ROLLBACK on failure.
  // BUG FIX: previously, fs.writeFileSync was called without a try/catch.
  // If the write failed mid-way (disk full, EACCES on an existing file with
  // O_TRUNC), the file could be left truncated/corrupted with NO way to
  // restore because no rollbackStore backup had been saved either.
  // Now: we save a rollbackStore backup BEFORE writing (above), and on write
  // failure we restore the original content and return a clear error string
  // (consistent with aplicar_diff's behavior of returning { written: false,
  // toolMessage: "[ERROR] ..." } instead of throwing).
  const dir = path.dirname(resolved);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await fs.promises.writeFile(resolved, result.content, "utf8");
  } catch (err) {
    const writeErr = err as NodeJS.ErrnoException;
    const errMsg = `[ERROR] Failed to write ${resolved}: ${writeErr.message}`;
    log.toolResult("editar_arquivo", false, `write failed: ${writeErr.message}`);

    // Try to restore the original content from the rollbackStore backup
    // so the file is NOT left in a truncated/corrupted state.
    if (savedRollbackBackup && original.length > 0) {
      try {
        // restoreBackup reads the latest snapshot from .rollback/ and writes
        // it back to the original path — exactly what we need here.
        restoreBackup(resolved);
        log.warn(`fileEdit: restored original content after write failure (rollback backup)`);
      } catch (restoreErr) {
        // If restoreBackup fails, try a direct write of the original content
        // we still have in memory (it was read at the start of editFile).
        try {
          await fs.promises.writeFile(resolved, original, "utf8");
          log.warn(`fileEdit: restored original content after write failure (in-memory fallback)`);
        } catch {
          log.error(`fileEdit: FAILED to restore original after write failure: ${(restoreErr as Error).message}`);
        }
      }
    } else if (original.length > 0) {
      // No rollback backup was saved, but we still have the original in memory
      // — try to restore it directly so the file isn't left truncated.
      try {
        await fs.promises.writeFile(resolved, original, "utf8");
        log.warn(`fileEdit: restored original content from in-memory copy (no rollback backup was saved)`);
      } catch (restoreErr) {
        log.error(`fileEdit: FAILED to restore original from in-memory copy: ${(restoreErr as Error).message}`);
      }
    }

    return errMsg;
  }

  log.toolResult("editar_arquivo", true, `${result.replacements} replacements`);

  // --- Sprint 8: on_file hooks (Worker-Thread sandbox) ---
  // Runs after the file has been written to disk. Best-effort — failures
  // are logged but never block the result. Typical use: auto-build,
  // auto-format, file-indexer refresh, etc.
  try {
    const { runHooks } = await import("./hookRunner.js");
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    await runHooks(
      "on_file",
      {
        filePath: resolved,
        content: result.content,
        mode: mode?.name,
      },
      mode?.name ?? null,
    );
  } catch (err) {
    /* hooks are best-effort */
    log.debug(`fileEdit: on_file hook error: ${(err as Error).message}`);
  }

  // -- IDEIA 12 Honesty + IDEIA 24 Import Resolver --
  // Post-write checks (diff reality check, hallucination detector, import
  // resolver). Extracted into runPostWriteChecks() to reduce cognitive
  // complexity. BUG FIX: previously the inline checks below duplicated
  // runPostWriteChecks() but never called it — leaving runPostWriteChecks
  // as dead code (mutations at L97/L106/L115 survived because the code
  // was unreachable). Now we call the extracted function so the checks
  // run through a single, testable code path.
  await runPostWriteChecks(resolved, result.content);

  // Run post-edit hooks (externalized via mode.hooks.postEdit)
  // Typical use: auto-format the file that was just written (terraform fmt, black, etc)
  let hookResults = "";
  try {
    const { runPostEditHooks } = await import("./modeExtensions.js");
    hookResults = await runPostEditHooks(resolved);
  } catch (err) {
    log.debug(`fileEdit: post-edit hooks skipped: ${(err as Error).message}`);
  }

  // Build success/warning message - append impact hint + hook results
  // Sprint C bug fix (BUG-U): quando 0 replacements, retorna WARNING em vez
  // of SUCCESS. Before, IA saw "SUCCESS 0 replacements" e achava que
  // funcionou, mas nada foi alterado. Agora retorna erro claro pra IA
  // entender que o search string não foi encontrado.
  let msg: string;
  if (result.replacements === 0) {
    msg = t("tool.zero_replacements", resolved);
    log.warn(`fileEdit: 0 replacements for ${resolved} — search string not found`);
  } else {
    msg = t("tool.replacements_applied", result.replacements, resolved);
  }
  if (impactHint) {
    msg += `\n\n${impactHint}`;
  }
  if (hookResults) {
    msg += `\n\n${hookResults}`;
  }
  return msg;
  } finally {
    // Always release the file lock (even on early returns above)
    if (releaseLock) releaseLock();
  }
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
