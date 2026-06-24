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

import { validateToolCall, formatValidationErrors } from "../toolSchemaValidation.js";

describe("toolSchemaValidation", () => {
  describe("validateToolCall", () => {
    it("passes when required params are present", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const r = validateToolCall("test_tool", { name: "hello" }, schema);
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it("fails when required param is missing", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string", description: "the name" } },
        required: ["name"],
      };
      const r = validateToolCall("test_tool", {}, schema);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toContain("name");
      expect(r.errors[0]).toContain("missing");
    });

    it("fails when required param is empty string", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      };
      const r = validateToolCall("test_tool", { name: "" }, schema);
      expect(r.valid).toBe(false);
    });

    it("fails when type is wrong (expected string, got number)", () => {
      const schema = {
        type: "object",
        properties: { age: { type: "string" } },
      };
      const r = validateToolCall("test_tool", { age: 42 }, schema);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toContain("string");
      expect(r.errors[0]).toContain("number");
    });

    it("validates enum values", () => {
      const schema = {
        type: "object",
        properties: { level: { type: "string", enum: ["low", "med", "high"] } },
      };
      const r = validateToolCall("test_tool", { level: "invalid" }, schema);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toContain("invalid");
      expect(r.errors[0]).toContain("low, med, high");
    });

    it("validates array items", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
      };
      const r = validateToolCall("test_tool", { items: ["ok", 42, "bad"] }, schema);
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });

    it("validates nested object properties", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              debug: { type: "boolean" },
            },
          },
        },
      };
      const r = validateToolCall("test_tool", { config: { debug: "yes" } }, schema);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toContain("boolean");
    });

    it("passes when no schema properties are specified", () => {
      const r = validateToolCall("test_tool", {}, { type: "object" });
      expect(r.valid).toBe(true);
    });
  });

  describe("formatValidationErrors", () => {
    it("formats errors with header and footer", () => {
      const msg = formatValidationErrors("test_tool", ["error 1", "error 2"]);
      expect(msg).toContain("SCHEMA VALIDATION");
      expect(msg).toContain("test_tool");
      expect(msg).toContain("error 1");
      expect(msg).toContain("error 2");
      expect(msg).toContain("Fix");
    });
  });
});
