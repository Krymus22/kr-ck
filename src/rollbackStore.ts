/**
 * rollbackStore.ts - Automatic backup + rollback for file edits.
 *
 * Before EVERY successful write via aplicar_diff / editar_arquivo /
 * editar_multi_arquivos, the original content is snapshotted into a
 * `.rollback/` directory inside the project root.
 *
 * If a guardrail fails, auto-heal exhausts retries, or the model/user
 * explicitly requests it, the snapshot can be restored via the
 * `desfazer_edicao` tool.
 *
 * Storage layout:
 *   <projectRoot>/.rollback/
 *     +-- index.json                  # ordered list of snapshots
 *     +-- snapshots/
 *         +-- <timestamp>_<rand>.bak  # raw content
 *         +-- <timestamp>_<rand>.meta.json  # { originalPath, toolName, timestamp, size }
 *
 * Snapshots older than 5 minutes are auto-pruned on every save() call
 * and on session exit.
 *
 * Public API:
 *   - saveBackup(originalPath, content, toolName): BackupRecord
 *   - restoreBackup(originalPath): boolean
 *   - listBackups(originalPath?): BackupRecord[]
 *   - pruneOldBackups(maxAgeMs?): number
 *   - getRollbackDir(): string
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export interface BackupRecord {
  /** Absolute path of the file that was backed up */
  originalPath: string;
  /** Absolute path of the snapshot .bak file */
  backupPath: string;
  /** Absolute path of the .meta.json file */
  metaPath: string;
  /** Tool that triggered the backup (aplicar_diff, editar_arquivo, etc.) */
  toolName: string;
  /** ISO timestamp of the backup */
  timestamp: string;
  /** Original file size in bytes */
  size: number;
  /** Stable ID for the snapshot (used by desfazer_edicao) */
  id: string;
  /**
   * Which agent made the edit. "main" for the main agent, "sub-N" for sub-agents.
   * Read from CLAUDE_KILLER_AGENT_ID env var (set by runSubAgent in subAgents.ts).
   * Older backups without this field default to "main".
   */
  agentId?: string;
}

interface IndexFile {
  version: 1;
  entries: BackupRecord[];
}

// --- Config ------------------------------------------------------------------

const ROLLBACK_DIR_NAME = ".rollback";
const SNAPSHOTS_SUBDIR = "snapshots";
const INDEX_FILENAME = "index.json";
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 200; // hard cap to prevent unbounded growth

let cachedProjectRoot: string | null = null;

// --- Path Helpers ------------------------------------------------------------

/**
 * Resolve the project root by walking up from cwd looking for a marker
 * file (package.json, tsconfig.json, .git, pyproject.toml, Cargo.toml,
 * go.mod). Falls back to cwd if none is found.
 */
function findProjectRoot(): string {
  if (cachedProjectRoot) return cachedProjectRoot;

  const markers = [
    "package.json",
    "tsconfig.json",
    ".git",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    ".claude-killer",
  ];

  let dir = process.cwd();
  for (let i = 0; i < 15; i++) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) {
      cachedProjectRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedProjectRoot = process.cwd();
  return cachedProjectRoot;
}

function getRollbackDir(): string {
  return path.join(findProjectRoot(), ROLLBACK_DIR_NAME);
}

function getSnapshotsDir(): string {
  return path.join(getRollbackDir(), SNAPSHOTS_SUBDIR);
}

function getIndexFilePath(): string {
  return path.join(getRollbackDir(), INDEX_FILENAME);
}

function ensureRollbackDirs(): void {
  const rollbackDir = getRollbackDir();
  const snapshotsDir = getSnapshotsDir();
  if (!fs.existsSync(rollbackDir)) {
    fs.mkdirSync(rollbackDir, { recursive: true });
  }
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }
}

// --- Index File --------------------------------------------------------------

function readIndex(): IndexFile {
  const indexFile = getIndexFilePath();
  try {
    if (fs.existsSync(indexFile)) {
      const raw = fs.readFileSync(indexFile, "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        return parsed;
      }
    }
  } catch (err) {
    log.warn(`[ROLLBACK] Failed to read index: ${(err as Error).message}`);
  }
  return { version: 1, entries: [] };
}

function writeIndex(index: IndexFile): void {
  ensureRollbackDirs();
  const indexFile = getIndexFilePath();
  try {
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf8");
  } catch (err) {
    log.warn(`[ROLLBACK] Failed to write index: ${(err as Error).message}`);
  }
}

// --- Pruning -----------------------------------------------------------------

/**
 * Remove backups older than maxAgeMs. Returns count of pruned entries.
 * Also enforces MAX_ENTRIES cap by removing oldest first.
 */
export function pruneOldBackups(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
  const index = readIndex();
  if (index.entries.length === 0) return 0;

  const cutoff = Date.now() - maxAgeMs;
  const { remaining, pruned: prunedByAge } = pruneExpired(index.entries, cutoff);
  const { finalRemaining, pruned: prunedByCap } = enforceMaxEntries(remaining);

  const totalPruned = prunedByAge + prunedByCap;
  if (totalPruned > 0) {
    writeIndex({ version: 1, entries: finalRemaining });
    log.debug(`[ROLLBACK] Pruned ${totalPruned} old backup(s)`);
  }
  return totalPruned;
}

/** Split entries into [expired, remaining] and delete expired snapshot files. */
function pruneExpired(entries: BackupRecord[], cutoff: number): { remaining: BackupRecord[]; pruned: number } {
  const remaining: BackupRecord[] = [];
  let pruned = 0;
  for (const entry of entries) {
    const ts = new Date(entry.timestamp).getTime();
    const isExpired = Number.isNaN(ts) || ts < cutoff;
    if (isExpired) {
      deleteSnapshotFiles(entry, "prune");
      pruned++;
    } else {
      remaining.push(entry);
    }
  }
  return { remaining, pruned };
}

