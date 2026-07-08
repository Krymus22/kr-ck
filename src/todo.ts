/**
 * Shared task list state for the TodoWrite tool.
 *
 * The last call to `todoWrite()` wins; the list is rendered at the bottom
 * of the REPL via `renderTodoBar()` after each model turn.
 *
 * Statuses:
 *   - "pending"      -> not started
 *   - "in_progress"  -> currently being worked on (only one allowed at a time)
 *   - "completed"    -> done
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

/**
 * Clear all todos. Equivalent to `setTodos([])`.
 *
 * Called by /reset, /session new, /session load, and auto-load on startup
 * to prevent the previous session's todo list from leaking into the new
 * session (state-leak bug fix — `currentTodos` is a module-level singleton).
 */
export function resetTodo(): void {
  currentTodos = [];
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

// --- Bar renderer (used by index.ts) --------------------------------------

/**
 * Returns a multi-line string representation of the current task list,
 * or empty string if there are no tasks.
 *
 * BUG FIX (alignment): the previous implementation measured string length
 * with `.length` AFTER wrapping substrings in ANSI color codes. Because
 * each `\x1b[38;2;...m` sequence adds ~23 chars that the terminal does
 * NOT render visibly, the computed length was ~23 chars larger than the
 * visible width. As a result, `padEnd(innerWidth)` added fewer spaces
 * than needed, and the closing `|` fell ~23 chars short of the `+`
 * border — producing a visibly broken box:
 *
 *     +----------------------------------------------------------------------------+
 *     | [3 tasks]                                           |   <- "|" stops short
 *     | OK Done                                              |
 *     +----------------------------------------------------------------------------+
 *
 * The fix computes the VISIBLE row text first (no ANSI codes), truncates
 * and pads based on the real character count, and only then re-injects
 * the ANSI color around the icon. Now every line has exactly
 * `innerWidth + 4` visible chars, matching the borders.
 */
export function renderTodoBar(maxWidth = 80): string {
  if (currentTodos.length === 0) return "";

  const innerWidth = Math.max(40, maxWidth - 4);
  const lines: string[] = [];
  const cyan = (s: string) => `\x1b[38;2;110;231;247m${s}\x1b[0m`;
  const violet = (s: string) => `\x1b[38;2;167;139;250m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[38;2;52;211;153m${s}\x1b[0m`;
  const grey = (s: string) => `\x1b[38;2;107;114;128m${s}\x1b[0m`;

  // Top border: `  +---...---+` (visible width = innerWidth + 4)
  lines.push(grey("  +" + "-".repeat(innerWidth) + "+"));

  // Header line — pad based on VISIBLE length so the closing "|" aligns
  // with the top border's "+". The previous code used `header.length`
  // which INCLUDED ANSI escape codes, causing the box to be misaligned
  // (closing "|" was ~23 chars short of the "+").
  const headerVisible = ` [${currentTodos.length} tasks]`;
  const headerPad = " ".repeat(Math.max(0, innerWidth - headerVisible.length));
  lines.push("  |" + cyan(headerVisible) + headerPad + "|");

  // Rows
  for (const t of currentTodos) {
    let iconVisible: string;
    let iconColored: string;
    if (t.status === "completed") {
      iconVisible = "OK";
      iconColored = green(iconVisible);
    } else if (t.status === "in_progress") {
      iconVisible = "[*]";
      iconColored = violet(iconVisible);
    } else {
      iconVisible = "[ ]";
      iconColored = grey(iconVisible);
    }
    const display = t.status === "in_progress" && t.active_form ? t.active_form : t.content;

    // Build the VISIBLE row text (no ANSI codes) so truncation/padding
    // operate on real character counts.
    const rowVisible = ` ${iconVisible} ${display}`.replace(/\s+/g, " ");
    let truncated = rowVisible;
    if (truncated.length > innerWidth) {
      // Truncate to exactly innerWidth chars: (innerWidth - 3) chars + "..."
      truncated = truncated.slice(0, Math.max(1, innerWidth - 3)) + "...";
    }
    // Pad to exactly innerWidth visible chars.
    const padded = truncated.padEnd(innerWidth);

    // Re-inject the ANSI color around the icon. The icon always sits at
    // position [1, 1+iconVisible.length) (after the leading space). Since
    // innerWidth >= 40, truncation never reaches the icon.
    const before = padded.slice(0, 1); // leading space
    const after = padded.slice(1 + iconVisible.length); // display + padding
    lines.push("  |" + before + iconColored + after + "|");
  }

  // Bottom border
  lines.push(grey("  +" + "-".repeat(innerWidth) + "+"));
  return lines.join("\n");
}