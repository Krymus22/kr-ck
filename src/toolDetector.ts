/**
 * toolDetector.ts — Detection of external tools on the user's machine.
 *
 * Sprint 2 cleanup: the old search layer (smartSearch, deepFilesystemSearch,
 * extremeFilesystemSearch, searchAllTools, extremeSearchAllTools,
 * aiOnlySearchAllTools, and friends) was removed. The new system uses
 * "pasta por modo" (per-mode folders) and does not need to scan the
 * filesystem for binaries.
 *
 * What remains:
 *   - detectTool()             — PATH + common locations (no scanning)
 *   - detectAndVerify()        — detect + functional verify
 *   - verifyToolWorks()        — runs the tool on a minimal test case
 *   - getSearchPathsForTool()  — returns common install locations
 *                                (kept for compatibility / debugging)
 *   - isAutoDetectEnabled()    — checks AUTO_DETECT_TOOLS env var
 *   - extractToolBinaryName()  — "tool:rojo_build" → "rojo"
 *   - getModeToolNames()       — dedupes tool binary names
 *   - findToolBinary()         — NEW: looks in modes/<mode>/tools/ first
 *   - types: ToolStatus, ToolDetectionResult
 *
 * Privacy: auto-detection is OFF by default. The user must opt in via
 * AUTO_DETECT_TOOLS=1. When off, only the PATH is checked.
 *
 * Detection levels:
 *   1. missing   — binary not found anywhere
 *   2. found     — binary exists and `--version` works
 *   3. working   — binary ran on a real test case and produced expected output
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export type ToolStatus = "missing" | "found" | "working";

export interface ToolDetectionResult {
  status: ToolStatus;
  /** Where the binary was found (null if missing). */
  binaryPath: string | null;
  /** Version string from `--version` (null if missing or failed). */
  version: string | null;
  /** Error message if detection failed (null if ok). */
  error: string | null;
  /** Which search locations were tried. */
  searchedPaths: string[];
}

// --- Config ------------------------------------------------------------------

/**
 * Whether deep auto-detection is enabled.
 * OFF by default for privacy. User must set AUTO_DETECT_TOOLS=1.
 *
 * When OFF: only checks PATH (via `which`/`where`).
 * When ON: searches common installation directories.
 */
const AUTO_DETECT_ENABLED = process.env.AUTO_DETECT_TOOLS === "1";

// --- Search paths ------------------------------------------------------------

/**
 * Common installation locations for Roblox/Luau tools.
 * Searched in order — most likely first.
 *
 * These are the standard locations where rokit, aftman, cargo, go install,
 * and manual installations place binaries. We do NOT scan the entire
 * filesystem — only these known directories.
 */
function getSearchPaths(toolName: string): string[] {
  const home = os.homedir();
  const platform = process.platform;

  // On Windows, binaries have .exe extension. On Unix, no extension.
  // BUG FIX (issue #24): previously we used the bare toolName on Windows,
  // so paths like ~/.rokit/bin/rojo (without .exe) would never match the
  // actual file ~/.rokit/bin/rojo.exe. This is why the user's rojo install
  // was never detected despite being in the most common location.
  const binName = platform === "win32" ? `${toolName}.exe` : toolName;

  const paths: string[] = [];

  // 1. ~/.claude-killer/bin/ (our own managed directory)
  paths.push(path.join(home, ".claude-killer", "bin", binName));

  // 2. Rokit (most common for Roblox tools)
  paths.push(path.join(home, ".rokit", "bin", binName));
  // Project-local rokit
  paths.push(path.join(process.cwd(), ".rokit", "bin", binName));

  // 3. Aftman (legacy toolchain manager)
  paths.push(path.join(home, ".aftman", "bin", binName));

  // 4. Cargo (Rust tools: selene, stylua)
  paths.push(path.join(home, ".cargo", "bin", binName));

  // 5. Go bin (selene can be installed via `go install`)
  paths.push(path.join(home, "go", "bin", binName));

  // 6. npm local bin (stylua has npm wrapper)
  paths.push(path.join(process.cwd(), "node_modules", ".bin", binName));

  // 7. System paths (platform-specific)
  if (platform === "win32") {
    paths.push(path.join("C:\\Program Files", toolName, binName));
    paths.push(path.join(home, "scoop", "shims", binName));
    paths.push(path.join(home, "AppData", "Local", "Programs", toolName, binName));
  } else {
    paths.push(`/usr/local/bin/${toolName}`);
    paths.push(`/usr/bin/${toolName}`);
    paths.push(path.join(home, ".local", "bin", toolName));
    // Homebrew (macOS)
    if (platform === "darwin") {
      paths.push(`/opt/homebrew/bin/${toolName}`);
      paths.push(`/usr/local/opt/${toolName}/bin/${toolName}`);
    }
  }

  return paths;
}

