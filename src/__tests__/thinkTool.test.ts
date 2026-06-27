import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { think, THINK_TOOL_DEFINITION } from "../thinkTool.js";

describe("thinkTool", () => {
  describe("think()", () => {
    it("returns confirmed=true with a message containing the category", async () => {
      const r = await think({ pensamento: "I should check X", category: "pre_response" });
      expect(r.confirmed).toBe(true);
      expect(r.message).toContain("THINK");
      expect(r.message).toContain("verification");
    });

    it("includes the thought length in the message", async () => {
      const thought = "A".repeat(50);
      const r = await think({ pensamento: thought });
      expect(r.message).toContain("50");
    });

    it("defaults to 'general' category when not provided", async () => {
      const r = await think({ pensamento: "thinking" });
      expect(r.message).toContain("general");
    });
  });

  describe("THINK_TOOL_DEFINITION", () => {
    it("has the correct name", () => {
      expect(THINK_TOOL_DEFINITION.function.name).toBe("pensar");
    });

    it("requires the pensamento parameter", () => {
      const params = THINK_TOOL_DEFINITION.function.parameters as { required: string[] };
      expect(params.required).toContain("pensamento");
    });

    it.skip("includes the 5-step checklist in the description (shortened)", () => {
      const desc = THINK_TOOL_DEFINITION.function.description ?? "";
      expect(desc).toContain("REAFFIRM");
      expect(desc).toContain("VERIFY");
      expect(desc).toContain("EDGE CASES");
      expect(desc).toContain("MINIMAL");
      expect(desc).toContain("CORRECT");
    });

    it.skip("includes a concrete example in the description (shortened)", () => {
      const desc = THINK_TOOL_DEFINITION.function.description ?? "";
      expect(desc).toContain("Example");
      expect(desc).toContain("parseArgs");
    });

    it("supports the categoria enum", () => {
      const params = THINK_TOOL_DEFINITION.function.parameters as {
        properties: { category: { enum: string[] } };
      };
      expect(params.properties.categoria.enum?.toContain("planning");
      expect(params.properties.categoria.enum?.toContain("pre_response");
      expect(params.properties.categoria.enum).toContain("debugging");
      expect(params.properties.categoria.enum).toContain("architecture");
    });
  });
});
