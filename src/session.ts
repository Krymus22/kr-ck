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
 */
export function startSession(cwd?: string, customId?: string): string {
  const dir = getProjectSessionDir(cwd);
  ensureSessionDir(dir);
  const id = customId ?? generateSessionId();
  const filePath = path.join(dir, `${id}.jsonl`);

  // Write header (first line = metadata)
  const header = JSON.stringify({
    type: "session-header",
    id,
    createdAt: new Date().toLocaleString("sv-SE"), // local time ISO format
    cwd: cwd ?? process.cwd(),
  });
  fs.writeFileSync(filePath, header + "\n", "utf8");

  activeSessionId = id;
  activeSessionPath = filePath;
  log.debug(`[SESSION] New session started: ${id}`);
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
 * Get the last session for the current project directory.
 * Returns null if no sessions exist.
 */
export function getLastSession(cwd?: string): { id: string; path: string } | null {
  const dir = getProjectSessionDir(cwd);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse(); // most recent first (IDs are timestamp-based)

  if (files.length === 0) return null;

  const lastFile = files[0]!;
  return {
    id: lastFile.replace(".jsonl", ""),
    path: path.join(dir, lastFile),
  };
}

/**
 * Load a session from disk. Returns array of messages (excluding header).
 * Does NOT modify history — caller is responsible for that.
 *
 * Supports partial ID match: if exact ID not found, looks for files
 * that START WITH the given prefix. This lets users type
 * /session load 2026-07 instead of the full timestamp ID.
 */
export function loadSessionMessages(sessionId: string, cwd?: string): unknown[] | null {
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
          return data.messages ?? [];
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
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "session-header") continue; // skip header
        messages.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return null;
  }
}

/**
 * Set the active session (after loading).
 */
export function setActiveSession(sessionId: string, cwd?: string): void {
  const dir = getProjectSessionDir(cwd);
  activeSessionId = sessionId;
  activeSessionPath = path.join(dir, `${sessionId}.jsonl`);
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
      const msgCount = lines.length - 1; // minus header
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
 */
export function deleteSession(sessionId: string, cwd?: string): boolean {
  const dir = getProjectSessionDir(cwd);
  const fullId = resolveSessionId(sessionId, dir);
  const filePath = path.join(dir, `${fullId}.jsonl`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Rename a session by copying + deleting. Supports partial ID match.
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
    return true;
  } catch {
    return false;
  }
}
