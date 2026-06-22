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
    return `[ERRO] Não foi possível obter lock no arquivo: ${(err as Error).message}`;
  }

  try {
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

  // --- Impact analysis (NEW) ---
  // Before writing, find all OTHER files in the project that reference
  // symbols defined in this file. Inject as a hint to the AI.
  // Non-blocking - never aborts the write, just adds context.
  let impactHint = "";
  try {
    const { analyzeImpact, formatImpactHint } = await import("./impactAnalyzer.js");
    const report = await analyzeImpact(resolved);
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
        return `[ERRO] Validação bloqueou a edição. Corrija os erros abaixo e tente novamente:\n\n${validation.blockingError}`;
      }

      // Log non-blocking warnings but proceed with the write
      for (const w of validation.warnings) {
        log.warn(`[validator] ${w}`);
      }

      // Append validation summary to the result so the AI (and user) can see
      // what was validated and what was skipped. This makes the validation
      // process VISIBLE instead of silent.
      if (validation.rulesApplied.length > 0 || validation.rulesSkipped.length > 0) {
        const applied = validation.rulesApplied.length > 0
          ? `validado por: ${validation.rulesApplied.join(", ")}`
          : "";
        const skipped = validation.rulesSkipped.length > 0
          ? `pulado: ${validation.rulesSkipped.join(", ")}`
          : "";
        const summary = [applied, skipped].filter(Boolean).join(" | ");
        if (summary) {
          result.content += `\n\n[VALIDAÇÃO] ${summary}`;
        }
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
            return `[ERRO] Revisor de segurança bloqueou a edição.\n\n${msg}`;
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

  // Backup original
  if (options?.backup && fs.existsSync(resolved)) {
    const backupPath = resolved + ".bak";
    fs.writeFileSync(backupPath, original, "utf8");
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
        return `[ERRO] Hook bloqueou: ${hr.message ?? "(no message)"}`;
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

  // Write
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, result.content, "utf8");

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

  // -- IDEIA 12 Honesty: Mark file as edited (for Read-Back Verification) --
  try {
    const { markFileAsEdited } = await import("./honestySystem.js");
    markFileAsEdited(resolved);
  } catch { /* honestySystem not available */ }

  // -- IDEIA 12 Honesty: Diff Reality Check --
  // Read file back and verify keywords the AI mentioned are actually present.
  try {
    const { diffRealityCheck } = await import("./honestySystem.js");
    const diffCheck = await diffRealityCheck(resolved, result.content);
    if (!diffCheck.matches && diffCheck.message) {
      log.warn(`[HONESTY:DiffCheck] ${diffCheck.message}`);
      // Append warning to success message so AI sees it
      // (Don't block the write - just inform)
    }
  } catch { /* honestySystem not available */ }

  // -- IDEIA 12 Honesty: Hallucination Detector --
  // Check if symbols used in the code actually exist.
  try {
    const { detectHallucinations } = await import("./honestySystem.js");
    const hallucinationCheck = await detectHallucinations(resolved, result.content);
    if (hallucinationCheck.hallucinatedSymbols.length > 0 && hallucinationCheck.message) {
      log.warn(`[HONESTY:Hallucination] ${hallucinationCheck.message}`);
    }
  } catch { /* honestySystem not available */ }

  // -- IDEIA 24: Import Resolver --
  // After writing, verify that imports resolve to existing files and export
  // the symbols used.
  try {
    const { checkImports } = await import("./importResolver.js");
    const importCheck = checkImports(resolved, result.content);
    if (!importCheck.ok && importCheck.message) {
      log.warn(`[IMPORT_RESOLVER] ${importCheck.message}`);
    }
  } catch { /* importResolver not available */ }

  // Run post-edit hooks (externalized via mode.hooks.postEdit)
  // Typical use: auto-format the file that was just written (terraform fmt, black, etc)
  let hookResults = "";
  try {
    const { runPostEditHooks } = await import("./modeExtensions.js");
    hookResults = await runPostEditHooks(resolved);
  } catch (err) {
    log.debug(`fileEdit: post-edit hooks skipped: ${(err as Error).message}`);
  }

  // Build success message - append impact hint + hook results
  let msg = `[SUCESSO] ${result.replacements}substituições(s) aplicada(s) em ${resolved}`;
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
