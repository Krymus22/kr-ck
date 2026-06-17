/**
 * taskState.ts - Structured task-state note-taking.
 *
 * The model maintains a TASK_STATE.md file in the project's
 * .claude-killer/ directory with a structured snapshot of:
 *   - What has been done (Done section)
 *   - What remains (Pending section)
 *   - Decisions made (Decisions section)
 *   - Bugs found (Bugs section)
 *   - Dependencies / blockers (Dependencies section)
 *
 * This file is updated:
 *   - On every stop_reason (when the agent finishes a turn)
 *   - On context compaction (so the compacted history can be reconstructed
 *     from TASK_STATE.md instead of being lost)
 *   - On explicit request via the atualizar_estado tool
 *
 * The structured format makes it easy for the model to "remember"
 * where it left off after compaction, and for the user to inspect
 * progress at any time.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export interface TaskState {
  /** Human-readable task title (set from the first user message) */
  title: string;
  /** ISO timestamp of the last update */
  updatedAt: string;
  /** ISO timestamp of when the task started */
  startedAt: string;
  /** Short summary of what's been done so far */
  done: string[];
  /** Items still pending */
  todo: string[];
  /** Decisions made (with brief rationale) */
  decisions: string[];
  /** Bugs encountered (with file:line if known) */
  bugs: string[];
  /** Dependencies / blockers */
  dependencies: string[];
  /** Free-form notes */
  notes: string;
}

// --- Path Helpers ------------------------------------------------------------

const DEFAULT_TASK_TITLE = "Untitled task";

function getTaskStatePath(): string {
  // Mirror the memory.ts projectDir layout: <cwd>/.claude-killer/TASK_STATE.md
  return path.join(process.cwd(), ".claude-killer", "TASK_STATE.md");
}

function ensureDir(): void {
  const dir = path.dirname(getTaskStatePath());
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.warn(`[TASK_STATE] Failed to create dir ${dir}: ${(err as Error).message}`);
    }
  }
}

// --- Persistence -------------------------------------------------------------

/**
 * Read the current TASK_STATE.md (if any). Returns null if not present.
 * Tolerant of partially-broken files - fills missing fields with defaults.
 */
