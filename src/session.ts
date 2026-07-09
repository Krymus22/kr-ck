/**
 * session.ts - Auto-persisting sessions (like Claude Code).
 *
 * HOW CLAUDE CODE DOES IT:
 *   1. Sessions stored per-project in ~/.claude/projects/<hash>/*.jsonl
 *   2. Each message appended to .jsonl IMMEDIATELY (append-only, fsync)
 *   3. On startup, auto-loads last session for current directory
 *   4. No explicit save needed — everything is auto-saved
 *   5. Survives crashes, terminal closes, /exit — because each message
 *      is written to disk BEFORE processing the next
 *
 * HOW CLAUDE-KILLER DOES IT (this file):
 *   - Sessions stored in ~/.claude-killer/sessions/<project-hash>/<id>.jsonl
 *   - Each message appended to JSONL file immediately via appendMessage()
 *   - On startup, auto-loads last session (or starts new one)
 *   - /session list, /session load, /session delete for manual management
 *   - No /session save needed — it's automatic
 *   - No tool for IA to save — sessions are infrastructure, not IA concern
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as log from "./logger.js";
// Import getEffortLevel so startSession() can persist the current effort
// level into the session header. This is a one-way dependency
// (session → effortLevels → history, no cycle back to session).
import { getEffortLevel, type EffortLevel } from "./effortLevels.js";

const VALID_EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "max"]);

/**
 * Check if a string is a valid EffortLevel.
 * Used to validate values read from session headers (defensive — old
 * sessions or hand-edited files might have invalid values).
 */
function isValidEffortLevel(s: unknown): s is EffortLevel {
  return typeof s === "string" && VALID_EFFORT_LEVELS.has(s);
}

// --- Session directory structure --------------------------------------------

const SESSIONS_BASE_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".claude-killer",
  "sessions",
);

/**
 * Get the project-specific session directory.
 * Uses a hash of the cwd so different projects have separate sessions.
 */
function getProjectSessionDir(cwd?: string): string {
  const projectPath = cwd ?? process.cwd();
  const hash = crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return path.join(SESSIONS_BASE_DIR, hash);
}

function ensureSessionDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Generate a session ID: YYYY-MM-DD_HH-MM-SS_random4
 * Uses LOCAL time (not UTC) so the ID matches the user's timezone.
 */
function generateSessionId(): string {
  const now = new Date();
  // Use local time components instead of toISOString() (which is UTC)
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const time = `${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}_${time}_${rand}`;
}

// --- Active session state ---------------------------------------------------

let activeSessionId: string | null = null;
let activeSessionPath: string | null = null;

/**
 * Start a new session. Creates the JSONL file and writes a header.
 * Called automatically on first message if no session is active.
 * @param cwd  Override cwd (for testing). Defaults to process.cwd().
 * @param customId  Custom session ID (for testing/renaming). Defaults to generated.
 *
 * The current effort level (low/medium/high/max) is captured in the header
 * so it can be restored when the session is loaded later. This makes effort
 * level per-session — switching sessions restores each session's effort.
 */
export function startSession(cwd?: string, customId?: string): string {
  const dir = getProjectSessionDir(cwd);
  ensureSessionDir(dir);
  const id = customId ?? generateSessionId();
  const filePath = path.join(dir, `${id}.jsonl`);

  // Capture the current effort level AT SESSION CREATION TIME. If the user
  // changes effort later via /effort, updateSessionEffortLevel() rewrites
  // this field. On load, loadSessionMessages() returns it so the caller
  // can call setEffortLevel() to restore it.
  const currentEffort = getEffortLevel();

  // Write header (first line = metadata)
  const header = JSON.stringify({
    type: "session-header",
    id,
    createdAt: new Date().toLocaleString("sv-SE"), // local time ISO format
    cwd: cwd ?? process.cwd(),
    projectCwd: cwd ?? process.cwd(), // directory the user is working in (restored on auto-load)
    effortLevel: currentEffort, // current thinking effort (restored on load)
  });
  fs.writeFileSync(filePath, header + "\n", "utf8");

  activeSessionId = id;
  activeSessionPath = filePath;
  log.debug(`[SESSION] New session started: ${id} (effort: ${currentEffort})`);
  return id;
}

