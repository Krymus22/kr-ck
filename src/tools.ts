/**
 * tools.ts - Implementation of the two filesystem tools:
 *   - ler_arquivo(caminho)             -> read a local file
 *   - escrever_arquivo(caminho, conteudo) -> write a local file (with guardrail)
 *
 * Both return a string result that goes back to the model as a "tool" message.
 * The guardrail intercept in escrever_arquivo may return an error string
 * instead of writing the file, triggering an auto-heal loop in the agent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { validateSyntax } from "./guardrail.js";
import { previewAndApprove } from "./diffPreview.js";
import { executePreFileWriteHooks, executePostFileWriteHooks } from "./hooks.js";
import { saveBackup, restoreBackup, listBackups } from "./rollbackStore.js";
import * as log from "./logger.js";
import { t } from "./i18n.js";

// --- ler_arquivo -------------------------------------------------------------

export interface LerArquivoArgs {
  caminho: string;
}

/**
 * Read a file from the local filesystem and return its content as a string.
 * Returns a structured error message if the file cannot be read.
 *
 * Edge case handling (Bug Hunter #9):
 *   - null/undefined/non-string `args.caminho` → returns error (no crash)
 *   - empty string `args.caminho` → returns error (resolves to cwd which is
 *     a directory but reading the cwd as a "file" is misleading)
 *   - broken symlinks inside a directory listing → skip the entry instead
 *     of throwing (previously `fs.statSync(full)` on a broken symlink would
 *     throw and abort the whole listing, hiding all sibling entries)
 */
export async function lerArquivo(args: LerArquivoArgs): Promise<string> {
  // Validate args.caminho BEFORE path.resolve — path.resolve(undefined)
  // throws TypeError synchronously, which would crash the caller instead
  // of returning a graceful error message to the IA.
  if (args == null || typeof args.caminho !== "string" || args.caminho === "") {
    const msg = `[ERROR] ler_arquivo: 'caminho' argument is required (received ${args?.caminho === undefined ? "undefined" : JSON.stringify(args?.caminho)}).`;
    log.toolResult("ler_arquivo", false, "invalid args");
    return msg;
  }

  const resolved = path.resolve(args.caminho);
  log.toolCall("ler_arquivo", { caminho: resolved });

  try {
    if (!fs.existsSync(resolved)) {
      const msg = `[ERROR] File not found: ${resolved}`;
      log.toolResult("ler_arquivo", false, "file not found");
      return msg;
    }

    const stats = fs.statSync(resolved);
    if (stats.isDirectory()) {
      // If path is a directory, list its contents instead.
      // Use lstatSync per entry so broken symlinks don't abort the whole
      // listing — they're shown as `[link]` entries instead of crashing.
      const entries = fs.readdirSync(resolved).map((e) => {
        const full = path.join(resolved, e);
        try {
          const st = fs.lstatSync(full);
          if (st.isSymbolicLink()) return `[link] ${e} ->`;
          if (st.isDirectory()) return `[dir]  ${e}/`;
          return `[file] ${e}`;
        } catch {
          // stat failed (permission denied, broken symlink, etc.) — still
          // show the entry name so the IA knows it exists.
          return `[?]    ${e}`;
        }
      });
      const listing = entries.join("\n");
      log.toolResult("ler_arquivo", true, `directory listing (${entries.length} itens)`);
      return `[DIRECTORY: ${resolved}]\n${listing}`;
    }

    const content = fs.readFileSync(resolved, "utf8");
    log.toolResult("ler_arquivo", true, `${content.length} chars`);
    return content;
  } catch (err) {
    const msg = `[ERROR] Failed to read ${resolved}: ${(err as Error).message}`;
    log.toolResult("ler_arquivo", false, (err as Error).message);
    return msg;
  }
}

// --- escrever_arquivo ---------------------------------------------------------

export interface AplicarDiffArgs {
  caminho: string;
  bloco_diff: string;
}

export interface WriteResult {
  /** true when file was actually written to disk */
  written: boolean;
  /** The tool result string to feed back to the model */
  toolMessage: string;
}