export function readTaskState(): TaskState | null {
  const filePath = getTaskStatePath();
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    return parseTaskStateMarkdown(raw);
  } catch (err) {
    log.warn(`[TASK_STATE] Failed to read: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Write the task state to TASK_STATE.md.
 */
export function writeTaskState(state: TaskState): void {
  ensureDir();
  const filePath = getTaskStatePath();
  try {
    fs.writeFileSync(filePath, serializeTaskStateMarkdown(state), "utf8");
    log.debug(`[TASK_STATE] Written to ${filePath}`);
  } catch (err) {
    log.warn(`[TASK_STATE] Failed to write: ${(err as Error).message}`);
  }
}

/**
 * Update specific fields of the current task state (merges with existing).
 * Returns the updated state.
 */
export function updateTaskState(patch: Partial<TaskState>): TaskState {
  const current = readTaskState();
  const now = new Date().toISOString();
  const merged: TaskState = {
    title: patch.title ?? current?.title ?? DEFAULT_TASK_TITLE,
    updatedAt: now,
    startedAt: current?.startedAt ?? now,
    done: patch.done ?? current?.done ?? [],
    todo: patch.todo ?? current?.todo ?? [],
    decisions: patch.decisions ?? current?.decisions ?? [],
    bugs: patch.bugs ?? current?.bugs ?? [],
    dependencies: patch.dependencies ?? current?.dependencies ?? [],
    notes: patch.notes ?? current?.notes ?? "",
  };
  writeTaskState(merged);
  return merged;
}

/**
 * Append a single item to a specific section. Useful for incremental
 * updates like "I just finished X" or "Found a bug in foo.ts:42".
 */
export function appendTaskStateItem(
  section: "done" | "todo" | "decisions" | "bugs" | "dependencies",
  item: string
): TaskState {
  const current = readTaskState();
  const list = current?.[section] ?? [];
  if (!list.includes(item)) {
    list.push(item);
  }
  return updateTaskState({ [section]: list } as Partial<TaskState>);
}

/**
 * Move an item from the pending list to `done`. Best-effort: matches by substring.
 */
export function markTaskItemDone(itemSubstring: string): TaskState {
  const current = readTaskState();
  if (!current) return updateTaskState({});
  const todo = [...(current.todo ?? [])];
  const done = [...(current.done ?? [])];
  const idx = todo.findIndex((t) => t.toLowerCase().includes(itemSubstring.toLowerCase()));
  if (idx >= 0) {
    const [moved] = todo.splice(idx, 1);
    done.push(moved);
  }
  return updateTaskState({ todo, done });
}

// --- Markdown Serialization --------------------------------------------------

function serializeTaskStateMarkdown(state: TaskState): string {
  const lines: string[] = [];
  lines.push(`# TASK_STATE`);
  lines.push(``);
  lines.push(`**Title:** ${state.title}`);
  lines.push(`**Started:** ${state.startedAt}`);
  lines.push(`**Updated:** ${state.updatedAt}`);
  lines.push(``);
  lines.push(`## Done`);
  if (state.done.length === 0) lines.push(`_(nothing yet)_`);
  for (const item of state.done) lines.push(`- [x] ${item}`);
  lines.push(``);
  lines.push(`## Todo`);
  if (state.todo.length === 0) lines.push(`_(nothing pending)_`);
  for (const item of state.todo) lines.push(`- [ ] ${item}`);
  lines.push(``);
  lines.push(`## Decisions`);
  if (state.decisions.length === 0) lines.push(`_(none recorded)_`);
  for (const item of state.decisions) lines.push(`- ${item}`);
  lines.push(``);
  lines.push(`## Bugs`);
  if (state.bugs.length === 0) lines.push(`_(none known)_`);
  for (const item of state.bugs) lines.push(`- ${item}`);
  lines.push(``);
  lines.push(`## Dependencies`);
  if (state.dependencies.length === 0) lines.push(`_(none)_`);
  for (const item of state.dependencies) lines.push(`- ${item}`);
  lines.push(``);
  lines.push(`## Notes`);
  lines.push(state.notes || `_(empty)_`);
  lines.push(``);
  return lines.join("\n");
}

function parseTaskStateMarkdown(raw: string): TaskState | null {
  if (!raw || raw.trim() === "") return null;

  const state: TaskState = {
    title: DEFAULT_TASK_TITLE,
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    done: [],
    todo: [],
    decisions: [],
    bugs: [],
    dependencies: [],
    notes: "",
  };

  // Title
  const titleMatch = /\*\*Title:\*\*\s*(.+)/.exec(raw);
  if (titleMatch) state.title = titleMatch[1].trim();

  const startedMatch = /\*\*Started:\*\*\s*(.+)/.exec(raw);
  if (startedMatch) state.startedAt = startedMatch[1].trim();

  const updatedMatch = /\*\*Updated:\*\*\s*(.+)/.exec(raw);
  if (updatedMatch) state.updatedAt = updatedMatch[1].trim();

  // Sections
  state.done = extractListSection(raw, "## Done");
  state.todo = extractListSection(raw, "## Todo");
  state.decisions = extractListSection(raw, "## Decisions");
  state.bugs = extractListSection(raw, "## Bugs");
  state.dependencies = extractListSection(raw, "## Dependencies");

  // Notes - everything after "## Notes" until EOF
  const notesMatch = /## Notes\s*\n([\s\S]*?)$/.exec(raw);
  if (notesMatch) {
    const notes = notesMatch[1].trim();
    if (notes && notes !== "_(empty)_") state.notes = notes;
  }

  return state;
}

function extractListSection(raw: string, header: string): string[] {
  const items: string[] = [];
  // Match the section header, then capture everything until the next ## header
  const sectionRegex = new RegExp(`${escapeRegex(header)}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = sectionRegex.exec(raw);
  if (!match) return items;
  const body = match[1];
  const lineRegex = /^-\s+(?:\[[ xX]\]\s+)?(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(body)) !== null) {
    const item = m[1].trim();
    if (item && !item.startsWith("_(nothing") && !item.startsWith("_(none")) {
      items.push(item);
    }
  }
  return items;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Public Helpers ----------------------------------------------------------

/**
 * Initialize the task state from a user message (the first message of a session).
 * Only sets the title if the file doesn't already exist.
 */
export function initTaskStateFromUserMessage(userMessage: string): void {
  const existing = readTaskState();
  if (existing) return; // don't overwrite
  const title = userMessage.slice(0, 100).replaceAll("\n", " ").trim() || DEFAULT_TASK_TITLE;
  const now = new Date().toISOString();
  writeTaskState({
    title,
    updatedAt: now,
    startedAt: now,
    done: [],
    todo: [],
    decisions: [],
    bugs: [],
    dependencies: [],
    notes: "",
  });
}

/**
 * Build a compact summary string suitable for injecting into the system
 * message after context compaction. Returns null if no task state exists.
 */
export function getTaskStateSummary(): string | null {
  const state = readTaskState();
  if (!state) return null;

  const parts: string[] = [];
  parts.push(`## TASK_STATE (auto-maintained)`);
  parts.push(`Title: ${state.title}`);
  parts.push(`Started: ${state.startedAt} - Updated: ${state.updatedAt}`);

  const sections: Array<{ label: string; items: string[]; marker: string }> = [
    { label: "Done", items: state.done, marker: "OK" },
    { label: "Todo", items: state.todo, marker: "[ ]" },
    { label: "Decisions", items: state.decisions, marker: "*" },
    { label: "Bugs", items: state.bugs, marker: "!" },
    { label: "Dependencies", items: state.dependencies, marker: "!" },
  ];
  for (const s of sections) {
    if (s.items.length > 0) {
      parts.push(`${s.label}:`);
      for (const item of s.items) parts.push(`  ${s.marker} ${item}`);
    }
  }
  if (state.notes) parts.push(`Notes: ${state.notes}`);
  return parts.join("\n");
}

/**
 * Clear the task state file. Called when the user issues /reset.
 */
export function clearTaskState(): void {
  const filePath = getTaskStatePath();
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    log.warn(`[TASK_STATE] Failed to clear: ${(err as Error).message}`);
  }
}
