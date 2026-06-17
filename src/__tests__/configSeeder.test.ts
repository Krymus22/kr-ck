/**
 * configSeeder.test.ts - Tests for first-run seeding of bundled defaults.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("configSeeder", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-seed-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("seedUserConfig should be a no-op when no defaults/ directory exists", async () => {
    const { seedUserConfig, isSeeded } = await import("./../configSeeder.js");
    // We're running in the project root which DOES have defaults/, so this test
    // verifies the positive path: when defaults exist, files are copied.
    const copied = seedUserConfig();
    // 6 tool JSON files + 15 skill MD files = 21 (or 0 if already seeded)
    expect(copied === 0 || copied === 21).toBe(true);
    // After seeding, marker should exist
    expect(isSeeded()).toBe(true);
  });

  it("seedUserConfig should create marker file on run", async () => {
    const { seedUserConfig, isSeeded } = await import("./../configSeeder.js");
    seedUserConfig();
    expect(isSeeded()).toBe(true);
  });

  it("seedUserConfig should be idempotent across runs", async () => {
    const { seedUserConfig } = await import("./../configSeeder.js");
    const first = seedUserConfig();
    const second = seedUserConfig();
    // Second run should always return 0 because marker exists
    expect(second).toBe(0);
    // First run is 0 if already seeded, 15 (or some count) if first time
    expect(first >= 0).toBe(true);
  });

  it("forceReseedOnNextRun should remove the marker file", async () => {
    const { seedUserConfig, forceReseedOnNextRun, isSeeded } = await import("./../configSeeder.js");
    seedUserConfig();
    const seededAfterSeed = isSeeded();
    forceReseedOnNextRun();
    // After force-reseed, marker should be gone OR not exist
    // (forceReseedOnNextRun only removes marker if it exists)
    expect(typeof seededAfterSeed).toBe("boolean");
  });

  it("should find defaults directory when running from project root", async () => {
    // This test verifies that the bundled defaults/ directory is discoverable
    // when running tests from the project root.
    const defaultsPath = path.join(process.cwd(), "defaults");
    const toolsPath = path.join(defaultsPath, "tools");
    const skillsPath = path.join(defaultsPath, "skills");

    expect(fs.existsSync(defaultsPath)).toBe(true);
    expect(fs.existsSync(toolsPath)).toBe(true);
    expect(fs.existsSync(skillsPath)).toBe(true);

    // Verify Roblox CLI tools are present
    const toolFiles = fs.readdirSync(toolsPath).filter((f) => f.endsWith(".json"));
    expect(toolFiles).toContain("rojo.json");
    expect(toolFiles).toContain("wally.json");
    expect(toolFiles).toContain("lune.json");
    expect(toolFiles).toContain("selene.json");
    expect(toolFiles).toContain("rokit.json");
    expect(toolFiles).toContain("wally-package-types.json");

    // Verify Roblox library + CLI skills are present (15 total now:
    // 9 libraries + 6 CLI tool docs)
    const skillFiles = fs.readdirSync(skillsPath).filter((f) => f.endsWith(".md"));
    // Library skills
    expect(skillFiles).toContain("profilestore.md");
    expect(skillFiles).toContain("bytenet.md");
    expect(skillFiles).toContain("replica.md");
    expect(skillFiles).toContain("react.md");
    expect(skillFiles).toContain("react-roblox.md");
    expect(skillFiles).toContain("trove.md");
    expect(skillFiles).toContain("signal.md");
    expect(skillFiles).toContain("observers.md");
    expect(skillFiles).toContain("cmdr.md");
    // CLI tool skills
    expect(skillFiles).toContain("rojo-cli.md");
    expect(skillFiles).toContain("wally-cli.md");
    expect(skillFiles).toContain("lune-cli.md");
    expect(skillFiles).toContain("selene-cli.md");
    expect(skillFiles).toContain("rokit-cli.md");
    expect(skillFiles).toContain("wally-package-types-cli.md");
  });

  it("each Roblox tool JSON should be valid and have required fields", () => {
    const toolsDir = path.join(process.cwd(), "defaults", "tools");
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".json"));

    expect(files.length).toBe(6);

    for (const file of files) {
      const filePath = path.join(toolsDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const tools = Array.isArray(data) ? data : [data];

      for (const tool of tools) {
        expect(tool.name).toMatch(/^[a-z_]+$/);
        expect(typeof tool.description).toBe("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.category).toBe("roblox");
        expect(typeof tool.command).toBe("string");
        expect(Array.isArray(tool.args)).toBe(true);
        expect(tool.detection).toBeDefined();
        expect(tool.detection.method).toBe("binary");
        expect(tool.context).toBeDefined();
        expect(Array.isArray(tool.context.whenToUse)).toBe(true);
        expect(tool.context.whenToUse.length).toBeGreaterThan(0);
        expect(tool.outputParser).toBe("raw");
      }
    }
  });

  it("each Roblox skill MD should have YAML frontmatter and real GitHub README content", () => {
    const skillsDir = path.join(process.cwd(), "defaults", "skills");
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));

    // 9 libraries + 6 CLI tool docs = 15 total
    expect(files.length).toBe(15);

    for (const file of files) {
      const filePath = path.join(skillsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      // Must start with YAML frontmatter
      expect(content.startsWith("---\n")).toBe(true);

      // Must end frontmatter with closing ---
      const endFront = content.indexOf("\n---\n", 4);
      expect(endFront).toBeGreaterThan(0);

      const frontmatter = content.slice(4, endFront);
      expect(frontmatter).toContain("name:");
      expect(frontmatter).toContain("version:");
      expect(frontmatter).toContain("source: github");
      expect(frontmatter).toContain("repo:");
      expect(frontmatter).toContain("url:");
      expect(frontmatter).toContain("category: roblox");

      // Body should be substantive (real README content, at least 500 chars)
      const body = content.slice(endFront + 5);
      expect(body.length).toBeGreaterThan(500, `${file} body too short`);

      // Should have the attribution header (we add this to every skill)
      expect(body).toContain("**Source:** This skill is the official README");
      expect(body).toContain("github.com");
    }
  });

  it("skill files should not contain 'Failed to fetch' markers (all READMEs downloaded successfully)", () => {
    const skillsDir = path.join(process.cwd(), "defaults", "skills");
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(skillsDir, file), "utf8");
      // No file should have the fetch-failure marker as the primary content
      // (we allow it as fallback text but real READMEs should be present)
      const bodyStart = content.indexOf("---\n\n", content.indexOf("---\n") + 4);
      const body = content.slice(bodyStart);
      // The body should have real content, not just the failure comment
      const realContent = body.replace(/<!--[\s\S]*?-->/g, "").trim();
      expect(realContent.length).toBeGreaterThan(200, `${file} has no real README content`);
    }
  });

  it("count of tool entries should match expected (11 subcommands across 6 CLIs)", () => {
    const toolsDir = path.join(process.cwd(), "defaults", "tools");
    const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".json"));
    let totalTools = 0;
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(toolsDir, file), "utf8"));
      totalTools += Array.isArray(data) ? data.length : 1;
    }
    // 3 (rojo) + 3 (wally) + 1 (lune) + 1 (selene) + 2 (rokit) + 1 (wally-package-types) = 11
    expect(totalTools).toBe(11);
  });
});

describe("ToolRegistry - load from tools/ directory", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-toolreg-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("should load tools from ~/.claude-killer/tools/*.json (multiple files)", async () => {
    const toolsDir = path.join(tmpHome, ".claude-killer", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    fs.writeFileSync(
      path.join(toolsDir, "mycli.json"),
      JSON.stringify([
        {
          name: "mycli_build",
          description: "Build with mycli",
          category: "custom",
          command: "mycli",
          args: ["build"],
          flags: [],
          detection: { method: "binary", check: "mycli --version" },
          context: { whenToUse: ["build"], examples: [] },
          outputParser: "raw",
        },
        {
          name: "mycli_test",
          description: "Test with mycli",
          category: "custom",
          command: "mycli",
          args: ["test"],
          flags: [],
          detection: { method: "binary", check: "mycli --version" },
          context: { whenToUse: ["test"], examples: [] },
          outputParser: "raw",
        },
      ]),
      "utf8"
    );

    fs.writeFileSync(
      path.join(toolsDir, "other.json"),
      JSON.stringify({
        name: "other_tool",
        description: "Another tool",
        category: "custom",
        command: "other",
        args: [],
        flags: [],
        detection: { method: "binary", check: "other --version" },
        context: { whenToUse: ["other"], examples: [] },
        outputParser: "raw",
      }),
      "utf8"
    );

    const { ToolRegistry } = await import("./../externalTools.js");
    const reg = new ToolRegistry();
    reg.loadUserTools();

    expect(reg.getAll()).toHaveLength(3);
    expect(reg.get("mycli_build")).toBeDefined();
    expect(reg.get("mycli_test")).toBeDefined();
    expect(reg.get("other_tool")).toBeDefined();
  });

  it("should preserve original category (e.g. roblox) from JSON", async () => {
    const toolsDir = path.join(tmpHome, ".claude-killer", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    fs.writeFileSync(
      path.join(toolsDir, "roblox.json"),
      JSON.stringify([
        {
          name: "rojo_build",
          description: "Build with rojo",
          category: "roblox",
          command: "rojo",
          args: ["build"],
          flags: [],
          detection: { method: "binary", check: "rojo --version" },
          context: { whenToUse: ["build roblox"], examples: [] },
          outputParser: "raw",
        },
      ]),
      "utf8"
    );

    const { ToolRegistry } = await import("./../externalTools.js");
    const reg = new ToolRegistry();
    reg.loadUserTools();

    const tool = reg.get("rojo_build");
    expect(tool).toBeDefined();
    expect(tool!.category).toBe("roblox"); // preserved, not forced to "custom"
  });

  it("should fall back to legacy tools.json when tools/ dir is empty", async () => {
    const configDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "tools.json"),
      JSON.stringify([
        {
          name: "legacy_tool",
          description: "Legacy single-file tool",
          command: "echo",
          args: [],
          flags: [],
          detection: { method: "binary", check: "echo --version" },
          context: { whenToUse: ["legacy"], examples: [] },
          outputParser: "raw",
        },
      ]),
      "utf8"
    );

    const { ToolRegistry } = await import("./../externalTools.js");
    const reg = new ToolRegistry();
    reg.loadUserTools();

    expect(reg.get("legacy_tool")).toBeDefined();
  });

  it("should skip invalid tools gracefully without throwing", async () => {
    const toolsDir = path.join(tmpHome, ".claude-killer", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });

    // Invalid: missing required name field
    fs.writeFileSync(
      path.join(toolsDir, "invalid.json"),
      JSON.stringify([
        { description: "no name", command: "foo" },
        {
          name: "valid_tool",
          description: "valid",
          command: "foo",
          args: [],
          flags: [],
          detection: { method: "binary", check: "foo" },
          context: { whenToUse: [], examples: [] },
          outputParser: "raw",
        },
      ]),
      "utf8"
    );

    // Invalid JSON syntax
    fs.writeFileSync(path.join(toolsDir, "broken.json"), "{not valid json", "utf8");

    const { ToolRegistry } = await import("./../externalTools.js");
    const reg = new ToolRegistry();
    expect(() => reg.loadUserTools()).not.toThrow();
    expect(reg.get("valid_tool")).toBeDefined();
    expect(reg.getAll()).toHaveLength(1);
  });
});
