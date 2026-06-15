/**
 * session.ts — Session persistence: save/restore conversations to disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";
import * as history from "./history.js";

const SESSION_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".claude-killer",
  "sessions"
);

export interface SessionMeta {
  id: string;
  createdAt: string;
  lastModified: string;
  messageCount: number;
  summary: string;
}

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replaceAll(":", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${date}_${time}_${rand}`;
}

export function saveSession(id?: string): string {
  ensureSessionDir();
  const sessionId = id ?? generateSessionId();
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);

  const messages = history.getHistory();
  const data = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
    messageCount: messages.length,
    messages,
    cavemanLevel: history.getCavemanLevel(),
    planMode: history.isPlanMode(),
  };

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  log.success(`Session saved: ${sessionId} (${messages.length} messages)`);
  return sessionId;
}

export function loadSession(sessionId: string): boolean {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);

  if (!fs.existsSync(filePath)) {
    log.error(`Session not found: ${sessionId}`);
    return false;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    // Reset and restore history
    history.resetHistory();

    // Add messages back (skip system prompt from old session, let history.ts regenerate it)
    for (const msg of data.messages) {
      if (msg.role === "system") continue; // will be regenerated
      if (msg.role === "user") {
        history.addUserMessage(msg.content);
      } else if (msg.role === "assistant") {
        history.addRawAssistantMessage(msg);
      } else if (msg.role === "tool") {
        history.addToolResult(msg.tool_call_id, msg.content);
      }
    }

    // Restore state
    if (data.cavemanLevel) history.setCavemanLevel(data.cavemanLevel);
    if (data.planMode) history.setPlanMode(true);

    log.success(`Session loaded: ${sessionId} (${data.messageCount} messages)`);
    return true;
  } catch (err) {
    log.error(`Failed to load session: ${(err as Error).message}`);
    return false;
  }
}

export function listSessions(): SessionMeta[] {
  ensureSessionDir();

  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(SESSION_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      sessions.push({
        id: data.id ?? file.replace(".json", ""),
        createdAt: data.createdAt ?? "unknown",
        lastModified: data.lastModified ?? "unknown",
        messageCount: data.messageCount ?? 0,
        summary: `Session with ${data.messageCount ?? 0} messages`,
      });
    } catch {
      // skip corrupt files
    }
  }

  return sessions.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

export function deleteSession(sessionId: string): boolean {
  const filePath = path.join(SESSION_DIR, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function autoSave(): string | null {
  try {
    return saveSession();
  } catch (err) {
    log.error(`Auto-save failed: ${(err as Error).message}`);
    return null;
  }
}