interface DiffBlock {
  search: string;
  replace: string;
}

export function parseDiffBlocks(diffText: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = diffText.split(/\r?\n/);
  
  let currentSearch: string[] = [];
  let currentReplace: string[] = [];
  let inSearch = false;
  let inReplace = false;
  
  for (const line of lines) {
    if (line.trim().startsWith("<<<<<<< SEARCH")) {
      inSearch = true;
      inReplace = false;
      currentSearch = [];
    } else if (line.trim().startsWith("=======")) {
      inSearch = false;
      inReplace = true;
      currentReplace = [];
    } else if (line.trim().startsWith(">>>>>>> REPLACE")) {
      inSearch = false;
      inReplace = false;
      blocks.push({
        search: currentSearch.join("\n"),
        replace: currentReplace.join("\n"),
      });
    } else if (inSearch) {
      currentSearch.push(line);
    } else if (inReplace) {
      currentReplace.push(line);
    }
  }
  
  return blocks;
}

interface NormalizedMap {
  normalizedText: string;
  indexMap: number[];
}

function normalizeWhitespaceWithMap(original: string): NormalizedMap {
  let normalizedText = "";
  const indexMap: number[] = [];
  
  let i = 0;
  while (i < original.length) {
    const char = original[i];
    
    if (/\s/.test(char)) {
      normalizedText += " ";
      indexMap.push(i);
      
      while (i + 1 < original.length && /\s/.test(original[i + 1])) {
        i++;
      }
    } else {
      normalizedText += char;
      indexMap.push(i);
    }
    i++;
  }
  
  return { normalizedText, indexMap };
}

function normalizeText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

export function applyDiffs(original: string, blocks: DiffBlock[]): { success: boolean; content: string; errorBlock?: string } {
  let currentContent = original;
  
  for (const block of blocks) {
    const normalizedSearch = normalizeText(block.search);
    
    if (normalizedSearch === "") {
      // For empty search blocks: if content is empty or contains only whitespace, replace completely.
      // Otherwise, prepend the new code.
      if (currentContent.trim() === "") {
        currentContent = block.replace;
      } else {
        currentContent = block.replace + "\n" + currentContent;
      }
      continue;
    }
    
    const { normalizedText, indexMap } = normalizeWhitespaceWithMap(currentContent);
    const startIdx = normalizedText.indexOf(normalizedSearch);
    if (startIdx === -1) {
      return {
        success: false,
        content: currentContent,
        errorBlock: block.search,
      };
    }
    
    const endIdx = startIdx + normalizedSearch.length;
    const origStart = indexMap[startIdx];
    const lastCharIdx = endIdx - 1;
    const origEndLastChar = indexMap[lastCharIdx];
    const origEnd = origEndLastChar + 1;
    
    currentContent = 
      currentContent.slice(0, origStart) + 
      block.replace + 
      currentContent.slice(origEnd);
  }
  
  return { success: true, content: currentContent };
}

/**
 * Apply a Search & Replace diff to a local file.
 *
 * New flow (write-first, advisory guardrail):
 *  1. Read the current file content.
 *  2. Parse and apply the diff blocks in memory.
 *  3. If SEARCH block not found, return descriptive error (nothing written).
 *  4. Write the patched content DIRECTLY to the real file on disk.
 *  5. Run post-write validation (e.g. npx tsc --noEmit for TS files).
 *  5a. PASS -> return success message.
 *  5b. FAIL -> do NOT revert the file; return an advisory warning with the full
 *      compiler/linter log so the agent can analyse the real error in context
 *      and decide autonomously whether to apply a fix diff or ignore it.
 */
