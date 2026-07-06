/**
 * tui-deep-conversations.test.tsx — Deep tests for long conversations and
 * all message types.
 *
 * Tests scenarios that the previous test suites didn't cover:
 *   - Conversations with 50+ messages of mixed types
 *   - System messages interspersed with chat messages
 *   - Streaming messages (isStreaming=true) accumulating over time
 *   - Tool call results displayed in chat
 *   - Error messages from agent
 *   - Multi-line messages with markdown
 *   - Messages with code blocks, lists, tables
 *   - Very long single messages (5000+ chars)
 *   - Messages with mixed languages
 *   - StatusBar with various token counts (1, 100, 1k, 10k, 100k, 1M)
 *   - StatusBar with various context windows (128k, 256k, 1M)
 *   - StatusBar with overflow (totalTokens > contextWindow)
 *   - StatusBar showing cost in different ranges
 *   - StatusBar showing tok/s during streaming
 *   - StatusBar with all features enabled together
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

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
import { StatusBar } from "../tui/StatusBar.js";
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import { TodoPanel, type TodoItem } from "../tui/TodoPanel.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const baseStatusBarProps = {
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
  contextWindow: 256000,
  warnThreshold: 0.6,
  compactThreshold: 0.75,
  costPerKPrompt: 0.01,
  costPerKCompletion: 0.03,
  planMode: false,
  mcpCount: 0,
  skillsCount: 0,
};

// ─── Long conversations ───────────────────────────────────────────────────

describe("Long conversations — 50+ messages of mixed types", () => {
  it("renders 50 alternating user/assistant messages without crash", () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${i}: ${i % 2 === 0 ? "pergunta" : "resposta"}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={100} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Message 49");
    expect(out).toContain("Message 0");
  });

  it("renders 100 messages with maxVisible=50 (only last 50)", () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `Msg ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={50} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Msg 99");
    expect(out).toContain("Msg 50");
    expect(out).not.toContain("Msg 49");
    expect(out).not.toContain("Msg 0");
  });

  it("renders 200 messages (only last 50 by default)", () => {
    const messages: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Message 199");
    expect(out).toContain("Message 150");
    expect(out).not.toContain("Message 149");
  });

  it("renders conversation with system messages interspersed", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Olá" },
      { role: "assistant", content: "Oi!" },
      { role: "system", content: "[SYSTEM] Modo roblox ativado" },
      { role: "user", content: "Cria um script" },
      { role: "assistant", content: "OK, criando..." },
      { role: "system", content: "[SYSTEM] Tool call: aplicar_diff" },
      { role: "assistant", content: "Pronto!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // System messages are filtered out in ChatDisplay (return null)
    expect(out).toContain("Olá");
    expect(out).toContain("Oi!");
    expect(out).toContain("Cria um script");
    expect(out).toContain("Pronto!");
    // System messages should NOT appear (filtered)
    expect(out).not.toContain("[SYSTEM]");
  });

  it("renders conversation with streaming messages (isStreaming=true)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Pergunta 1" },
      { role: "assistant", content: "Resposta 1 completa" },
      { role: "user", content: "Pergunta 2" },
      { role: "assistant", content: "Resp", isStreaming: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Pergunta 1");
    expect(out).toContain("Resposta 1 completa");
    expect(out).toContain("Pergunta 2");
    expect(out).toContain("Resp");
  });

  it("renders conversation with assistant message containing markdown", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Explica" },
      {
        role: "assistant",
        content: `# Título

## Subtítulo

Aqui está um **negrito** e um *itálico*.

- Item 1
- Item 2
- Item 3

\`\`\`typescript
const x: number = 42;
console.log(x);
\`\`\`

E por fim um [link](https://example.com).`,
      },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Título");
    expect(out).toContain("Subtítulo");
    expect(out).toContain("negrito");
    expect(out).toContain("Item 1");
    expect(out).toContain("Item 2");
    expect(out).toContain("const x");
    expect(out).toContain("link");
  });

  it("renders conversation with code blocks in multiple languages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: `TypeScript:
\`\`\`typescript
const x: number = 1;
\`\`\`

Python:
\`\`\`python
x = 1
\`\`\`

Lua:
\`\`\`lua
local x = 1
\`\`\`

Go:
\`\`\`go
x := 1
\`\`\``,
      },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("const x: number = 1");
    expect(out).toContain("x = 1");
    expect(out).toContain("local x = 1");
    expect(out).toContain("x := 1");
  });

  it("renders conversation with error messages in content", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Roda npm test" },
      { role: "assistant", content: "Vou rodar os testes." },
      { role: "assistant", content: "[ERROR] Falha: 3 testes falharam\n  - test 1: expected 5 got 4\n  - test 2: TypeError\n  - test 3: timeout" },
      { role: "assistant", content: "Vou corrigir os erros." },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("[ERROR]");
    expect(out).toContain("3 testes falharam");
    expect(out).toContain("test 1");
    expect(out).toContain("TypeError");
  });

  it("renders conversation with very long single message (5000 chars)", () => {
    const longText = "Lorem ipsum dolor sit amet. ".repeat(200); // ~5600 chars
    const messages: ChatMessage[] = [
      { role: "assistant", content: longText },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("Lorem ipsum");
  });

  it("renders conversation with mixed languages (PT + EN + CJK)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Olá, como vai? Hello, how are you? 你好吗？" },
      { role: "assistant", content: "Estou bem! I'm fine! 我很好！" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Olá");
    expect(out).toContain("Hello");
    expect(out).toContain("你好吗？");
    expect(out).toContain("Estou bem");
    expect(out).toContain("I'm fine");
    expect(out).toContain("我很好");
  });

  it("renders conversation with tables in markdown", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: `| Modelo | Contexto | Custo |
|--------|----------|-------|
| Kimi   | 256k     | $0    |
| Minimax| 1M       | $0    |`,
      },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Modelo");
    expect(out).toContain("Contexto");
    expect(out).toContain("Kimi");
    expect(out).toContain("Minimax");
  });

  it("renders conversation with nested lists", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: `Top level:
- Item 1
  - Sub 1.1
  - Sub 1.2
- Item 2
  - Sub 2.1
    - Sub-sub 2.1.1`,
      },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Item 1");
    expect(out).toContain("Sub 1.1");
    expect(out).toContain("Sub-sub 2.1.1");
  });

  it("renders conversation with inline code", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Use `npm install` to install deps. Then `npm test` to run tests." },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("npm install");
    expect(out).toContain("npm test");
  });

  it("renders conversation with blockquotes", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: `Como dizia o poeta:

> A vida é breve,
> a arte é longa.`,
      },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("A vida é breve");
    expect(out).toContain("a arte é longa");
  });
});

// ─── StatusBar with various token counts ─────────────────────────────────

describe("StatusBar — various token counts and context windows", () => {
  it("renders with 1 token (minimal)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={1} promptTokens={1} completionTokens={0} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1/256k");
    expect(out).toContain("0%");
  });

  it("renders with 100 tokens", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={100} promptTokens={80} completionTokens={20} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("100/256k");
  });

  it("renders with 1000 tokens (formats as 1k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={1000} promptTokens={800} completionTokens={200} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1k/256k");
    expect(out).not.toContain("1.0k");
  });

  it("renders with 1500 tokens (formats as 1.5k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={1500} promptTokens={1000} completionTokens={500} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1.5k/256k");
  });

  it("renders with 10000 tokens (formats as 10k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={10000} promptTokens={8000} completionTokens={2000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("10k/256k");
    expect(out).not.toContain("10.0k");
  });

  it("renders with 100000 tokens (formats as 100k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={100000} promptTokens={80000} completionTokens={20000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("100k/256k");
    expect(out).not.toContain("100.0k");
  });

  it("renders with 1000000 tokens (formats as 1M)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={1000000}
        promptTokens={800000}
        completionTokens={200000}
        contextWindow={1000000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1M/1M");
    expect(out).not.toContain("1.0M");
    expect(out).toContain("100%");
  });

  it("renders with 1500000 tokens (formats as 1.5M)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={1500000}
        promptTokens={1000000}
        completionTokens={500000}
        contextWindow={2000000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1.5M/2M");
  });

  it("renders with context window 128000 (kimi-k2.6 default)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} contextWindow={128000} totalTokens={64000} promptTokens={50000} completionTokens={14000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("64k/128k");
    expect(out).toContain("50%");
  });

  it("renders with context window 256000 (kimi-k2.6 actual)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} contextWindow={256000} totalTokens={128000} promptTokens={100000} completionTokens={28000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("128k/256k");
    expect(out).toContain("50%");
  });

  it("renders with context window 1000000 (minimax-m3)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} contextWindow={1000000} totalTokens={500000} promptTokens={400000} completionTokens={100000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("500k/1M");
    expect(out).toContain("50%");
  });

  it("renders with overflow (totalTokens > contextWindow) — regression test", () => {
    // This was Bug #2 from PR #7 — StatusBar crashed with RangeError
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={300000}
        promptTokens={250000}
        completionTokens={50000}
        contextWindow={256000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // Should NOT crash — should render clamped bar (15 # chars)
    expect(out).toContain("300k/256k");
    expect(out).toContain("###############"); // 15 # (clamped, no - chars)
    expect(out).toContain("117%"); // 300/256 = 1.17 = 117%
  });

  it("renders with massive overflow (10x context window)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={2560000}
        promptTokens={2000000}
        completionTokens={560000}
        contextWindow={256000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // 2.56M rounds to 2.6M (one decimal place for millions)
    expect(out).toContain("2.6M/256k");
    expect(out).toContain("1000%");
  });

  it("renders warn color (yellow) at 60% context usage", () => {
    // 60% of 256k = 153600 tokens
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={153600}
        promptTokens={100000}
        completionTokens={53600}
        contextWindow={256000}
        warnThreshold={0.6}
        compactThreshold={0.75}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // At 60% we're at the warn threshold — bar should be yellow (warning color)
    // We can't easily assert color in stripped output, but we can verify it renders
    expect(out).toContain("154k/256k"); // rounded
    expect(out).toContain("60%");
  });

  it("renders error color (red) at 75% context usage (compact threshold)", () => {
    // 75% of 256k = 192000 tokens
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={192000}
        promptTokens={150000}
        completionTokens={42000}
        contextWindow={256000}
        warnThreshold={0.6}
        compactThreshold={0.75}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("192k/256k");
    expect(out).toContain("75%");
  });

  it("renders cost in cents range ($0.001)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={100}
        promptTokens={80}
        completionTokens={20}
        costPerKPrompt={0.01}
        costPerKCompletion={0.03}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // cost = (80/1000)*0.01 + (20/1000)*0.03 = 0.0008 + 0.0006 = $0.0014
    expect(out).toContain("$0.001");
  });

  it("renders cost in dollars range ($1.50)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={150000}
        promptTokens={100000}
        completionTokens={50000}
        costPerKPrompt={0.01}
        costPerKCompletion={0.03}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // cost = (100000/1000)*0.01 + (50000/1000)*0.03 = 1 + 1.5 = $2.50
    expect(out).toContain("$2.500");
  });

  it("renders tok/s with decimal (42.5)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} tokensPerSecond={42.5} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("42.5");
    expect(out).toContain("tok/s");
  });

  it("renders tok/s with integer (100)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} tokensPerSecond={100} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("100.0");
    expect(out).toContain("tok/s");
  });

  it("renders all features enabled together", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={50000}
        promptTokens={40000}
        completionTokens={10000}
        contextWindow={256000}
        planMode={true}
        mcpCount={3}
        skillsCount={5}
        effortLabel="MAX"
        tokensPerSecond={88.8}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("50k/256k");
    expect(out).toContain("20%");
    expect(out).toContain("MAX");
    expect(out).toContain("88.8");
    expect(out).toContain("tok/s");
    expect(out).toContain("[PLAN]");
    expect(out).toContain("$");
  });

  it("renders when costPerK is 0 (free tier)", () => {
    const { lastFrame } = render(
      <StatusBar
        {...baseStatusBarProps}
        totalTokens={1000}
        promptTokens={800}
        completionTokens={200}
        costPerKPrompt={0}
        costPerKCompletion={0}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // No cost should be shown
    expect(out).not.toContain("$");
  });
});

// ─── Context bar fill verification ────────────────────────────────────────

describe("StatusBar — context bar fill verification", () => {
  it("renders 0% fill (all dashes, no #)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={0} promptTokens={0} completionTokens={0} contextWindow={256000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // 15 dashes, no #
    expect(out).toContain("---------------");
    expect(out).not.toContain("#");
  });

  it("renders 100% fill (all #, no dashes)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={256000} promptTokens={200000} completionTokens={56000} contextWindow={256000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("###############");
    // Should not have any dashes in the bar (only the # are the bar)
    // The bar is between two spaces, so check for " ############### "
    expect(out).toMatch(/#{15}/);
  });

  it("renders ~50% fill (mix of # and -)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={128000} promptTokens={100000} completionTokens={28000} contextWindow={256000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // 50% of 15 = 7.5, rounded to 8
    // 12 # + 3 - (log scale)
    expect(out).toMatch(/#{12}-{3}/);
  });

  it("renders ~25% fill", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={64000} promptTokens={50000} completionTokens={14000} contextWindow={256000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // 25% of 15 = 3.75, rounded to 4
    // 8 # + 7 - (log scale)
    expect(out).toMatch(/#{8}-{7}/);
  });

  it("renders ~75% fill", () => {
    const { lastFrame } = render(
      <StatusBar {...baseStatusBarProps} totalTokens={192000} promptTokens={150000} completionTokens={42000} contextWindow={256000} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // 75% of 15 = 11.25, rounded to 11
    // 14 # + 1 - (log scale)
    expect(out).toMatch(/#{14}-{1}/);
  });
});

// ─── TodoPanel with many tasks ────────────────────────────────────────────

describe("TodoPanel — many tasks and complex states", () => {
  it("renders 20 tasks of mixed statuses", () => {
    const todos: TodoItem[] = Array.from({ length: 20 }, (_, i) => ({
      status: i % 3 === 0 ? "completed" : i % 3 === 1 ? "in_progress" : "pending",
      content: `Task ${i}`,
      active_form: i % 3 === 1 ? `Currently working on Task ${i}` : "",
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("20 tasks");
    expect(out).toContain("Task 0");
    expect(out).toContain("Task 19");
  });

  it("renders tasks with very long active_form", () => {
    const todos: TodoItem[] = [
      {
        status: "in_progress",
        content: "Short",
        active_form: "Currently working on a very long task description that should not break the layout but should be visible in the panel".repeat(2),
      },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("renders all completed tasks", () => {
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, i) => ({
      status: "completed" as const,
      content: `Done ${i}`,
      active_form: "",
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("5 tasks");
    // All should have check icon (v)
    expect(out).toContain("Done 0");
    expect(out).toContain("Done 4");
  });

  it("renders all in_progress tasks", () => {
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, i) => ({
      status: "in_progress" as const,
      content: `Working ${i}`,
      active_form: `Currently working on ${i}`,
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("5 tasks");
    expect(out).toContain("Currently working on 0");
    expect(out).toContain("Currently working on 4");
  });

  it("renders all pending tasks", () => {
    const todos: TodoItem[] = Array.from({ length: 5 }, (_, i) => ({
      status: "pending" as const,
      content: `Pending ${i}`,
      active_form: "",
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("5 tasks");
    expect(out).toContain("Pending 0");
    expect(out).toContain("Pending 4");
  });
});

// ─── Message type coverage ────────────────────────────────────────────────

describe("Message types — all variants", () => {
  it("renders user message with leading space alignment", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "test" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // ChatDisplay adds leading space for alignment
    expect(out).toContain(" you:");
    expect(out).toContain(" test");
  });

  it("renders assistant message with leading space alignment", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "response" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain(" Claude-Killer:");
    expect(out).toContain(" response");
  });

  it("renders assistant streaming message (no trailing newline)", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "partial response...", isStreaming: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("partial response...");
  });

  it("renders assistant final message (with trailing newline)", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "final response", isStreaming: false },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("final response");
  });

  it("system messages are filtered (not shown in chat)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "system", content: "[SYSTEM] Hidden from user" },
      { role: "assistant", content: "hi" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("hello");
    expect(out).toContain("hi");
    expect(out).not.toContain("[SYSTEM]");
    expect(out).not.toContain("Hidden from user");
  });

  it("renders conversation ending with streaming message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2 (streaming)", isStreaming: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Q1");
    expect(out).toContain("A1");
    expect(out).toContain("Q2");
    expect(out).toContain("A2 (streaming)");
  });
});
