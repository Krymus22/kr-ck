/**
 * robloxMcpGuard.test.ts — Testes do guard de segurança MCP do Roblox Studio
 */

import { describe, it, expect } from "vitest";
import {
  classifyMcpTool,
  extractToolName,
  isRobloxStudioMcpTool,
  evaluateMcpToolCall,
  getAllowedRobloxMcpTools,
  getBlockedRobloxMcpTools,
} from "../robloxMcpGuard.js";

describe("robloxMcpGuard", () => {
  describe("isRobloxStudioMcpTool", () => {
    it("detecta Roblox_Studio__ prefix", () => {
      expect(isRobloxStudioMcpTool("Roblox_Studio__multi_edit")).toBe(true);
    });

    it("detecta roblox_studio__ prefix (lowercase)", () => {
      expect(isRobloxStudioMcpTool("roblox_studio__script_read")).toBe(true);
    });

    it("detecta RobloxStudio__ prefix", () => {
      expect(isRobloxStudioMcpTool("RobloxStudio__execute_luau")).toBe(true);
    });

    it("rejeita outros servidores MCP", () => {
      expect(isRobloxStudioMcpTool("other_server__tool")).toBe(false);
      expect(isRobloxStudioMcpTool("github__search")).toBe(false);
      expect(isRobloxStudioMcpTool("multi_edit")).toBe(false);
    });
  });

  describe("extractToolName", () => {
    it("extrai nome sem prefixo", () => {
      expect(extractToolName("Roblox_Studio__multi_edit")).toBe("multi_edit");
      expect(extractToolName("roblox_studio__script_read")).toBe("script_read");
    });

    it("retorna nome original se não tem prefixo", () => {
      expect(extractToolName("multi_edit")).toBe("multi_edit");
    });
  });

  describe("classifyMcpTool", () => {
    it("classifica tools read-only corretamente", () => {
      expect(classifyMcpTool("script_read")).toBe("read");
      expect(classifyMcpTool("script_search")).toBe("read");
      expect(classifyMcpTool("script_grep")).toBe("read");
      expect(classifyMcpTool("search_game_tree")).toBe("read");
      expect(classifyMcpTool("inspect_instance")).toBe("read");
      expect(classifyMcpTool("explore_subagent")).toBe("read");
      expect(classifyMcpTool("list_roblox_studios")).toBe("read");
      expect(classifyMcpTool("console_output")).toBe("read");
    });

    it("classifica tools write como bloqueadas", () => {
      expect(classifyMcpTool("multi_edit")).toBe("write");
      expect(classifyMcpTool("insert_from_creator_store")).toBe("write");
      expect(classifyMcpTool("generate_mesh")).toBe("write");
      expect(classifyMcpTool("generate_material")).toBe("write");
      expect(classifyMcpTool("generate_procedural_model")).toBe("write");
    });

    it("classifica tools execute com monitoramento", () => {
      expect(classifyMcpTool("execute_luau")).toBe("execute");
      expect(classifyMcpTool("run_script_in_play_mode")).toBe("execute");
    });

    it("classifica tools playtest", () => {
      expect(classifyMcpTool("start_stop_play")).toBe("playtest");
      expect(classifyMcpTool("screen_capture")).toBe("playtest");
      expect(classifyMcpTool("playtest_subagent")).toBe("playtest");
      expect(classifyMcpTool("character_navigation")).toBe("playtest");
      expect(classifyMcpTool("keyboard_input")).toBe("playtest");
      expect(classifyMcpTool("mouse_input")).toBe("playtest");
    });

    it("classifica session tools", () => {
      expect(classifyMcpTool("set_active_studio")).toBe("session");
    });

    it("retorna unknown para tools desconhecidas", () => {
      expect(classifyMcpTool("unknown_tool")).toBe("unknown");
      expect(classifyMcpTool("new_tool_not_listed")).toBe("unknown");
    });
  });

  describe("evaluateMcpToolCall", () => {
    it("BLOQUEIA multi_edit (write)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__multi_edit", {
        path: "game.ServerScriptService.MyScript",
        edits: [],
      });
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("write");
      expect(result.blockReason).toContain("BLOCKED");
      expect(result.blockReason).toContain("aplicar_diff");
      expect(result.blockReason).toContain("Bug Hunter");
      expect(result.blockReason).toContain("DataGuard");
    });

    it("BLOQUEIA generate_mesh (write)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__generate_mesh", {});
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("write");
      expect(result.blockReason).toContain("generate");
    });

    it("BLOQUEIA insert_from_creator_store (write)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__insert_from_creator_store", {});
      expect(result.allowed).toBe(false);
      expect(result.category).toBe("write");
      expect(result.blockReason).toContain("version control");
    });

    it("PERMITE script_read (read)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__script_read", {
        path: "game.ServerScriptService.MyScript",
      });
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("read");
      expect(result.shouldLog).toBe(false);
    });

    it("PERMITE search_game_tree (read)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__search_game_tree", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("read");
    });

    it("PERMITE execute_luau (execute) com logging", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__execute_luau", {
        code: "print('hello')",
      });
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("execute");
      expect(result.shouldLog).toBe(true);
    });

    it("PERMITE start_stop_play (playtest)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__start_stop_play", {
        action: "start",
      });
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("playtest");
    });

    it("PERMITE set_active_studio (session)", () => {
      const result = evaluateMcpToolCall("Roblox_Studio__set_active_studio", {
        id: "123",
      });
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("session");
    });

    it("PERMITE tools desconhecidas (default-allow policy — per user request)", () => {
      // PHILISOPHY CHANGE (commit a65fde5): "se o usuário instala um mcp é
      // porque confia no mcp, então todas as tools daquele mcp deveriam não
      // serem bloqueadas". Tools unknown agora são PERMITIDAS, não bloqueadas.
      // Apenas WRITE tools conhecidas (multi_edit, generate_*, insert_*) são
      // bloqueadas porque bypassam o pipeline de segurança.
      const result = evaluateMcpToolCall("Roblox_Studio__unknown_new_tool", {});
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("unknown");
      // Não deve ter blockReason (é permitido, não bloqueado)
      expect(result.blockReason).toBeUndefined();
    });

    it("NÃO interfere com outros servidores MCP", () => {
      const result = evaluateMcpToolCall("github__search_repos", { q: "react" });
      expect(result.allowed).toBe(true);
      expect(result.category).toBe("unknown");
      expect(result.shouldLog).toBe(false);
    });
  });

  describe("getAllowedRobloxMcpTools / getBlockedRobloxMcpTools", () => {
    it("getAllowed contém apenas tools não-write", () => {
      const allowed = getAllowedRobloxMcpTools();
      expect(allowed).toContain("script_read");
      expect(allowed).toContain("execute_luau");
      expect(allowed).toContain("start_stop_play");
      expect(allowed).not.toContain("multi_edit");
      expect(allowed).not.toContain("generate_mesh");
    });

    it("getBlocked contém apenas tools write", () => {
      const blocked = getBlockedRobloxMcpTools();
      expect(blocked).toContain("multi_edit");
      expect(blocked).toContain("generate_mesh");
      expect(blocked).toContain("insert_from_creator_store");
      expect(blocked).not.toContain("script_read");
      expect(blocked).not.toContain("execute_luau");
    });
  });
});
