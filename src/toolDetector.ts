/**
 * toolDetector.ts — Deep detection of external tools on the user's machine.
 *
 * Replaces the simple `tool --version` check in externalTools.ts with a
 * multi-path search that looks in all common installation locations.
 *
 * Privacy: auto-detection is OFF by default. The user must opt in via
 * AUTO_DETECT_TOOLS=1 env var. When off, only the PATH is checked (same
 * behavior as before — no regression). When on, the detector searches
 * common locations but does NOT scan the entire filesystem.
 *
 * Detection levels:
 *   1. missing   — binary not found anywhere
 *   2. found     — binary exists and `--version` works
 *   3. working   — binary ran on a real test case and produced expected output
 *
 * The "working" level is verified by running the tool on a minimal test
 * case (e.g., selene on a 1-line .luau file, rojo build on a minimal project).
 * This catches broken installations, wrong versions, missing configs.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

  const paths: string[] = [];

  // 1. ~/.claude-killer/bin/ (our own managed directory)
  paths.push(path.join(home, ".claude-killer", "bin", toolName));

  // 2. Rokit (most common for Roblox tools)
  paths.push(path.join(home, ".rokit", "bin", toolName));
  // Project-local rokit
  paths.push(path.join(process.cwd(), ".rokit", "bin", toolName));

  // 3. Aftman (legacy toolchain manager)
  paths.push(path.join(home, ".aftman", "bin", toolName));

  // 4. Cargo (Rust tools: selene, stylua)
  paths.push(path.join(home, ".cargo", "bin", toolName));

  // 5. Go bin (selene can be installed via `go install`)
  paths.push(path.join(home, "go", "bin", toolName));

  // 6. npm local bin (stylua has npm wrapper)
  paths.push(path.join(process.cwd(), "node_modules", ".bin", toolName));

  // 7. System paths (platform-specific)
  if (platform === "win32") {
    paths.push(path.join("C:\\Program Files", toolName, `${toolName}.exe`));
    paths.push(path.join(home, "scoop", "shims", `${toolName}.exe`));
    paths.push(path.join(home, "AppData", "Local", "Programs", toolName, `${toolName}.exe`));
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
 * Find a binary by searching PATH (via `which` on Unix, `where` on Windows).
 * Returns the full path or null.
 */
