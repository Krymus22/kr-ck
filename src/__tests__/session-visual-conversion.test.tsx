/**
 * session-visual-conversion.test.tsx — Tests for convertSessionToVisualMessages.
 *
 * BUG FIX (thinking-vazando): Regression test for the session-reload thinking
 * leak. Previously, tool results loaded from the session file used the literal
 * string "tool" as toolName (because the session file only stores tool_call_id,
 * not the name). This meant the ChatDisplay filter that hides `pensar` tool
 * results never matched during session reload, causing thinking content to
 * leak into the visible chat.
 *
 * The fix builds a tool_call_id → toolName lookup from assistant tool_calls
 * and resolves the real tool name for each tool result. These tests verify:
 *   - toolName is correctly resolved from tool_call_id
 *   - pensar tool results get toolName="pensar" (so the filter catches them)
 *   - other tools are unaffected
 */

import { describe, it, expect } from "vitest";
import { convertSessionToVisualMessages } from "../tui/App.js";
import type { ChatMessage } from "../tui/ChatDisplay.js";

describe("convertSessionToVisualMessages — toolName resolution (thinking-vazando fix)", () => {
  it("resolve toolName do tool_call_id para tool results", () => {
    // Session file format: assistant has tool_calls with id+name,
    // tool result only has tool_call_id (no name).
    const sessionMsgs = [
      { role: "user", content: "lê o arquivo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: { name: "ler_arquivo", arguments: '{"path":"/tmp/test.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc123", content: "conteúdo do arquivo" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Find the tool result (isResult=true)
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("ler_arquivo"); // not "tool"!
  });

  it("pensar tool results ficam com toolName=pensar (filtro do ChatDisplay pega)", () => {
    // This is the CORE regression test for the thinking leak.
    // Before the fix, toolName was "tool" → filter `msg.toolName === "pensar"`
    // never matched → thinking content leaked into visible chat on session reload.
    const sessionMsgs = [
      { role: "user", content: "pensa nisso" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_think_1",
            type: "function",
            function: { name: "pensar", arguments: '{"pensamento":"preciso analisar..."}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_think_1", content: "[THINK] ✓ Pensamento registrado" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("pensar"); // NOW the filter will catch it
  });

  it("think alias também é resolvido corretamente", () => {
    // If the model called "think" instead of "pensar", the session file
    // stores function.name="think". The converter should preserve it
    // so the ChatDisplay filter (which now checks both "pensar" and "think")
    // catches it.
    const sessionMsgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_think_alias",
            type: "function",
            function: { name: "think", arguments: '{"pensamento":"..."}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_think_alias", content: "[THINK] ✓" },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("think");
  });

  it("múltiplas tools com IDs diferentes — cada uma resolve seu próprio nome", () => {
    const sessionMsgs = [
      { role: "user", content: "faz várias coisas" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "pensar", arguments: "{}" } },
          { id: "c3", type: "function", function: { name: "executar_comando", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "arquivo..." },
      { role: "tool", tool_call_id: "c2", content: "[THINK]" },
      { role: "tool", tool_call_id: "c3", content: "output..." },
    ];

    const visual = convertSessionToVisualMessages(sessionMsgs);
    const results = visual.filter((m) => m.role === "tool" && m.isResult);
    expect(results).toHaveLength(3);
    expect(results[0]!.toolName).toBe("ler_arquivo");
    expect(results[1]!.toolName).toBe("pensar");
    expect(results[2]!.toolName).toBe("executar_comando");
  });

  it("tool result sem tool_call_id correspondente usa fallback 'tool'", () => {
    // Edge case: orphan tool result (shouldn't happen normally, but defensive)
    const sessionMsgs = [
      { role: "tool", tool_call_id: "orphan_id", content: "no matching call" },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    const toolResult = visual.find((m) => m.role === "tool" && m.isResult);
    expect(toolResult).toBeDefined();
    expect(toolResult!.toolName).toBe("tool"); // fallback
  });

  it("explode tool_calls do assistant em visual tool call messages", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: "Vou ler o arquivo",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"x"}' } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Should have: [assistant text] + [tool call (not result)]
    expect(visual).toHaveLength(2);
    expect(visual[0]).toMatchObject({ role: "assistant", content: "Vou ler o arquivo" });
    expect(visual[1]).toMatchObject({
      role: "tool",
      toolName: "ler_arquivo",
      isResult: false,
    });
  });
});

// ─── Regression tests: content=null (reasoning models) ──────────────────────
//
// BUG: When reasoning models (GLM 5.2, DeepSeek V4 Pro) respond with only
// reasoning_content + tool_calls (no visible text), content is saved as null
// in the JSONL. convertSessionToVisualMessages was silently dropping these
// messages, making the entire assistant turn disappear from the visual history.
//
// FIX: When content is null/empty BUT there are tool_calls, generate a
// placeholder assistant message so the user sees the assistant was active.

describe("convertSessionToVisualMessages — content=null (reasoning models)", () => {
  it("assistant with content=null + tool_calls generates placeholder + tool calls", () => {
    const sessionMsgs = [
      {
        role: "user",
        content: "ler arquivo X",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"X"}' } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Should have: [user] + [assistant placeholder] + [tool call]
    expect(visual).toHaveLength(3);
    expect(visual[0]).toMatchObject({ role: "user", content: "ler arquivo X" });
    expect(visual[1]).toMatchObject({ role: "assistant" });
    expect(visual[1]!.content).toContain("usando ferramentas");
    expect(visual[1]!.content).toContain("ler_arquivo");
    expect(visual[2]).toMatchObject({
      role: "tool",
      toolName: "ler_arquivo",
      isResult: false,
    });
  });

  it("assistant with content=null + multiple tool_calls lists all tool names", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "buscar_texto", arguments: "{}" } },
          { id: "tc3", type: "function", function: { name: "parse_ast", arguments: "{}" } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // Should have: [assistant placeholder] + [tool1] + [tool2] + [tool3]
    expect(visual).toHaveLength(4);
    expect(visual[0]).toMatchObject({ role: "assistant" });
    expect(visual[0]!.content).toContain("ler_arquivo");
    expect(visual[0]!.content).toContain("buscar_texto");
    expect(visual[0]!.content).toContain("parse_ast");
  });

  it("assistant with content='' (empty string) + tool_calls also gets placeholder", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "executar_comando", arguments: "{}" } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    expect(visual).toHaveLength(2);
    expect(visual[0]).toMatchObject({ role: "assistant" });
    expect(visual[0]!.content).toContain("executar_comando");
  });

  it("assistant with content=undefined + tool_calls also gets placeholder", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: undefined,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "pensar", arguments: "{}" } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    expect(visual).toHaveLength(2);
    expect(visual[0]).toMatchObject({ role: "assistant" });
  });

  it("assistant with content=null + NO tool_calls generates nothing (no placeholder)", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: null,
        // No tool_calls — just reasoning, no visible action
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // No visual message — there's nothing to show (no text, no tool calls)
    expect(visual).toHaveLength(0);
  });

  it("session with all content=null still shows user messages + tool calls + placeholders", () => {
    // Simulate a real reasoning model session: user asks, assistant thinks
    // (no text) and calls tools, tool returns result, assistant thinks again
    // and responds with text.
    const sessionMsgs = [
      { role: "user", content: "cria um arquivo" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: '{"caminho":"foo"}' } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", content: "file content" },
      {
        role: "assistant",
        content: "Criei o arquivo com sucesso!",
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // [user] + [assistant placeholder] + [tool call] + [tool result] + [assistant text]
    expect(visual).toHaveLength(5);
    expect(visual[0]).toMatchObject({ role: "user" });
    expect(visual[1]).toMatchObject({ role: "assistant" });
    expect(visual[1]!.content).toContain("usando ferramentas");
    expect(visual[2]).toMatchObject({ role: "tool", isResult: false });
    expect(visual[3]).toMatchObject({ role: "tool", isResult: true });
    expect(visual[4]).toMatchObject({ role: "assistant", content: "Criei o arquivo com sucesso!" });
  });

  it("content as array with text parts works alongside tool_calls", () => {
    const sessionMsgs = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Vou ler o arquivo" }],
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
    ];
    const visual = convertSessionToVisualMessages(sessionMsgs);
    // [assistant text] + [tool call] — no placeholder (content was present)
    expect(visual).toHaveLength(2);
    expect(visual[0]).toMatchObject({ role: "assistant", content: "Vou ler o arquivo" });
    expect(visual[1]).toMatchObject({ role: "tool", isResult: false });
  });
});
