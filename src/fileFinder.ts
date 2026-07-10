/**
 * fileFinder.ts — Find tool binaries on the user's machine.
 *
 * Sprint 9: Replaces the old search system (S/A/X keys) with a simpler
 * 2-step approach:
 *   1. searchInDefinedFolders() — fast, checks known locations
 *   2. searchEntireMachine() — slow, scans all drives (needs permission)
 *
 * Used by:
 *   - Mini chat configurator (Sprint 11) — "tenho selene em algum lugar"
 *   - Command /buscar <arquivo> — direct CLI access
 *   - Future: inbox organizer can suggest copying found files
 */

import { execSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export interface SearchResult {
  /** Full path to the found file */
  path: string;
  /** Where it was found (which search location) */
  source: string;
}

export interface SearchProgress {
  /** Current drive/path being scanned */
  current: string;
  /** Number of results found so far */
  found: number;
}

// --- Defined Folders Search (fast) -------------------------------------------

/**
 * Reject file names that contain path separators or traversal characters.
 * Used to harden shell commands (`which ${fileName}`) and path.join() against
 * command injection and path traversal.
 *
 * Bug Hunter #9: previously, a fileName like `foo; rm -rf /` would be
 * interpolated directly into the `which` shell command, allowing arbitrary
 * command execution. A fileName like `../../etc/passwd` would let
 * path.join() escape the target directory. Now we reject these.
 *
 * FIX-SEC Bug #3: the previous blocklist regex missed several dangerous
 * characters: `%` (Windows %VAR% expansion), `"`, `*`, `?`, `[`, `]`, `{`,
 * `}`, `~`, `^`, `=`, and whitespace. Each can either expand into something
 * dangerous (env vars, find globs) or break out of quoting. Switching to a
 * strict allowlist closes all known gaps. Allowed: letters, digits, dot,
 * underscore, hyphen — covers all legitimate tool/file names
 * ("selene", "rojo.exe", "wally-package-types", "my_file.lua").
 */
export function isSafeFileName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  // Allowlist: A-Z, a-z, 0-9, dot, underscore, hyphen only.
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Reject mode names that contain path separators or traversal characters.
 * Bug Hunter #9: previously, a modeName like `../../etc` would let
 * path.join(home, ".claude-killer", "modes", modeName, "tools") escape the
 * intended tools/ directory (resolving to home/.claude-killer/etc/tools).
 *
 * FIX-SEC Bug #2: exported so toolConfigurator.ts and modes.ts can reuse the
 * same strict allowlist before writing mode/manifest files. Allowlist mirrors
 * isSafeFileName (letters, digits, dot, underscore, hyphen).
 */
export function isSafeModeName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Search for a file in known/predefined folders.
 * This is fast (~1s) and doesn't need user permission.
 *
 * Search locations (in order):
 *   1. ~/.claude-killer/modes/<mode>/tools/
 *   2. ~/.claude-killer/modes/<mode>/inbox/
 *   3. ~/.claude-killer/modes/normal/tools/ (base mode)
 *   4. ~/.rokit/bin/ (legacy)
 *   5. ~/.aftman/bin/ (legacy)
 *   6. ~/.cargo/bin/ (legacy)
 *   7. ~/go/bin/ (legacy)
 *   8. System PATH (via which/where)
 */
export function searchInDefinedFolders(
  fileName: string,
  modeName: string | null,
): SearchResult[] {
  // Validate fileName — empty/unsafe fileName would either return the
  // directory itself as a result (empty path.join) or allow command
  // injection via `which ${fileName}`. Bug Hunter #9.
  if (!isSafeFileName(fileName)) {
    log.debug(`[FILE_FINDER] searchInDefinedFolders: rejected unsafe fileName "${fileName}"`);
    return [];
  }
  // Validate modeName (only if provided)
  if (modeName != null && !isSafeModeName(modeName)) {
    log.debug(`[FILE_FINDER] searchInDefinedFolders: rejected unsafe modeName "${modeName}"`);
    return [];
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const platform = process.platform;
  const exeName = platform === "win32" ? `${fileName}.exe` : fileName;

  const results: SearchResult[] = [];

  // Build list of folders to search
  const folders: Array<{ dir: string; label: string }> = [];

  if (modeName) {
    folders.push({ dir: path.join(home, ".claude-killer", "modes", modeName, "tools"), label: `modes/${modeName}/tools` });
    folders.push({ dir: path.join(home, ".claude-killer", "modes", modeName, "inbox"), label: `modes/${modeName}/inbox` });
  }
  folders.push({ dir: path.join(home, ".claude-killer", "modes", "normal", "tools"), label: "modes/normal/tools" });
  folders.push({ dir: path.join(home, ".rokit", "bin"), label: ".rokit/bin" });
  folders.push({ dir: path.join(home, ".aftman", "bin"), label: ".aftman/bin" });
  folders.push({ dir: path.join(home, ".cargo", "bin"), label: ".cargo/bin" });
  folders.push({ dir: path.join(home, "go", "bin"), label: "go/bin" });

  // Search each folder
  for (const { dir, label } of folders) {
    if (!fs.existsSync(dir)) continue;
    const candidate = path.join(dir, exeName);
    if (fs.existsSync(candidate)) {
      results.push({ path: candidate, source: label });
    }
    // Also try without .exe (in case fileName already has extension)
    if (platform === "win32" && exeName !== fileName) {
      const candidate2 = path.join(dir, fileName);
      if (fs.existsSync(candidate2)) {
        results.push({ path: candidate2, source: label });
      }
    }
  }

  // Search PATH (which/where). Use execFileSync with shell:false and pass
  // fileName as a separate argv element to avoid command injection when
  // fileName contains shell metacharacters. Bug Hunter #9.
  //
  // FIX-SEC Bug #4: previously this used execSync with a STRING command (which
  // forces shell:true) and POSIX-style backslash escaping of `"`. On Windows
  // cmd.exe that escaping doesn't work — `\"` is treated literally and a
  // fileName containing `"` could break out of the quote. execFileSync with
  // shell:false bypasses the shell entirely and passes argv directly to the
  // OS, which matches the original comment's intent and is correct on both
  // Windows and POSIX.
  try {
    const cmd = platform === "win32" ? "where" : "which";
    const result = execFileSync(cmd, [fileName], {
      encoding: "utf8",
      timeout: 5000,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!results.some((r) => r.path === line)) {
        results.push({ path: line, source: "PATH" });
      }
    }
  } catch {
    // not in PATH — ignore
  }

  log.debug(`[FILE_FINDER] searchInDefinedFolders("${fileName}"): ${results.length} results`);
  return results;
}

// --- Entire Machine Search (slow, needs permission) --------------------------

/**
 * Search the ENTIRE machine for a file.
 * This is SLOW (30s-5min) and should only run with explicit user permission.
 *
 * Windows: `where /R <drive> <filename>` for each drive (C:\, D:\, etc.)
 * Unix: `find / -name <filename> -type f 2>/dev/null`
 *
 * @param fileName   File to search for (e.g., "selene" or "selene.exe")
 * @param onProgress Callback for progress updates (current path being scanned)
 * @param abortSignal Object with `aborted: boolean` — set to true to cancel
 * @returns Array of results (may be empty)
 */
export async function searchEntireMachine(
  fileName: string,
  onProgress?: (progress: SearchProgress) => void,
  abortSignal?: { aborted: boolean },
): Promise<SearchResult[]> {
  // Validate fileName — same rationale as searchInDefinedFolders: prevents
  // command injection into `find / -name "${exeName}"` and `where /R`.
  // Bug Hunter #9.
  if (!isSafeFileName(fileName)) {
    log.debug(`[FILE_FINDER] searchEntireMachine: rejected unsafe fileName "${fileName}"`);
    return [];
  }

  const platform = process.platform;
  const exeName = platform === "win32" ? `${fileName}.exe` : fileName;
  const results: SearchResult[] = [];

  if (platform === "win32") {
    // Windows: enumerate drives and search each with `where /R`
    const drives = enumerateDrives();
    for (const drive of drives) {
      if (abortSignal?.aborted) break;

      onProgress?.({ current: drive, found: results.length });
      log.debug(`[FILE_FINDER] Scanning ${drive}...`);

      try {
        // Both `drive` and `exeName` are validated/sanitized:
        //   - drive comes from fsutil (or static fallback) — no shell metas
        //   - exeName comes from isSafeFileName-checked fileName
        // We still quote them to be defense-in-depth.
        const safeDrive = drive.replace(/"/g, "");
        const safeExe = exeName.replace(/"/g, "");
        const result = execSync(`where /R "${safeDrive}" "${safeExe}"`, {
          encoding: "utf8",
          timeout: 120000, // 2 min per drive
          stdio: ["pipe", "pipe", "ignore"],
          maxBuffer: 10 * 1024 * 1024,
        });
        const lines = result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!results.some((r) => r.path === line)) {
            results.push({ path: line, source: drive });
          }
        }
      } catch {
        // not found on this drive or timeout
      }
    }
  } else {
    // Unix: use `find /` with exclusions for system dirs
    onProgress?.({ current: "/", found: 0 });
    log.debug(`[FILE_FINDER] Scanning / with find...`);

    try {
      // exeName already validated by isSafeFileName (no quotes, no $, etc.)
      // so double-quoting is safe and prevents wildcard expansion.
      const safeExe = exeName.replace(/"/g, "");
      const result = execSync(
        `find / -name "${safeExe}" -type f \\( -perm -u+x -o -name "*.exe" \\) 2>/dev/null | head -20`,
        {
          encoding: "utf8",
          timeout: 120000,
          stdio: ["pipe", "pipe", "ignore"],
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const lines = result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        results.push({ path: line, source: "/" });
      }
    } catch {
      // find failed or timeout
    }
  }

  onProgress?.({ current: abortSignal?.aborted ? "(cancelled)" : "(done)", found: results.length });
  log.debug(`[FILE_FINDER] searchEntireMachine: ${results.length} results${abortSignal?.aborted ? " (cancelled)" : ""}`);
  return results;
}

/**
 * Enumerate available drives on Windows.
 * Uses `fsutil fsinfo drives` (returns "Drives: C:\ D:\ E:\").
 * Falls back to ["C:\\", "D:\\", "E:\\"] if fsutil fails.
 */
function enumerateDrives(): string[] {
  try {
    const result = execSync("fsutil fsinfo drives", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      shell: "cmd.exe",
    });
    const match = result.match(/Drives:\s*(.+)/i);
    if (match?.[1]) {
      return match[1].trim().split(/\s+/).filter(Boolean);
    }
  } catch {
    // fsutil may need admin — fall back
  }
  return ["C:\\", "D:\\", "E:\\"];
}

// --- High-level search flow --------------------------------------------------

/**
 * Full search flow:
 *   1. Search defined folders (fast, automatic)
 *   2. If not found, ask user permission for full machine search
 *   3. Search entire machine (slow, with progress)
 *
 * @param fileName   File to search for
 * @param modeName   Active mode name
 * @param askPermission  Callback that asks user "search entire machine?" → returns boolean
 * @param onProgress  Progress callback for the machine search
 * @returns Results from whichever step found the file
 */
export async function searchFile(
  fileName: string,
  modeName: string | null,
  askPermission?: () => Promise<boolean>,
  onProgress?: (progress: SearchProgress) => void,
): Promise<{ results: SearchResult[]; searchedEntireMachine: boolean }> {
  // Step 1: Defined folders (fast) — also validates fileName/modeName.
  log.info(`[FILE_FINDER] Step 1: searching defined folders for "${fileName}"...`);
  const definedResults = searchInDefinedFolders(fileName, modeName);

  if (definedResults.length > 0) {
    return { results: definedResults, searchedEntireMachine: false };
  }

  // If fileName was rejected as unsafe, don't proceed to slow machine search.
  if (!isSafeFileName(fileName)) {
    return { results: [], searchedEntireMachine: false };
  }

  // Step 2: Ask permission for full machine search
  if (!askPermission) {
    // No permission callback — just return empty
    return { results: [], searchedEntireMachine: false };
  }

  const permitted = await askPermission();
  if (!permitted) {
    log.info(`[FILE_FINDER] User denied full machine search`);
    return { results: [], searchedEntireMachine: false };
  }

  // Step 3: Full machine search (slow)
  log.info(`[FILE_FINDER] Step 2: searching entire machine for "${fileName}"...`);
  const machineResults = await searchEntireMachine(fileName, onProgress);

  return { results: machineResults, searchedEntireMachine: true };
}

/**
 * Copy a found file to the mode's tools/ directory.
 *
 * @param sourcePath  Path to the found file
 * @param modeName    Target mode name
 * @returns Path where the file was copied, or null on error
 */
export function copyToModeTools(sourcePath: string, modeName: string): string | null {
  // Validate modeName against path traversal. Bug Hunter #9: previously,
  // modeName = "../../etc" would make path.join() escape the intended
  // tools/ directory. Now we reject unsafe mode names.
  if (!isSafeModeName(modeName)) {
    log.error(`[FILE_FINDER] copyToModeTools: rejected unsafe modeName "${modeName}"`);
    return null;
  }
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    log.error(`[FILE_FINDER] copyToModeTools: sourcePath must be a non-empty string`);
    return null;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const toolsDir = path.join(home, ".claude-killer", "modes", modeName, "tools");

  // Defense-in-depth: verify the resolved toolsDir didn't escape the
  // modes/ root (e.g. via a future bypass of isSafeModeName).
  const modesRoot = path.join(home, ".claude-killer", "modes");
  const resolvedTools = path.resolve(toolsDir);
  if (!resolvedTools.startsWith(modesRoot + path.sep) && resolvedTools !== modesRoot) {
    log.error(`[FILE_FINDER] copyToModeTools: resolved toolsDir "${resolvedTools}" escapes modes root`);
    return null;
  }

  // Create tools dir if it doesn't exist
  if (!fs.existsSync(toolsDir)) {
    fs.mkdirSync(toolsDir, { recursive: true });
  }

  const fileName = path.basename(sourcePath);
  const destPath = path.join(toolsDir, fileName);

  try {
    // Don't overwrite if already exists
    if (fs.existsSync(destPath)) {
      log.warn(`[FILE_FINDER] ${fileName} already exists in tools/ — skipping copy`);
      return destPath;
    }

    fs.copyFileSync(sourcePath, destPath);
    log.success(`[FILE_FINDER] Copied ${fileName} → modes/${modeName}/tools/`);
    return destPath;
  } catch (err) {
    log.error(`[FILE_FINDER] Failed to copy: ${(err as Error).message}`);
    return null;
  }
}
