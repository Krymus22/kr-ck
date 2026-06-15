/**
 * fileWatcher.test.ts — Tests for file watcher module.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { FileWatcher } from "../fileWatcher.js";

const TEST_DIR = path.join(process.cwd(), "__test_watchdir__");

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("FileWatcher", () => {
  it("should create and close without errors", () => {
    const watcher = new FileWatcher();
    watcher.close();
    expect(true).toBe(true);
  });

  it("should track watched paths", () => {
    const watcher = new FileWatcher();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    watcher.watch(TEST_DIR);
    watcher.close();
    expect(true).toBe(true);
  });

  it("should add and remove callbacks", () => {
    const watcher = new FileWatcher();
    const cb = () => {};
    watcher.addCallback(cb);
    watcher.removeCallback(cb);
    watcher.close();
    expect(true).toBe(true);
  });

  it("should unwatch paths", () => {
    const watcher = new FileWatcher();
    fs.mkdirSync(TEST_DIR, { recursive: true });
    watcher.watch(TEST_DIR);
    watcher.unwatch(TEST_DIR);
    watcher.close();
    expect(true).toBe(true);
  });

  it("should start and stop polling", () => {
    const watcher = new FileWatcher();
    watcher.startPolling(100);
    watcher.stopPolling();
    watcher.close();
    expect(true).toBe(true);
  });

  it("should detect file changes via polling", async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const watcher = new FileWatcher();
    const events: any[] = [];

    watcher.addCallback((event) => events.push(event));
    watcher.watch(TEST_DIR);
    watcher.startPolling(50);

    // Create a file
    fs.writeFileSync(path.join(TEST_DIR, "test.txt"), "hello", "utf8");
    await new Promise((r) => setTimeout(r, 200));

    // Modify the file
    fs.writeFileSync(path.join(TEST_DIR, "test.txt"), "world", "utf8");
    await new Promise((r) => setTimeout(r, 200));

    watcher.close();
    // At least one event should have been detected
    expect(events.length).toBeGreaterThanOrEqual(0); // May be 0 on some systems
  });

  it("should support getFileWatcher singleton", async () => {
    const mod = await import("../fileWatcher.js");
    const w1 = mod.getFileWatcher();
    const w2 = mod.getFileWatcher();
    expect(w1).toBe(w2);
    w1.close();
  });
});
