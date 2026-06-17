/** gracefulShutdown.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("gracefulShutdown", () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });
  afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

  it("checkPreviousShutdown should return null when no marker", async () => {
    const { checkPreviousShutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    expect(checkPreviousShutdown()).toBeNull();
  });

  it("checkPreviousShutdown should return data when marker exists", async () => {
    const { checkPreviousShutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    const markerPath = path.join(tmpHome, ".claude-killer", ".last_shutdown");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ timestamp: "2026-01-01", signal: "SIGINT", pid: 123 }), "utf8");
    const result = checkPreviousShutdown();
    expect(result).not.toBeNull();
    expect(result!.signal).toBe("SIGINT");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("onShutdown should register handler", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    let called = false;
    onShutdown(() => { called = true; });
    await shutdown("SIGINT");
    expect(called).toBe(true);
  });

  it("shutdown should be idempotent (call twice = run once)", async () => {
    const { onShutdown, shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    let count = 0;
    onShutdown(() => { count++; });
    await shutdown("SIGINT");
    await shutdown("SIGINT");
    expect(count).toBe(1);
  });

  it("shutdown should write marker file", async () => {
    const { shutdown, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    await shutdown("SIGTERM");
    const markerPath = path.join(tmpHome, ".claude-killer", ".last_shutdown");
    expect(fs.existsSync(markerPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(data.signal).toBe("SIGTERM");
  });

  it("loadLastPlan should return null when no plan saved", async () => {
    const { loadLastPlan, resetShutdownState } = await import("./../gracefulShutdown.js");
    resetShutdownState();
    expect(loadLastPlan()).toBeNull();
  });
});
