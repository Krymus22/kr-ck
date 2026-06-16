/**
 * tools-registry.test.ts — Tests for tools/index.ts and category modules (real imports).
 */

import { describe, it, expect } from "vitest";
import { ALL_TOOLS, TOOL_COUNTS, getToolsByCategory, searchTools, listAllToolNames } from "../tools/index.js";
import { ROBLOX_TOOLS } from "../tools/roblox.js";
import { PYTHON_TOOLS } from "../tools/python.js";
import { NODE_TOOLS } from "../tools/node.js";
import { RUST_TOOLS } from "../tools/rust.js";
import { GO_TOOLS } from "../tools/go.js";
import { DOCKER_TOOLS } from "../tools/docker.js";

describe("tools/index.ts (real module)", () => {
  describe("ALL_TOOLS", () => {
    it("should be a non-empty array", () => {
      expect(Array.isArray(ALL_TOOLS)).toBe(true);
      expect(ALL_TOOLS.length).toBeGreaterThan(0);
    });

    it("should have unique tool names", () => {
      const names = ALL_TOOLS.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it("every tool should have required fields", () => {
      for (const tool of ALL_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.category).toBeTruthy();
        expect(["roblox", "python", "node", "rust", "go", "docker"]).toContain(tool.category);
      }
    });
  });

  describe("TOOL_COUNTS", () => {
    it("should have counts for each category", () => {
      expect(TOOL_COUNTS.roblox).toBeGreaterThan(0);
      expect(TOOL_COUNTS.python).toBeGreaterThan(0);
      expect(TOOL_COUNTS.node).toBeGreaterThan(0);
      expect(TOOL_COUNTS.rust).toBeGreaterThan(0);
      expect(TOOL_COUNTS.go).toBeGreaterThan(0);
      expect(TOOL_COUNTS.docker).toBeGreaterThan(0);
    });

    it("total should match ALL_TOOLS length", () => {
      expect(TOOL_COUNTS.total).toBe(ALL_TOOLS.length);
    });
  });

  describe("getToolsByCategory", () => {
    it("should filter by roblox", () => {
      const tools = getToolsByCategory("roblox");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("roblox");
    });

    it("should filter by python", () => {
      const tools = getToolsByCategory("python");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("python");
    });

    it("should filter by node", () => {
      const tools = getToolsByCategory("node");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("node");
    });

    it("should filter by rust", () => {
      const tools = getToolsByCategory("rust");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("rust");
    });

    it("should filter by go", () => {
      const tools = getToolsByCategory("go");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("go");
    });

    it("should filter by docker", () => {
      const tools = getToolsByCategory("docker");
      expect(tools.length).toBeGreaterThan(0);
      for (const t of tools) expect(t.category).toBe("docker");
    });

    it("should return empty for non-existent category", () => {
      expect(getToolsByCategory("nonexistent")).toHaveLength(0);
    });
  });

  describe("searchTools", () => {
    it("should find tools by name", () => {
      const results = searchTools("rojo");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should find tools by description", () => {
      const results = searchTools("docker");
      expect(results.length).toBeGreaterThan(0);
    });

    it("should be case-insensitive", () => {
      const lower = searchTools("pytest");
      const upper = searchTools("PYTEST");
      expect(lower.length).toBe(upper.length);
    });

    it("should return empty for no match", () => {
      expect(searchTools("xyznonexistent")).toHaveLength(0);
    });
  });

  describe("listAllToolNames", () => {
    it("should return array of strings", () => {
      const names = listAllToolNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(typeof n).toBe("string");
    });
  });

  describe("category modules", () => {
    it("ROBLOX_TOOLS count", () => { expect(ROBLOX_TOOLS.length).toBe(19); });
    it("PYTHON_TOOLS count", () => { expect(PYTHON_TOOLS.length).toBe(8); });
    it("NODE_TOOLS count", () => { expect(NODE_TOOLS.length).toBe(11); });
    it("RUST_TOOLS count", () => { expect(RUST_TOOLS.length).toBe(8); });
    it("GO_TOOLS count", () => { expect(GO_TOOLS.length).toBe(9); });
    it("DOCKER_TOOLS count", () => { expect(DOCKER_TOOLS.length).toBe(11); });

    it("index.ts aggregates all category arrays", () => {
      const expected = ROBLOX_TOOLS.length + PYTHON_TOOLS.length + NODE_TOOLS.length +
        RUST_TOOLS.length + GO_TOOLS.length + DOCKER_TOOLS.length;
      expect(ALL_TOOLS.length).toBeGreaterThanOrEqual(expected);
    });

    it("no duplicate tool names across all modules", () => {
      const allNames = [
        ...ROBLOX_TOOLS, ...PYTHON_TOOLS, ...NODE_TOOLS,
        ...RUST_TOOLS, ...GO_TOOLS, ...DOCKER_TOOLS,
      ].map((t) => t.name);
      expect(new Set(allNames).size).toBe(allNames.length);
    });

    it("every tool has at least one whenToUse context", () => {
      const allTools = [...ROBLOX_TOOLS, ...PYTHON_TOOLS, ...NODE_TOOLS,
        ...RUST_TOOLS, ...GO_TOOLS, ...DOCKER_TOOLS];
      for (const tool of allTools) {
        expect(tool.context).toBeDefined();
        expect(tool.context!.whenToUse.length).toBeGreaterThan(0);
      }
    });
  });
});
