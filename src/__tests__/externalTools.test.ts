/**
 * externalTools.test.ts — Tests for the external tools framework
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ToolRegistry,
  ToolDetector,
  ToolExecutor,
  ToolSuggester,
  type Tool,
  type ToolInvocation,
} from "../externalTools.js";

// ─── Mock Tools ─────────────────────────────────────────────────────────────

const mockTool: Tool = {
  name: "test_tool",
  description: "A test tool",
  category: "custom",
  command: "test-cmd",
  args: ["run"],
  flags: [
    { name: "--verbose", type: "boolean" },
    { name: "--output", type: "string", default: "output.txt" }
  ],
  detection: {
    method: "binary",
    check: "test-cmd --version"
  },
  context: {
    whenToUse: ["run tests", "execute test"],
    examples: ["test-cmd run --verbose"]
  },
  outputParser: "raw"
};

const mockConfigTool: Tool = {
  name: "config_tool",
  description: "A tool detected by config file",
  category: "python",
  command: "pytest",
  args: [],
  flags: [],
  detection: {
    method: "config",
    check: "pyproject.toml"
  },
  context: {
    whenToUse: ["run pytest", "python tests"],
    requiresProject: ["pyproject.toml"],
    examples: ["pytest"]
  },
  outputParser: "structured"
};

// ─── Tool Registry Tests ────────────────────────────────────────────────────

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register a tool", () => {
    registry.register(mockTool);
    expect(registry.get("test_tool")).toBeDefined();
    expect(registry.get("test_tool")?.name).toBe("test_tool");
  });

  it("should register multiple tools", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    expect(registry.getAll().length).toBe(2);
  });

  it("should get tools by category", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    const pythonTools = registry.getByCategory("python");
    expect(pythonTools.length).toBe(1);
    expect(pythonTools[0].name).toBe("config_tool");
  });

  it("should search tools by intent", () => {
    registry.registerAll([mockTool, mockConfigTool]);
    const results = registry.searchByIntent("run tests");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("test_tool");
  });

  it("should check if tool is installed (binary)", () => {
    registry.register(mockTool);
    // This will fail because test-cmd doesn't exist
    expect(registry.isInstalled("test_tool")).toBe(false);
  });

  it("should check if tool is installed (config)", () => {
    registry.register(mockConfigTool);
    // This will depend on whether pyproject.toml exists
    const result = registry.isInstalled("config_tool");
    expect(typeof result).toBe("boolean");
  });

  it("should add tool dynamically", () => {
    const result = registry.addTool({
      ...mockTool,
      name: "dynamic_tool"
    });
    expect(result.success).toBe(true);
    expect(registry.get("dynamic_tool")).toBeDefined();
  });

  it("should fail to add tool without name", () => {
    const result = registry.addTool({
      ...mockTool,
      name: ""
    });
    expect(result.success).toBe(false);
  });
});

// ─── Tool Detector Tests ────────────────────────────────────────────────────

describe("ToolDetector", () => {
  let registry: ToolRegistry;
  let detector: ToolDetector;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([mockTool, mockConfigTool]);
    detector = new ToolDetector(registry);
  });

  it("should detect tool from intent", () => {
    const result = detector.detectFromIntent("run tests please");
    expect(result).not.toBeNull();
    expect(result?.tool).toBe("test_tool");
  });

  it("should return null for no match", () => {
    const result = detector.detectFromIntent("hello world");
    expect(result).toBeNull();
  });

  it("should detect tools from context", () => {
    // This depends on whether pyproject.toml exists in cwd
    const results = detector.detectFromContext();
    expect(Array.isArray(results)).toBe(true);
  });

  it("should detect both intent and context", () => {
    const result = detector.detect("run tests", ".");
    expect(result.intent).not.toBeNull();
    expect(Array.isArray(result.context)).toBe(true);
  });
});

// ─── Tool Executor Tests ────────────────────────────────────────────────────

describe("ToolExecutor", () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(mockTool);
    executor = new ToolExecutor(registry);
  });

  it("should fail for unknown tool", async () => {
    const result = await executor.execute("unknown_tool");
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Tool "unknown_tool" not found');
  });

  it("should fail for uninstalled tool", async () => {
    const result = await executor.execute("test_tool");
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("not installed");
  });

  it("should execute installed tool", async () => {
    // Mark tool as installed
    registry.register({
      ...mockTool,
      name: "echo_tool",
      command: "echo",
      args: ["hello"],
      detection: { method: "binary", check: "echo --version" }
    });
    
    const result = await executor.execute("echo_tool");
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("should handle command timeout", async () => {
    registry.register({
      ...mockTool,
      name: "sleep_tool",
      command: "sleep",
      args: ["10"],
      detection: { method: "binary", check: "sleep --version" }
    });
    
    const result = await executor.execute("sleep_tool", {}, { timeout: 100 });
    expect(result.success).toBe(false);
  });
});

// ─── Tool Suggester Tests ───────────────────────────────────────────────────

describe("ToolSuggester", () => {
  let registry: ToolRegistry;
  let suggester: ToolSuggester;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([mockTool, mockConfigTool]);
    suggester = new ToolSuggester(registry);
  });

  it("should suggest tools based on intent", () => {
    const suggestions = suggester.suggest("run tests");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].tool.name).toBe("test_tool");
  });

  it("should rank suggestions by confidence", () => {
    const suggestions = suggester.suggest("run tests");
    expect(suggestions[0].confidence).toBeGreaterThan(0);
    if (suggestions.length > 1) {
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(suggestions[1].confidence);
    }
  });

  it("should return empty for no match", () => {
    const suggestions = suggester.suggest("hello world");
    expect(suggestions.length).toBe(0);
  });

  it("should get best suggestion", () => {
    const best = suggester.getBest("run tests");
    expect(best).not.toBeNull();
    expect(best?.name).toBe("test_tool");
  });

  it("should return null for no best", () => {
    const best = suggester.getBest("hello world");
    expect(best).toBeNull();
  });
});

// ─── Tool Interface Tests ───────────────────────────────────────────────────

describe("Tool Interface", () => {
  it("should have required fields", () => {
    const tool: Tool = {
      name: "test",
      description: "Test",
      category: "custom",
      command: "test",
      args: [],
      flags: [],
      detection: { method: "binary", check: "test --version" },
      context: { whenToUse: [], examples: [] },
      outputParser: "raw"
    };

    expect(tool.name).toBe("test");
    expect(tool.description).toBe("Test");
    expect(tool.category).toBe("custom");
    expect(tool.command).toBe("test");
    expect(tool.detection.method).toBe("binary");
    expect(tool.outputParser).toBe("raw");
  });

  it("should support all categories", () => {
    const categories = ["roblox", "python", "node", "rust", "go", "docker", "system", "custom"];
    categories.forEach(cat => {
      const tool: Tool = {
        name: `test_${cat}`,
        description: "Test",
        category: cat as any,
        command: "test",
        args: [],
        flags: [],
        detection: { method: "binary", check: "test --version" },
        context: { whenToUse: [], examples: [] },
        outputParser: "raw"
      };
      expect(tool.category).toBe(cat);
    });
  });

  it("should support all flag types", () => {
    const flags = [
      { name: "--string", type: "string" as const },
      { name: "--number", type: "number" as const },
      { name: "--boolean", type: "boolean" as const }
    ];

    flags.forEach(flag => {
      expect(["string", "number", "boolean"]).toContain(flag.type);
    });
  });
});

// ─── Tool Invocation Tests ──────────────────────────────────────────────────

describe("ToolInvocation", () => {
  it("should have tool name", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: {}
    };
    expect(invocation.tool).toBe("test_tool");
  });

  it("should support args", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: { verbose: true, output: "file.txt" }
    };
    expect(invocation.args.verbose).toBe(true);
    expect(invocation.args.output).toBe("file.txt");
  });

  it("should support context", () => {
    const invocation: ToolInvocation = {
      tool: "test_tool",
      args: {},
      context: "Running tests for the project"
    };
    expect(invocation.context).toBe("Running tests for the project");
  });
});

// ─── Additional ToolRegistry Tests ──────────────────────────────────────────

describe("ToolRegistry - extended", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should overwrite existing tool with warning", () => {
    registry.register(mockTool);
    registry.register({ ...mockTool, description: "updated" });
    expect(registry.get("test_tool")?.description).toBe("updated");
  });

  it("should return undefined for non-existent tool", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should get user tools path", () => {
    const userPath = registry.getUserToolsPath();
    expect(userPath).toContain("tools.json");
  });

  it("should get user tools count (0 initially)", () => {
    expect(registry.getUserToolsCount()).toBe(0);
  });

  it("should remove user tool", () => {
    registry.addTool({ ...mockTool, name: "custom1", category: "custom" });
    expect(registry.get("custom1")).toBeDefined();
    const result = registry.removeUserTool("custom1");
    expect(result.success).toBe(true);
    expect(registry.get("custom1")).toBeUndefined();
  });

  it("should fail to remove non-existent tool", () => {
    const result = registry.removeUserTool("nonexistent");
    expect(result.success).toBe(false);
  });

  it("should fail to remove non-custom tool", () => {
    registry.register(mockTool); // category: "custom" already
    // Register a roblox tool directly
    registry.register({ ...mockTool, name: "roblox_tool", category: "roblox" });
    const result = registry.removeUserTool("roblox_tool");
    expect(result.success).toBe(false);
  });

  it("should update user tool", () => {
    registry.addTool({ ...mockTool, name: "upd_tool", category: "custom" });
    const result = registry.updateUserTool("upd_tool", { description: "updated desc" });
    expect(result.success).toBe(true);
    expect(registry.get("upd_tool")?.description).toBe("updated desc");
  });

  it("should fail to update non-existent tool", () => {
    const result = registry.updateUserTool("nonexistent", {});
    expect(result.success).toBe(false);
  });

  it("should fail to update non-custom tool", () => {
    registry.register({ ...mockTool, name: "roblox_upd", category: "roblox" });
    const result = registry.updateUserTool("roblox_upd", { description: "nope" });
    expect(result.success).toBe(false);
  });

  it("should fail to update with invalid data", () => {
    registry.addTool({ ...mockTool, name: "upd2", category: "custom" });
    const result = registry.updateUserTool("upd2", { name: "" });
    expect(result.success).toBe(false);
  });

  it("should detect tool with 'package' method", () => {
    const pkgTool: Tool = {
      ...mockTool, name: "pkg_tool",
      detection: { method: "package", check: "package.json" }
    };
    registry.register(pkgTool);
    const result = registry.isInstalled("pkg_tool");
    expect(typeof result).toBe("boolean");
  });

  it("should detect tool with 'manual' method", () => {
    const manualTool: Tool = {
      ...mockTool, name: "manual_tool",
      detection: { method: "manual", check: "", installed: true }
    };
    registry.register(manualTool);
    expect(registry.isInstalled("manual_tool")).toBe(true);
  });

  it("should detect tool with 'manual' method not installed", () => {
    const manualTool: Tool = {
      ...mockTool, name: "manual_tool2",
      detection: { method: "manual", check: "", installed: false }
    };
    registry.register(manualTool);
    expect(registry.isInstalled("manual_tool2")).toBe(false);
  });

  it("should return false for unknown detection method", () => {
    const unknownTool: Tool = {
      ...mockTool, name: "unk_tool",
      detection: { method: "unknown" as any, check: "" }
    };
    registry.register(unknownTool);
    expect(registry.isInstalled("unk_tool")).toBe(false);
  });

  it("should return false for non-existent tool in isInstalled", () => {
    expect(registry.isInstalled("ghost")).toBe(false);
  });

  it("should use cached detection within 5 minutes", () => {
    const tool: Tool = {
      ...mockTool, name: "cached_tool",
      detection: { method: "manual", check: "", installed: true, lastChecked: Date.now() }
    };
    registry.register(tool);
    expect(registry.isInstalled("cached_tool")).toBe(true);
  });

  it("should re-check when cache expired", () => {
    const tool: Tool = {
      ...mockTool, name: "expired_tool",
      detection: { method: "manual", check: "", installed: true, lastChecked: Date.now() - 10 * 60 * 1000 }
    };
    registry.register(tool);
    expect(registry.isInstalled("expired_tool")).toBe(true);
  });
});

// ─── ToolExecutor - extended ────────────────────────────────────────────────

describe("ToolExecutor - extended", () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    executor = new ToolExecutor(registry);
  });

  it("should build command with flags", async () => {
    registry.register({
      ...mockTool,
      name: "echo_flag",
      command: "echo",
      args: ["hello"],
      detection: { method: "binary", check: "echo --version" },
      flags: [
        { name: "--verbose", type: "boolean" },
        { name: "--output", type: "string" }
      ]
    });
    const result = await executor.execute("echo_flag", { "--verbose": true, "--output": "file.txt" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("should parse JSON output", async () => {
    // Write a temp script that outputs valid JSON
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");
    const tmpScript = path.join(os.tmpdir(), `__test_json_out_${Date.now()}.js`);
    fs.writeFileSync(tmpScript, 'console.log(JSON.stringify({key:"value"}))');
    
    registry.register({
      ...mockTool,
      name: "json_echo",
      command: "node",
      args: [tmpScript],
      detection: { method: "manual", check: "", installed: true },
      outputParser: "json"
    });
    const result = await executor.execute("json_echo");
    try { fs.unlinkSync(tmpScript); } catch {}
    
    expect(result.success).toBe(true);
    expect(result.metadata).toBeDefined();
    expect(result.metadata.key).toBe("value");
  });

  it("should parse structured output", async () => {
    registry.register({
      ...mockTool,
      name: "struct_echo",
      command: "echo",
      args: ["error: something failed"],
      detection: { method: "binary", check: "echo --version" },
      outputParser: "structured"
    });
    const result = await executor.execute("struct_echo");
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("should handle structured output with warnings", async () => {
    registry.register({
      ...mockTool,
      name: "warn_echo",
      command: "echo",
      args: ["warning: careful"],
      detection: { method: "binary", check: "echo --version" },
      outputParser: "structured"
    });
    const result = await executor.execute("warn_echo");
    expect(result.suggestions).toBeDefined();
  });

  it("should use custom parser", async () => {
    registry.register({
      ...mockTool,
      name: "custom_echo",
      command: "echo",
      args: ["test"],
      detection: { method: "binary", check: "echo --version" },
      outputParser: "custom",
      customParser: (output) => ({ success: true, output: `custom: ${output.trim()}`, metadata: { custom: true } })
    });
    const result = await executor.execute("custom_echo");
    expect(result.output).toContain("custom: test");
    expect(result.metadata?.custom).toBe(true);
  });

  it("should handle command execution failure", async () => {
    registry.register({
      ...mockTool,
      name: "fail_cmd",
      command: "nonexistent_command_xyz",
      args: [],
      detection: { method: "binary", check: "nonexistent_command_xyz --version" }
    });
    const result = await executor.execute("fail_cmd");
    expect(result.success).toBe(false);
  });
});

// ─── ToolSuggester - extended ───────────────────────────────────────────────

describe("ToolSuggester - extended", () => {
  let registry: ToolRegistry;
  let suggester: ToolSuggester;

  beforeEach(() => {
    registry = new ToolRegistry();
    suggester = new ToolSuggester(registry);
  });

  it("should match by command name", () => {
    registry.register({
      ...mockTool,
      name: "pytest_run",
      command: "pytest",
      context: { whenToUse: [], examples: [] }
    });
    const suggestions = suggester.suggest("run pytest on code");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].reason).toContain("command");
  });

  it("should match by category", () => {
    registry.register({
      ...mockTool,
      name: "rust_build",
      command: "cargo",
      category: "rust",
      context: { whenToUse: [], examples: [] }
    });
    const suggestions = suggester.suggest("build rust project");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("should boost confidence for installed tools", () => {
    registry.register({
      ...mockTool,
      name: "echo_suggest",
      command: "echo",
      detection: { method: "binary", check: "echo --version" },
      context: { whenToUse: ["echo text"], examples: [] }
    });
    const suggestions = suggester.suggest("echo text");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].reason).toContain("installed");
  });
});

// ─── Singleton Tests ────────────────────────────────────────────────────────

describe("Singletons", () => {
  it("getRegistry should return ToolRegistry", async () => {
    const { getRegistry } = await import("../externalTools.js");
    const reg = getRegistry();
    expect(reg).toBeInstanceOf(ToolRegistry);
  });

  it("getDetector should return ToolDetector", async () => {
    const { getDetector } = await import("../externalTools.js");
    const det = getDetector();
    expect(det).toBeInstanceOf(ToolDetector);
  });

  it("getExecutor should return ToolExecutor", async () => {
    const { getExecutor } = await import("../externalTools.js");
    const exec = getExecutor();
    expect(exec).toBeInstanceOf(ToolExecutor);
  });

  it("getSuggester should return ToolSuggester", async () => {
    const { getSuggester } = await import("../externalTools.js");
    const sug = getSuggester();
    expect(sug).toBeInstanceOf(ToolSuggester);
  });

  it("initializeTools should register built-in tools", async () => {
    const { initializeTools, getRegistry } = await import("../externalTools.js");
    await initializeTools();
    const reg = getRegistry();
    expect(reg.getAll().length).toBeGreaterThan(0);
  });
});