// --- Detection ---------------------------------------------------------------

/**
 * Find a binary by searching PATH.
 *
 * On Windows: uses PowerShell (same shell as executar_comando) because
 * PowerShell inherits the FULL PATH including paths added by user profile,
 * rokit shims, cargo installer, etc. Using `cmd.exe` (Node's default
 * for execSync) misses these paths — that's why the IA could find tools
 * but the detector couldn't.
 *
 * On Unix: uses `which` (reliable, inherits shell PATH).
 */
function findInPath(toolName: string): string | null {
  // SECURITY: validate toolName before interpolating into shell command.
  // (CodeQL: js/shell-command-injection-from-environment.)
  // Allow only alphanumerics, dash, underscore, dot — typical binary names.
  if (!/^[A-Za-z0-9._-]+$/.test(toolName)) {
    return null;
  }
  try {
    if (process.platform === "win32") {
      // Use PowerShell — same as executar_comando does.
      // This ensures we get the same PATH the IA sees.
      //
      // IMPORTANT: do NOT set `shell: "powershell.exe"`. Node.js appends
      // cmd.exe-style `/d /s /c` flags to ANY custom shell on Windows, which
      // PowerShell rejects (it interprets `/d` as a path and aborts). Instead
      // we let Node use its default Windows shell (cmd.exe), which hosts the
      // explicit `powershell -NoProfile -Command "..."` invocation correctly.
      // See BH28 (FIX-WINDOWS Bug 1).
      const result = execSync(
        `powershell -NoProfile -Command "(Get-Command ${toolName} -ErrorAction SilentlyContinue).Source"`,
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "ignore"],
        }
      );
      const found = result.trim();
      return found || null;
    } else {
      const result = execSync(`which ${toolName}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "ignore"],
      });
      const found = result.trim().split("\n")[0]?.trim();
      return found || null;
    }
  } catch {
    return null;
  }
}

/**
 * Check if a file exists and is executable (or at least exists on Windows).
 */
function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (process.platform === "win32") {
      return stat.isFile();
    }
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Run `<binary> --version` and return the version string.
 * Returns null if the binary doesn't respond or fails.
 * Uses PowerShell on Windows for consistent PATH resolution.
 */
function getVersion(binaryPath: string): string | null {
  try {
    // On Windows we deliberately do NOT set `shell: "powershell.exe"`.
    // Node.js appends cmd.exe-style `/d /s /c` flags to any custom shell on
    // Windows, which PowerShell rejects. Node's default Windows shell
    // (cmd.exe) handles `"<path>" --version` correctly and inherits the same
    // PATH. See BH28 (FIX-WINDOWS Bug 2).
    const result = execSync(`"${binaryPath}" --version`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    // Extract version number from output (e.g., "rojo 7.6.1" → "7.6.1")
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? result.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect a tool on the user's machine.
 *
 * @param toolName  The binary name (e.g., "rojo", "selene", "stylua")
 * @param options   Optional: forceDeepSearch=true to ignore AUTO_DETECT_TOOLS setting
 *                  (kept for API compatibility — new system does not call this
 *                  flag, but external callers/tests may still pass it)
 * @returns         Detection result with status, path, version
 */
export function detectTool(toolName: string, options?: { forceDeepSearch?: boolean }): ToolDetectionResult {
  const forceDeep = options?.forceDeepSearch ?? false;
  const searchedPaths: string[] = [];

  // Step 1: Always check PATH first (cheap, non-invasive)
  const pathResult = findInPath(toolName);
  if (pathResult) {
    searchedPaths.push(`PATH → ${pathResult}`);
    const version = getVersion(pathResult);
    if (version) {
      return {
        status: "found",
        binaryPath: pathResult,
        version,
        error: null,
        searchedPaths,
      };
    }
  }

  // Step 2: If auto-detect is OFF and not forced, stop here (privacy)
  if (!AUTO_DETECT_ENABLED && !forceDeep) {
    searchedPaths.push("(deep search disabled — set AUTO_DETECT_TOOLS=1)");
    return {
      status: "missing",
      binaryPath: null,
      version: null,
      error: "Not found in PATH. Set AUTO_DETECT_TOOLS=1 to search common locations.",
      searchedPaths,
    };
  }

  // Step 3: Deep search in common locations (most obvious first)
  const searchPaths = getSearchPaths(toolName);
  for (const p of searchPaths) {
    searchedPaths.push(p);
    if (isExecutable(p)) {
      const version = getVersion(p);
      if (version) {
        return {
          status: "found",
          binaryPath: p,
          version,
          error: null,
          searchedPaths,
        };
      }
      // Binary exists but --version failed — might be broken
      return {
        status: "found",
        binaryPath: p,
        version: null,
        error: `Binary found at ${p} but --version failed (may be broken)`,
        searchedPaths,
      };
    }
  }

  // Step 4: Windows extra search — check common download locations
  if (process.platform === "win32") {
    const home = os.homedir();
    const extraPaths = [
      path.join(home, "Downloads", toolName, `${toolName}.exe`),
      path.join(home, "Downloads", `${toolName}.exe`),
      path.join(home, "Desktop", toolName, `${toolName}.exe`),
      path.join(home, "Documents", toolName, `${toolName}.exe`),
      path.join(home, "Tools", toolName, `${toolName}.exe`),
      path.join(home, "Tools", `${toolName}.exe`),
      path.join("C:\\Tools", toolName, `${toolName}.exe`),
      path.join("C:\\Tools", `${toolName}.exe`),
      path.join("D:\\Tools", toolName, `${toolName}.exe`),
      path.join("D:\\Tools", `${toolName}.exe`),
      path.join("C:\\Users", os.userInfo().username, "scoop", "apps", toolName, "current", `${toolName}.exe`),
    ];
    for (const p of extraPaths) {
      searchedPaths.push(p);
      if (isExecutable(p)) {
        const version = getVersion(p);
        if (version) {
          return { status: "found", binaryPath: p, version, error: null, searchedPaths };
        }
        return { status: "found", binaryPath: p, version: null, error: `Found at ${p} but --version failed`, searchedPaths };
      }
    }
  }

  // Not found in common locations
  return {
    status: "missing",
    binaryPath: null,
    version: null,
    error: `Not found in PATH or common locations (${searchedPaths.length} locations checked)`,
    searchedPaths,
  };
}

// --- Functional verification -------------------------------------------------

/**
 * Verify that a tool actually WORKS by running it on a test case.
 *
 * This goes beyond `--version` — it runs the tool on real input and
 * checks the output. This catches:
 *   - Broken installations (binary exists but crashes)
 *   - Missing config files (selene without selene.toml)
 *   - Wrong architecture (x86 binary on ARM)
 *   - Corrupted downloads
 *
 * @param toolName  The tool name (e.g., "selene", "stylua", "rojo")
 * @param binaryPath  Full path to the binary
 * @returns  true if the tool works correctly, false otherwise
 */
export async function verifyToolWorks(toolName: string, binaryPath: string): Promise<{ works: boolean; error?: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-verify-"));

  try {
    switch (toolName) {
      case "selene": {
        // Write a valid .luau file and run selene on it.
        // Sprint B (BUG-B fix): --no-global-check não existe em selene 0.28.0+.
        // Usar apenas --quiet (que existe em todas as versões suportadas).
        const testFile = path.join(tmpDir, "test.luau");
        fs.writeFileSync(testFile, "local x = 1\nprint(x)\n", "utf8");
        try {
          execSync(`"${binaryPath}" --quiet "${testFile}"`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          return { works: true };
        } catch (err: any) {
          // Selene returns non-zero on lint errors, but a VALID file should pass.
          // If it fails even on valid code, the installation is broken.
          return { works: false, error: `selene failed on valid test code: ${err.message}` };
        }
      }

      case "stylua": {
        // Write a well-formatted .luau file and run stylua --check
        const testFile = path.join(tmpDir, "test.luau");
        fs.writeFileSync(testFile, "local x = 1\nprint(x)\n", "utf8");
        try {
          execSync(`"${binaryPath}" --check "${testFile}"`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          return { works: true };
        } catch (err: any) {
          return { works: false, error: `stylua --check failed on valid code: ${err.message}` };
        }
      }

      case "rojo": {
        // Create a minimal Rojo project and try to build it
        const projectDir = path.join(tmpDir, "rojo-test");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(
          path.join(projectDir, "default.project.json"),
          JSON.stringify({
            name: "test",
            tree: { $className: "DataModel", ReplicatedStorage: {} },
          }),
          "utf8"
        );
        try {
          execSync(`"${binaryPath}" build "${path.join(projectDir, "default.project.json")}" -o "${path.join(tmpDir, "test.rbxl")}"`, {
            encoding: "utf8",
            timeout: 10000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          // Check that the output file was created
          if (fs.existsSync(path.join(tmpDir, "test.rbxl"))) {
            return { works: true };
          }
          return { works: false, error: "rojo build completed but no output file was created" };
        } catch (err: any) {
          return { works: false, error: `rojo build failed: ${err.message}` };
        }
      }

      case "lune": {
        // Write a minimal Lune script and run it
        const testFile = path.join(tmpDir, "test.luau");
        fs.writeFileSync(testFile, 'print("hello from lune")\nreturn 0\n', "utf8");
        try {
          execSync(`"${binaryPath}" run "${testFile}"`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          return { works: true };
        } catch (err: any) {
          return { works: false, error: `lune run failed: ${err.message}` };
        }
      }

      case "wally": {
        // Just check --version works (wally needs a manifest to actually run)
        try {
          execSync(`"${binaryPath}" --version`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          return { works: true };
        } catch (err: any) {
          return { works: false, error: `wally --version failed: ${err.message}` };
        }
      }

      default: {
        // For unknown tools, just check --version
        try {
          execSync(`"${binaryPath}" --version`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "ignore"],
          });
          return { works: true };
        } catch (err: any) {
          return { works: false, error: `${toolName} --version failed: ${err.message}` };
        }
      }
    }
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Full detection + verification pipeline.
 *
 * 1. Detect the tool (PATH + deep search if enabled)
 * 2. If found, verify it actually works on a test case
 * 3. Return the final status
 */
export async function detectAndVerify(toolName: string): Promise<ToolDetectionResult & { verified: boolean }> {
  const detection = detectTool(toolName);

  if (detection.status === "missing") {
    return { ...detection, verified: false };
  }

  // Found — now verify it works
  const verification = await verifyToolWorks(toolName, detection.binaryPath!);

  if (verification.works) {
    return { ...detection, status: "working", verified: true };
  }

  return {
    ...detection,
    status: "found",
    verified: false,
    error: verification.error ?? "Tool found but verification failed",
  };
}

/**
 * Get the list of search paths for a tool (for debugging/display).
 */
export function getSearchPathsForTool(toolName: string): string[] {
  return getSearchPaths(toolName);
}

/**
 * Check if auto-detection is enabled.
 */
export function isAutoDetectEnabled(): boolean {
  return AUTO_DETECT_ENABLED;
}

// --- Mode helpers ------------------------------------------------------------

/**
 * Get tool names from mode tool IDs.
 * "tool:rojo_build" → "rojo"
 * "tool:selene_lint" → "selene"
 * "tool:wally_install" → "wally"
 */
export function extractToolBinaryName(toolId: string): string {
  return toolId
    .replace(/^tool:/, "")
    .replace(/_(build|serve|sourcemap|install|search|publish|lint|format|run|process|add)$/, "")
    .replace(/_/g, "-"); // underscores → dashes (e.g. wally_package_types → wally-package-types). See BH28 (FIX-WINDOWS Bug 3).
}

/**
 * Get all tool binary names needed by a mode.
 */
export function getModeToolNames(modeToolIds: string[]): string[] {
  const names = modeToolIds.map(extractToolBinaryName);
  // Deduplicate (rojo_build and rojo_serve both map to "rojo")
  return [...new Set(names)];
}

// --- Mode-based tool binary finder (Sprint 2) --------------------------------

/**
 * Find a tool binary in the mode's tools/ folder.
 *
 * Sprint 2: replaces the old 1500-line search system.
 * Instead of scanning 15+ locations, we look in ONE place:
 *   ~/.claude-killer/modes/<mode>/tools/<name>.exe (Windows)
 *   ~/.claude-killer/modes/<mode>/tools/<name>     (Unix)
 *
 * If not found there, falls back to detectTool() (PATH + common locations)
 * for backward compatibility.
 *
 * @param toolName  Binary name (e.g., "rojo", "selene")
 * @param modeName  Active mode name (e.g., "roblox"). If null, skips mode folder.
 * @returns Full path to binary, or null if not found.
 */
export function findToolBinary(toolName: string, modeName: string | null): string | null {
  if (!toolName) return null;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;

  // 1. Look in mode's tools/ folder first (new system)
  if (modeName) {
    const modeToolPath = path.join(home, ".claude-killer", "modes", modeName, "tools", exeName);
    if (fs.existsSync(modeToolPath)) {
      log.debug(`[TOOL_FINDER] Found ${toolName} in mode ${modeName}: ${modeToolPath}`);
      return modeToolPath;
    }
  }

  // 2. Look in "normal" mode's tools/ folder (base mode — always inherited)
  const normalToolPath = path.join(home, ".claude-killer", "modes", "normal", "tools", exeName);
  if (fs.existsSync(normalToolPath)) {
    log.debug(`[TOOL_FINDER] Found ${toolName} in normal mode: ${normalToolPath}`);
    return normalToolPath;
  }

  // 3. Fallback: old detectTool() (PATH + common locations)
  // This is kept for backward compatibility during migration.
  // Will be removed in a future sprint once all users migrate.
  const detection = detectTool(toolName, { forceDeepSearch: true });
  if (detection.binaryPath) {
    log.debug(`[TOOL_FINDER] Found ${toolName} via legacy detectTool: ${detection.binaryPath}`);
    return detection.binaryPath;
  }

  log.debug(`[TOOL_FINDER] ${toolName} not found (mode: ${modeName ?? "none"})`);
  return null;
}

/**
 * Get the path to a mode's tools/ directory.
 * Returns the user's ~/.claude-killer/modes/<mode>/tools/ path.
 */
export function getModeToolsDir(modeName: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".claude-killer", "modes", modeName, "tools");
}

/**
 * List all tools (binaries) in a mode's tools/ folder.
 * Returns array of { name, path } for each file found.
 */
export function listModeTools(modeName: string): Array<{ name: string; path: string }> {
  const toolsDir = getModeToolsDir(modeName);
  if (!fs.existsSync(toolsDir)) return [];

  const results: Array<{ name: string; path: string }> = [];
  for (const file of fs.readdirSync(toolsDir)) {
    const filePath = path.join(toolsDir, file);
    try {
      if (fs.statSync(filePath).isFile()) {
        // Strip .exe extension on Windows for the name
        const name = process.platform === "win32" ? file.replace(/\.exe$/i, "") : file;
        results.push({ name, path: filePath });
      }
    } catch {
      // skip files that can't be stat'd
    }
  }
  return results;
}
