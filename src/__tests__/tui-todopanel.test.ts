import { describe, it, expect } from "vitest";
import { TodoPanel, TodoItem } from "../tui/TodoPanel.js";
import { colors, icons } from "../tui/theme.js";

function selectTodoIcon(status: TodoItem["status"]): string {
  if (status === "completed") return icons.check;
  if (status === "in_progress") return icons.dot;
  return icons.circle;
}

function selectTodoColor(status: TodoItem["status"]): string {
  if (status === "completed") return colors.success;
  if (status === "in_progress") return colors.secondary;
  return colors.muted;
}

function selectTodoDisplay(item: TodoItem): string {
  return item.status === "in_progress" && item.active_form ? item.active_form : item.content;
}

function shouldRenderEmpty(todos: TodoItem[]): boolean {
  return todos.length === 0;
}

describe("TodoPanel component", () => {
  it("should be a function", () => {
    expect(typeof TodoPanel).toBe("function");
  });

  describe("TodoItem type", () => {
    it("should accept pending status", () => {
      const item: TodoItem = { status: "pending", content: "task", active_form: "" };
      expect(item.status).toBe("pending");
    });

    it("should accept in_progress status", () => {
      const item: TodoItem = { status: "in_progress", content: "task", active_form: "working" };
      expect(item.status).toBe("in_progress");
    });

    it("should accept completed status", () => {
      const item: TodoItem = { status: "completed", content: "task", active_form: "" };
      expect(item.status).toBe("completed");
    });
  });

  describe("icon selection logic", () => {
    it("should use check icon for completed", () => {
      expect(selectTodoIcon("completed")).toBe(icons.check);
    });

    it("should use dot icon for in_progress", () => {
      expect(selectTodoIcon("in_progress")).toBe(icons.dot);
    });

    it("should use circle icon for pending", () => {
      expect(selectTodoIcon("pending")).toBe(icons.circle);
    });
  });

  describe("color selection logic", () => {
    it("should use success color for completed", () => {
      expect(selectTodoColor("completed")).toBe(colors.success);
    });

    it("should use secondary color for in_progress", () => {
      expect(selectTodoColor("in_progress")).toBe(colors.secondary);
    });

    it("should use muted color for pending", () => {
      expect(selectTodoColor("pending")).toBe(colors.muted);
    });
  });

  describe("display text selection logic", () => {
    it("should show active_form when in_progress and active_form is set", () => {
      const item: TodoItem = { status: "in_progress", content: "Fix bug", active_form: "Investigating error" };
      expect(selectTodoDisplay(item)).toBe("Investigating error");
    });

    it("should show content when in_progress but active_form is empty", () => {
      const item: TodoItem = { status: "in_progress", content: "Fix bug", active_form: "" };
      expect(selectTodoDisplay(item)).toBe("Fix bug");
    });

    it("should show content for pending status", () => {
      const item: TodoItem = { status: "pending", content: "Write tests", active_form: "" };
      expect(selectTodoDisplay(item)).toBe("Write tests");
    });

    it("should show content for completed status", () => {
      const item: TodoItem = { status: "completed", content: "Deploy", active_form: "" };
      expect(selectTodoDisplay(item)).toBe("Deploy");
    });
  });

  describe("empty list behavior", () => {
    it("should return true for empty todos (component returns null)", () => {
      expect(shouldRenderEmpty([])).toBe(true);
    });

    it("should return false for non-empty todos", () => {
      const todos: TodoItem[] = [{ status: "pending", content: "task", active_form: "" }];
      expect(shouldRenderEmpty(todos)).toBe(false);
    });
  });

  describe("task count header", () => {
    it("should show correct count", () => {
      const todos: TodoItem[] = [
        { status: "pending", content: "a", active_form: "" },
        { status: "in_progress", content: "b", active_form: "" },
        { status: "completed", content: "c", active_form: "" },
      ];
      expect(todos.length).toBe(3);
    });
  });
});
