/** specFirst.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("specFirst", () => {
  beforeEach(async () => {
    const { clearSpec } = await import("./../specFirst.js");
    clearSpec();
  });

  it("createSpec should store spec", async () => {
    const { createSpec, getSpec } = await import("./../specFirst.js");
    const spec = createSpec({
      name: "GetCoins", description: "Returns player coins",
      inputs: [{ name: "playerId", type: "number", required: true }],
      outputs: [{ name: "coins", type: "number" }],
      edgeCases: ["playerId < 0", "player not found"],
      constraints: ["Must not modify player data"],
    });
    expect(spec.name).toBe("GetCoins");
    expect(getSpec()).not.toBeNull();
  });

  it("hasSpec should return false initially", async () => {
    const { hasSpec } = await import("./../specFirst.js");
    expect(hasSpec()).toBe(false);
  });

  it("hasSpec should return true after createSpec", async () => {
    const { createSpec, hasSpec } = await import("./../specFirst.js");
    createSpec({ name: "Test", description: "", inputs: [], outputs: [], edgeCases: [], constraints: [] });
    expect(hasSpec()).toBe(true);
  });

  it("formatSpec should format all fields", async () => {
    const { createSpec, formatSpec } = await import("./../specFirst.js");
    createSpec({
      name: "GetCoins", description: "Returns coins",
      inputs: [{ name: "playerId", type: "number", required: true, description: "Player ID" }],
      outputs: [{ name: "coins", type: "number", description: "Current coins" }],
      edgeCases: ["Negative ID"],
      constraints: ["Read-only"],
    });
    const result = formatSpec();
    expect(result).toContain("[SPEC: GetCoins]");
    expect(result).toContain("playerId");
    expect(result).toContain("number");
    expect(result).toContain("Negative ID");
    expect(result).toContain("Read-only");
  });

  it("formatSpec should return empty string when no spec", async () => {
    const { formatSpec } = await import("./../specFirst.js");
    expect(formatSpec()).toBe("");
  });

  it("clearSpec should remove spec", async () => {
    const { createSpec, clearSpec, hasSpec } = await import("./../specFirst.js");
    createSpec({ name: "X", description: "", inputs: [], outputs: [], edgeCases: [], constraints: [] });
    clearSpec();
    expect(hasSpec()).toBe(false);
  });
});
