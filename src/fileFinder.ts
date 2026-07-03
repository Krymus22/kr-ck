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

import { execSync, spawn } from "node:child_process";
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

  // Search PATH (which/where)
  try {
    const cmd = platform === "win32" ? "where" : "which";
    const result = execSync(`${cmd} ${fileName}`, {
      encoding: "utf8",
      timeout: 5000,
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
        const result = execSync(`where /R "${drive}" "${exeName}"`, {
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
      const result = execSync(
        `find / -name "${exeName}" -type f \\( -perm -u+x -o -name "*.exe" \\) 2>/dev/null | head -20`,
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
  // Step 1: Defined folders (fast)
  log.info(`[FILE_FINDER] Step 1: searching defined folders for "${fileName}"...`);
  const definedResults = searchInDefinedFolders(fileName, modeName);

  if (definedResults.length > 0) {
    return { results: definedResults, searchedEntireMachine: false };
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
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const toolsDir = path.join(home, ".claude-killer", "modes", modeName, "tools");

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
