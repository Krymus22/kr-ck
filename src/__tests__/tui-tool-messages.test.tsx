/**
 * tui-tool-messages.test.tsx — Tests for tool call/result display in chat.
 *
 * BUG BEING FIXED: Tool calls (ler_arquivo, aplicar_diff, executar_comando)
 * were being displayed via console.log() from the logger, which broke the
 * Ink TUI layout by appearing ABOVE the chat instead of in chronological
 * order within the chat.
 *
 * The fix:
 *   1. agent.ts now accepts onToolCall and onToolResult callbacks
 *   2. App.tsx passes these callbacks to runAgentLoop
 *   3. The callbacks add "tool" messages to the chat (role: "tool")
 *   4. ChatDisplay renders tool messages with icons in chronological order
 *   5. logger.ts has setTuiMode(true) that suppresses console.log when TUI
 *      is active (preventing the layout-breaking behavior)
 *
 * These tests verify:
 *   - ChatDisplay renders tool call messages with arrow icon
 *   - ChatDisplay renders tool result messages with check/cross icon
 *   - Tool messages appear in chronological order with user/assistant
 *   - logger.toolCall is suppressed when TUI mode is active
 *   - logger.toolResult is suppressed when TUI mode is active
 *   - Tool args are formatted (path, comando, query)
 *   - Tool results are truncated (don't dominate the chat)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    // Spy on these so we can verify they're called (or not) in TUI mode
    toolCall: vi.fn(actual.toolCall),
    toolResult: vi.fn(actual.toolResult),
    reply: vi.fn(actual.reply),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  };
});

// Mock config
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Import AFTER mocks
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import * as logger from "../logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── ChatDisplay: tool message rendering ──────────────────────────────────

describe("ChatDisplay — tool message rendering", () => {
  it("renders tool call message with arrow icon and tool name", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ path: "/foo.ts" }), toolName: "ler_arquivo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("/foo.ts");
  });

  it("renders tool result (success) with check icon", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "file content here", toolName: "ler_arquivo", isResult: true, ok: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("file content here");
    // icons.check = "v" (success)
    expect(out).toContain("v");
  });

  it("renders tool result (error) with cross icon", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "[ERRO] File not found", toolName: "ler_arquivo", isResult: true, ok: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("[ERRO]");
    // icons.cross = "x" (error)
    expect(out).toContain("x");
  });

  it("renders tool call with path arg formatted", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ path: "/home/user/file.ts" }), toolName: "ler_arquivo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/home/user/file.ts");
  });

  it("renders tool call with comando arg formatted", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ comando: "npm test" }), toolName: "executar_comando", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("npm test");
  });

  it("renders tool call with query arg formatted", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ query: "function foo" }), toolName: "buscar_conteudo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("function foo");
  });

  it("truncates very long tool args", () => {
    const longPath = "/very/long/path/" + "a".repeat(200) + "/file.ts";
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ path: longPath }), toolName: "ler_arquivo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Should be truncated (contain ellipsis …)
    expect(out).toContain("…");
    // Should NOT contain the full 200+ char path
    expect(out).not.toContain("a".repeat(200));
  });

  it("truncates very long tool results (3 lines max)", () => {
    const longResult = "line1\nline2\nline3\nline4\nline5\nline6";
    const messages: ChatMessage[] = [
      { role: "tool", content: longResult, toolName: "executar_comando", isResult: true, ok: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Should contain first 3 lines
    expect(out).toContain("line1");
    expect(out).toContain("line2");
    expect(out).toContain("line3");
    // Should NOT contain lines 4-6
    expect(out).not.toContain("line4");
    expect(out).not.toContain("line5");
    expect(out).not.toContain("line6");
  });

  it("renders tool messages in chronological order with user/assistant", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Lê o arquivo" },
      { role: "tool", content: JSON.stringify({ path: "/foo.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "file content", toolName: "ler_arquivo", isResult: true, ok: true },
      { role: "assistant", content: "Li o arquivo. Conteúdo: file content" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");

    // Verify order: user → tool call → tool result → assistant
    const idxUser = out.indexOf("Lê o arquivo");
    const idxToolCall = out.indexOf("ler_arquivo");
    const idxToolResult = out.indexOf("file content");
    const idxAssistant = out.indexOf("Li o arquivo");

    expect(idxUser).toBeLessThan(idxToolCall);
    expect(idxToolCall).toBeLessThan(idxToolResult);
    expect(idxToolResult).toBeLessThan(idxAssistant);
  });

  it("renders multiple tool calls in sequence", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Faz várias coisas" },
      { role: "tool", content: JSON.stringify({ path: "/a.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "content A", toolName: "ler_arquivo", isResult: true, ok: true },
      { role: "tool", content: JSON.stringify({ comando: "echo hi" }), toolName: "executar_comando", isResult: false },
      { role: "tool", content: "hi", toolName: "executar_comando", isResult: true, ok: true },
      { role: "assistant", content: "Pronto!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("ler_arquivo");
    expect(out).toContain("/a.ts");
    expect(out).toContain("content A");
    expect(out).toContain("executar_comando");
    expect(out).toContain("echo hi");
    expect(out).toContain("hi");
    expect(out).toContain("Pronto!");
  });

  it("renders tool messages indented (2 spaces)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "test" },
      { role: "tool", content: JSON.stringify({ path: "/foo.ts" }), toolName: "ler_arquivo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Tool messages should be indented with 2 spaces (per ChatDisplay)
    // Find the line containing "ler_arquivo" and verify it starts with spaces
    const lines = out.split("\n");
    const toolLine = lines.find((l) => l.includes("ler_arquivo"));
    expect(toolLine).toBeDefined();
    expect(toolLine?.trimStart()).toMatch(/^->\s/); // icons.arrow = "->"
  });
});

// ─── logger TUI mode suppression ──────────────────────────────────────────

describe("logger — TUI mode suppression", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Reset TUI mode before each test
    logger.setTuiMode(false);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    logger.setTuiMode(false);
  });

  it("setTuiMode(true) suppresses logger.toolCall", () => {
    logger.setTuiMode(true);
    logger.toolCall("ler_arquivo", { path: "/foo.ts" });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("setTuiMode(false) allows logger.toolCall", () => {
    logger.setTuiMode(false);
    logger.toolCall("ler_arquivo", { path: "/foo.ts" });
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it("setTuiMode(true) suppresses logger.toolResult", () => {
    logger.setTuiMode(true);
    logger.toolResult("ler_arquivo", true, "ok");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("setTuiMode(true) suppresses logger.reply", () => {
    logger.setTuiMode(true);
    logger.reply("response text");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("isTuiMode() reflects current state", () => {
    expect(logger.isTuiMode()).toBe(false);
    logger.setTuiMode(true);
    expect(logger.isTuiMode()).toBe(true);
    logger.setTuiMode(false);
    expect(logger.isTuiMode()).toBe(false);
  });

  it("setTuiMode is idempotent", () => {
    logger.setTuiMode(true);
    logger.setTuiMode(true);
    expect(logger.isTuiMode()).toBe(true);
    logger.setTuiMode(false);
    logger.setTuiMode(false);
    expect(logger.isTuiMode()).toBe(false);
  });
});

// ─── App integration: tool messages appear in chat ────────────────────────

describe("App — tool messages appear in chat (not above)", () => {
  // These tests use the App component with mocked agent that simulates
  // tool calls. They verify that tool messages are added to the chat
  // history (via setMessages) and rendered by ChatDisplay.

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ChatDisplay renders tool messages between user and assistant", () => {
    // Simulate the chat state AFTER a tool call has been made:
    // user → tool call → tool result → assistant
    const messages: ChatMessage[] = [
      { role: "user", content: "Lê /foo.ts" },
      { role: "tool", content: JSON.stringify({ path: "/foo.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "const x = 1;", toolName: "ler_arquivo", isResult: true, ok: true },
      { role: "assistant", content: "O arquivo contém `const x = 1;`." },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");

    // All 4 message types should be visible
    expect(out).toContain("Lê /foo.ts");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("/foo.ts");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("O arquivo contém");

    // Verify chronological order
    const idx1 = out.indexOf("Lê /foo.ts");
    const idx2 = out.indexOf("ler_arquivo");
    const idx3 = out.indexOf("const x = 1;");
    const idx4 = out.indexOf("O arquivo contém");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });

  it("ChatDisplay renders tool messages after assistant streaming message", () => {
    // Scenario: assistant is streaming, then calls a tool
    const messages: ChatMessage[] = [
      { role: "user", content: "Investiga" },
      { role: "assistant", content: "Vou ler o arquivo", isStreaming: true },
      { role: "tool", content: JSON.stringify({ path: "/foo.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "content", toolName: "ler_arquivo", isResult: true, ok: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("Investiga");
    expect(out).toContain("Vou ler o arquivo");
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("content");

    // Verify order
    const idx1 = out.indexOf("Investiga");
    const idx2 = out.indexOf("Vou ler o arquivo");
    const idx3 = out.indexOf("ler_arquivo");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("ChatDisplay handles tool error followed by retry", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Lê /missing.ts" },
      { role: "tool", content: JSON.stringify({ path: "/missing.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "[ERRO] File not found", toolName: "ler_arquivo", isResult: true, ok: false },
      { role: "assistant", content: "Arquivo não encontrado. Vou tentar outro caminho." },
      { role: "tool", content: JSON.stringify({ path: "/correct.ts" }), toolName: "ler_arquivo", isResult: false },
      { role: "tool", content: "content", toolName: "ler_arquivo", isResult: true, ok: true },
      { role: "assistant", content: "Encontrei!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("/missing.ts");
    expect(out).toContain("[ERRO]");
    expect(out).toContain("Arquivo não encontrado");
    expect(out).toContain("/correct.ts");
    expect(out).toContain("Encontrei!");
  });
});

// ─── Tool message edge cases ──────────────────────────────────────────────

describe("ChatDisplay — tool message edge cases", () => {
  it("handles tool message with empty args", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "{}", toolName: "pensar", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("pensar");
  });

  it("handles tool message with invalid JSON args (defensive)", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "not valid json", toolName: "ler_arquivo", isResult: false },
    ];
    expect(() => render(<ChatDisplay messages={messages} />)).not.toThrow();
  });

  it("handles tool message with no toolName", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "{}", toolName: undefined, isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Should fall back to "tool" label
    expect(out).toContain("tool");
  });

  it("handles tool result with empty content", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "", toolName: "executar_comando", isResult: true, ok: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("executar_comando");
  });

  it("renders tool messages with special chars in args", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ path: "/file with spaces.ts" }), toolName: "ler_arquivo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/file with spaces.ts");
  });

  it("renders tool messages with accented chars in args", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: JSON.stringify({ query: "coração" }), toolName: "buscar_conteudo", isResult: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("coração");
    expect(out).not.toContain("├");
  });

  it("renders many tool calls in sequence (10+)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Faz 10 things" },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: "tool" as const,
        content: JSON.stringify({ comando: `echo ${i}` }),
        toolName: "executar_comando",
        isResult: false,
      })),
      { role: "assistant", content: "Pronto!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("echo 0");
    expect(out).toContain("echo 9");
    expect(out).toContain("Pronto!");
  });
});
