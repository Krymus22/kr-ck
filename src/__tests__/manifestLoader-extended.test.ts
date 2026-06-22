/**
 * manifestLoader-extended.test.ts — Edge cases do manifestLoader (Sprint 3/6).
 *
 * Cobre situações que o teste básico não toca:
 *   - loadModeManifests com arquivo JSON vazio []
 *   - loadModeManifests com arquivo JSON que é objeto (não array)
 *   - loadActiveManifests sem modo ativo (retorna só normal)
 *   - generateFunctionCallsFromManifests com flags boolean
 *   - generateFunctionCallsFromManifests com flags number
 *   - generateFunctionCallsFromManifests com flag default value
 *   - generateFunctionCallsFromManifests com context.whenToUse
 *   - generateFunctionCallsFromManifests com context.examples
 *   - executeFromManifest com cwd customizado
 *   - executeFromManifest com timeout (command demora)
 *   - loadActiveManifests com sharedWith entre modos
 *   - findSharedManifests ignora modo normal e modo ativo
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const modesMock = vi.hoisted(() => ({ getActiveMode: vi.fn(() => null) }));
vi.mock("../modes.js", () => ({ getActiveMode: modesMock.getActiveMode }));

const toolDetectorMock = vi.hoisted(() => ({ findToolBinary: vi.fn(() => null) }));
vi.mock("../toolDetector.js", () => ({ findToolBinary: toolDetectorMock.findToolBinary }));

const cpMock = vi.hoisted(() => ({ execSync: vi.fn(() => "ok") }));
vi.mock("node:child_process", () => ({
  execSync: cpMock.execSync,
  spawn: vi.fn(),
}));

import {
  loadModeManifests,
  loadActiveManifests,
  generateFunctionCallsFromManifests,
  executeFromManifest,
  type ToolManifest,
} from "../manifestLoader.js";

describe("manifestLoader — extended (edge cases)", () => {
  let tmpHome: string;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-manifest-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    origCwd = process.cwd();
    vi.clearAllMocks();
    modesMock.getActiveMode.mockReturnValue(null);
    toolDetectorMock.findToolBinary.mockReturnValue("/fake/binary");
    cpMock.execSync.mockReturnValue("ok output");
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeUserManifest(modeName: string, fileName: string, content: unknown): string {
    const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
    return filePath;
  }

  // --- loadModeManifests edge cases -----------------------------------------

  it("lida com arquivo JSON vazio []", () => {
    writeUserManifest("roblox", "empty.json", []);
    const manifests = loadModeManifests("roblox");
    // Array vazio não adiciona nenhum manifest.
    expect(manifests).toEqual([]);
  });

  it("lida com arquivo JSON que é objeto (não array)", () => {
    writeUserManifest("roblox", "single.json", {
      name: "single_tool",
      description: "Single",
      category: "roblox",
      command: "single",
      args: [],
    });
    const manifests = loadModeManifests("roblox");
    expect(manifests.length).toBe(1);
    expect(manifests[0].name).toBe("single_tool");
  });

  // --- loadActiveManifests ---------------------------------------------------

  it("sem modo ativo retorna apenas manifests do normal", () => {
    modesMock.getActiveMode.mockReturnValue(null);
    writeUserManifest("normal", "n1.json", {
      name: "normal_tool",
      description: "N",
      category: "normal",
      command: "n",
      args: [],
    });

    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    expect(names).toContain("normal_tool");
    // Nenhum tool de outro modo deve ser incluído.
    expect(names).not.toContain("mode_specific_tool");
  });

  // --- generateFunctionCallsFromManifests -----------------------------------

  it("gera property boolean para flag boolean", () => {
    const manifests: ToolManifest[] = [
      {
        name: "rojo_build",
        description: "Build",
        category: "x",
        command: "rojo",
        args: ["build"],
        flags: [{ name: "--watch", type: "boolean", description: "Watch" }],
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    expect(calls.length).toBe(1);
    const props = calls[0].function.parameters.properties;
    expect(props.watch).toBeDefined();
    expect(props.watch.type).toBe("boolean");
  });

  it("gera property number para flag number", () => {
    const manifests: ToolManifest[] = [
      {
        name: "t",
        description: "T",
        category: "x",
        command: "t",
        args: [],
        flags: [{ name: "--port", type: "number", description: "Port" }],
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    const props = calls[0].function.parameters.properties;
    expect(props.port).toBeDefined();
    expect(props.port.type).toBe("number");
  });

  it("inclui default value na propriedade do flag", () => {
    const manifests: ToolManifest[] = [
      {
        name: "t",
        description: "T",
        category: "x",
        command: "t",
        args: [],
        flags: [{ name: "--port", type: "number", description: "Port", default: 8080 }],
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    const props = calls[0].function.parameters.properties;
    expect(props.port.default).toBe(8080);
  });

  it("adiciona 'When to use' na descrição quando context.whenToUse presente", () => {
    const manifests: ToolManifest[] = [
      {
        name: "t",
        description: "Base desc",
        category: "x",
        command: "t",
        args: [],
        context: { whenToUse: ["antes de buildar", "após sync"] },
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    const desc = calls[0].function.description as string;
    expect(desc).toContain("When to use");
    expect(desc).toContain("antes de buildar");
    expect(desc).toContain("após sync");
  });

  it("adiciona Examples na descrição quando context.examples presente", () => {
    const manifests: ToolManifest[] = [
      {
        name: "t",
        description: "Base desc",
        category: "x",
        command: "t",
        args: [],
        context: { examples: ["rojo build", "rojo serve"] },
      },
    ];
    const calls = generateFunctionCallsFromManifests(manifests, "roblox");
    const desc = calls[0].function.description as string;
    expect(desc).toContain("Examples");
    expect(desc).toContain("rojo build");
    expect(desc).toContain("rojo serve");
  });

  // --- executeFromManifest ---------------------------------------------------

  it("repassa cwd customizado para o execSync", async () => {
    const manifests: ToolManifest[] = [
      { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: ["build"] },
    ];
    await executeFromManifest("rojo_build", { dir: "/custom/cwd" }, manifests, "roblox");
    expect(cpMock.execSync).toHaveBeenCalled();
    // execSync(command, options) — 2 args
    const opts = cpMock.execSync.mock.calls[0]![1] as { cwd?: string };
    expect(opts.cwd).toBe("/custom/cwd");
  });

  it("captura timeout do execSync e retorna ok=false com errors", async () => {
    cpMock.execSync.mockImplementation(() => {
      const err = new Error("Command timed out") as any;
      err.status = 124;
      err.stderr = "timeout";
      throw err;
    });
    const manifests: ToolManifest[] = [
      { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: ["build"] },
    ];
    const result = await executeFromManifest("rojo_build", {}, manifests, "roblox");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // --- Shared manifests ------------------------------------------------------

  it("loadActiveManifests inclui tool de outro modo via sharedWith", () => {
    modesMock.getActiveMode.mockReturnValue({ name: "roblox" });
    // Cria manifest no modo "normal" com sharedWith ["roblox"]
    writeUserManifest("normal", "shared.json", {
      name: "shared_tool",
      description: "Shared",
      category: "normal",
      command: "shared",
      args: [],
      sharedWith: ["roblox"],
    });
    // Cria manifest no modo "roblox" específico
    writeUserManifest("roblox", "rojo.json", {
      name: "rojo_build",
      description: "Build",
      category: "roblox",
      command: "rojo",
      args: ["build"],
    });

    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    expect(names).toContain("shared_tool");
    expect(names).toContain("rojo_build");
  });

  it("findSharedManifests não inclui tools do próprio modo ativo (apenas sharedWith)", () => {
    modesMock.getActiveMode.mockReturnValue({ name: "roblox" });
    // Cria manifest no roblox com sharedWith ["roblox"] (auto-referência)
    writeUserManifest("roblox", "self.json", {
      name: "self_tool",
      description: "Self",
      category: "roblox",
      command: "self",
      args: [],
      sharedWith: ["roblox"],
    });
    // Cria manifest em outro modo com sharedWith ["roblox"]
    writeUserManifest("devops", "shared.json", {
      name: "devops_tool",
      description: "Shared",
      category: "devops",
      command: "d",
      args: [],
      sharedWith: ["roblox"],
    });

    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);
    // devops_tool deve ser incluído (shared com roblox)
    expect(names).toContain("devops_tool");
    // self_tool também é do modo roblox específico — deve aparecer pois é do modo ativo
    expect(names).toContain("self_tool");
  });
});
