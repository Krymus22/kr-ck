/**
 * backgroundProcesses.test.ts — Tests for background process management.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

import {
  startBackgroundProcess,
  getProcessOutput,
  listBackgroundProcesses,
  killProcess,
  killAllBackgroundProcesses,
  cleanupExitedProcesses,
  _resetForTests,
  _getProcessCount,
} from "../backgroundProcesses.js";

describe("backgroundProcesses", () => {
  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it("starts a background process and returns its info", () => {
    const proc = startBackgroundProcess("echo hello");
    expect(proc.id).toBe(1);
    expect(proc.command).toBe("echo hello");
    expect(proc.exited).toBe(false);
    expect(proc.exitCode).toBeNull();
    expect(proc.stdout).toBe("");
    expect(proc.stderr).toBe("");
  });

  it("captures stdout from a background process", async () => {
    const proc = startBackgroundProcess("echo hello world");
    // Wait for the process to finish and capture output
    await new Promise(r => setTimeout(r, 500));
    const output = getProcessOutput(proc.id);
    expect(output).not.toBeNull();
    expect(output).toContain("hello world");
  });

  it("lists all background processes", () => {
    startBackgroundProcess("echo test1");
    startBackgroundProcess("echo test2");
    const list = listBackgroundProcesses();
    expect(list).toContain("Background processes (2)");
    expect(list).toContain("echo test1");
    expect(list).toContain("echo test2");
  });

  it("returns null for non-existent process ID", () => {
    const output = getProcessOutput(9999);
    expect(output).toBeNull();
  });

  it("returns 'No background processes' when empty", () => {
    const list = listBackgroundProcesses();
    expect(list).toBe("No background processes running.");
  });

  it("kills a running process", () => {
    const proc = startBackgroundProcess("sleep 60");
    const killed = killProcess(proc.id);
    expect(killed).toBe(true);
  });

  it("returns false when killing non-existent process", () => {
    const killed = killProcess(9999);
    expect(killed).toBe(false);
  });

  it("killAllBackgroundProcesses kills all processes", () => {
    startBackgroundProcess("sleep 60");
    startBackgroundProcess("sleep 60");
    expect(_getProcessCount()).toBe(2);
    killAllBackgroundProcesses();
    expect(_getProcessCount()).toBe(0);
  });

  it("cleanupExitedProcesses removes finished processes", async () => {
    const proc = startBackgroundProcess("echo done");
    // Wait for it to finish
    await new Promise(r => setTimeout(r, 500));
    expect(proc.exited).toBe(true);
    cleanupExitedProcesses();
    expect(_getProcessCount()).toBe(0);
  });

  it("process IDs increment correctly", () => {
    const p1 = startBackgroundProcess("echo 1");
    const p2 = startBackgroundProcess("echo 2");
    const p3 = startBackgroundProcess("echo 3");
    expect(p1.id).toBe(1);
    expect(p2.id).toBe(2);
    expect(p3.id).toBe(3);
  });

  it("output shows process status (running or exited)", async () => {
    const proc = startBackgroundProcess("echo test");
    // Initially running (or just finished)
    await new Promise(r => setTimeout(r, 500));
    const output = getProcessOutput(proc.id);
    expect(output).not.toBeNull();
    // Should contain either "running" or "exited"
    expect(output).toMatch(/(running|exited)/);
  });
});
