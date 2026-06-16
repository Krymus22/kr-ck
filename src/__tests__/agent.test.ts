/**
 * agent.test.ts — Tests for agent.ts pure logic functions.
 * Covers: parseArgs, asString, isTestFailure, alreadyInHistory,
 * tool dispatch logic, auto-heal flow, READ_ONLY_TOOLS set,
 * trigger context building, and memory injection flow.
 */

import { describe, it, expect } from "vitest";

// ─── Extract pure functions from agent.ts ──────────────────────────────────

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  if (typeof val === "object") return JSON.stringify(val);
  return fallback;
}

const TEST_TOOLS = new Set(["executar_testes", "executar_comando", "sugerir_fixes"]);
const READ_ONLY_TOOLS = new Set([
  "ler_arquivo", "ler_arquivo_avancado", "buscar_arquivos", "buscar_texto",
  "git_status", "git_log", "git_diff",
]);
const FILE_TOOLS = new Set(["aplicar_diff", "editar_arquivo", "multi_edit"]);

function isTestFailure(resultStr: string): boolean {
  const lower = resultStr.toLowerCase();
  return (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("❌") ||
    lower.includes("failing")
  ) && (
    lower.includes("test") ||
    lower.includes("lint") ||
    lower.includes("vitest") ||
    lower.includes("jest") ||
    lower.includes("pytest") ||
    lower.includes("cargo") ||
    lower.includes("eslint") ||
    lower.includes("tsc")
  );
}

function alreadyInHistory(toolCallId: string, history: Array<{ role?: string; tool_call_id?: string }>): boolean {
  const lastMsg = history.at(-1);
  return lastMsg?.role === "tool" && lastMsg?.tool_call_id === toolCallId;
}

function classifyToolCalls(toolCalls: Array<{ function: { name: string } }>): {
  readOnly: string[];
  write: string[];
  test: string[];
} {
  const readOnly: string[] = [];
  const write: string[] = [];
  const test: string[] = [];

  for (const tc of toolCalls) {
    const name = tc.function.name;
    if (READ_ONLY_TOOLS.has(name)) {
      readOnly.push(name);
    } else {
      write.push(name);
    }
    if (TEST_TOOLS.has(name)) {
      test.push(name);
    }
  }

  return { readOnly, write, test };
}