export async function aplicarDiff(
  args: AplicarDiffArgs
): Promise<WriteResult> {
  // Validate args BEFORE path.resolve / .length — both crash on null/undefined.
  // Bug Hunter #9: IA sometimes sends empty args object {} when the schema
  // isn't enforced; previously this threw TypeError synchronously.
  if (args == null || typeof args.caminho !== "string" || args.caminho === "") {
    const msg = `[ERROR] aplicar_diff: 'caminho' argument is required (received ${args?.caminho === undefined ? "undefined" : JSON.stringify(args?.caminho)}).`;
    log.toolResult("aplicar_diff", false, "invalid args (caminho)");
    return { written: false, toolMessage: msg };
  }
  if (typeof args.bloco_diff !== "string") {
    const msg = `[ERROR] aplicar_diff: 'bloco_diff' argument must be a string (received ${args.bloco_diff === undefined ? "undefined" : JSON.stringify(args.bloco_diff)}).`;
    log.toolResult("aplicar_diff", false, "invalid args (bloco_diff)");
    return { written: false, toolMessage: msg };
  }

  const resolved = path.resolve(args.caminho);
  log.toolCall("aplicar_diff", { caminho: resolved, diffLength: args.bloco_diff.length });

  // -- Step 1: Read current file content ------------------------------------
  let originalContent = "";
  if (fs.existsSync(resolved)) {
    try {
      originalContent = fs.readFileSync(resolved, "utf8");
    } catch (err) {
      const msg = `[ERROR] Failed to read arquivo existente ${resolved}: ${(err as Error).message}`;
      log.toolResult("aplicar_diff", false, (err as Error).message);
      return { written: false, toolMessage: msg };
    }
  }

  // -- Step 2: Parse diff blocks ---------------------------------------------
  const blocks = parseDiffBlocks(args.bloco_diff);
  if (blocks.length === 0) {
    const msg = `Error: No valid SEARCH/REPLACE block found in bloco_diff. Make sure to use the structure:\n<<<<<<< SEARCH\n[old code]\n=======\n[new code]\n>>>>>>> REPLACE`;
    log.toolResult("aplicar_diff", false, "no block parsed");
    return { written: false, toolMessage: msg };
  }

  // -- Step 3: Apply diffs in memory -----------------------------------------
  const patchResult = applyDiffs(originalContent, blocks);
  if (!patchResult.success) {
    const searchPart = patchResult.errorBlock ?? "";
    const msg = `Error: SEARCH block not found in the original file. Make sure to copy the snippet exactly as it is.\n\nSEARCH block that failed:\n${searchPart}`;
    log.toolResult("aplicar_diff", false, "SEARCH not found");
    return { written: false, toolMessage: msg };
  }

  const newContent = patchResult.content;

  // -- Step 4: Diff preview + approval ----------------------------------------
  const approved = await previewAndApprove(resolved, originalContent, newContent);
  if (!approved) {
    const msg = `[REJECTED] Diff not applied - user rejected the change in preview.`;
    log.toolResult("aplicar_diff", false, "diff rejected by user");
    return { written: false, toolMessage: msg };
  }

  // -- Step 5: Pre-file-write hooks -----------------------------------------
  const preWriteResult = await executePreFileWriteHooks(resolved, newContent);
  if (preWriteResult.block) {
    const msg = `[BLOCKED] Write prevented by hook: ${preWriteResult.reason ?? "no reason"}`;
    log.toolResult("aplicar_diff", false, "bloqueado por pre-hook");
    return { written: false, toolMessage: msg };
  }
  const contentToWrite = preWriteResult.modifiedContent ?? newContent;

  // -- Step 6: Write to disk -----------------------------------------------
  // Save rollback backup BEFORE writing (only if file already exists)
  let backupId: string | null = null;
  if (originalContent.length > 0) {
    const backup = saveBackup(resolved, originalContent, "aplicar_diff");
    if (backup) backupId = backup.id;
  }

  try {
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, contentToWrite, "utf8");
    log.success(`File written: ${resolved} (${contentToWrite.length} bytes)`);
  } catch (err) {
    // BUG FIX (Error Path Hunter Round 4): On write failure (disk full,
    // EACCES, EISDIR, etc.) the file on disk may be partially written or
    // truncated, leaving it in a corrupted state. The rollback backup was
    // already saved above (saveBackup) — but the original content was NOT
    // restored to disk, so the file stayed corrupted until the user (or IA)
    // manually invoked desfazer_edicao.
    //
    // Now: if we had a non-empty `originalContent` (file existed before),
    // attempt to restore it to disk so the file is left in its pre-edit
    // state. Best-effort — if restore also fails (e.g., disk still full),
    // we log the secondary failure but still report the primary write error.
    let restored = false;
    if (originalContent.length > 0) {
      try {
        fs.writeFileSync(resolved, originalContent, "utf8");
        restored = true;
        log.warn(`[APLICAR_DIFF] Write failed — restored original content for ${resolved}`);
      } catch (restoreErr) {
        log.error(`[APLICAR_DIFF] Write failed AND restore failed for ${resolved}: ${(restoreErr as Error).message}. Backup still available via desfazer_edicao (id=${backupId ?? "n/a"}).`);
      }
    }
    const rollbackNote = originalContent.length > 0
      ? (restored
        ? `\n[ROLLBACK] Original content was restored to disk. Backup id: ${backupId ?? "n/a"}.`
        : `\n[ROLLBACK] Restore failed — backup id ${backupId ?? "n/a"} still available via desfazer_edicao.`)
      : "";
    const msg = `[ERROR] Failed to write ${resolved}: ${(err as Error).message}${rollbackNote}`;
    log.toolResult("aplicar_diff", false, (err as Error).message);
    return { written: false, toolMessage: msg };
  }

  // -- Step 7: Post-file-write hooks ---------------------------------------
  await executePostFileWriteHooks(resolved, contentToWrite);

  // -- Step 8: Post-write validation (advisory) ----------------------------
  const validation = await validateSyntax(resolved, contentToWrite);

  if (!validation.valid) {
    const warnMsg =
      `[POST-WRITE WARNING] File saved successfully, but post-write validation detected issues.\n` +
      `File: ${resolved}\n\n` +
      `Validator error log:\n${validation.errorMessage}\n\n` +
      `The file HAS BEEN SAVED to disk. Analyze the errors above in the real project context ` +
      `and decide whether to apply a fix diff or whether the error can be ignored as a false positive.`;

    log.toolResult(
      "aplicar_diff",
      false,
      `post-write validation: ${validation.errorMessage?.slice(0, 80)}`
    );
    // written = true because the file IS on disk; toolMessage carries the advisory warning
    return { written: true, toolMessage: warnMsg };
  }

  // -- All good --------------------------------------------------------------
  const backupInfo = backupId ? ` Backup salvo: ${backupId}.` : "";
  const msg = `[SUCCESS] Diff applied and file saved: ${resolved} (${newContent.length} bytes). Post-write validation: OK.${backupInfo}`;
  log.toolResult("aplicar_diff", true, `${newContent.length} bytes`);
  return { written: true, toolMessage: msg };
}

