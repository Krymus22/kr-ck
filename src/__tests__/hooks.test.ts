import { describe, it, expect, beforeEach } from "vitest";
import {
  onPreToolCall,
  onPostToolCall,
  executePreToolCallHooks,
  executePostToolCallHooks,
  clearAllHooks,
  unregisterHook,
} from "../hooks.js";

describe("Hook System", () => {
  beforeEach(() => {
    clearAllHooks();
  });

  describe("preToolCall hooks", () => {
    it("executes registered hooks", async () => {
      let called = false;
      onPreToolCall(async (ctx) => {
        called = true;
        expect(ctx.toolName).toBe("test_tool");
        expect(ctx.args).toEqual({ foo: "bar" });
        return {};
      });

      const result = await executePreToolCallHooks("test_tool", { foo: "bar" });
      expect(called).toBe(true);
      expect(result.skip).toBeFalsy();
    });

    it("skips tool when hook returns skip: true", async () => {
      onPreToolCall(async () => {
        return { skip: true, resultOverride: "skipped by hook" };
      });

      const result = await executePreToolCallHooks("any_tool", {});
      expect(result.skip).toBe(true);
      expect(result.resultOverride).toBe("skipped by hook");
    });

    it("modifies args via modifiedArgs", async () => {
      onPreToolCall(async (ctx) => {
        return { modifiedArgs: { ...ctx.args, injected: true } };
      });

      const result = await executePreToolCallHooks("tool", { original: true });
      expect(result.modifiedArgs).toEqual({ original: true, injected: true });
    });

    it("executes hooks in priority order", async () => {
      const order: number[] = [];
      onPreToolCall(async () => { order.push(2); return {}; }, 2);
      onPreToolCall(async () => { order.push(1); return {}; }, 1);
      onPreToolCall(async () => { order.push(3); return {}; }, 3);

      await executePreToolCallHooks("tool", {});
      expect(order).toEqual([1, 2, 3]);
    });

    it("stops execution when skip is returned", async () => {
      const calls: string[] = [];
      onPreToolCall(async () => { calls.push("first"); return { skip: true }; }, 1);
      onPreToolCall(async () => { calls.push("second"); return {}; }, 2);

      await executePreToolCallHooks("tool", {});
      expect(calls).toEqual(["first"]);
    });
  });

  describe("postToolCall hooks", () => {
    it("executes and can modify result", async () => {
      onPostToolCall(async (ctx, result) => {
        return { modifiedResult: result + " [modified]" };
      });

      const r = await executePostToolCallHooks("tool", {}, "original");
      expect(r.modifiedResult).toBe("original [modified]");
    });

    it("chains multiple hooks", async () => {
      onPostToolCall(async (ctx, result) => {
        return { modifiedResult: result + " +A" };
      });
      onPostToolCall(async (ctx, result) => {
        return { modifiedResult: result + " +B" };
      });

      const r = await executePostToolCallHooks("tool", {}, "start");
      expect(r.modifiedResult).toBe("start +A +B");
    });
  });

  describe("unregisterHook", () => {
    it("removes a hook by id", async () => {
      let called = false;
      const id = onPreToolCall(async () => { called = true; return {}; });
      unregisterHook(id);

      await executePreToolCallHooks("tool", {});
      expect(called).toBe(false);
    });

    it("returns false for unknown id", () => {
      expect(unregisterHook("nonexistent")).toBe(false);
    });
  });

  describe("clearAllHooks", () => {
    it("removes all hooks", async () => {
      let count = 0;
      onPreToolCall(async () => { count++; return {}; });
      onPostToolCall(async () => { count++; return {}; });
      clearAllHooks();

      await executePreToolCallHooks("tool", {});
      await executePostToolCallHooks("tool", {}, "result");
      expect(count).toBe(0);
    });
  });
});