function findInPath(toolName: string): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = execSync(`${cmd} ${toolName}`, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const found = result.trim().split("\n")[0]?.trim();
    return found || null;
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
 */
function getVersion(binaryPath: string): string | null {
  try {
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
 *                  (used by the manual "S" search button in the Hub)
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
    searchedPaths.push("(deep search disabled — set AUTO_DETECT_TOOLS=1 or use manual search)");
    return {
      status: "missing",
      binaryPath: null,
      version: null,
      error: "Not found in PATH. Press S in Hub for manual deep search.",
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

// --- Deep filesystem scan ---------------------------------------------------

/**
 * Scan the ENTIRE filesystem for a binary.
 *
 * On Windows: uses `where /R <drive> <name>.exe` for each drive (C:\, D:\, etc.)
 * On Unix: uses `find / -name <name> -type f 2>/dev/null`
 *
 * This is SLOW (30s-5min depending on drive size) but finds binaries
 * ANYWHERE on the machine — even in unusual locations like
 * C:\Users\kryst\Projects\MyGame\tools\rojo.exe
 *
 * Only triggered manually by the user pressing 'S' in the Hub.
 * Never runs automatically.
 *
 * @param toolName  Binary name (e.g., "rojo")
 * @param onProgress  Callback for progress updates
 * @returns  Detection result or null if not found
 */
export async function deepFilesystemSearch(
  toolName: string,
  onProgress?: (msg: string) => void,
): Promise<ToolDetectionResult | null> {
  const searchedPaths: string[] = [];

  if (process.platform === "win32") {
    // Windows: use `where /R <drive> <name>.exe` for each drive
    // `where /R` recursively searches from a root path
    const drives = ["C:\\", "D:\\", "E:\\"];
    const exeName = `${toolName}.exe`;

    for (const drive of drives) {
      onProgress?.(`Escaneando ${drive}...`);
      searchedPaths.push(`${drive} (where /R scan)`);

      try {
        const result = execSync(`where /R "${drive}" "${exeName}"`, {
          encoding: "utf8",
          timeout: 120000, // 2 min per drive
          stdio: ["pipe", "pipe", "ignore"],
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large outputs
        });

        // `where /R` returns one path per line
        const lines = result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) {
          const binaryPath = lines[0]!;
          onProgress?.(`Encontrado: ${binaryPath}`);
          const version = getVersion(binaryPath);
          return {
            status: "found",
            binaryPath,
            version,
            error: null,
            searchedPaths,
          };
        }
      } catch {
        // Not found on this drive (or drive doesn't exist, or timeout)
      }
    }
  } else {
    // Unix: use `find / -name <name> -type f`
    onProgress?.(`Escaneando / (find)...`);
    searchedPaths.push("/ (find scan)");

    try {
      const result = execSync(`find / -name "${toolName}" -type f -executable 2>/dev/null`, {
        encoding: "utf8",
        timeout: 120000,
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      });

      const lines = result.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        const binaryPath = lines[0]!;
        onProgress?.(`Encontrado: ${binaryPath}`);
        const version = getVersion(binaryPath);
        return {
          status: "found",
          binaryPath,
          version,
          error: null,
          searchedPaths,
        };
      }
    } catch {
      // find failed or timeout
    }
  }

  onProgress?.(`${toolName}: nao encontrado em nenhum lugar`);
  return null;
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
        // Write a valid .luau file and run selene on it
        const testFile = path.join(tmpDir, "test.luau");
        fs.writeFileSync(testFile, "local x = 1\nprint(x)\n", "utf8");
        try {
          execSync(`"${binaryPath}" --no-global-check --quiet "${testFile}"`, {
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

// --- Batch search (for manual Hub button) -----------------------------------

export interface SearchResult {
  toolName: string;
  status: ToolStatus;
  binaryPath: string | null;
  version: string | null;
  searchedPaths: string[];
}

export interface SearchProgress {
  currentTool: string;
  currentPath: string;
  toolsDone: number;
  toolsTotal: number;
  results: SearchResult[];
}

/**
 * Search for multiple tools in sequence, calling onProgress after each one.
 * Always does deep search (ignores AUTO_DETECT_TOOLS setting) because this
 * is triggered manually by the user pressing 'S' in the Hub.
 *
 * @param toolNames  Array of tool binary names to search (e.g., ["rojo", "selene"])
 * @param onProgress  Callback called after each tool is searched
 * @returns  Array of search results
 */
export async function searchAllTools(
  toolNames: string[],
  onProgress?: (progress: SearchProgress) => void,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (let i = 0; i < toolNames.length; i++) {
    const toolName = toolNames[i];

    // Report: starting search for this tool
    onProgress?.({
      currentTool: toolName,
      currentPath: "(buscando em locais comuns...)",
      toolsDone: i,
      toolsTotal: toolNames.length,
      results: [...results],
    });

    // Step 1: Search common locations (fast, ~1s per tool)
    let detection = detectTool(toolName, { forceDeepSearch: true });

    // Step 2: If not found in common locations, do DEEP filesystem scan
    // This searches the ENTIRE C:\, D:\, etc. (slow but thorough)
    if (detection.status === "missing") {
      onProgress?.({
        currentTool: toolName,
        currentPath: "(escaneando filesystem inteiro...)",
        toolsDone: i,
        toolsTotal: toolNames.length,
        results: [...results],
      });

      const deepResult = await deepFilesystemSearch(toolName, (msg) => {
        onProgress?.({
          currentTool: toolName,
          currentPath: msg,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      });

      if (deepResult) {
        detection = deepResult;
      }
    }

    const result: SearchResult = {
      toolName,
      status: detection.status,
      binaryPath: detection.binaryPath,
      version: detection.version,
      searchedPaths: detection.searchedPaths,
    };
    results.push(result);

    // Report: done with this tool
    onProgress?.({
      currentTool: toolName,
      currentPath: detection.binaryPath ?? "(nao encontrado)",
      toolsDone: i + 1,
      toolsTotal: toolNames.length,
      results: [...results],
    });
  }

  return results;
}

/**
 * Get tool names from mode tool IDs.
 * "tool:rojo_build" → "rojo"
 * "tool:selene_lint" → "selene"
 * "tool:wally_install" → "wally"
 */
export function extractToolBinaryName(toolId: string): string {
  return toolId
    .replace(/^tool:/, "")
    .replace(/_(build|serve|sourcemap|install|search|publish|lint|format|run|process|add)$/, "");
}

/**
 * Get all tool binary names needed by a mode.
 */
export function getModeToolNames(modeToolIds: string[]): string[] {
  const names = modeToolIds.map(extractToolBinaryName);
  // Deduplicate (rojo_build and rojo_serve both map to "rojo")
  return [...new Set(names)];
}
