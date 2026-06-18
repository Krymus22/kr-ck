/**
 * toolInstaller.ts — Auto-install external tools from GitHub Releases.
 *
 * When a tool is missing, the user (or the AI) can trigger installation.
 * This module:
 *   1. Queries GitHub Releases API for the latest version
 *   2. Downloads the correct binary for the user's platform
 *   3. Installs to ~/.claude-killer/bin/ (safe, no sudo needed)
 *   4. Makes it executable (chmod +x on Unix)
 *   5. Verifies the installation works
 *
 * Privacy: installation requires explicit action. The tool is NOT
 * auto-installed without the user's consent.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as https from "node:https";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as log from "./logger.js";
import { detectAndVerify } from "./toolDetector.js";

// --- Types -------------------------------------------------------------------

export interface InstallResult {
  success: boolean;
  toolName: string;
  version: string | null;
  binaryPath: string | null;
  error?: string;
}

export interface GitHubRelease {
  tagName: string;
  assets: Array<{
    name: string;
    browserDownloadUrl: string;
    size: number;
  }>;
}

// --- Config ------------------------------------------------------------------

/** Directory where we install tools. */
const INSTALL_DIR = path.join(os.homedir(), ".claude-killer", "bin");

/** GitHub API base URL. */
const GITHUB_API = "https://api.github.com";

/**
 * Map tool names to their GitHub repos.
 * This tells the installer where to download from.
 */
const TOOL_REPOS: Record<string, { owner: string; repo: string; binaryName: string }> = {
  rojo: { owner: "rojo-rbx", repo: "rojo", binaryName: "rojo" },
  selene: { owner: "Kampfkarren", repo: "selene", binaryName: "selene" },
  stylua: { owner: "JohnnyMorganz", repo: "StyLua", binaryName: "stylua" },
  lune: { owner: "lune-org", repo: "lune", binaryName: "lune" },
  wally: { owner: "UpliftGames", repo: "wally", binaryName: "wally" },
  "wally-package-types": { owner: "JohnnyMorganz", repo: "wally-package-types", binaryName: "wally-package-types" },
  rokit: { owner: "rojo-rbx", repo: "rokit", binaryName: "rokit" },
};

// --- Helpers -----------------------------------------------------------------

/**
 * Get the platform-specific asset name pattern.
 * E.g., on linux x86_64, look for "linux-x86_64" or "linux-x64" in the asset name.
 */
function getPlatformPattern(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32") {
    return arch === "arm64" ? "windows-aarch64" : "windows-x86_64";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "macos-aarch64" : "macos-x86_64";
  }
  // Linux
  return arch === "arm64" ? "linux-aarch64" : "linux-x86_64";
}

/**
 * Fetch the latest release info from GitHub API.
 * Returns null on error (rate limit, network, etc).
 */
