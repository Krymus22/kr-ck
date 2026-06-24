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

// --- ler_arquivo -------------------------------------------------------------

export interface LerArquivoArgs {
  caminho: string;
}

/**
 * Read a file from the local filesystem and return its content as a string.
 * Returns a structured error message if the file cannot be read.
 */
export async function lerArquivo(args: LerArquivoArgs): Promise<string> {
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
      // If path is a directory, list its contents instead
      const entries = fs.readdirSync(resolved).map((e) => {
        const full = path.join(resolved, e);
        return fs.statSync(full).isDirectory() ? `[dir]  ${e}/` : `[file] ${e}`;
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
    const msg = `[ERROR] Failed to write ${resolved}: ${(err as Error).message}`;
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
  const resolved = path.resolve(args.caminho);
  log.toolCall("desfazer_edicao", { caminho: resolved });

  const ok = restoreBackup(resolved);
  if (ok) {
    return `[SUCCESS] File restored from backup: ${resolved}`;
  }

  // List available backups for diagnostics
  const backups = listBackups(resolved);
  if (backups.length === 0) {
    return `[ERROR] No backup available for ${resolved}. ` +
      `Backups are created automatically before each successful aplicar_diff / editar_arquivo on existing files, ` +
      `and expire after 5 minutes.`;
  }

  return `[ERROR] Failed to restore backup for ${resolved}. ` +
    `There are ${backups.length} backup(s) registered but the restore failed (backup file may be corrupted or missing).`;
}

// --- listar_backups -----------------------------------------------------------

export interface ListarBackupsArgs {
  /** Optional: filter by file path. If omitted, lists all backups. */
  caminho?: string;
}

/**
 * List available rollback backups for a file (or all backups if no path given).
 */
export function listarBackups(args: ListarBackupsArgs): string {
  const filter = args.caminho ? path.resolve(args.caminho) : undefined;
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
  const cwd = args.cwd ?? process.cwd();
  const timeoutMs = args.timeoutMs ?? 60_000;
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
      const output = `[ERROR] Failed to start command: ${err.message}`;
      log.toolResult("executar_comando", false, err.message);
      resolve(output);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

      if (killed) {
        const out = `[ERROR] Command exceeded timeout of ${timeoutMs}ms and was killed.\n${combined}`;
        log.toolResult("executar_comando", false, "timeout");
        resolve(out);
        return;
      }

      if (code === 0) {
        log.toolResult("executar_comando", true, `exit=0`);
        resolve(combined || "[OK] Command completed with no output.");
      } else {
        const out = `[ERROR] Command failed (exit=${code}):\n${combined}`;
        log.toolResult("executar_comando", false, `exit=${code}`);
        resolve(out);
      }
    });
  });
}

