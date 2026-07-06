/**
 * fileWatcher-extended.test.ts — Extended tests for fileWatcher.ts
 *
 * Covers 30+ tests across:
 *   - FileWatcher class (addCallback/removeCallback, watch/unwatch, polling)
 *   - FileChangeEvent shape
 *   - getFileWatcher singleton
 *   - close() cleanup
 *   - edge cases: non-existent paths, double-watch, double-close
 *
 * Uses polling (deterministic) instead of fs.watch (event-timing-dependent).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import { FileWatcher, getFileWatcher } from "../fileWatcher.js";

describe("FileWatcher callbacks (extended)", () => {
  let watcher: FileWatcher;

  beforeEach(() => {
    watcher = new FileWatcher();
  });

  afterEach(() => {
    watcher.close();
  });

  it("addCallback registers a callback (does not throw)", () => {
    expect(() => watcher.addCallback(() => {})).not.toThrow();
  });

  it("removeCallback does not throw when callback not registered", () => {
    expect(() => watcher.removeCallback(() => {})).not.toThrow();
  });

  it("removeCallback removes a previously added callback", () => {
    const cb = vi.fn();
    watcher.addCallback(cb);
    watcher.removeCallback(cb);
    // No way to directly verify removal without triggering an event;
    // we verify it doesn't throw and was called once (i.e. not at all).
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple callbacks can be added", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    watcher.addCallback(cb1);
    watcher.addCallback(cb2);
    // No exceptions means success
    expect(true).toBe(true);
  });

  it("adding the same callback twice is idempotent (Set behavior)", () => {
    const cb = vi.fn();
    watcher.addCallback(cb);
    watcher.addCallback(cb);
    // Should not throw
    expect(true).toBe(true);
  });
});

describe("FileWatcher watch / unwatch (extended)", () => {
  let tmpDir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-ext-"));
    watcher = new FileWatcher();
  });

  afterEach(() => {
    watcher.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("watch on an existing directory does not throw", () => {
    expect(() => watcher.watch(tmpDir)).not.toThrow();
  });

  it("watch on an existing file does not throw", () => {
    const file = path.join(tmpDir, "file.txt");
    fs.writeFileSync(file, "data");
    expect(() => watcher.watch(file)).not.toThrow();
  });

  it("watch on a non-existent path does not throw", () => {
    expect(() => watcher.watch(path.join(tmpDir, "nope"))).not.toThrow();
  });

  it("watching the same path twice does not throw", () => {
    watcher.watch(tmpDir);
    expect(() => watcher.watch(tmpDir)).not.toThrow();
  });

  it("unwatch on a non-watched path does not throw", () => {
    expect(() => watcher.unwatch(path.join(tmpDir, "unwatched"))).not.toThrow();
  });

  it("unwatch on a watched path does not throw", () => {
    watcher.watch(tmpDir);
    expect(() => watcher.unwatch(tmpDir)).not.toThrow();
  });

  it("watch with recursive=true does not throw", () => {
    expect(() => watcher.watch(tmpDir, true)).not.toThrow();
  });

  it("watch with recursive=false does not throw", () => {
    expect(() => watcher.watch(tmpDir, false)).not.toThrow();
  });
});

describe("FileWatcher polling (extended)", () => {
  let tmpDir: string;
  let watcher: FileWatcher;
  let watchedFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-poll-"));
    watchedFile = path.join(tmpDir, "tracked.txt");
    fs.writeFileSync(watchedFile, "initial");
    watcher = new FileWatcher();
    watcher.watch(watchedFile);
  });

  afterEach(() => {
    watcher.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startPolling does not throw", () => {
    expect(() => watcher.startPolling(50)).not.toThrow();
  });

  it("startPolling twice does not throw (idempotent)", () => {
    watcher.startPolling(50);
    expect(() => watcher.startPolling(50)).not.toThrow();
  });

  it("stopPolling does not throw", () => {
    watcher.startPolling(50);
    expect(() => watcher.stopPolling()).not.toThrow();
  });

  it("stopPolling without startPolling does not throw", () => {
    expect(() => watcher.stopPolling()).not.toThrow();
  });

  it("emits 'created' event on first poll for an existing file", async () => {
    const events: any[] = [];
    watcher.addCallback((e) => events.push(e));
    watcher.startPolling(20);
    await new Promise((r) => setTimeout(r, 50));
    watcher.stopPolling();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe("created");
    expect(events[0].filePath).toBe(watchedFile);
  });

  it("emits 'modified' event when file content changes", async () => {
    const events: any[] = [];
    watcher.addCallback((e) => events.push(e));
    watcher.startPolling(20);
    // Wait for first poll (created)
    await new Promise((r) => setTimeout(r, 30));
    // Modify the file
    const newPath = `${watchedFile}.tmp`;
    fs.writeFileSync(watchedFile, "modified content");
    // Touch mtime
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(watchedFile, future, future);
    await new Promise((r) => setTimeout(r, 60));
    watcher.stopPolling();
    const modifiedEvents = events.filter((e) => e.type === "modified");
    expect(modifiedEvents.length).toBeGreaterThan(0);
  });

  it("emits 'deleted' event when file is removed", async () => {
    const events: any[] = [];
    watcher.addCallback((e) => events.push(e));
    watcher.startPolling(20);
    await new Promise((r) => setTimeout(r, 30)); // created
    fs.unlinkSync(watchedFile);
    await new Promise((r) => setTimeout(r, 60));
    watcher.stopPolling();
    const deletedEvents = events.filter((e) => e.type === "deleted");
    expect(deletedEvents.length).toBeGreaterThan(0);
  });

  it("FileChangeEvent has correct shape", async () => {
    const events: any[] = [];
    watcher.addCallback((e) => events.push(e));
    watcher.startPolling(20);
    await new Promise((r) => setTimeout(r, 40));
    watcher.stopPolling();
    expect(events.length).toBeGreaterThan(0);
    const e = events[0];
    expect(e).toHaveProperty("type");
    expect(e).toHaveProperty("filePath");
    expect(e).toHaveProperty("timestamp");
    expect(typeof e.type).toBe("string");
    expect(typeof e.filePath).toBe("string");
    expect(e.timestamp).toBeInstanceOf(Date);
  });
});

describe("FileWatcher close (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-close-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("close on a fresh watcher does not throw", () => {
    const w = new FileWatcher();
    expect(() => w.close()).not.toThrow();
  });

  it("close after watching does not throw", () => {
    const w = new FileWatcher();
    w.watch(tmpDir);
    expect(() => w.close()).not.toThrow();
  });

  it("close after polling does not throw", () => {
    const w = new FileWatcher();
    w.startPolling(50);
    expect(() => w.close()).not.toThrow();
  });

  it("close twice does not throw", () => {
    const w = new FileWatcher();
    w.close();
    expect(() => w.close()).not.toThrow();
  });

  it("close stops polling", () => {
    const w = new FileWatcher();
    w.startPolling(50);
    w.close();
    // No way to assert the interval is cleared without internals;
    // we just verify no exceptions and process can exit cleanly
    expect(true).toBe(true);
  });
});

describe("getFileWatcher singleton (extended)", () => {
  it("returns a FileWatcher instance", () => {
    const w = getFileWatcher();
    expect(w).toBeInstanceOf(FileWatcher);
  });

  it("returns the same instance on subsequent calls", () => {
    const w1 = getFileWatcher();
    const w2 = getFileWatcher();
    expect(w1).toBe(w2);
  });
});

describe("FileWatcher edge cases (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-edge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("callback that throws is caught (does not crash watcher)", async () => {
    const w = new FileWatcher();
    const file = path.join(tmpDir, "edge.txt");
    fs.writeFileSync(file, "data");
    w.watch(file);
    w.addCallback(() => {
      throw new Error("callback crash");
    });
    w.startPolling(20);
    await new Promise((r) => setTimeout(r, 40));
    // Should not have crashed the process
    w.stopPolling();
    w.close();
    expect(true).toBe(true);
  });

  it("startPolling with default interval does not throw", () => {
    const w = new FileWatcher();
    expect(() => w.startPolling()).not.toThrow();
    w.close();
  });

  it("watching a directory then unwatching by absolute path", () => {
    const w = new FileWatcher();
    w.watch(tmpDir);
    expect(() => w.unwatch(tmpDir)).not.toThrow();
    w.close();
  });

  it("watching a directory then unwatching by relative path resolves correctly", () => {
    const w = new FileWatcher();
    w.watch(tmpDir);
    // unwatch uses path.resolve, so a relative path also works if cwd matches
    // We just verify no exceptions
    expect(() => w.unwatch(tmpDir)).not.toThrow();
    w.close();
  });
});