async function fetchLatestRelease(owner: string, repo: string): Promise<GitHubRelease | null> {
  return new Promise((resolve) => {
    const url = `${GITHUB_API}/repos/${owner}/${repo}/releases/latest`;
    log.debug(`[INSTALLER] Fetching ${url}`);

    const req = https.get(url, {
      headers: {
        "User-Agent": "claude-killer-installer",
        "Accept": "application/vnd.github+json",
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) {
        log.debug(`[INSTALLER] GitHub API returned ${res.statusCode}`);
        resolve(null);
        return;
      }

      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const release = JSON.parse(data);
          resolve({
            tagName: release.tag_name ?? "",
            assets: (release.assets ?? []).map((a: any) => ({
              name: a.name ?? "",
              browserDownloadUrl: a.browser_download_url ?? "",
              size: a.size ?? 0,
            })),
          });
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      log.debug(`[INSTALLER] GitHub API error: ${err.message}`);
      resolve(null);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Find the right asset to download for the current platform.
 * Looks for .zip files containing the platform pattern.
 */
function findAssetForPlatform(release: GitHubRelease): { url: string; name: string } | null {
  const pattern = getPlatformPattern();
  log.debug(`[INSTALLER] Looking for asset matching "${pattern}"`);

  // Try exact pattern match first
  for (const asset of release.assets) {
    const lower = asset.name.toLowerCase();
    if (lower.includes(pattern) && (lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))) {
      return { url: asset.browserDownloadUrl, name: asset.name };
    }
  }

  // Fallback: try without arch suffix (some repos use "linux" not "linux-x86_64")
  const platformShort = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  for (const asset of release.assets) {
    const lower = asset.name.toLowerCase();
    if (lower.includes(platformShort) && (lower.endsWith(".zip") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz"))) {
      return { url: asset.browserDownloadUrl, name: asset.name };
    }
  }

  return null;
}

/**
 * Download a file from a URL to a local path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const req = https.get(url, {
      headers: { "User-Agent": "claude-killer-installer" },
      timeout: 120000, // 2 min download timeout
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          file.close();
          fs.unlinkSync(destPath);
          downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    });

    req.on("error", (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(err);
    });
    req.on("timeout", () => {
      req.destroy();
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(new Error("Download timed out"));
    });
  });
}

/**
 * Extract a zip/tar.gz archive and find the binary inside.
 * Returns the path to the extracted binary.
 */
function extractArchive(archivePath: string, destDir: string, binaryName: string): string | null {
  const isZip = archivePath.endsWith(".zip");
  const isTarGz = archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz");

  try {
    if (isZip) {
      // Use unzip command (available on most systems)
      execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { stdio: "pipe", timeout: 30000 });
    } else if (isTarGz) {
      execSync(`tar -xzf "${archivePath}" -C "${destDir}"`, { stdio: "pipe", timeout: 30000 });
    } else {
      // Not an archive — might be a raw binary
      fs.copyFileSync(archivePath, path.join(destDir, binaryName));
    }
  } catch {
    // Try Python's zipfile as fallback for zip
    if (isZip) {
      try {
        execSync(`python3 -c "import zipfile; zipfile.ZipFile('${archivePath}').extractall('${destDir}')"`, { stdio: "pipe", timeout: 30000 });
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  // Find the binary in the extracted files
  const findBinary = (dir: string): string | null => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findBinary(fullPath);
        if (found) return found;
      } else if (entry.name === binaryName || entry.name === `${binaryName}.exe`) {
        return fullPath;
      }
    }
    return null;
  };

  return findBinary(destDir);
}

// --- Public API --------------------------------------------------------------

/**
 * Install a tool from GitHub Releases.
 *
 * 1. Query GitHub for the latest release
 * 2. Download the correct asset for the user's platform
 * 3. Extract the binary
 * 4. Install to ~/.claude-killer/bin/
 * 5. Make executable (chmod +x)
 * 6. Verify it works
 *
 * @param toolName  The tool name (e.g., "rojo", "selene")
 * @returns         Install result with success/failure info
 */
export async function installTool(toolName: string): Promise<InstallResult> {
  const repoInfo = TOOL_REPOS[toolName];
  if (!repoInfo) {
    return {
      success: false,
      toolName,
      version: null,
      binaryPath: null,
      error: `Unknown tool: ${toolName}. Supported: ${Object.keys(TOOL_REPOS).join(", ")}`,
    };
  }

  log.info(`[INSTALLER] Installing ${toolName} from ${repoInfo.owner}/${repoInfo.repo}...`);

  // Step 1: Fetch latest release
  const release = await fetchLatestRelease(repoInfo.owner, repoInfo.repo);
  if (!release) {
    return {
      success: false,
      toolName,
      version: null,
      binaryPath: null,
      error: `Failed to fetch latest release from GitHub (network error or rate limited)`,
    };
  }

  const version = release.tagName.replace(/^v/, ""); // "v7.6.1" → "7.6.1"
  log.info(`[INSTALLER] Latest version: ${version}`);

  // Step 2: Find the right asset for this platform
  const asset = findAssetForPlatform(release);
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(", ");
    return {
      success: false,
      toolName,
      version,
      binaryPath: null,
      error: `No binary found for platform ${getPlatformPattern()}. Available assets: ${available}`,
    };
  }

  log.info(`[INSTALLER] Downloading ${asset.name}...`);

  // Step 3: Create install directory
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // Step 4: Download to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-install-"));
  const archivePath = path.join(tmpDir, asset.name);

  try {
    await downloadFile(asset.url, archivePath);
    log.debug(`[INSTALLER] Downloaded to ${archivePath}`);

    // Step 5: Extract
    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    const binaryPath = extractArchive(archivePath, extractDir, repoInfo.binaryName);

    if (!binaryPath) {
      return {
        success: false,
        toolName,
        version,
        binaryPath: null,
        error: `Binary "${repoInfo.binaryName}" not found in archive after extraction`,
      };
    }

    // Step 6: Copy to install directory
    const destPath = path.join(INSTALL_DIR, repoInfo.binaryName);
    fs.copyFileSync(binaryPath, destPath);

    // Step 7: Make executable (Unix only)
    if (process.platform !== "win32") {
      fs.chmodSync(destPath, 0o755);
    }

    log.success(`[INSTALLER] ${toolName} v${version} installed to ${destPath}`);

    // Step 8: Verify it works
    const verification = await detectAndVerify(toolName);
    if (verification.status === "working") {
      log.success(`[INSTALLER] ${toolName} verified and working`);
    } else {
      log.warn(`[INSTALLER] ${toolName} installed but verification failed: ${verification.error}`);
    }

    return {
      success: true,
      toolName,
      version,
      binaryPath: destPath,
    };
  } catch (err: any) {
    return {
      success: false,
      toolName,
      version,
      binaryPath: null,
      error: `Installation failed: ${err.message}`,
    };
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
 * Check if a tool can be auto-installed (i.e., it's in TOOL_REPOS).
 */
export function canInstall(toolName: string): boolean {
  return toolName in TOOL_REPOS;
}

/**
 * Get the install directory path.
 */
export function getInstallDir(): string {
  return INSTALL_DIR;
}

/**
 * List all installable tools.
 */
export function listInstallableTools(): string[] {
  return Object.keys(TOOL_REPOS);
}

/**
 * Get the GitHub repo info for a tool.
 */
export function getToolRepo(toolName: string): { owner: string; repo: string } | null {
  return TOOL_REPOS[toolName] ?? null;
}
