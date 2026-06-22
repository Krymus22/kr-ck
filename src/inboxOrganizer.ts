/**
 * inboxOrganizer.ts — Organiza arquivos do inbox/ da pasta do modo.
 *
 * Sprint 10: Usuário joga arquivos no inbox/ e roda /organize.
 * O sistema classifica cada arquivo por extensão + conteúdo e move
 * pra pasta correta (tools/, skills/, hooks/, mcps/, manifests/).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

export type FileType =
  | "tool"
  | "skill"
  | "hook"
  | "mcp"
  | "manifest"
  | "docs"
  | "archive"
  | "unknown";

export interface OrganizeResult {
  organized: Array<{
    fileName: string;
    fileType: FileType;
    destination: string;
    createdManifest?: boolean;
  }>;
  ignored: Array<{ fileName: string; reason: string }>;
  errors: Array<{ fileName: string; error: string }>;
}

/**
 * Classify a file by extension + content inspection.
 *
 * Heuristics (cheap and predictable — no AI calls):
 *   - .exe or no extension on Unix = tool binary
 *   - .md = skill
 *   - .js = hook (looks for module.exports with trigger/run) OR mcp
 *           (looks for json-rpc/stdio/@modelcontextprotocol)
 *   - .json = manifest if has category OR is array; mcp config if has
 *             command+args without category; default manifest
 *   - .zip / .tar.gz = archive (ignored — extract manually)
 *   - .txt / .rst = docs (kept in inbox)
 *   - anything else = unknown (kept in inbox)
 */
export function classifyFile(filePath: string): FileType {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();

  // .exe or no extension on Unix = likely a tool binary
  if (ext === ".exe" || (ext === "" && process.platform !== "win32")) {
    return "tool";
  }
  // .md = skill
  if (ext === ".md") {
    return "skill";
  }
  // .js = hook or mcp (needs content inspection)
  if (ext === ".js") {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      // Hook: has module.exports with trigger/run
      if (/module\.exports\s*=.*\{[\s\S]*(trigger|run)/i.test(content)) {
        return "hook";
      }
      // MCP: has JSON-RPC or stdio references
      if (/json-rpc|stdio|@modelcontextprotocol/i.test(content)) {
        return "mcp";
      }
      // Ambiguous — default to hook
      return "hook";
    } catch {
      return "hook";
    }
  }
  // .json = manifest, config, or mcp config
  if (ext === ".json") {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const content = JSON.parse(raw) as unknown;
      // Array of items (e.g. multiple tool manifests) = manifest
      if (Array.isArray(content)) {
        return "manifest";
      }
      // Object: manifest if has category OR (command + args)
      if (content && typeof content === "object") {
        const obj = content as Record<string, unknown>;
        if (obj.category || (obj.command && obj.args)) {
          return "manifest";
        }
      }
      return "manifest"; // default for .json
    } catch {
      return "manifest"; // invalid JSON, still try as manifest
    }
  }
  // .zip / .tar.gz = archive
  if (ext === ".zip" || ext === ".gz" || ext === ".tar" || name.endsWith(".tar.gz")) {
    return "archive";
  }
  // .txt = docs
  if (ext === ".txt" || ext === ".rst") {
    return "docs";
  }
  return "unknown";
}

/**
 * Get the inbox directory for the active mode.
 * Returns null when modeName is null.
 */
export function getInboxDir(modeName: string | null): string | null {
  if (!modeName) return null;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".claude-killer", "modes", modeName, "inbox");
}

/**
 * List files in the inbox directory.
 * Skips README.md and dotfiles (hidden files).
 */