/** If list exceeds MAX_ENTRIES, drop oldest entries (in-place order). */
function enforceMaxEntries(remaining: BackupRecord[]): { finalRemaining: BackupRecord[]; pruned: number } {
  if (remaining.length <= MAX_ENTRIES) return { finalRemaining: remaining, pruned: 0 };
  const excess = remaining.length - MAX_ENTRIES;
  const toRemove = remaining.slice(0, excess);
  for (const entry of toRemove) {
    deleteSnapshotFiles(entry, "cap");
  }
  return { finalRemaining: remaining.slice(excess), pruned: excess };
}

/** Delete a backup's .bak + .meta.json files (best-effort). */
function deleteSnapshotFiles(entry: BackupRecord, reason: "prune" | "cap" | "clear"): void {
  try { fs.unlinkSync(entry.backupPath); } catch (err) { log.debug(`[ROLLBACK] ${reason}: ${entry.backupPath} - ${(err as Error).message}`); }
  try { fs.unlinkSync(entry.metaPath); } catch (err) { log.debug(`[ROLLBACK] ${reason}: ${entry.metaPath} - ${(err as Error).message}`); }
}

// --- Public API --------------------------------------------------------------

/**
 * Save a backup of the current file content before it gets overwritten.
 * Returns the BackupRecord or null if the backup could not be created.
 *
 * If the file doesn't exist yet (new file creation), no backup is saved
 * - there's nothing to roll back to.
 */
export function saveBackup(
  originalPath: string,
  content: string,
  toolName: string
): BackupRecord | null {
  try {
    const resolved = path.resolve(originalPath);
    // Only backup if file currently exists (i.e. this is an edit, not a create)
    if (!fs.existsSync(resolved)) {
      log.debug(`[ROLLBACK] Skipping backup for new file: ${resolved}`);
      return null;
    }

    ensureRollbackDirs();

    // Prune old backups first to keep the directory small
    pruneOldBackups();

    const timestamp = new Date().toISOString();
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const id = `${ts}_${rand}`;
    const safeName = resolved.replaceAll(/[\\/]/g, "_").replace(/^_+/, "");
    const backupPath = path.join(getSnapshotsDir(), `${id}__${safeName}.bak`);
    const metaPath = path.join(getSnapshotsDir(), `${id}__${safeName}.meta.json`);

    // Write backup content
    fs.writeFileSync(backupPath, content, "utf8");

    const record: BackupRecord = {
      originalPath: resolved,
      backupPath,
      metaPath,
      toolName,
      timestamp,
      size: Buffer.byteLength(content, "utf8"),
      id,
      agentId: process.env.CLAUDE_KILLER_AGENT_ID ?? "main",
    };

    // Write metadata
    fs.writeFileSync(metaPath, JSON.stringify(record, null, 2), "utf8");

    // Update index
    const index = readIndex();
    index.entries.push(record);
    writeIndex(index);

    log.debug(`[ROLLBACK] Saved backup for ${resolved} (${record.size} bytes, tool=${toolName})`);
    return record;
  } catch (err) {
    log.warn(`[ROLLBACK] Failed to save backup for ${originalPath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Restore the most recent backup for the given file path.
 * Returns true on success, false if no backup exists or restore failed.
 */
export function restoreBackup(originalPath: string): boolean {
  try {
    const resolved = path.resolve(originalPath);
    const index = readIndex();

    // Find the most recent backup for this file
    let latestEntry: BackupRecord | null = null;
    for (let i = index.entries.length - 1; i >= 0; i--) {
      if (index.entries[i].originalPath === resolved) {
        latestEntry = index.entries[i];
        break;
      }
    }

    if (!latestEntry) {
      log.warn(`[ROLLBACK] No backup found for ${resolved}`);
      return false;
    }
    const latest: BackupRecord = latestEntry;

    if (!fs.existsSync(latest.backupPath)) {
      log.warn(`[ROLLBACK] Backup file missing on disk: ${latest.backupPath}`);
      // Remove stale entry
      index.entries = index.entries.filter((e) => e.id !== latest.id);
      writeIndex(index);
      return false;
    }

    const content = fs.readFileSync(latest.backupPath, "utf8");
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf8");

    // Remove the restored entry from the index so the next restore goes further back
    index.entries = index.entries.filter((e) => e.id !== latest.id);
    writeIndex(index);

    log.success(`[ROLLBACK] Restored ${resolved} from backup ${latest.id} (${latest.size} bytes)`);
    return true;
  } catch (err) {
    log.error(`[ROLLBACK] Failed to restore ${originalPath}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * List all backups, optionally filtered by original path.
 * Returns entries sorted from oldest to newest.
 */
export function listBackups(originalPath?: string): BackupRecord[] {
  const index = readIndex();
  let entries = index.entries;
  if (originalPath) {
    const resolved = path.resolve(originalPath);
    entries = entries.filter((e) => e.originalPath === resolved);
  }
  return [...entries].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * Return the rollback directory path (for debugging / inspection).
 */
export function getRollbackDirPath(): string {
  return getRollbackDir();
}

/**
 * Clear ALL backups. Used on session exit if desired.
 */
export function clearAllBackups(): number {
  const index = readIndex();
  const count = index.entries.length;
  for (const entry of index.entries) {
    deleteSnapshotFiles(entry, "clear");
  }
  writeIndex({ version: 1, entries: [] });
  log.debug(`[ROLLBACK] Cleared ${count} backup(s)`);
  return count;
}

/**
 * Reset internal state - clears the cached project root so the next call
 * re-discovers it. Primarily useful for tests that chdir between cases.
 */
export function resetRollbackState(): void {
  cachedProjectRoot = null;
}