/**
 * Append a single message to the active session's JSONL file.
 * This is called IMMEDIATELY after each message is added to history —
 * no buffering, no delay. If the terminal crashes right after this,
 * the message is already on disk.
 */
export function appendMessage(msg: { role: string; content?: string; [key: string]: unknown }): void {
  if (!activeSessionPath) {
    // Auto-start session on first message (like Claude Code)
    startSession();
  }
  if (!activeSessionPath) return;

  try {
    const line = JSON.stringify({ ...msg, ts: Date.now() }) + "\n";
    fs.appendFileSync(activeSessionPath, line, "utf8");
  } catch (err) {
    log.debug(`[SESSION] Failed to append: ${(err as Error).message}`);
  }
}

/**
 * Append a compaction snapshot to the active session's JSONL file.
 *
 * A compaction snapshot captures the EXACT in-memory history at the moment
 * compaction completed. This is used on session load to restore the IA's
 * context precisely as it was (compacted summary + recent messages), rather
 * than loading the full un-compacted history (which might exceed the context
 * window).
 *
 * The snapshot contains:
 *   - type: "compaction-snapshot" (marker for load logic)
 *   - messages: the full in-memory history array AFTER compaction
 *   - method: "llm" | "mechanical" (how compaction was done)
 *   - ts: timestamp
 *
 * On load:
 *   - Visual display: uses ALL messages from the file (full conversation)
 *   - IA context: uses the LAST compaction snapshot (exact compacted state)
 *
 * This guarantees the IA gets exactly the context it had at shutdown —
 * no more, no less — so it ALWAYS fits in the context window.
 */
export function appendCompactionSnapshot(
  messages: unknown[],
  method: "llm" | "mechanical",
): void {
  if (!activeSessionPath) return;

  try {
    const line = JSON.stringify({
      type: "compaction-snapshot",
      messages,
      method,
      ts: Date.now(),
    }) + "\n";
    fs.appendFileSync(activeSessionPath, line, "utf8");
    log.debug(`[SESSION] Compaction snapshot saved (${messages.length} messages, method=${method})`);
  } catch (err) {
    log.debug(`[SESSION] Failed to save compaction snapshot: ${(err as Error).message}`);
  }
}

/**
 * Read the `projectCwd` field from a session file's header.
 * This is the directory the user was working in when the session was active.
 * Returns null if the file doesn't exist or has no projectCwd field.
 */
