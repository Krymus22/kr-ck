/**
 * concurrency-races.test.ts — Race condition tests for:
 *   1. session.ts    — appendFileSync under rapid sequential appends
 *   2. apiKeyPool.ts — per-key mutex under concurrent acquire
 *
 * (apiClient.ts hedging tests live in concurrency-hedging.test.ts because
 *  they need to mock apiKeyPool, which would conflict with the real-module
 *  imports here.)
 *
 * NOTE: `import` is used everywhere (no require()) per project convention.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── 1. session.ts — appendFileSync race ────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

let tmpHome: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-race-"));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  try { process.chdir(originalCwd); } catch { /* noop */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* noop */ }
});

async function loadSessionModule() {
  vi.resetModules();
  return await import("../session.js");
}

describe("CONCURRENCY 1 — session appendMessage (appendFileSync)", () => {
  it("rapid sequential appends never interleave lines (each line is valid JSON)", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();

    // Fire 200 messages back-to-back. appendFileSync is synchronous so
    // within a single Node.js process these are serialized — but we verify
    // that no partial write corrupts a line.
    for (let i = 0; i < 200; i++) {
      appendMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}-${"x".repeat(50)}` });
    }

    const last = getLastSession();
    expect(last).not.toBeNull();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    // 1 header + 200 messages
    expect(lines.length).toBe(201);

    // Every line must be valid JSON (no partial writes, no interleaving).
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws on corruption
      expect(parsed).toBeDefined();
    }

    // Order is preserved (FIFO).
    const firstMsg = JSON.parse(lines[1]!);
    expect(firstMsg.content).toContain("msg-0-");
    const lastMsg = JSON.parse(lines[200]!);
    expect(lastMsg.content).toContain("msg-199-");
  });

  it("appendMessage is synchronous — no async interleaving possible", async () => {
    const { startSession, appendMessage, getLastSession } = await loadSessionModule();
    startSession();

    // If appendMessage were async, interleaving Promise microtasks between
    // calls could corrupt the file. Verify it returns void (not a Promise).
    const result = appendMessage({ role: "user", content: "sync-check" });
    expect(result).toBeUndefined(); // synchronous — no Promise returned

    const last = getLastSession();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // header + 1 message
  });

  it("auto-start session is idempotent under rapid first-message calls", async () => {
    const { appendMessage, getLastSession, getActiveSessionId } = await loadSessionModule();

    // Three rapid calls with no active session. The first triggers
    // startSession() synchronously; the rest reuse it. We must end up with
    // exactly ONE session file containing all three messages.
    appendMessage({ role: "user", content: "first" });
    appendMessage({ role: "user", content: "second" });
    appendMessage({ role: "user", content: "third" });

    const sid = getActiveSessionId();
    expect(sid).not.toBeNull();

    const last = getLastSession();
    expect(last).not.toBeNull();
    const lines = fs.readFileSync(last!.path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(4); // header + 3 messages
  });
});

// ─── 2. apiKeyPool.ts — per-key mutex race ──────────────────────────────────

import {
  initApiKeyPool,
  acquireKeyForStreaming,
  tryAcquireKeyImmediate,
  getAvailableKeyCount,
  getPoolStats,
  resetPool,
  resetPoolStats,
} from "../apiKeyPool.js";

describe("CONCURRENCY 2 — apiKeyPool per-key mutex", () => {
  beforeEach(() => {
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_API_KEYS;
    delete process.env.NVIDIA_API_KEYS_FILE;
    process.env.NVIDIA_API_KEYS = "nvapi-race-k1,nvapi-race-k2,nvapi-race-k3";
    resetPool();
    initApiKeyPool();
  });

  afterEach(() => {
    resetPool();
    delete process.env.NVIDIA_API_KEYS;
  });

  it("two concurrent acquireKeyForStreaming never get the same key (mutex enforced)", async () => {
    // Fire 3 concurrent acquisitions (pool has 3 keys). Each should get a
    // DIFFERENT key — the mutex + round-robin guarantee this.
    const handles = await Promise.all([
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
    ]);

    const indices = handles.map((h) => (h as any).entry.index);
    const uniqueIndices = new Set(indices);
    expect(uniqueIndices.size).toBe(3); // all different — no key shared

    // Cleanup
    for (const h of handles) h.release(true, 200, 50);
  });

  it("4th concurrent acquisition waits until a key is released (no mutex violation)", async () => {
    // Acquire all 3 keys (don't release yet).
    const [h1, h2, h3] = await Promise.all([
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
    ]);

    // 4th acquisition should be pending — no free key.
    let acquired4 = false;
    const p4 = acquireKeyForStreaming().then((h) => {
      acquired4 = true;
      return h;
    });

    // Give the event loop a chance — p4 must still be pending.
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired4).toBe(false);

    // inFlight must reflect reality: 3 keys busy, 0 available.
    expect(getAvailableKeyCount()).toBe(0);

    // Release ONE key — p4 should now acquire it (mutex passes to waiter).
    h1.release(true, 200, 50);
    const h4 = await p4;
    expect(acquired4).toBe(true);

    // h4 must hold a real key (one of the 3 indices), and the pool must
    // still show 2 in-flight from the unreleased h2, h3 + 1 from h4 = 3 busy
    // (or 1 busy if h4 raced ahead and released; we only assert <= 3).
    const idx4 = (h4 as any).entry.index;
    expect(idx4).toBeGreaterThanOrEqual(0);
    expect(idx4).toBeLessThan(3);

    // Cleanup
    h2.release(true, 200, 50);
    h3.release(true, 200, 50);
    h4.release(true, 200, 50);
  });

  it("tryAcquireKeyImmediate returns null when all keys are locked", async () => {
    // Lock all 3 keys via the async path.
    const [h1, h2, h3] = await Promise.all([
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
      acquireKeyForStreaming(),
    ]);

    // tryAcquireKeyImmediate is non-blocking — must return null since all
    // 3 keys are locked.
    const immediate = tryAcquireKeyImmediate();
    expect(immediate).toBeNull();

    // Release one — now tryAcquireKeyImmediate should succeed.
    h1.release(true, 200, 50);
    const immediate2 = tryAcquireKeyImmediate();
    expect(immediate2).not.toBeNull();
    immediate2!.release(true, 200, 50);

    // Cleanup
    h2.release(true, 200, 50);
    h3.release(true, 200, 50);
  });

  it("releaseKey decrements inFlight exactly once per acquire (no double-release leak)", async () => {
    resetPoolStats();

    const h = await acquireKeyForStreaming();
    const idx = (h as any).entry.index;

    // After acquire, inFlight for this key must be 1.
    const statsBefore = getPoolStats();
    expect(statsBefore[idx].inFlight).toBe(1);

    h.release(true, 200, 50);

    // After release, inFlight must be 0 (not negative, not still 1).
    const statsAfter = getPoolStats();
    expect(statsAfter[idx].inFlight).toBe(0);
    expect(statsAfter[idx].totalCalls).toBe(1);
    expect(statsAfter[idx].successCount).toBe(1);
  });

  it("FIFO ordering: waiters acquire in the order they called acquire", async () => {
    // Single-key pool forces serialization.
    resetPool();
    process.env.NVIDIA_API_KEYS = "nvapi-fifo-only";
    initApiKeyPool();

    const h1 = await acquireKeyForStreaming();
    const order: number[] = [];

    // Queue 3 waiters — each records its call order when it acquires.
    // NOTE: acquireKey polls pickNextKey() every 100ms when the key is
    // busy, so waiters acquire ~100ms after the previous release.
    const waiters = [1, 2, 3].map((n) =>
      acquireKeyForStreaming().then((h) => {
        order.push(n);
        return h;
      })
    );

    // Give microtasks a chance to settle — all 3 must be waiting.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);

    // Release h1 — first waiter should acquire after ~100ms poll.
    h1.release(true, 200, 10);
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual([1]);

    // Release the first waiter's handle — second waiter acquires.
    (await waiters[0]!).release(true, 200, 10);
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual([1, 2]);

    // Release second — third acquires.
    (await waiters[1]!).release(true, 200, 10);
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual([1, 2, 3]);

    // Cleanup
    (await waiters[2]!).release(true, 200, 10);
  });
});
