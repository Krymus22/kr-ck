/**
 * Shared task list state for the TodoWrite tool.
 *
 * The last call to `todoWrite()` wins; the list is rendered at the bottom
 * of the REPL via `renderTodoBar()` after each model turn.
 *
 * Statuses:
 *   - "pending"      → not started
 *   - "in_progress"  → currently being worked on (only one allowed at a time)
 *   - "completed"    → done
 *
 * Each item carries both `content` (past tense, what was done) and
 * `active_form` (present continuous, shown when status is in_progress).
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  status: TodoStatus;
  content: string;
  active_form: string;
}

let currentTodos: TodoItem[] = [];

function resolveStatus(status: TodoStatus, firstInProgressSeen: { value: boolean }): TodoStatus {
  if (status === "completed") return "completed";
  if (status === "in_progress") {
    if (firstInProgressSeen.value) return "pending";
    firstInProgressSeen.value = true;
    return "in_progress";
  }
  return "pending";
}

export function getTodos(): ReadonlyArray<TodoItem> {
  return currentTodos;
}

export function setTodos(items: TodoItem[]): void {
  // Coerce statuses, keep only first in_progress if multiple submitted.
  const firstInProgress = { value: false };
  currentTodos = items.map((it) => {
    const status = resolveStatus(it.status, firstInProgress);
    return {
      status,
      content: String(it.content ?? "").slice(0, 200),
      active_form: String(it.active_form ?? it.content ?? "").slice(0, 200),
    };
  }).filter((it) => it.content.length > 0);
}

/**
 * Apply a task list write tool call. Accepts any of:
 *   - a flat array of TodoItem (preferred)
 *   - a single object {todos: TodoItem[]}
 *   - field variants with array properties
 * Returns a result string for the model.
 */
export function todoWrite(args: { items?: TodoItem[]; todos?: TodoItem[]; todo?: TodoItem[] } | TodoItem[]): string {
  let items: TodoItem[] = [];
  if (Array.isArray(args)) {
    items = args;
  } else if (Array.isArray(args.items)) {
    items = args.items;
  } else if (Array.isArray(args.todos)) {
    items = args.todos;
  } else if (Array.isArray(args.todo)) {
    items = args.todo;
  }
  setTodos(items);
  return `[SUCCESS] Todo list atualizado: ${currentTodos.length} itens ` +
    `(${currentTodos.filter((t) => t.status === "completed").length} done, ` +
    `${currentTodos.filter((t) => t.status === "in_progress").length} active, ` +
    `${currentTodos.filter((t) => t.status === "pending").length} pending).`;
}

// ─── Bar renderer (used by index.ts) ──────────────────────────────────────

function pad(s: string, n: number): string {
  s = s.replaceAll(/\s+/g, " ");
  if (s.length > n) s = s.slice(0, Math.max(1, n - 1)) + "…";
  return s.padEnd(n);
}

/**
 * Returns a multi-line string representation of the current task list,
 * or empty string if there are no tasks.
 */
export function renderTodoBar(maxWidth = 80): string {
  if (currentTodos.length === 0) return "";

  const innerWidth = Math.max(40, maxWidth - 4);
  const lines: string[] = [];
  const cyan = (s: string) => `\x1b[38;2;110;231;247m${s}\x1b[0m`;
  const violet = (s: string) => `\x1b[38;2;167;139;250m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[38;2;52;211;153m${s}\x1b[0m`;
  const grey = (s: string) => `\x1b[38;2;107;114;128m${s}\x1b[0m`;

  const header = ` ${cyan("[" + currentTodos.length + " tasks]")}`;
  lines.push(grey("  ┌" + "─".repeat(innerWidth) + "┐") + "\n" + "  │" + header + " ".repeat(Math.max(0, innerWidth - header.length)) + "│");

  for (const t of currentTodos) {
    let icon: string;
    if (t.status === "completed") {
      icon = green("✓");
    } else if (t.status === "in_progress") {
      icon = violet("●");
    } else {
      icon = grey("○");
    }
    const display = t.status === "in_progress" && t.active_form ? t.active_form : t.content;
    const padded = pad(" " + icon + " " + display, innerWidth);
    lines.push("  │" + violet(padded.slice(0, innerWidth + 30)) + "│");
  }
  lines.push(grey("  └" + "─".repeat(innerWidth) + "┘"));
  return lines.join("\n");
}