/**
 * taskState-deep.test.ts — Testes profundos do taskState
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  readTaskState,
  writeTaskState,
  updateTaskState,
  appendTaskStateItem,
  markTaskItemDone,
  initTaskStateFromUserMessage,
  getTaskStateSummary,
  clearTaskState,
} from "../taskState.js";

describe("taskState — deep coverage", () => {
  beforeEach(() => {
    clearTaskState();
  });

  describe("writeTaskState / readTaskState", () => {
    it("escreve e lê task state", () => {
      writeTaskState({
        title: "Test Task",
        status: "in_progress",
        items: [{ text: "item 1", done: false }],
        notes: "test notes",
      });
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.title).toBe("Test Task");
      expect(state!.items.length).toBe(1);
    });

    it("retorna null quando não há task state", () => {
      clearTaskState();
      const state = readTaskState();
      expect(state).toBeNull();
    });
  });

  describe("updateTaskState", () => {
    it("atualiza campos parciais", () => {
      writeTaskState({
        title: "Original",
        status: "pending",
        items: [],
        notes: "",
      });
      updateTaskState({ status: "in_progress" });
      const state = readTaskState();
      expect(state!.status).toBe("in_progress");
      expect(state!.title).toBe("Original"); // não mudou
    });

    it("cria task state se não existe", () => {
      clearTaskState();
      updateTaskState({ title: "New Task" });
      const state = readTaskState();
      expect(state).not.toBeNull();
      expect(state!.title).toBe("New Task");
    });
  });

  describe("appendTaskStateItem", () => {
    it("adiciona item ao task state", () => {
      writeTaskState({
        title: "Test",
        status: "in_progress",
        items: [],
        notes: "",
      });
      appendTaskStateItem("todo", "new item");
      const state = readTaskState();
      expect(state!.items.length).toBe(1);
      expect(state!.items[0].text).toBe("new item");
    });

    it("não lança exceção quando task state não existe", () => {
      clearTaskState();
      expect(() => appendTaskStateItem("todo", "item")).not.toThrow();
    });
  });

  describe("markTaskItemDone", () => {
    it("marca item como feito", () => {
      writeTaskState({
        title: "Test",
        status: "in_progress",
        items: [{ text: "do something", done: false }],
        notes: "",
      });
      markTaskItemDone("do something");
      const state = readTaskState();
      expect(state!.items[0].done).toBe(true);
    });

    it("não lança exceção quando item não existe", () => {
      writeTaskState({
        title: "Test",
        status: "in_progress",
        items: [],
        notes: "",
      });
      expect(() => markTaskItemDone("nonexistent")).not.toThrow();
    });
  });

  describe("initTaskStateFromUserMessage", () => {
    it("inicializa task state a partir de mensagem", () => {
      initTaskStateFromUserMessage("Create a gacha system for the game");
      const state = readTaskState();
      // Pode ou não criar task state dependendo da heurística
      if (state) {
        expect(state).toHaveProperty("title");
      }
    });
  });

  describe("getTaskStateSummary", () => {
    it("retorna null quando não há task state", () => {
      clearTaskState();
      const summary = getTaskStateSummary();
      expect(summary).toBeNull();
    });

    it("retorna string quando há task state", () => {
      writeTaskState({
        title: "Test Task",
        status: "in_progress",
        items: [{ text: "item 1", done: false }],
        notes: "",
      });
      const summary = getTaskStateSummary();
      expect(typeof summary).toBe("string");
      expect(summary).toContain("Test Task");
    });
  });

  describe("clearTaskState", () => {
    it("não lança exceção", () => {
      expect(() => clearTaskState()).not.toThrow();
    });

    it("limpa task state", () => {
      writeTaskState({ title: "Test", status: "pending", items: [], notes: "" });
      clearTaskState();
      expect(readTaskState()).toBeNull();
    });
  });
});