export function getSessionProjectCwd(sessionPath: string): string | null {
  try {
    const content = fs.readFileSync(sessionPath, "utf8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) return null;
    const header = JSON.parse(firstLine);
    if (header.type === "session-header" && typeof header.projectCwd === "string") {
      return header.projectCwd;
    }
    // Fallback: old sessions have `cwd` field
    if (header.type === "session-header" && typeof header.cwd === "string") {
      return header.cwd;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the `effortLevel` field from a session file's header.
 * This is the thinking effort that was active when the session was last used.
 * Returns null if the file doesn't exist, has no effortLevel field, OR has
 * an invalid value (defensive against old/hand-edited sessions).
 */
export function getSessionEffortLevel(sessionPath: string): EffortLevel | null {
  try {
    const content = fs.readFileSync(sessionPath, "utf8");
    const firstLine = content.split("\n")[0];
    if (!firstLine) return null;
    const header = JSON.parse(firstLine);
    if (header.type === "session-header" && isValidEffortLevel(header.effortLevel)) {
      return header.effortLevel;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Update the `effortLevel` field in the active session's header.
 * Called when the user changes effort via /effort so the new level
 * persists across restarts and is restored when this session is loaded.
 *
 * No-op if no session is active (e.g., effort changed before any message
 * was sent — the lazy-init startSession() will capture the current level
 * when it eventually runs).
 *
 * Follows the same read-modify-write pattern as updateSessionProjectCwd().
 */
export function updateSessionEffortLevel(level: EffortLevel): void {
  if (!activeSessionPath) return;
  if (!isValidEffortLevel(level)) return;
  try {
    const content = fs.readFileSync(activeSessionPath, "utf8");
    const lines = content.split("\n");
    if (lines.length === 0) return;
    const header = JSON.parse(lines[0]!);
    header.effortLevel = level;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(activeSessionPath, lines.join("\n"), "utf8");
    log.debug(`[SESSION] Updated effortLevel to ${level}`);
  } catch (err) {
    log.debug(`[SESSION] Failed to update effortLevel: ${(err as Error).message}`);
  }
}

/**
 * Get the last session for the current project directory.
 * Returns null if no sessions exist.
 * Also returns the projectCwd and effortLevel from the session header
 * (if available) so the caller can restore the working directory and
 * thinking effort.
 */
export function getLastSession(cwd?: string): { id: string; path: string; projectCwd: string | null; effortLevel: EffortLevel | null } | null {
  const dir = getProjectSessionDir(cwd);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // most recent first (IDs are timestamp-based)

  if (files.length === 0) return null;

  const lastFile = files[0]!;
  const filePath = path.join(dir, lastFile);
  const projectCwd = getSessionProjectCwd(filePath);
  const effortLevel = getSessionEffortLevel(filePath);

  return {
    id: lastFile.replace(".jsonl", ""),
    path: filePath,
    projectCwd,
    effortLevel,
  };
}

/**
 * Result of loading a session: separates regular messages (for visual
 * display — the full conversation history) from compaction snapshots
 * (for IA context — the exact compacted state at the last compaction).
 *
 * BUG FIX (BS-3): added `postSnapshotMessages` — messages that arrived
 * AFTER the last compaction snapshot. These must be appended to the
 * snapshot when restoring the IA's context, otherwise the IA "forgets"
 * recent messages (including the user's last question).
 */
export interface LoadedSession {
  /** All regular messages (user/assistant/tool/system) — for VISUAL display. */
  messages: unknown[];
  /**
   * The LAST compaction snapshot, or null if no compaction happened.
   * Contains the exact in-memory history at the moment compaction completed.
   * Used to restore the IA's context precisely as it was — guaranteed to
   * fit in the context window because it was the context the IA had.
   */
  lastSnapshot: { messages: unknown[]; method: string; ts: number } | null;
  /**
   * Messages that arrived AFTER the last compaction snapshot.
   * These are NOT in the snapshot (the snapshot was taken before them).
   * They MUST be appended to the snapshot when restoring IA context,
   * otherwise the IA forgets the user's most recent messages.
   *
   * If lastSnapshot is null (no compaction happened), this is the same
   * as `messages` (all messages are "post-snapshot" in that case).
   */
  postSnapshotMessages: unknown[];
  /**
   * The thinking effort level recorded in the session header at the
   * time the session was last used. null if the header doesn't have an
   * effortLevel field (old sessions created before this feature) or if
   * the value is invalid.
   *
   * The caller should call setEffortLevel() with this value (when non-null)
   * to restore the per-session effort level.
   */
  effortLevel: EffortLevel | null;
}

/**
 * Load a session from disk. Returns regular messages + last compaction snapshot.
 *
 * - `messages`: ALL messages from the file (full conversation history) —
 *   used for VISUAL display so the user can see everything.
 * - `lastSnapshot`: the last compaction snapshot (if any) — used for IA
 *   context to restore exactly what the IA had at the last compaction,
 *   NOT the full history (which might exceed the context window after
 *   compaction removed messages from memory but not from the file).
 *
 * Supports partial ID match: if exact ID not found, looks for files
 * that START WITH the given prefix. This lets users type
 * /session load 2026-07 instead of the full timestamp ID.
 */
export function loadSessionMessages(sessionId: string, cwd?: string): LoadedSession | null {
  const dir = getProjectSessionDir(cwd);
  let filePath = path.join(dir, `${sessionId}.jsonl`);

  // If exact match not found, try partial match (prefix)
  if (!fs.existsSync(filePath)) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")) : [];
    const match = files.find(f => f.startsWith(sessionId));
    if (match) {
      filePath = path.join(dir, match);
    } else {
      // Also check old .json format
      const oldPath = path.join(SESSIONS_BASE_DIR, `${sessionId}.json`);
      if (fs.existsSync(oldPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(oldPath, "utf8"));
          return { messages: data.messages ?? [], lastSnapshot: null, postSnapshotMessages: data.messages ?? [], effortLevel: null };
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  try {
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const messages: unknown[] = [];
    let lastSnapshot: LoadedSession["lastSnapshot"] = null;
    // BUG FIX (BS-3): track messages that arrive AFTER the last snapshot.
    // These must be appended to the snapshot when restoring IA context.
    let postSnapshotMessages: unknown[] = [];
    let snapshotSeen = false;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session-header") continue; // skip header

        // Compaction snapshots are stored separately — not in the regular
        // messages array. We keep only the LAST one (most recent compaction).
        if (parsed.type === "compaction-snapshot") {
          lastSnapshot = {
            messages: parsed.messages ?? [],
            method: parsed.method ?? "unknown",
            ts: parsed.ts ?? 0,
          };
          // Reset post-snapshot tracking: only messages AFTER the LAST
          // snapshot matter (older post-snapshot messages are already
          // captured inside this snapshot's predecessor, which was
          // superseded when this snapshot was written).
          snapshotSeen = true;
          postSnapshotMessages = [];
          continue; // don't add to regular messages
        }

        messages.push(parsed);
        // If we've seen a snapshot, this message came after it.
        if (snapshotSeen) {
          postSnapshotMessages.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    // If no snapshot was seen, all messages are "post-snapshot" (no compaction).
    if (!snapshotSeen) {
      postSnapshotMessages = messages;
    }
    // Read the effort level from the session header (for restoration on load).
    // null if the header doesn't have it (old sessions) or has an invalid value.
    const effortLevel = getSessionEffortLevel(filePath);
    return { messages, lastSnapshot, postSnapshotMessages, effortLevel };
  } catch {
    return null;
  }
}

/**
 * Set the active session (after loading).
 *
 * BUG FIX (partial-id-double-write): If `sessionId` is a PARTIAL prefix
 * (e.g., user typed `/session load 2026-07`), resolve it to the full ID
 * before setting `activeSessionPath`. Without this, `activeSessionPath`
 * would point to a non-existent file (`<dir>/2026-07.jsonl`), and the next
 * `appendMessage` call would CREATE that file — splitting writes between
 * the original full-ID file and the new partial-ID file (double-write).
 *
 * If the exact file exists, use it as-is (no resolution needed).
 * If neither an exact nor a partial match exists, fall back to the raw
 * input (callers ensure the file exists before calling this, so this
 * branch is defensive only).
 */
export function setActiveSession(sessionId: string, cwd?: string): void {
  const dir = getProjectSessionDir(cwd);
  const exactPath = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(exactPath)) {
    activeSessionId = sessionId;
    activeSessionPath = exactPath;
    return;
  }
  // Exact file not found — try partial prefix match (same logic as
  // loadSessionMessages so both resolve to the SAME file).
  const resolvedId = resolveSessionId(sessionId, dir);
  activeSessionId = resolvedId;
  activeSessionPath = path.join(dir, `${resolvedId}.jsonl`);
}

/**
 * Update the `projectCwd` field in the active session's header.
 * Called when the user changes directory via /cd or FolderBrowser.
 * This ensures the session remembers which project directory was active,
 * so on next startup the directory is restored automatically.
 */
export function updateSessionProjectCwd(newCwd: string): void {
  if (!activeSessionPath) return;
  try {
    const content = fs.readFileSync(activeSessionPath, "utf8");
    const lines = content.split("\n");
    if (lines.length === 0) return;
    const header = JSON.parse(lines[0]!);
    header.projectCwd = newCwd;
    lines[0] = JSON.stringify(header);
    fs.writeFileSync(activeSessionPath, lines.join("\n"), "utf8");
    log.debug(`[SESSION] Updated projectCwd to ${newCwd}`);
  } catch (err) {
    log.debug(`[SESSION] Failed to update projectCwd: ${(err as Error).message}`);
  }
}

/**
 * Get the active session ID (or null if no session active).
 */
export function getActiveSessionId(): string | null {
  return activeSessionId;
}

// --- Session management (for /session slash command) -----------------------

export interface SessionMeta {
  id: string;
  createdAt: string;
  lastModified: string;
  messageCount: number;
  summary: string;
}

/**
 * List all sessions for the current project directory.
 */
export function listSessions(cwd?: string): SessionMeta[] {
  const dir = getProjectSessionDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) continue;

      const header = JSON.parse(lines[0]!);
      // BUG FIX (inflated-count): Previously `msgCount = lines.length - 1`
      // counted ALL non-header lines, including compaction-snapshot markers.
      // A session with 5 real messages + 2 snapshots showed "7 msgs" in
      // /session list. Now we skip snapshot lines so the count reflects
      // only user/assistant/tool/system messages.
      let msgCount = 0;
      for (let i = 1; i < lines.length; i++) {
        try {
          const parsed = JSON.parse(lines[i]!);
          if (parsed.type === "compaction-snapshot") continue;
          msgCount++;
        } catch {
          // Malformed line — skip (don't count).
        }
      }
      const firstUserMsg = lines
        .slice(1)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((m) => m?.role === "user");
      // BUG FIX: content can be either a string ("hello") OR an array of
      // content parts ([{type:"text", text:"..."}, ...]) per the OpenAI chat
      // spec. Previously we called .slice(0, 60) unconditionally, which on an
      // array would return an array slice (not a string) and silently violate
      // the SessionMeta.summary: string contract — the TUI would then render
      // "[object Object]" or similar. We now only slice when content is a
      // string; otherwise we fall back to the message-count summary.
      const rawContent = firstUserMsg?.content;
      const summary = typeof rawContent === "string" && rawContent.length > 0
        ? rawContent.slice(0, 60)
        : `${msgCount} messages`;

      const stat = fs.statSync(filePath);
      sessions.push({
        id: header.id ?? file.replace(".jsonl", ""),
        createdAt: header.createdAt ?? "unknown",
        lastModified: stat.mtime.toISOString(),
        messageCount: msgCount,
        summary,
      });
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

/**
 * Resolve a session ID (exact or partial prefix match).
 * Returns the full ID if found, or the input if no match.
 */
function resolveSessionId(sessionId: string, dir: string): string {
  // Exact match
  const exactPath = path.join(dir, `${sessionId}.jsonl`);
  if (fs.existsSync(exactPath)) return sessionId;

  // Partial match (prefix)
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    const match = files.find(f => f.replace(".jsonl", "").startsWith(sessionId));
    if (match) return match.replace(".jsonl", "");
  }
  return sessionId;
}

/**
 * Delete a session file. Supports partial ID match.
 *
 * BUG FIX (zombie-session): If the deleted session was the ACTIVE one,
 * clear `activeSessionId`/`activeSessionPath`. Without this, the next
 * `appendMessage` call would write to the deleted file path —
 * `fs.appendFileSync` CREATES the file if missing, producing a "zombie"
 * session file containing only the new message (and no header).
 */
export function deleteSession(sessionId: string, cwd?: string): boolean {
  const dir = getProjectSessionDir(cwd);
  const fullId = resolveSessionId(sessionId, dir);
  const filePath = path.join(dir, `${fullId}.jsonl`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  // If we just deleted the active session, clear the active pointers so
  // the next appendMessage auto-creates a fresh session (with header)
  // instead of writing to the now-deleted path.
  if (activeSessionId === fullId) {
    activeSessionId = null;
    activeSessionPath = null;
  }
  return true;
}

/**
 * Rename a session by copying + deleting. Supports partial ID match.
 *
 * BUG FIX (split-write-on-rename): If the renamed session was the ACTIVE
 * one, update `activeSessionId`/`activeSessionPath` to point to the new
 * file. Without this, the old file would be deleted but `activeSessionPath`
 * would still point to the old path — the next `appendMessage` would
 * CREATE a new file at the old path (with no header), splitting the
 * conversation across two files.
 */
export function renameSession(oldId: string, newId: string, cwd?: string): boolean {
  const dir = getProjectSessionDir(cwd);
  const fullOldId = resolveSessionId(oldId, dir);
  const oldPath = path.join(dir, `${fullOldId}.jsonl`);
  const newPath = path.join(dir, `${newId}.jsonl`);

  if (!fs.existsSync(oldPath)) return false;
  if (fs.existsSync(newPath)) return false;

  try {
    const content = fs.readFileSync(oldPath, "utf8");
    const lines = content.split("\n");
    // Update header
    if (lines[0]) {
      const header = JSON.parse(lines[0]);
      header.id = newId;
      lines[0] = JSON.stringify(header);
    }
    fs.writeFileSync(newPath, lines.join("\n"), "utf8");
    fs.unlinkSync(oldPath);
    // If we just renamed the active session, repoint the active pointers
    // to the new file so subsequent appends go to the right place.
    if (activeSessionId === fullOldId) {
      activeSessionId = newId;
      activeSessionPath = newPath;
    }
    return true;
  } catch {
    return false;
  }
}
