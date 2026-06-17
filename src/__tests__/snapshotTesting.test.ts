/** snapshotTesting.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("snapshotTesting", () => {
  beforeEach(async () => {
    const { clearSnapshots } = await import("./../snapshotTesting.js");
    clearSnapshots();
  });

  it("hasBeforeSnapshot should return false initially", async () => {
    const { hasBeforeSnapshot } = await import("./../snapshotTesting.js");
    expect(hasBeforeSnapshot("foo", "test.ts")).toBe(false);
  });

  it("clearSnapshots should not throw", async () => {
    const { clearSnapshots } = await import("./../snapshotTesting.js");
    expect(() => clearSnapshots()).not.toThrow();
  });

  it("getSnapshots should return empty array initially", async () => {
    const { getSnapshots } = await import("./../snapshotTesting.js");
    expect(getSnapshots().length).toBe(0);
  });

  it("captureBeforeSnapshot should return not captured for non-JS files", async () => {
    const { captureBeforeSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureBeforeSnapshot("foo", "test.luau", "[]");
    expect(result.captured).toBe(false);
  });

  it("captureAfterSnapshot should return not captured when no before-snapshot", async () => {
    const { captureAfterSnapshot } = await import("./../snapshotTesting.js");
    const result = await captureAfterSnapshot("foo", "test.ts");
    expect(result.captured).toBe(false);
    expect(result.message).toContain("No before-snapshot");
  });
});