// --- desfazer_edicao ----------------------------------------------------------

export interface DesfazerEdicaoArgs {
  /** Absolute or relative path of the file to restore. */
  caminho: string;
}

/**
 * Restore the most recent backup for the given file path.
 * Returns a status message suitable for the model.
 */
export function desfazerEdicao(args: DesfazerEdicaoArgs): string {
  // Validate args before path.resolve (would throw TypeError on null/undefined).
  if (args == null || typeof args.caminho !== "string" || args.caminho === "") {
    log.toolResult("desfazer_edicao", false, "invalid args");
    return t("tool.no_backup_available", args?.caminho ?? "");
  }
  const resolved = path.resolve(args.caminho);
  log.toolCall("desfazer_edicao", { caminho: resolved });

  const ok = restoreBackup(resolved);
  if (ok) {
    return t("tool.file_restored", resolved);
  }

  // List available backups for diagnostics
  const backups = listBackups(resolved);
  if (backups.length === 0) {
    return t("tool.no_backup_available", resolved);
  }

  return t("tool.restore_backup_failed", resolved, backups.length);
}

// --- listar_backups -----------------------------------------------------------

export interface ListarBackupsArgs {
  /** Optional: filter by file path. If omitted, lists all backups. */
  caminho?: string;
}

/**
 * List available rollback backups for a file (or all backups if no path given).
 *
 * Edge case handling (Bug Hunter #4 round 4):
 *   - null/undefined args → list ALL backups (the caminho is optional, so a
 *     missing args object is equivalent to "no filter"). Previously this
 *     threw TypeError on `args.caminho`.
 *   - non-string `args.caminho` (number/object/array) → ignored, treats as
 *     "no filter". Previously `path.resolve(123)` threw TypeError
 *     synchronously because path.resolve only accepts strings/URLs.
 *   - empty string `args.caminho` → same as no filter (lists all).
 */
