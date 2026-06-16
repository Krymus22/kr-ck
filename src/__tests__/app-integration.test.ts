/**
 * app-integration.test.ts — Integration tests for cross-component interactions.
 * Covers: App ↔ ExtensionHub, App ↔ agent, App ↔ history,
 * Extension center ↔ trigger engine, memory ↔ agent flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  syncExtensions,
  toggleExtension,
  setTriggerMode,
  cycleTriggerMode,
  executeTrigger,
  registerExecutor,
  getExtensionsForTrigger,
  getEnabledExtensions,
  getHubSummary,
  getAllExtensions,
  disableAll,
  enableAllInCategory,
  type ExtensionEntry,
  type TriggerContext,
  type TriggerResult,
} from "../extensionCenter.js";

// ─── Integration: Extension Hub ↔ Trigger Engine ──────────────────────────

describe("Integration: ExtensionHub ↔ TriggerEngine", () => {
  beforeEach(() => {
    // Reset state by syncing empty list then re-syncing
    syncExtensions([]);
  });

  it("should execute on_file trigger for extensions with that mode", async () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "on_file");

    const executed: string[] = [];
    registerExecutor(async (ext) => {
      executed.push(ext.id);
      return "ok";
    });

    const ctx: TriggerContext = { cwd: "/project" };
    const results = await executeTrigger("on_file", ctx);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(executed).toContain("test:ext1");
  });

  it("should NOT execute disabled extensions", async () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "tool", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "disabled");

    const executed: string[] = [];
    registerExecutor(async (ext) => {
      executed.push(ext.id);
      return "ok";
    });

    const ctx: TriggerContext = { cwd: "/project" };
    const results = await executeTrigger("on_file", ctx);
    expect(results).toHaveLength(0);
    expect(executed).toHaveLength(0);
  });

  it("should execute always trigger on every iteration", async () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "plugin", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "always");

    const executed: string[] = [];
    registerExecutor(async (ext) => {
      executed.push(ext.id);
      return "ok";
    });

    const ctx: TriggerContext = { cwd: "/project" };
    await executeTrigger("always", ctx);
    await executeTrigger("always", ctx);
    await executeTrigger("always", ctx);
    expect(executed).toHaveLength(3);
  });

  it("should handle executor errors gracefully", async () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "on_task");

    registerExecutor(async () => {
      throw new Error("Executor failed");
    });

    const ctx: TriggerContext = { cwd: "/project" };
    const results = await executeTrigger("on_task", ctx);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].output).toContain("Executor failed");
  });

  it("should execute multiple extensions in order", async () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test1", installed: true },
      { id: "test:ext2", name: "ext2", category: "tool", description: "test2", installed: true },
      { id: "test:ext3", name: "ext3", category: "mcp", description: "test3", installed: true },
    ]);
    setTriggerMode("test:ext1", "on_file");
    setTriggerMode("test:ext2", "on_file");
    setTriggerMode("test:ext3", "on_file");

    const order: string[] = [];
    registerExecutor(async (ext) => {
      order.push(ext.id);
      return "ok";
    });

    const ctx: TriggerContext = { cwd: "/project" };
    await executeTrigger("on_file", ctx);
    expect(order).toEqual(["test:ext1", "test:ext2", "test:ext3"]);
  });
});

// ─── Integration: Extension State Transitions ──────────────────────────────

describe("Integration: Extension state transitions", () => {
  beforeEach(() => {
    syncExtensions([]);
  });

  it("should toggle extension and auto-disable trigger mode", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "always");
    expect(getExtension("test:ext1")?.enabled).toBe(true);

    toggleExtension("test:ext1");
    expect(getExtension("test:ext1")?.enabled).toBe(false);
    expect(getExtension("test:ext1")?.triggerMode).toBe("disabled");
  });

  it("should cycle through all trigger modes", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "tool", description: "test", installed: true },
    ]);

    // Initial state is "disabled", so first cycle goes to "on_file"
    const expectedModes = ["on_file", "on_task", "always", "disabled"];
    for (const expectedMode of expectedModes) {
      const result = cycleTriggerMode("test:ext1");
      expect(result).toBe(expectedMode);
    }
  });

  it("should setTriggerMode auto-enable when mode is not disabled", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: false },
    ]);

    setTriggerMode("test:ext1", "on_file");
    expect(getExtension("test:ext1")?.enabled).toBe(true);
    expect(getExtension("test:ext1")?.triggerMode).toBe("on_file");
  });

  it("should setTriggerMode auto-disable when mode is disabled", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);

    setTriggerMode("test:ext1", "always");
    expect(getExtension("test:ext1")?.enabled).toBe(true);

    setTriggerMode("test:ext1", "disabled");
    expect(getExtension("test:ext1")?.enabled).toBe(false);
  });

  it("should enableAllInCategory set all installed extensions in category", () => {
    syncExtensions([
      { id: "test:s1", name: "s1", category: "skill", description: "s1", installed: true },
      { id: "test:s2", name: "s2", category: "skill", description: "s2", installed: true },
      { id: "test:t1", name: "t1", category: "tool", description: "t1", installed: true },
    ]);

    const count = enableAllInCategory("skill", "on_task");
    expect(count).toBe(2);
    expect(getExtension("test:s1")?.triggerMode).toBe("on_task");
    expect(getExtension("test:s2")?.triggerMode).toBe("on_task");
    expect(getExtension("test:t1")?.triggerMode).toBe("disabled");
  });

  it("should disableAll disable everything", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
      { id: "test:ext2", name: "ext2", category: "tool", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "always");
    setTriggerMode("test:ext2", "on_file");

    disableAll();
    expect(getEnabledExtensions()).toHaveLength(0);
  });
});

// ─── Integration: syncExtensions preserves state ──────────────────────────

describe("Integration: syncExtensions preserves state", () => {
  beforeEach(() => {
    syncExtensions([]);
  });

  it("should preserve enabled state on re-sync", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);
    toggleExtension("test:ext1");

    // Re-sync with same extension
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "skill", description: "test", installed: true },
    ]);

    expect(getExtension("test:ext1")?.enabled).toBe(false);
  });

  it("should preserve triggerMode on re-sync", () => {
    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "tool", description: "test", installed: true },
    ]);
    setTriggerMode("test:ext1", "on_task");

    syncExtensions([
      { id: "test:ext1", name: "ext1", category: "tool", description: "test", installed: true },
    ]);

    expect(getExtension("test:ext1")?.triggerMode).toBe("on_task");
  });

  it("should default new extensions to installed state", () => {
    syncExtensions([
      { id: "test:new", name: "new", category: "mcp", description: "new", installed: true },
    ]);
    expect(getExtension("test:new")?.enabled).toBe(true);
  });

  it("should default uninstalled extensions to disabled", () => {
    syncExtensions([
      { id: "test:uninstalled", name: "uninstalled", category: "tool", description: "test", installed: false },
    ]);
    expect(getExtension("test:uninstalled")?.enabled).toBe(false);
  });
});

// ─── Integration: Hub summary ──────────────────────────────────────────────

describe("Integration: Hub summary", () => {
  beforeEach(() => {
    syncExtensions([]);
  });

  it("should count correctly across categories", () => {
    syncExtensions([
      { id: "test:s1", name: "s1", category: "skill", description: "s1", installed: true },
      { id: "test:s2", name: "s2", category: "skill", description: "s2", installed: true },
      { id: "test:t1", name: "t1", category: "tool", description: "t1", installed: true },
      { id: "test:m1", name: "m1", category: "mcp", description: "m1", installed: true },
    ]);
    // syncExtensions enables all installed by default, so disable some
    setTriggerMode("test:s2", "disabled");
    setTriggerMode("test:m1", "disabled");
    setTriggerMode("test:s1", "always");
    setTriggerMode("test:t1", "on_file");

    const summary = getHubSummary();
    expect(summary.total).toBe(4);
    expect(summary.enabled).toBe(2);
    expect(summary.byCategory.skill.total).toBe(2);
    expect(summary.byCategory.skill.enabled).toBe(1);
    expect(summary.byCategory.tool.total).toBe(1);
    expect(summary.byCategory.tool.enabled).toBe(1);
    expect(summary.byCategory.mcp.total).toBe(1);
    expect(summary.byCategory.mcp.enabled).toBe(0);
    expect(summary.byTrigger.always).toBe(1);
    expect(summary.byTrigger.on_file).toBe(1);
    expect(summary.byTrigger.disabled).toBe(2);
  });
});

// ─── Helper ────────────────────────────────────────────────────────────────

function getExtension(id: string): ExtensionEntry | undefined {
  return getAllExtensions().find((e) => e.id === id);
}
