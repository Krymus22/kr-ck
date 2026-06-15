/**
 * shell.test.ts — Tests for shell execution module.
 */

import { describe, it, expect } from "vitest";
import { runShell, runShellSync } from "../shell.js";

describe("runShell", () => {
  it("should execute a simple command", async () => {
    const result = await runShell({ command: "echo hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("hello");
    expect(result.timedOut).toBe(false);
  });

  it("should execute node command", async () => {
    const result = await runShell({ command: "node -v" });
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
  });

  it("should handle invalid command gracefully", async () => {
    const result = await runShell({ command: "nonexistent_command_xyz_abc" });
    expect(result.exitCode).not.toBe(0);
  });

  it("should respect cwd option", async () => {
    const result = await runShell({ command: "node -v", cwd: "C:\\" });
    expect(result.exitCode).toBe(0);
  });

  it("should handle timeout", async () => {
    const result = await runShell({ command: "echo done", timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
  });

  it("should return shell result object", async () => {
    const result = await runShell({ command: "echo test" });
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.timedOut).toBe("boolean");
  });
});

describe("runShellSync", () => {
  it("should execute a command synchronously", () => {
    const result = runShellSync({ command: "echo sync" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toContain("sync");
  });

  it("should handle sync errors", () => {
    const result = runShellSync({ command: "nonexistent_xyz" });
    expect(result.exitCode).not.toBe(0);
  });
});