export function listarBackups(args: ListarBackupsArgs): string {
  // Validate args BEFORE touching args.caminho — both null/undefined and
  // a non-string caminho would crash path.resolve() synchronously, which
  // would crash the caller instead of returning a graceful message.
  // caminho is OPTIONAL per the ListarBackupsArgs interface, so a missing
  // or invalid value simply means "list all backups".
  const caminho = args != null && typeof args.caminho === "string" && args.caminho !== ""
    ? args.caminho
    : undefined;
  const filter = caminho ? path.resolve(caminho) : undefined;
  log.toolCall("listar_backups", { caminho: filter ?? "(todos)" });

  const backups = listBackups(filter);
  if (backups.length === 0) {
    const suffix = filter ? ` for ${filter}` : "";
    return `[INFO] No backup available${suffix}.`;
  }

  const lines = backups.map((b, i) => {
    const time = b.timestamp;
    return `  ${i + 1}. [${b.id}] ${b.originalPath} - ${b.size} bytes - ${b.toolName} - ${time}`;
  });
  return `[INFO] ${backups.length} backup(s) available:\n${lines.join("\n")}`;
}

// --- executar_comando --------------------------------------------------------

export interface ExecutarComandoArgs {
  comando: string;
  /** Optional working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Optional timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

/**
 * Executes a shell command asynchronously with streaming stdout/stderr.
 *
 * Streams output to the optional onStdout / onStderr callbacks so the
 * agent UI can display progress in real time. Captures up to
 * MAX_OUTPUT_BYTES of combined output and returns it when the command
 * completes.
 *
 * Replaces the previous execSync-based implementation - does NOT block
 * the event loop.
 */
export async function executarComando(
  args: ExecutarComandoArgs
): Promise<string> {
  // Validate args BEFORE spawn — spawn(undefined) throws TypeError
  // synchronously, crashing the caller. Empty command on bash just exits 0
  // (no-op), but PowerShell throws, so reject empty too for consistency.
  if (args == null || typeof args.comando !== "string" || args.comando.trim() === "") {
    const msg = t("tool.command_start_failed", "comando is required (empty or non-string)");
    log.toolResult("executar_comando", false, "invalid args");
    return msg;
  }

  // Clamp timeout: negative or zero would fire setTimeout immediately and
  // SIGKILL the child before it even starts. Treat as "use default".
  const cwd = args.cwd ?? process.cwd();
  let timeoutMs = args.timeoutMs ?? 60_000;
  if (typeof timeoutMs !== "number" || !isFinite(timeoutMs) || timeoutMs <= 0) {
    timeoutMs = 60_000;
  }
  const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB cap
  log.toolCall("executar_comando", { comando: args.comando, cwd });

  return new Promise((resolve) => {
    const child = spawn(args.comando, {
      cwd,
      shell: process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stdout.length);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_BYTES - stderr.length);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const output = t("tool.command_start_failed", err.message);
      log.toolResult("executar_comando", false, err.message);
      resolve(output);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

      if (killed) {
        const out = t("tool.command_timeout", timeoutMs, combined);
        log.toolResult("executar_comando", false, "timeout");
        resolve(out);
        return;
      }

      if (code === 0) {
        log.toolResult("executar_comando", true, `exit=0`);
        resolve(combined || t("tool.command_no_output"));
      } else {
        const out = t("tool.command_failed", code, combined);
        log.toolResult("executar_comando", false, `exit=${code}`);
        resolve(out);
      }
    });
  });
}

