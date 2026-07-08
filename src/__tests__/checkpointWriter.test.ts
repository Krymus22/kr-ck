/** checkpointWriter.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("./../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("./../history.js", () => ({
  getHistory: vi.fn(() => []),
  // Bug Hunter #2: writeCheckpoint now calls estimateTokens() for contextPercent.
  estimateTokens: vi.fn(() => 0),
}));

describe("checkpointWriter", () => {
  beforeEach(async () => {
    const { resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    vi.resetModules();
  });

  it("shouldCheckpoint returns 0 when context is small", async () => {
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    // Pass 128000 explicitly to pin the historical context window used by
    // these regression tests. Production uses config.contextWindowTokens
    // (256_000 for Kimi K2.6) — see checkpoint-firing-too-early regression
    // test in checkpointWriter-extended.test.ts.
    expect(shouldCheckpoint(100, 128000)).toBe(0);
  });

  it("shouldCheckpoint returns 1 at 20%", async () => {
    const { shouldCheckpoint } = await import("./../checkpointWriter.js");
    expect(shouldCheckpoint(26000, 128000)).toBe(1); // ~20% of 128000
  });

  it("shouldCheckpoint returns 2 at 45%", async () => {
    const { shouldCheckpoint, resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    // Simulate checkpoint 1 already done
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({ choices: [{ message: { content: '{"intention":"","nextAction":"","constraints":[],"taskTree":[],"currentWork":"","filesInvolved":[],"crossTaskDiscoveries":[],"errorsAndCorrections":[],"runtimeState":"","designDecisions":[],"miscNotes":""}' } }] });
    await writeCheckpoint(1, 128000);
    expect(shouldCheckpoint(58000, 128000)).toBe(2); // ~45%
  });

  it("shouldCheckpoint returns 0 if already checkpointed", async () => {
    const { shouldCheckpoint, resetCheckpoints } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    const { writeCheckpoint } = await import("./../checkpointWriter.js");
    const { chat } = await import("./../apiClient.js");
    (chat as any).mockResolvedValue({ choices: [{ message: { content: '{"intention":"","nextAction":"","constraints":[],"taskTree":[],"currentWork":"","filesInvolved":[],"crossTaskDiscoveries":[],"errorsAndCorrections":[],"runtimeState":"","designDecisions":[],"miscNotes":""}' } }] });
    await writeCheckpoint(1, 128000);
    expect(shouldCheckpoint(26000, 128000)).toBe(0); // Already done checkpoint 1
  });

  it("formatCheckpoint should format all fields", async () => {
    const { formatCheckpoint } = await import("./../checkpointWriter.js");
    const state = {
      intention: "Fix bug", nextAction: "Run tests", constraints: ["Don't break API"],
      taskTree: ["Fix bug", "Add test"], currentWork: "Fixed the bug",
      filesInvolved: [{ path: "src/test.ts", change: "Added fix" }],
      crossTaskDiscoveries: ["Bug also affects auth"],
      errorsAndCorrections: [{ error: "Type mismatch", fix: "Cast to string" }],
      runtimeState: "Tests passing",
      designDecisions: [{ decision: "Use Option type", rationale: "Safer" }],
      miscNotes: "Remember to update docs",
    };
    const result = formatCheckpoint(state as any);
    expect(result).toContain("CHECKPOINT STATE");
    expect(result).toContain("Fix bug");
    expect(result).toContain("Run tests");
    expect(result).toContain("src/test.ts");
    expect(result).toContain("Type mismatch");
  });

  it("resetCheckpoints should clear state", async () => {
    const { resetCheckpoints, getLastCheckpointNumber } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    expect(getLastCheckpointNumber()).toBe(0);
  });

  it("getLastCheckpointState should return null initially", async () => {
    const { resetCheckpoints, getLastCheckpointState } = await import("./../checkpointWriter.js");
    resetCheckpoints();
    expect(getLastCheckpointState()).toBeNull();
  });
});
