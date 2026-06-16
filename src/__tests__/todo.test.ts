import { describe, it, expect, beforeEach } from "vitest";
import { todoWrite, getTodos, setTodos, renderTodoBar } from "../todo.js";

describe("todoWrite", () => {
  beforeEach(() => {
    setTodos([]);
  });

  it("sets todos from flat array", () => {
    const result = todoWrite([
      { status: "pending", content: "Task 1", active_form: "Working on task 1" },
      { status: "in_progress", content: "Task 2", active_form: "Working on task 2" },
    ]);

    expect(result).toContain("2 itens");
    expect(getTodos()).toHaveLength(2);
  });

  it("sets todos from {items: [...]} shape", () => {
    const result = todoWrite({
      items: [
        { status: "completed", content: "Done task", active_form: "Done" },
      ],
    });

    expect(result).toContain("1 itens");
    expect(getTodos()[0].status).toBe("completed");
  });

  it("sets todos from {todos: [...]} shape", () => {
    todoWrite({
      todos: [
        { status: "pending", content: "Task A", active_form: "A" },
      ],
    });

    expect(getTodos()).toHaveLength(1);
  });

  it("sets todos from {todo: [...]} shape", () => {
    const result = todoWrite({
      todo: [
        { status: "completed", content: "Done task", active_form: "Done" },
        { status: "pending", content: "Pending task", active_form: "Pending" },
      ],
    });

    expect(result).toContain("2 itens");
    expect(getTodos()).toHaveLength(2);
    expect(getTodos()[0].status).toBe("completed");
    expect(getTodos()[1].status).toBe("pending");
  });

  it("enforces single in_progress", () => {
    setTodos([
      { status: "in_progress", content: "First", active_form: "First" },
      { status: "in_progress", content: "Second", active_form: "Second" },
      { status: "pending", content: "Third", active_form: "Third" },
    ]);

    const todos = getTodos();
    const inProgress = todos.filter((t) => t.status === "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0].content).toBe("First");
  });

  it("clears todos with empty array", () => {
    todoWrite([
      { status: "pending", content: "Task", active_form: "T" },
    ]);
    expect(getTodos()).toHaveLength(1);

    todoWrite([]);
    expect(getTodos()).toHaveLength(0);
  });

  it("filters out empty content", () => {
    todoWrite([
      { status: "pending", content: "", active_form: "" },
      { status: "pending", content: "Real task", active_form: "Real" },
    ]);

    expect(getTodos()).toHaveLength(1);
  });
});

describe("renderTodoBar", () => {
  beforeEach(() => {
    setTodos([]);
  });

  it("returns empty string when no todos", () => {
    expect(renderTodoBar()).toBe("");
  });

  it("renders a box with todos", () => {
    setTodos([
      { status: "completed", content: "Done", active_form: "Done" },
      { status: "in_progress", content: "Working", active_form: "Working..." },
      { status: "pending", content: "Pending", active_form: "Pending" },
    ]);

    const bar = renderTodoBar();
    expect(bar).toContain("3 tasks");
    expect(bar).toContain("✓");
    expect(bar).toContain("●");
    expect(bar).toContain("○");
    expect(bar).toContain("Working...");
    expect(bar).toContain("Done");
  });
});