export function listInboxFiles(modeName: string | null): string[] {
  const inboxDir = getInboxDir(modeName);
  if (!inboxDir || !fs.existsSync(inboxDir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(inboxDir)) {
    // Skip README.md and hidden files
    if (entry === "README.md" || entry.startsWith(".")) continue;
    const fullPath = path.join(inboxDir, entry);
    try {
      if (fs.statSync(fullPath).isFile()) {
        files.push(entry);
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return files;
}

/**
 * Move a file from inbox to the correct destination folder.
 *
 * Sprint B (BUG-E fix): retorna status explicitamente. Se o arquivo já existe
 * no destino, retorna "skipped" (não "moved"). Antes, retornava o destPath
 * mesmo quando não moveu, e organizeInbox colocava em `organized[]` — bug.
 *
 * @returns objeto com status, destination path e reason (se skipped)
 */
function moveFile(
  fileName: string,
  fileType: FileType,
  modeName: string,
): { status: "moved" | "skipped"; destination: string; reason?: string } {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const modeDir = path.join(home, ".claude-killer", "modes", modeName);
  const inboxDir = path.join(modeDir, "inbox");
  const sourcePath = path.join(inboxDir, fileName);

  // Determine destination folder
  const destFolder =
    fileType === "tool"
      ? "tools"
      : fileType === "skill"
        ? "skills"
        : fileType === "hook"
          ? "hooks"
          : fileType === "mcp"
            ? "mcps"
            : "manifests"; // manifest → manifests/

  const destDir = path.join(modeDir, destFolder);
  const destPath = path.join(destDir, fileName);

  // Create dest dir if needed
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  // Don't overwrite if already exists
  if (fs.existsSync(destPath)) {
    log.warn(`[INBOX] ${fileName} already exists in ${destFolder}/ — skipping`);
    return { status: "skipped", destination: destPath, reason: `already exists in ${destFolder}/` };
  }

  // Move (rename)
  fs.renameSync(sourcePath, destPath);
  log.info(`[INBOX] Moved ${fileName} → ${destFolder}/`);
  return { status: "moved", destination: destPath };
}

/**
 * Organize all files in the inbox directory.
 * Classifies each file and moves it to the correct folder.
 *
 * Returns a structured result with organized / ignored / errors arrays.
 * Safe to call when no mode is active (returns an error result).
 */
export function organizeInbox(modeName: string | null): OrganizeResult {
  const result: OrganizeResult = { organized: [], ignored: [], errors: [] };

  if (!modeName) {
    result.errors.push({ fileName: "(none)", error: "No active mode" });
    return result;
  }

  const inboxDir = getInboxDir(modeName);
  if (!inboxDir || !fs.existsSync(inboxDir)) {
    result.errors.push({
      fileName: "(none)",
      error: "Inbox directory does not exist",
    });
    return result;
  }

  const files = listInboxFiles(modeName);
  if (files.length === 0) {
    return result; // empty inbox, nothing to do
  }

  for (const fileName of files) {
    const filePath = path.join(inboxDir, fileName);
    try {
      const fileType = classifyFile(filePath);

      if (fileType === "unknown" || fileType === "docs") {
        result.ignored.push({
          fileName,
          reason:
            fileType === "docs"
              ? "Documentation file (not moved)"
              : "Unknown file type",
        });
        continue;
      }

      if (fileType === "archive") {
        result.ignored.push({
          fileName,
          reason: "Archive (.zip/.tar.gz) — extract manually and re-organize",
        });
        continue;
      }

      const moveResult = moveFile(fileName, fileType, modeName);
      if (moveResult.status === "moved") {
        result.organized.push({
          fileName,
          fileType,
          destination: moveResult.destination,
          createdManifest: false, // manifest creation is Sprint 11 (configurator)
        });
      } else {
        // Sprint B (BUG-E fix): skipped (already exists) vai pra ignored,
        // não pra organized.
        result.ignored.push({
          fileName,
          reason: moveResult.reason ?? "skipped (already exists at destination)",
        });
      }
    } catch (err) {
      result.errors.push({
        fileName,
        error: (err as Error).message,
      });
    }
  }

  return result;
}

/**
 * Format organize result as a user-friendly summary string (PT-BR).
 * Used by /organize slash command and ExtensionHub 'O' key.
 */
export function formatOrganizeResult(result: OrganizeResult): string {
  const lines: string[] = [];

  if (result.organized.length > 0) {
    lines.push("✓ Organizados:");
    for (const o of result.organized) {
      const folder =
        o.fileType === "tool"
          ? "tools"
          : o.fileType === "skill"
            ? "skills"
            : o.fileType === "hook"
              ? "hooks"
              : o.fileType === "mcp"
                ? "mcps"
                : "manifests";
      lines.push(`  ${o.fileName} → ${folder}/`);
    }
  }

  if (result.ignored.length > 0) {
    lines.push("\n⚠ Ignorados:");
    for (const i of result.ignored) {
      lines.push(`  ${i.fileName}: ${i.reason}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push("\n✗ Erros:");
    for (const e of result.errors) {
      lines.push(`  ${e.fileName}: ${e.error}`);
    }
  }

  if (
    result.organized.length === 0 &&
    result.ignored.length === 0 &&
    result.errors.length === 0
  ) {
    lines.push("Inbox vazio — nada para organizar.");
  }

  return lines.join("\n");
}
