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

import { execSync, spawn } from "node:child_process";
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
  try {
    if (process.platform === "win32") {
      // Use PowerShell — same as executar_comando does.
      // This ensures we get the same PATH the IA sees.
      const result = execSync(
        `powershell -NoProfile -Command "(Get-Command ${toolName} -ErrorAction SilentlyContinue).Source"`,
        {
          encoding: "utf8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "ignore"],
          shell: "powershell.exe",
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
    const result = execSync(`"${binaryPath}" --version`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32" ? "powershell.exe" : undefined,
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

// --- Smart search layer (Option B) ------------------------------------------
//
// Before falling back to the slow full-filesystem scan, we try a layer of
// "smart" lookups that cover ~99% of real-world installations:
//   1. rokit.toml / aftman.toml in cwd and ancestor directories
//   2. Windows registry PATH (HKLM + HKCU) — broader than process PATH
//   3. Package manager queries: scoop list, cargo install --list, winget list
//
// This is fast (~1-3s total) and finds tools that the simple PATH check misses
// because the user's terminal session may not have inherited the full PATH
// (e.g., rokit shims installed after the shell was launched).

/**
 * Walk up from cwd looking for `rokit.toml` or `aftman.toml`.
 * Returns the directory containing the first match, or null if none found.
 *
 * Rokit and Aftman both create a `.rokit/bin/` or `.aftman/bin/` subfolder
 * with the tool binaries — so finding the config file gives us the bin path.
 */
function findToolchainConfig(): { kind: "rokit" | "aftman"; dir: string } | null {
  let dir = process.cwd();
  const home = os.homedir();
  const root = path.parse(dir).root;

  for (let i = 0; i < 20; i++) {
    const rokitToml = path.join(dir, "rokit.toml");
    const aftmanToml = path.join(dir, "aftman.toml");
    if (fs.existsSync(rokitToml)) return { kind: "rokit", dir };
    if (fs.existsSync(aftmanToml)) return { kind: "aftman", dir };
    if (dir === home || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the FULL PATH from the Windows registry (HKLM + HKCU).
 *
 * The process.env.PATH we inherit may be missing entries that were added
 * AFTER the shell was launched (e.g., rokit/scoop installers that update
 * the user PATH but don't affect already-running processes).
 *
 * Returns an array of directories. On non-Windows platforms, returns [].
 */
function getRegistryPathDirs(): string[] {
  if (process.platform !== "win32") return [];

  const dirs: string[] = [];
  // Read both HKLM (system) and HKCU (user) PATH
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const subkey = hive === "HKLM"
        ? "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"
        : "HKCU\\Environment";
      const result = execSync(
        `reg query "${subkey}" /v PATH`,
        { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "ignore"] }
      );
      // Output looks like:
      //   PATH    REG_EXPAND_SZ    C:\foo;C:\bar;...
      const match = result.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      if (match?.[1]) {
        const value = match[1].trim();
        // Expand %VAR% references (e.g., %USERPROFILE%)
        const expanded = expandEnvVars(value);
        dirs.push(...expanded.split(";").map((d) => d.trim()).filter(Boolean));
      }
    } catch {
      // registry read failed — skip this hive
    }
  }
  return dirs;
}

/**
 * Expand %VAR% references in a Windows path string using process.env.
 * Only handles common vars: %USERPROFILE%, %APPDATA%, %LOCALAPPDATA%, %PROGRAMDATA%, %SystemRoot%, %TEMP%.
 */
function expandEnvVars(value: string): string {
  return value
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE ?? os.homedir())
    .replace(/%APPDATA%/gi, process.env.APPDATA ?? "")
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA ?? "")
    .replace(/%PROGRAMDATA%/gi, process.env.PROGRAMDATA ?? "C:\\ProgramData")
    .replace(/%SystemRoot%/gi, process.env.SystemRoot ?? "C:\\Windows")
    .replace(/%TEMP%/gi, process.env.TEMP ?? "");
}

/**
 * Query a package manager for installed tools matching `toolName`.
 * Returns paths to binaries if found, or empty array if not found / not installed.
 *
 * Supports: scoop, cargo, winget. Each is optional — if not installed, silently skipped.
 */
function queryPackageManagers(toolName: string): string[] {
  const found: string[] = [];

  // --- Scoop (Windows) ---
  // `scoop which <tool>` returns the path to the binary
  if (process.platform === "win32") {
    try {
      const result = execSync(`scoop which ${toolName}`, {
        encoding: "utf8", timeout: 4000, stdio: ["pipe", "pipe", "ignore"],
      });
      const p = result.trim().split("\n")[0]?.trim();
      if (p && fs.existsSync(p)) found.push(p);
    } catch { /* scoop not installed or tool not found */ }
  }

  // --- Cargo (Rust tools: selene, stylua, wally, lune) ---
  // `cargo install --list` returns installed packages; we look for toolName in the list
  // and then check ~/.cargo/bin/<toolName>
  try {
    const result = execSync("cargo install --list", {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"],
    });
    // Output format:
    //   selene v0.27.1:
    //     selene
    if (new RegExp(`^${toolName}\\s+v`, "m").test(result)) {
      const cargoBin = path.join(os.homedir(), ".cargo", "bin", process.platform === "win32" ? `${toolName}.exe` : toolName);
      if (fs.existsSync(cargoBin)) found.push(cargoBin);
    }
  } catch { /* cargo not installed */ }

  // --- Winget (Windows) ---
  // We can't easily get a binary path from winget, but we can detect if the package
  // is installed and add the typical install location.
  if (process.platform === "win32") {
    try {
      const result = execSync(`winget list --source winget --disable-interactivity`, {
        encoding: "utf8", timeout: 8000, stdio: ["pipe", "pipe", "ignore"],
      });
      // Look for toolName in the list (case-insensitive)
      if (new RegExp(`\\b${toolName}\\b`, "i").test(result)) {
        // Check common winget install locations
        const candidates = [
          path.join(os.homedir(), "AppData", "Local", "Programs", toolName, `${toolName}.exe`),
          path.join("C:\\Program Files", toolName, `${toolName}.exe`),
          path.join("C:\\Program Files (x86)", toolName, `${toolName}.exe`),
        ];
        for (const c of candidates) {
          if (fs.existsSync(c)) { found.push(c); break; }
        }
      }
    } catch { /* winget not installed */ }
  }

  return found;
}

/**
 * Smart search layer — combines toolchain-config discovery, registry PATH,
 * and package manager queries. Fast (1-3s total).
 *
 * @returns A detection result if the tool was found, or null to fall through
 *          to the slow filesystem scan.
 */
export function smartSearch(toolName: string): ToolDetectionResult | null {
  const searchedPaths: string[] = [];

  // 1. Walk up looking for rokit.toml / aftman.toml
  const config = findToolchainConfig();
  if (config) {
    const binDir = path.join(config.dir, `.${config.kind}`, "bin");
    const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;
    const candidate = path.join(binDir, exeName);
    searchedPaths.push(`[smart] ${config.kind}.toml @ ${config.dir} → ${candidate}`);
    if (isExecutable(candidate)) {
      const version = getVersion(candidate);
      return {
        status: "found",
        binaryPath: candidate,
        version,
        error: null,
        searchedPaths,
      };
    }
  }

  // 2. Registry PATH (Windows) — check each dir for the binary
  if (process.platform === "win32") {
    const dirs = getRegistryPathDirs();
    const exeName = `${toolName}.exe`;
    for (const dir of dirs) {
      const candidate = path.join(dir, exeName);
      searchedPaths.push(`[smart] registry PATH → ${candidate}`);
      if (isExecutable(candidate)) {
        const version = getVersion(candidate);
        if (version) {
          return { status: "found", binaryPath: candidate, version, error: null, searchedPaths };
        }
      }
    }
  }

  // 3. Package manager queries
  const pkgMgrPaths = queryPackageManagers(toolName);
  for (const p of pkgMgrPaths) {
    searchedPaths.push(`[smart] package manager → ${p}`);
    const version = getVersion(p);
    if (version) {
      return { status: "found", binaryPath: p, version, error: null, searchedPaths };
    }
  }

  // Not found via smart layer — return null to fall through
  return null;
}

// --- Extreme filesystem scan (manual, with cancel) -------------------------

/**
 * Enumerate all available drives on the system.
 * Windows: uses `fsutil fsinfo drives` (returns "Drives: C:\ D:\ E:\ ...")
 * Unix: returns ["/"] plus any mount points under /mnt and /media.
 */
function enumerateDrives(): string[] {
  if (process.platform === "win32") {
    try {
      const result = execSync("fsutil fsinfo drives", {
        encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"],
        shell: "cmd.exe",
      });
      // Output: "Drives: C:\ D:\ E:\"
      const match = result.match(/Drives:\s*(.+)/i);
      if (match?.[1]) {
        const drives = match[1].trim().split(/\s+/).filter(Boolean);
        return drives;
      }
    } catch {
      // fsutil may need admin — fall back to common drives
    }
    return ["C:\\", "D:\\", "E:\\", "F:\\"];
  }

  // Unix: scan /, /mnt/*, /media/*
  const drives = ["/"];
  try {
    for (const parent of ["/mnt", "/media"]) {
      if (fs.existsSync(parent)) {
        const entries = fs.readdirSync(parent);
        for (const e of entries) {
          drives.push(path.join(parent, e));
        }
      }
    }
  } catch { /* ignore */ }
  return drives;
}

/**
 * Folders to skip during the extreme filesystem scan.
 * These are system folders that:
 *   - Take forever to scan (Windows, $Recycle.Bin, WinSxS)
 *   - Are guaranteed not to contain user tools
 *   - Often throw permission errors
 */
const SKIP_FOLDERS = new Set([
  "Windows", "$Recycle.Bin", "System Volume Information", "WinSxS",
  "ProgramData", "$Windows.~WS", "$Windows.~BT", "Recovery",
  "node_modules", ".git", "__pycache__", ".venv", "venv",
  "AppData\\Local\\Microsoft\\WindowsApps", // Store apps shims, not real binaries
]);

/**
 * Extreme filesystem scan — searches EVERY drive for the binary.
 *
 * Unlike `deepFilesystemSearch`, this:
 *   - Enumerates ALL drives (not just C/D/E)
 *   - Uses PowerShell `Get-ChildItem -Recurse` on Windows (more reliable than `where /R`)
 *   - Skips system folders that are slow and useless
 *   - Streams progress (current path being scanned)
 *   - Supports AbortSignal for cancellation (Esc to cancel)
 *
 * This is SLOW (1-10 min) but finds binaries ANYWHERE on the system.
 *
 * Only triggered manually by the user pressing 'X' in the Hub.
 */
export async function extremeFilesystemSearch(
  toolName: string,
  onProgress?: (msg: string) => void,
  abortSignal?: { aborted: boolean },
): Promise<ToolDetectionResult | null> {
  const searchedPaths: string[] = [];
  const drives = enumerateDrives();
  const exeName = process.platform === "win32" ? `${toolName}.exe` : toolName;

  onProgress?.(`Unidades detectadas: ${drives.join(", ")}`);

  for (const drive of drives) {
    if (abortSignal?.aborted) {
      onProgress?.("Cancelado pelo usuario");
      return null;
    }

    onProgress?.(`Escaneando ${drive} (isso pode demorar)...`);
    searchedPaths.push(`${drive} (extreme scan)`);

    if (process.platform === "win32") {
      // Use PowerShell Get-ChildItem -Recurse with -ErrorAction SilentlyContinue
      // This is more reliable than `where /R` and shows better progress.
      // We exclude system folders to speed up the scan.
      const excludePatterns = SKIP_FOLDERS.values();
      const excludeClause = Array.from(excludePatterns)
        .map((f) => `-exclude "${f}"`)
        .join(" ");

      try {
        // Stream output line-by-line so we can update progress AND cancel mid-scan
        const result = await runPowerShellScanAsync(
          drive,
          exeName,
          excludeClause,
          abortSignal,
          (currentDir) => onProgress?.(`${drive} → ${currentDir}`),
        );
        if (result) {
          onProgress?.(`Encontrado: ${result}`);
          const version = getVersion(result);
          return {
            status: "found",
            binaryPath: result,
            version,
            error: null,
            searchedPaths,
          };
        }
      } catch {
        // drive doesn't exist or scan failed — continue to next drive
      }
    } else {
      // Unix: use find with -path exclusions
      const excludeArgs = Array.from(SKIP_FOLDERS)
        .map((f) => `-path "*/${f}" -prune`)
        .join(" -o ");

      try {
        const cmd = `find "${drive}" \\( ${excludeArgs} \\) -o -name "${exeName}" -type f -executable -print 2>/dev/null`;
        const result = await runCommandAsync(cmd, abortSignal, (line) => {
          // find doesn't stream directories, just matches — show count
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
        // find failed or was canceled
      }
    }
  }

  onProgress?.(`${toolName}: nao encontrado em nenhuma unidade`);
  return null;
}

/**
 * Run a PowerShell recursive scan asynchronously.
 * Returns the first matching path, or null if none found.
 *
 * We use spawn (not execSync) so the scan can be canceled mid-flight
 * and we can stream progress.
 */
function runPowerShellScanAsync(
  drive: string,
  exeName: string,
  excludeClause: string,
  abortSignal: { aborted: boolean } | undefined,
  onProgress: (currentDir: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    // PowerShell command that outputs matching files one per line.
    // We stream stdout so we can cancel as soon as we see the first match.
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Get-ChildItem -Path '${drive}' -Filter '${exeName}' -Recurse -File ${excludeClause} |
  ForEach-Object {
    Write-Output $_.FullName
    Write-Error "PROGRESS:$($_.DirectoryName)"
  }
`.trim();

    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", psScript,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let firstMatch: string | null = null;
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    // Check for abort every 200ms
    const abortChecker = setInterval(() => {
      if (abortSignal?.aborted) {
        clearInterval(abortChecker);
        finish(null);
      }
    }, 200);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      // Check if we have a complete line with a path
      const lines = stdout.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !firstMatch) {
          firstMatch = trimmed;
          // Cancel the scan — we found what we need
          clearInterval(abortChecker);
          finish(firstMatch);
          return;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      // We use stderr for progress updates (cheaper than mixing with stdout)
      const text = chunk.toString("utf8");
      const match = text.match(/PROGRESS:(.+)/);
      if (match?.[1]) {
        onProgress(match[1].trim());
      }
    });

    child.on("close", () => {
      clearInterval(abortChecker);
      // Process any remaining stdout
      const finalLines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      finish(firstMatch ?? finalLines[0] ?? null);
    });

    child.on("error", () => {
      clearInterval(abortChecker);
      finish(null);
    });

    // Hard timeout: 3 minutes per drive
    setTimeout(() => {
      clearInterval(abortChecker);
      finish(firstMatch);
    }, 180000);
  });
}

/**
 * Run a shell command asynchronously with cancel support.
 */
function runCommandAsync(
  cmd: string,
  abortSignal: { aborted: boolean } | undefined,
  _onProgress: (line: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let resolved = false;

    const finish = (err?: Error | null, result?: string) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(result ?? "");
    };

    const abortChecker = setInterval(() => {
      if (abortSignal?.aborted) {
        clearInterval(abortChecker);
        finish(null, "");
      }
    }, 200);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("close", () => {
      clearInterval(abortChecker);
      finish(null, stdout);
    });
    child.on("error", (err) => {
      clearInterval(abortChecker);
      finish(err);
    });

    setTimeout(() => {
      clearInterval(abortChecker);
      finish(null, stdout);
    }, 180000);
  });
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
 * Pipeline per tool:
 *   1. detectTool() — PATH + common locations (~1s)
 *   2. smartSearch() — rokit/aftman config + registry PATH + package managers (~1-3s)
 *   3. deepFilesystemSearch() — full C:\, D:\, E:\ scan (slow fallback, ~30s-2min)
 *
 * Step 3 (full filesystem scan) is the slowest. The new smartSearch layer
 * (step 2) catches ~99% of real-world cases without needing the slow scan,
 * so the user only waits when the tool is in a really unusual location.
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

    // Step 2: Smart search — rokit/aftman config + registry PATH + package managers
    // This is fast (~1-3s) and catches cases where the PATH inherited by the
    // current process doesn't include shims added by rokit/scoop/etc installers.
    if (detection.status === "missing") {
      onProgress?.({
        currentTool: toolName,
        currentPath: "(camada esperta: rokit.toml, registry PATH, scoop/cargo/winget...)",
        toolsDone: i,
        toolsTotal: toolNames.length,
        results: [...results],
      });

      const smartResult = smartSearch(toolName);
      if (smartResult && smartResult.status === "found") {
        detection = smartResult;
      }
    }

    // Step 2.5: AI-assisted search — ask an LLM for unlikely-but-plausible paths.
    // Fast (3-10s) and catches cases like "user extracted rojo to D:\GameDev\Tools\".
    // Falls back gracefully if AI_SEARCH_ENABLED=false or API key is missing.
    if (detection.status === "missing") {
      onProgress?.({
        currentTool: toolName,
        currentPath: "(camada IA: perguntando ao LLM onde o binario pode estar...)",
        toolsDone: i,
        toolsTotal: toolNames.length,
        results: [...results],
      });

      try {
        const { aiSuggestToolLocation, aiResultToDetectionResult } = await import("./aiSearch.js");
        const aiResult = await aiSuggestToolLocation(toolName, detection.searchedPaths);
        if (aiResult.error) {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA pulada: ${aiResult.error.slice(0, 60)})`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
        } else if (aiResult.verifiedPath) {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA sugeriu: ${aiResult.verifiedPath})`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
          const aiDetection = aiResultToDetectionResult(toolName, aiResult);
          if (aiDetection && aiDetection.status === "found") {
            detection = aiDetection;
          }
        } else {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA sugeriu ${aiResult.suggestions.length} caminhos, nenhum existe)`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
        }
      } catch (err: any) {
        // AI search module failed to load or threw — continue with filesystem scan
        onProgress?.({
          currentTool: toolName,
          currentPath: `(IA falhou: ${(err?.message ?? "").slice(0, 60)})`,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      }
    }

    // Step 3: If still not found, do DEEP filesystem scan
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
 * EXTREME search — straight to full filesystem scan, skipping common locations
 * and the smart layer. Use this when 'S' doesn't find a tool that you KNOW
 * is installed somewhere unusual.
 *
 * Triggered manually by pressing 'X' in the Hub. Supports cancellation via
 * the abortSignal parameter (Esc in the Hub sets aborted=true).
 *
 * Differences vs. searchAllTools:
 *   - Skips the fast common-location check (step 1)
 *   - Skips the smart layer (step 2)
 *   - Uses extremeFilesystemSearch which scans ALL drives (not just C/D/E)
 *   - Uses PowerShell Get-ChildItem (more reliable than `where /R`)
 *   - Skips system folders (Windows, $Recycle.Bin, WinSxS, etc.)
 *   - Streams progress (current folder being scanned)
 *   - Supports Esc-to-cancel
 *
 * @param toolNames  Array of tool binary names to search
 * @param onProgress  Callback called after each tool is searched
 * @param abortSignal  Object whose `aborted` field can be set to true to cancel
 * @returns  Array of search results
 */
export async function extremeSearchAllTools(
  toolNames: string[],
  onProgress?: (progress: SearchProgress) => void,
  abortSignal?: { aborted: boolean },
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (let i = 0; i < toolNames.length; i++) {
    if (abortSignal?.aborted) break;

    const toolName = toolNames[i];

    onProgress?.({
      currentTool: toolName,
      currentPath: "(escaneamento EXTREMO: todas as unidades...)",
      toolsDone: i,
      toolsTotal: toolNames.length,
      results: [...results],
    });

    let detection: ToolDetectionResult | null = null;

    // Step 1: Smart layer first (fast, ~1-3s) — catches most cases
    // Even in extreme mode, we try smart first because it's instant
    // and avoids a 5-min scan if the tool is in a config-defined bin.
    const smartResult = smartSearch(toolName);
    if (smartResult && smartResult.status === "found") {
      detection = smartResult;
    }

    // Step 2: AI-assisted search — ask an LLM for unlikely-but-plausible paths.
    // Much faster (3-10s) than scanning every drive, and often finds the binary
    // in unusual locations like "D:\GameDev\Tools\rojo.exe".
    if (!detection) {
      onProgress?.({
        currentTool: toolName,
        currentPath: "(camada IA: perguntando ao LLM onde o binario pode estar...)",
        toolsDone: i,
        toolsTotal: toolNames.length,
        results: [...results],
      });

      try {
        const { aiSuggestToolLocation, aiResultToDetectionResult } = await import("./aiSearch.js");
        const aiResult = await aiSuggestToolLocation(toolName, []);
        if (aiResult.verifiedPath) {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA sugeriu: ${aiResult.verifiedPath})`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
          const aiDetection = aiResultToDetectionResult(toolName, aiResult);
          if (aiDetection && aiDetection.status === "found") {
            detection = aiDetection;
          }
        } else if (aiResult.error) {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA pulada: ${aiResult.error.slice(0, 60)})`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
        } else {
          onProgress?.({
            currentTool: toolName,
            currentPath: `(IA sugeriu ${aiResult.suggestions.length} caminhos, nenhum existe — indo pro filesystem scan)`,
            toolsDone: i,
            toolsTotal: toolNames.length,
            results: [...results],
          });
        }
      } catch (err: any) {
        onProgress?.({
          currentTool: toolName,
          currentPath: `(IA falhou: ${(err?.message ?? "").slice(0, 60)})`,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      }
    }

    // Step 3: Extreme filesystem scan — ALL drives, with cancel
    if (!detection) {
      const extremeResult = await extremeFilesystemSearch(toolName, (msg) => {
        onProgress?.({
          currentTool: toolName,
          currentPath: msg,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      }, abortSignal);

      if (extremeResult) {
        detection = extremeResult;
      }
    }

    const finalResult: SearchResult = detection
      ? {
          toolName,
          status: detection.status,
          binaryPath: detection.binaryPath,
          version: detection.version,
          searchedPaths: detection.searchedPaths,
        }
      : {
          toolName,
          status: "missing",
          binaryPath: null,
          version: null,
          searchedPaths: ["(extreme scan: nao encontrado em nenhuma unidade)"],
        };
    results.push(finalResult);

    onProgress?.({
      currentTool: toolName,
      currentPath: finalResult.binaryPath ?? "(nao encontrado)",
      toolsDone: i + 1,
      toolsTotal: toolNames.length,
      results: [...results],
    });
  }

  return results;
}

/**
 * AI-ONLY search — uses just the LLM to suggest paths.
 * Much faster than 'S' or 'X' (3-10s total for all tools) but only finds
 * the binary if it's in a location the model can guess.
 *
 * Use this as a quick first pass before falling back to 'S' or 'X'.
 * Triggered by pressing 'A' in the Hub.
 *
 * @param toolNames  Array of tool binary names to search
 * @param onProgress  Callback called after each tool is searched
 * @returns  Array of search results
 */
export async function aiOnlySearchAllTools(
  toolNames: string[],
  onProgress?: (progress: SearchProgress) => void,
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];

  for (let i = 0; i < toolNames.length; i++) {
    const toolName = toolNames[i];

    onProgress?.({
      currentTool: toolName,
      currentPath: "(camada IA: perguntando ao LLM...)",
      toolsDone: i,
      toolsTotal: toolNames.length,
      results: [...results],
    });

    let detection: ToolDetectionResult | null = null;

    try {
      const { aiSuggestToolLocation, aiResultToDetectionResult } = await import("./aiSearch.js");
      const aiResult = await aiSuggestToolLocation(toolName, []);
      if (aiResult.verifiedPath) {
        onProgress?.({
          currentTool: toolName,
          currentPath: `(IA sugeriu: ${aiResult.verifiedPath})`,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
        const aiDetection = aiResultToDetectionResult(toolName, aiResult);
        if (aiDetection && aiDetection.status === "found") {
          detection = aiDetection;
        }
      } else if (aiResult.error) {
        onProgress?.({
          currentTool: toolName,
          currentPath: `(IA pulada: ${aiResult.error.slice(0, 60)})`,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      } else {
        onProgress?.({
          currentTool: toolName,
          currentPath: `(IA sugeriu ${aiResult.suggestions.length} caminhos, nenhum existe)`,
          toolsDone: i,
          toolsTotal: toolNames.length,
          results: [...results],
        });
      }
    } catch (err: any) {
      onProgress?.({
        currentTool: toolName,
        currentPath: `(IA falhou: ${(err?.message ?? "").slice(0, 60)})`,
        toolsDone: i,
        toolsTotal: toolNames.length,
        results: [...results],
      });
    }

    const finalResult: SearchResult = detection
      ? {
          toolName,
          status: detection.status,
          binaryPath: detection.binaryPath,
          version: detection.version,
          searchedPaths: detection.searchedPaths,
        }
      : {
          toolName,
          status: "missing",
          binaryPath: null,
          version: null,
          searchedPaths: ["(IA nao encontrou o binario)"],
        };
    results.push(finalResult);

    onProgress?.({
      currentTool: toolName,
      currentPath: finalResult.binaryPath ?? "(nao encontrado)",
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
