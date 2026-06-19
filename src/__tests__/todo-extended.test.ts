/**
 * todo-extended.test.ts — Casos edge / integração p/ todo.ts.
 * Foco: addTodo (2), updateTodo (2), renderTodoBar (2), resetTodo (1), edge (1).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { todoWrite, getTodos, setTodos, renderTodoBar, type TodoItem } from "../todo.js";

function makeItem(content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { status, content, active_form: content };
}

describe("todo (extended) — addTodo", () => {
  beforeEach(() => setTodos([]));

  it("todoWrite com array plano adiciona todos na ordem dada", () => {
    const result = todoWrite([makeItem("A"), makeItem("B"), makeItem("C")]);
    expect(result).toContain("3 itens");
    expect(getTodos().map((t) => t.content)).toEqual(["A", "B", "C"]);
  });

  it("setTodos diretamente também popula o estado (sem passar por todoWrite)", () => {
    setTodos([makeItem("X"), makeItem("Y")]);
    expect(getTodos().length).toBe(2);
    expect(getTodos()[0]!.content).toBe("X");
  });
});

describe("todo (extended) — updateTodo", () => {
  beforeEach(() => setTodos([]));

  it("transição pending → in_progress → completed via re-setTodos", () => {
    setTodos([makeItem("task1", "pending")]);
    expect(getTodos()[0]!.status).toBe("pending");
    setTodos([makeItem("task1", "in_progress")]);
    expect(getTodos()[0]!.status).toBe("in_progress");
    setTodos([makeItem("task1", "completed")]);
    expect(getTodos()[0]!.status).toBe("completed");
  });

  it("atualizar um item não afeta os demais (substituição completa)", () => {
    setTodos([makeItem("A", "completed"), makeItem("B", "pending"), makeItem("C", "pending")]);
    setTodos([makeItem("A", "completed"), makeItem("B", "in_progress"), makeItem("C", "pending")]);
    const todos = getTodos();
    expect(todos[0]!.status).toBe("completed");
    expect(todos[1]!.status).toBe("in_progress");
    expect(todos[2]!.status).toBe("pending");
  });
});

describe("todo (extended) — renderTodoBar", () => {
  beforeEach(() => setTodos([]));

  it("render com maxWidth customizado (40) ainda renderiza o header de tasks", () => {
    setTodos([makeItem("task pequena")]);
    const bar = renderTodoBar(40);
    expect(bar).toContain("1 tasks");
    expect(bar).toContain("[ ]"); // pending
  });

  it("render mostra active_form (não content) quando status é in_progress", () => {
    setTodos([{ status: "in_progress", content: "Task Content", active_form: "Currently doing" }]);
    const bar = renderTodoBar(120);
    expect(bar).toContain("Currently doing");
    // O content "Task Content" não aparece quando active_form está em uso
    expect(bar).not.toContain("Task Content");
  });
});

describe("todo (extended) — resetTodo", () => {
  beforeEach(() => setTodos([]));

  it("setTodos([]) limpa completamente; renderTodoBar retorna ''", () => {
    setTodos([makeItem("A"), makeItem("B"), makeItem("C")]);
    expect(getTodos().length).toBe(3);
    expect(renderTodoBar()).not.toBe("");
    setTodos([]);
    expect(getTodos().length).toBe(0);
    expect(renderTodoBar()).toBe("");
  });
});

describe("todo (extended) — edge cases", () => {
  beforeEach(() => setTodos([]));

  it("conteúdo > 200 chars é truncado para 200 (com reticências via slice)", () => {
    const long = "x".repeat(300);
    todoWrite([{ status: "pending", content: long, active_form: long }]);
    const t = getTodos()[0]!;
    expect(t.content.length).toBe(200);
    expect(t.active_form.length).toBe(200);
  });

  it("active_form faltando usa content como fallback", () => {
    // @ts-expect-error: testando input sem active_form
    todoWrite([{ status: "pending", content: "sem active" }]);
    const t = getTodos()[0]!;
    expect(t.content).toBe("sem active");
    expect(t.active_form).toBe("sem active");
  });
});
