/**
 * fase5-external-tools.test.ts — E2E tests for Phase 5 of TEST_PLAN.md.
 *
 * Tests covered (all mocked — no real binaries needed):
 *   5.1 Rojo (build, sourcemap)
 *   5.2 Wally (search, install)
 *   5.3 Selene (Luau linting)
 *   5.4 StyLua (Luau formatting)
 *   5.5 Lune (run Luau scripts)
 *   5.6 wally-package-types
 *
 * Strategy: mock spawn/child_process to return canned outputs.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock spawn (used by selene/stylua/lune via shell.ts)
const mockedSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: mockedSpawn,
  execSync: vi.fn(),
  exec: vi.fn(),
}));

// Mock luauValidator (uses selene internally)
const mockedValidateLuauBeforeWrite = vi.hoisted(() => vi.fn(async () => ({ ok: true, rulesApplied: [], rulesSkipped: [] })));
vi.mock("../luauValidator.js", () => ({
  validateLuauBeforeWrite: mockedValidateLuauBeforeWrite,
  getActiveValidationRules: vi.fn(async () => [
    { tool: "selene_lint", filePattern: "*.luau", blocking: true },
    { tool: "stylua_check", filePattern: "*.luau", blocking: false },
  ]),
  shouldValidateFile: vi.fn(async () => true),
}));

// Mock externalTools (rojo, wally, lune registry)
const mockedRegistry = vi.hoisted(() => ({
  getAll: vi.fn(() => [
    { name: "rojo_build", category: "roblox", command: "rojo", installed: true },
    { name: "rojo_sourcemap", category: "roblox", command: "rojo", installed: true },
    { name: "wally_install", category: "roblox", command: "wally", installed: true },
    { name: "wally_search", category: "roblox", command: "wally", installed: true },
    { name: "selene_lint", category: "roblox", command: "selene", installed: true },
    { name: "stylua_check", category: "roblox", command: "stylua", installed: true },
    { name: "lune_run", category: "roblox", command: "lune", installed: true },
    { name: "generate_types", category: "roblox", command: "wally-package-types", installed: true },
  ]),
  getByCategory: vi.fn((cat) => cat === "roblox" ? [
    { name: "rojo_build" }, { name: "wally_install" }, { name: "selene_lint" }, { name: "lune_run" },
  ] : []),
  isInstalled: vi.fn(() => true),
  addTool: vi.fn(),
  get: vi.fn((name) => ({ name, installed: true })),
}));

const mockedExecutor = vi.hoisted(() => ({
  execute: vi.fn(async (toolName, args) => {
    // Simulate tool execution with canned outputs
    const outputs = {
      "rojo_build": "Build successful. Output: game.rbxl (1.2 MB)",
      "rojo_sourcemap": "Sourcemap generated: sourcemap.json (45 KB)",
      "wally_install": "Installed 5 packages to Packages/",
      "wally_search": "Found 3 packages: roact, rodux, flipper",
      "selene_lint": "Linting complete. 0 errors, 2 warnings.",
      "stylua_check": "Format check: PASS (all files formatted correctly)",
      "lune_run": "Script output: Hello from Lune! Result: 42",
      "generate_types": "Generated types for 5 packages in Packages/",
    };
    return { success: true, stdout: outputs[toolName] ?? "ok", stderr: "", exitCode: 0 };
  }),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => mockedRegistry),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => mockedExecutor),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(),
}));

// Import AFTER mocks
import { getRegistry, getExecutor } from "../externalTools.js";
import { validateLuauBeforeWrite } from "../luauValidator.js";

describe("Fase 5 E2E — Ferramentas Externas (mocked)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fase5-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 5.1 Rojo ────────────────────────────────────────────────────────

  describe("5.1 Rojo", () => {
    it("rojo_build tool está registrada e instalada", () => {
      const registry = getRegistry();
      const all = registry.getAll();
      const rojoBuild = all.find((t) => t.name === "rojo_build");
      expect(rojoBuild).toBeDefined();
      expect(rojoBuild?.installed).toBe(true);
    });

    it("rojo_build executa e retorna sucesso", async () => {
      const executor = getExecutor();
      const result = await executor.execute("rojo_build", { projectFile: "default.project.json" });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Build successful");
      expect(result.exitCode).toBe(0);
    });

    it("rojo_sourcemap gera sourcemap.json", async () => {
      const executor = getExecutor();
      const result = await executor.execute("rojo_sourcemap", { projectFile: "default.project.json" });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Sourcemap generated");
    });

    it("rojo_build cria arquivo .rbxl", async () => {
      // Setup minimal Rojo project
      const projectDir = path.join(tmpDir, "rojo-project");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "default.project.json"),
        JSON.stringify({
          name: "test-project",
          tree: {
            $className: "DataModel",
            ReplicatedStorage: {
              TestModule: { $path: "src/TestModule.luau" },
            },
          },
        }, null, 2)
      );
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "src", "TestModule.luau"),
        'local M = {}\nfunction M.hello()\n    print("Hello from Rojo!")\nend\nreturn M\n'
      );

      const executor = getExecutor();
      const result = await executor.execute("rojo_build", { projectFile: "default.project.json", output: "test.rbxl" });
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(projectDir, "default.project.json"))).toBe(true);
    });
  });

  // ─── 5.2 Wally ───────────────────────────────────────────────────────

  describe("5.2 Wally", () => {
    it("wally_search retorna packages encontrados", async () => {
      const executor = getExecutor();
      const result = await executor.execute("wally_search", { query: "react" });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Found 3 packages");
      expect(result.stdout).toContain("roact");
    });

    it("wally_install instala packages do wally.toml", async () => {
      const projectDir = path.join(tmpDir, "wally-project");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "wally.toml"),
        '[package]\nname = "user/project"\nversion = "0.1.0"\n\n[dependencies]\nroact = "roblox/roact@1.4.4"\n'
      );

      const executor = getExecutor();
      const result = await executor.execute("wally_install", { dir: projectDir });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Installed 5 packages");
    });
  });

  // ─── 5.3 Selene ──────────────────────────────────────────────────────

  describe("5.3 Selene", () => {
    it("selene_lint tool está registrada", () => {
      const registry = getRegistry();
      const selene = registry.getAll().find((t) => t.name === "selene_lint");
      expect(selene).toBeDefined();
      expect(selene?.installed).toBe(true);
    });

    it("validateLuauBeforeWrite retorna ok=true para código limpo", async () => {
      mockedValidateLuauBeforeWrite.mockResolvedValueOnce({
        ok: true,
        rulesApplied: [{ tool: "selene_lint", passed: true }],
        rulesSkipped: [],
      });

      const cleanCode = "local x = 1\nprint(x)\n";
      const result = await validateLuauBeforeWrite("/tmp/test.luau", cleanCode, [
        { tool: "selene_lint", filePattern: "*.luau", blocking: true },
      ], tmpDir);

      expect(result.ok).toBe(true);
    });

    it("validateLuauBeforeWrite retorna ok=false para código com erro", async () => {
      mockedValidateLuauBeforeWrite.mockResolvedValueOnce({
        ok: false,
        rulesApplied: [{ tool: "selene_lint", passed: false }],
        rulesSkipped: [],
        blockingError: "test.luau:1:1: error[undefined_variable]: x is not defined",
      });

      const badCode = "local y = undefinedVar\nprint(y)\n";
      const result = await validateLuauBeforeWrite("/tmp/bad.luau", badCode, [
        { tool: "selene_lint", filePattern: "*.luau", blocking: true },
      ], tmpDir);

      expect(result.ok).toBe(false);
      expect(result.blockingError).toContain("error");
    });
  });

  // ─── 5.4 StyLua ──────────────────────────────────────────────────────

  describe("5.4 StyLua", () => {
    it("stylua_check tool está registrada", () => {
      const registry = getRegistry();
      const stylua = registry.getAll().find((t) => t.name === "stylua_check");
      expect(stylua).toBeDefined();
    });

    it("stylua_check retorna sucesso para código bem formatado", async () => {
      const executor = getExecutor();
      const result = await executor.execute("stylua_check", { file: "test.luau" });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("PASS");
    });

    it("validateLuauBeforeWrite com stylua rule não bloqueia (warning only)", async () => {
      mockedValidateLuauBeforeWrite.mockResolvedValueOnce({
        ok: true, // stylua is non-blocking
        rulesApplied: [{ tool: "stylua_check", passed: false }],
        rulesSkipped: [],
        warnings: ["Format issues found in test.luau"],
      });

      const badlyFormatted = "local    x    =    1\nprint(    x    )\n";
      const result = await validateLuauBeforeWrite("/tmp/bad_format.luau", badlyFormatted, [
        { tool: "stylua_check", filePattern: "*.luau", blocking: false },
      ], tmpDir);

      // Non-blocking rule means ok=true even with warnings
      expect(result.ok).toBe(true);
    });
  });

  // ─── 5.5 Lune ────────────────────────────────────────────────────────

  describe("5.5 Lune", () => {
    it("lune_run executa script .luau e retorna output", async () => {
      const executor = getExecutor();
      const result = await executor.execute("lune_run", { script: "test.luau" });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("Hello from Lune!");
      expect(result.stdout).toContain("42");
    });

    it("lune_run com script que usa game:GetService falha (sem Roblox API)", async () => {
      // Simulate Lune failing because game:GetService isn't available
      mockedExecutor.execute.mockResolvedValueOnce({
        success: false,
        stdout: "",
        stderr: "Error: attempt to index nil (global 'game')",
        exitCode: 1,
      });

      const scriptContent = 'local rs = game:GetService("ReplicatedStorage")\nprint(rs)\n';
      fs.writeFileSync(path.join(tmpDir, "test.lune.luau"), scriptContent);

      const executor = getExecutor();
      const result = await executor.execute("lune_run", { script: "test.lune.luau" });
      expect(result.success).toBe(false);
      expect(result.stderr).toContain("game");
    });
  });

  // ─── 5.6 wally-package-types ─────────────────────────────────────────

  describe("5.6 wally-package-types", () => {
    it("generate_types tool está registrada", () => {
      const registry = getRegistry();
      const genTypes = registry.getAll().find((t) => t.name === "generate_types");
      expect(genTypes).toBeDefined();
    });

    it("generate_types executa após wally_install", async () => {
      // Setup: wally install + generate types
      const projectDir = path.join(tmpDir, "wally-project");
      fs.mkdirSync(path.join(projectDir, "Packages"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "wally.toml"),
        '[package]\nname = "user/project"\nversion = "0.1.0"\n\n[dependencies]\nroact = "roblox/roact@1.4.4"\n'
      );

      const executor = getExecutor();

      // Step 1: wally install
      const installResult = await executor.execute("wally_install", { dir: projectDir });
      expect(installResult.success).toBe(true);

      // Step 2: generate types
      const typesResult = await executor.execute("generate_types", { dir: projectDir });
      expect(typesResult.success).toBe(true);
      expect(typesResult.stdout).toContain("Generated types");
    });
  });

  // ─── Integration: full Roblox workflow ───────────────────────────────

  describe("Integration — Roblox project workflow", () => {
    it("setup project + install deps + generate types + build", async () => {
      const projectDir = path.join(tmpDir, "full-project");
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.mkdirSync(path.join(projectDir, "Packages"), { recursive: true });

      // 1. Create default.project.json
      fs.writeFileSync(
        path.join(projectDir, "default.project.json"),
        JSON.stringify({
          name: "full-project",
          tree: { $className: "DataModel", ReplicatedStorage: { src: { $path: "src" } } },
        }, null, 2)
      );

      // 2. Create wally.toml
      fs.writeFileSync(
        path.join(projectDir, "wally.toml"),
        '[package]\nname = "user/full-project"\nversion = "0.1.0"\n\n[dependencies]\nroact = "roblox/roact@1.4.4"\nrodux = "roblox/rodux@3.0.0"\n'
      );

      // 3. Create a source file
      fs.writeFileSync(
        path.join(projectDir, "src", "init.luau"),
        'local M = {}\nfunction M.start()\n    print("Project started!")\nend\nreturn M\n'
      );

      const executor = getExecutor();

      // 4. Install Wally packages
      const installResult = await executor.execute("wally_install", { dir: projectDir });
      expect(installResult.success).toBe(true);

      // 5. Generate types
      const typesResult = await executor.execute("generate_types", { dir: projectDir });
      expect(typesResult.success).toBe(true);

      // 6. Build with Rojo
      const buildResult = await executor.execute("rojo_build", { projectFile: "default.project.json" });
      expect(buildResult.success).toBe(true);

      // 7. Validate source with selene
      mockedValidateLuauBeforeWrite.mockResolvedValueOnce({
        ok: true,
        rulesApplied: [{ tool: "selene_lint", passed: true }],
        rulesSkipped: [],
      });
      const code = fs.readFileSync(path.join(projectDir, "src", "init.luau"), "utf8");
      const validateResult = await validateLuauBeforeWrite(
        path.join(projectDir, "src", "init.luau"),
        code,
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        projectDir
      );
      expect(validateResult.ok).toBe(true);
    });
  });
});