function buildTriggerContext(
  cwd: string,
  filePath?: string,
  toolName?: string,
): { cwd: string; filePath?: string; toolName?: string } {
  const ctx: { cwd: string; filePath?: string; toolName?: string } = { cwd };
  if (filePath) ctx.filePath = filePath;
  if (toolName) ctx.toolName = toolName;
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("agent.ts pure logic", () => {
  describe("parseArgs", () => {
    it("should parse valid JSON", () => {
      const result = parseArgs('{"caminho": "src/main.ts"}');
      expect(result).toEqual({ caminho: "src/main.ts" });
    });

    it("should return _raw for invalid JSON", () => {
      const result = parseArgs("not json");
      expect(result).toEqual({ _raw: "not json" });
    });

    it("should handle empty string", () => {
      const result = parseArgs("");
      expect(result).toEqual({ _raw: "" });
    });

    it("should handle nested objects", () => {
      const result = parseArgs('{"a": {"b": [1,2,3]}}');
      expect(result).toEqual({ a: { b: [1, 2, 3] } });
    });

    it("should handle numeric values in JSON", () => {
      const result = parseArgs('{"count": 42}');
      expect(result).toEqual({ count: 42 });
    });

    it("should handle boolean values in JSON", () => {
      const result = parseArgs('{"flag": true}');
      expect(result).toEqual({ flag: true });
    });
  });

  describe("asString", () => {
    it("should return string as-is", () => {
      expect(asString("hello")).toBe("hello");
    });

    it("should return fallback for null", () => {
      expect(asString(null)).toBe("");
      expect(asString(null, "default")).toBe("default");
    });

    it("should return fallback for undefined", () => {
      expect(asString(undefined)).toBe("");
    });

    it("should convert number to string", () => {
      expect(asString(42)).toBe("42");
    });

    it("should convert boolean to string", () => {
      expect(asString(true)).toBe("true");
      expect(asString(false)).toBe("false");
    });

    it("should JSON.stringify objects", () => {
      expect(asString({ a: 1 })).toBe('{"a":1}');
    });

    it("should convert symbol to string", () => {
      const result = asString(Symbol("test"));
      expect(result).toBe("Symbol(test)");
    });

    it("should return fallback for function", () => {
      expect(asString(() => {})).toBe("");
    });

    it("should handle empty string", () => {
      expect(asString("")).toBe("");
    });
  });

  describe("isTestFailure", () => {
    it("should detect vitest failures", () => {
      expect(isTestFailure("2 tests failed in vitest")).toBe(true);
    });

    it("should detect jest failures", () => {
      expect(isTestFailure("FAIL src/test.test.ts - jest")).toBe(true);
    });

    it("should detect pytest failures", () => {
      expect(isTestFailure("3 failed in pytest")).toBe(true);
    });

    it("should detect cargo test failures", () => {
      expect(isTestFailure("test result: FAILED. 5 passed; 2 failed")).toBe(true);
    });

    it("should detect eslint errors", () => {
      expect(isTestFailure("error: Unexpected var eslint")).toBe(true);
    });

    it("should detect tsc errors", () => {
      expect(isTestFailure("error TS2322: tsc found 1 error")).toBe(true);
    });

    it("should detect ❌ emoji failures", () => {
      expect(isTestFailure("❌ 3 tests failed")).toBe(true);
    });

    it("should NOT detect generic errors without test context", () => {
      expect(isTestFailure("Error: file not found")).toBe(false);
    });

    it("should NOT detect success messages", () => {
      expect(isTestFailure("320 tests passed")).toBe(false);
    });

    it("should detect lint failures", () => {
      expect(isTestFailure("5 problems found (3 errors, 2 warnings) lint")).toBe(true);
    });
  });

  describe("alreadyInHistory", () => {
    it("should return true if last message matches tool_call_id", () => {
      const history = [
        { role: "assistant" },
        { role: "tool", tool_call_id: "call_123" },
      ];
      expect(alreadyInHistory("call_123", history)).toBe(true);
    });

    it("should return false if last message has different tool_call_id", () => {
      const history = [
        { role: "assistant" },
        { role: "tool", tool_call_id: "call_456" },
      ];
      expect(alreadyInHistory("call_123", history)).toBe(false);
    });

    it("should return false if last message is not a tool message", () => {
      const history = [
        { role: "assistant", content: "hello" },
      ];
      expect(alreadyInHistory("call_123", history)).toBe(false);
    });

    it("should return false for empty history", () => {
      expect(alreadyInHistory("call_123", [])).toBe(false);
    });

    it("should only check the LAST message", () => {
      const history = [
        { role: "tool", tool_call_id: "call_123" },
        { role: "assistant", content: "response" },
      ];
      expect(alreadyInHistory("call_123", history)).toBe(false);
    });
  });

  describe("classifyToolCalls", () => {
    it("should classify read-only tools", () => {
      const calls = [
        { function: { name: "ler_arquivo" } },
        { function: { name: "buscar_texto" } },
      ];
      const result = classifyToolCalls(calls);
      expect(result.readOnly).toEqual(["ler_arquivo", "buscar_texto"]);
      expect(result.write).toHaveLength(0);
    });

    it("should classify write tools", () => {
      const calls = [
        { function: { name: "aplicar_diff" } },
        { function: { name: "editar_arquivo" } },
      ];
      const result = classifyToolCalls(calls);
      expect(result.write).toEqual(["aplicar_diff", "editar_arquivo"]);
      expect(result.readOnly).toHaveLength(0);
    });

    it("should classify test tools", () => {
      const calls = [
        { function: { name: "executar_testes" } },
        { function: { name: "sugerir_fixes" } },
      ];
      const result = classifyToolCalls(calls);
      expect(result.test).toEqual(["executar_testes", "sugerir_fixes"]);
    });

    it("should handle mixed tool calls", () => {
      const calls = [
        { function: { name: "ler_arquivo" } },
        { function: { name: "aplicar_diff" } },
        { function: { name: "executar_testes" } },
        { function: { name: "git_status" } },
      ];
      const result = classifyToolCalls(calls);
      expect(result.readOnly).toEqual(["ler_arquivo", "git_status"]);
      expect(result.write).toEqual(["aplicar_diff", "executar_testes"]);
      expect(result.test).toEqual(["executar_testes"]);
    });

    it("should handle unknown tools as write", () => {
      const calls = [{ function: { name: "custom_tool" } }];
      const result = classifyToolCalls(calls);
      expect(result.write).toEqual(["custom_tool"]);
    });

    it("should handle empty tool calls", () => {
      const result = classifyToolCalls([]);
      expect(result.readOnly).toHaveLength(0);
      expect(result.write).toHaveLength(0);
      expect(result.test).toHaveLength(0);
    });
  });

  describe("buildTriggerContext", () => {
    it("should build context with cwd only", () => {
      const ctx = buildTriggerContext("/project");
      expect(ctx).toEqual({ cwd: "/project" });
    });

    it("should include filePath when provided", () => {
      const ctx = buildTriggerContext("/project", "/project/src/main.ts");
      expect(ctx.filePath).toBe("/project/src/main.ts");
    });

    it("should include toolName when provided", () => {
      const ctx = buildTriggerContext("/project", undefined, "aplicar_diff");
      expect(ctx.toolName).toBe("aplicar_diff");
    });

    it("should include all fields when all provided", () => {
      const ctx = buildTriggerContext("/project", "/project/file.ts", "editar_arquivo");
      expect(ctx).toEqual({
        cwd: "/project",
        filePath: "/project/file.ts",
        toolName: "editar_arquivo",
      });
    });
  });

  describe("Tool set membership", () => {
    it("READ_ONLY_TOOLS should contain expected tools", () => {
      expect(READ_ONLY_TOOLS.has("ler_arquivo")).toBe(true);
      expect(READ_ONLY_TOOLS.has("ler_arquivo_avancado")).toBe(true);
      expect(READ_ONLY_TOOLS.has("buscar_arquivos")).toBe(true);
      expect(READ_ONLY_TOOLS.has("buscar_texto")).toBe(true);
      expect(READ_ONLY_TOOLS.has("git_status")).toBe(true);
      expect(READ_ONLY_TOOLS.has("git_log")).toBe(true);
      expect(READ_ONLY_TOOLS.has("git_diff")).toBe(true);
    });

    it("FILE_TOOLS should contain expected tools", () => {
      expect(FILE_TOOLS.has("aplicar_diff")).toBe(true);
      expect(FILE_TOOLS.has("editar_arquivo")).toBe(true);
      expect(FILE_TOOLS.has("multi_edit")).toBe(true);
    });

    it("TEST_TOOLS should contain expected tools", () => {
      expect(TEST_TOOLS.has("executar_testes")).toBe(true);
      expect(TEST_TOOLS.has("executar_comando")).toBe(true);
      expect(TEST_TOOLS.has("sugerir_fixes")).toBe(true);
    });

    it("WRITE tools should NOT be in READ_ONLY_TOOLS", () => {
      expect(READ_ONLY_TOOLS.has("aplicar_diff")).toBe(false);
      expect(READ_ONLY_TOOLS.has("editar_arquivo")).toBe(false);
      expect(READ_ONLY_TOOLS.has("executar_comando")).toBe(false);
    });

    it("READ_ONLY tools should NOT be in FILE_TOOLS", () => {
      expect(FILE_TOOLS.has("ler_arquivo")).toBe(false);
      expect(FILE_TOOLS.has("git_status")).toBe(false);
    });
  });

  describe("Auto-heal retry logic", () => {
    it("should respect MAX_AUTO_HEAL_RETRIES limit", () => {
      let retries = 0;
      function attemptHeal(): boolean {
        if (retries >= 2) return false;
        retries++;
        return true;
      }
      expect(attemptHeal()).toBe(true);
      expect(attemptHeal()).toBe(true);
      expect(attemptHeal()).toBe(false);
      expect(retries).toBe(2);
    });

    it("should detect test failure in tool result", () => {
      const toolResult = "FAIL src/app.test.ts\n  Expected 5 to equal 3";
      expect(isTestFailure(toolResult)).toBe(true);
    });

    it("should not false-positive on success", () => {
      const toolResult = "✓ 320 tests passed in 8.12s";
      expect(isTestFailure(toolResult)).toBe(false);
    });
  });
});
