/**
 * robloxMcpGuard.ts - Security layer for Roblox Studio MCP tools.
 *
 * PROBLEM: The Roblox Studio MCP server provides 20+ tools that can directly
 * modify the game (multi_edit, execute_luau, generate_mesh, etc.). If the IA
 * calls these directly, it BYPASSES all safety mechanisms:
 *   - Bug Hunter (never sees the edited code)
 *   - DataGuard (never detects SetAsync without GetAsync)
 *   - Read-before-Write enforcement (never forces read before edit)
 *   - Rollback Store (never creates backup)
 *   - Strict Quality Gate (never blocks on test failure)
 *   - Guardrail (never validates safety)
 *
 * SOLUTION: Blacklist of WRITE tools that bypass the safety pipeline.
 * Tools in the blacklist are BLOCKED — the IA must use `aplicar_diff`
 * instead, which goes through the full pipeline.
 *
 * PHILOSOPHY (per user request, July 2026):
 *   "se o usuário instala um mcp é porque confia no mcp, então todas as
 *    tools daquele mcp deveriam não serem bloqueadas"
 *
 *   → Default-ALLOW policy for unknown tools. If a tool is not in the
 *     blacklist, it's allowed. This avoids blocking new tools that Roblox
 *     adds to Studio MCP without notice.
 *
 *   → Only WRITE tools that bypass our safety pipeline are blocked
 *     (multi_edit, generate_*, insert_from_creator_store).
 *
 *   → EXECUTE tools (execute_luau) are allowed WITH logging, because the
 *     IA needs to test code it wrote via aplicar_diff.
 *
 *   → READ/PLAYTEST/SESSION tools are allowed silently.
 *
 *   → UNKNOWN tools are ALLOWED silently (default-allow). If you want to
 *     classify them for documentation, add them to TOOL_CLASSIFICATION.
 *
 * ARCHITECTURE:
 *
 *   IA calls MCP tool "Roblox_Studio__multi_edit"
 *     ↓
 *   robloxMcpGuard.classifyTool("multi_edit") → "write"
 *     ↓
 *   BLOCKED — return error message telling IA to use aplicar_diff
 *     ↓
 *   IA calls aplicar_diff (our tool)
 *     ↓
 *   Normal pipeline: read-before-write → Bug Hunter → DataGuard → rollback → write
 *     ↓
 *   Rojo syncs file to Studio automatically
 *     ↓
 *   IA can then call "Roblox_Studio__script_read" to verify (read-only, allowed)
 */

import * as log from "./logger.js";

// ─── Tool Classification ────────────────────────────────────────────────────

export type McpToolCategory = "read" | "write" | "execute" | "playtest" | "session" | "unknown";

/**
 * Roblox Studio MCP tool names (without the "Roblox_Studio__" prefix).
 * Classification based on the official documentation:
 * https://create.roblox.com/docs/studio/mcp
 */
const TOOL_CLASSIFICATION: Record<string, McpToolCategory> = {
  // ── READ-ONLY (safe to pass through directly) ─────────────────────────────
  "script_read": "read",
  "script_search": "read",
  "script_grep": "read",
  "search_game_tree": "read",
  "inspect_instance": "read",
  "explore_subagent": "read",
  "list_roblox_studios": "read",
  "console_output": "read",
  "get_studio_state": "read",  // Retorna estado do Studio (place aberto, selection, modo edit/play)

  // ── WRITE/EDIT (BLOCKED — must use our aplicar_diff pipeline) ─────────────
  // These modify scripts or insert assets. The IA must use our tools instead
  // so that Bug Hunter, DataGuard, read-before-write, and rollback all run.
  "multi_edit": "write",
  "insert_from_creator_store": "write",
  "generate_mesh": "write",
  "generate_material": "write",
  "generate_procedural_model": "write",

  // ── EXECUTE (allowed with monitoring — IA needs to test code) ─────────────
  // execute_luau runs arbitrary Luau in Studio. We allow this because:
  //   1. The IA needs to test code it wrote (via aplicar_diff)
  //   2. DataGuard already validated the code before it was written
  //   3. We log the execution for audit trail
  "execute_luau": "execute",
  "run_script_in_play_mode": "execute",

  // ── PLAYTEST (allowed — controls game runtime, not code) ──────────────────
  "start_stop_play": "playtest",
  "screen_capture": "playtest",
  "playtest_subagent": "playtest",
  "character_navigation": "playtest",
  "keyboard_input": "playtest",
  "mouse_input": "playtest",

  // ── SESSION (allowed — session management) ────────────────────────────────
  "set_active_studio": "session",
};

/**
 * Classify an MCP tool by its category.
 * @param toolName The tool name WITHOUT the server prefix (e.g., "multi_edit")
 * @returns The category, or "unknown" if not recognized
 */
export function classifyMcpTool(toolName: string): McpToolCategory {
  return TOOL_CLASSIFICATION[toolName] ?? "unknown";
}

/**
 * Extract the tool name from a prefixed MCP tool call.
 * "Roblox_Studio__multi_edit" → "multi_edit"
 */
export function extractToolName(prefixedName: string): string {
  const idx = prefixedName.indexOf("__");
  return idx === -1 ? prefixedName : prefixedName.slice(idx + 2);
}

/**
 * Check if a prefixed tool name belongs to the Roblox Studio MCP server.
 * "Roblox_Studio__multi_edit" → true
 * "other_server__tool" → false
 */
export function isRobloxStudioMcpTool(prefixedName: string): boolean {
  return prefixedName.startsWith("Roblox_Studio__") ||
         prefixedName.startsWith("roblox_studio__") ||
         prefixedName.startsWith("RobloxStudio__");
}

// ─── Guard Logic ────────────────────────────────────────────────────────────

export interface GuardResult {
  /** Whether the tool call is allowed to proceed */
  allowed: boolean;
  /** If blocked, the error message to return to the IA */
  blockReason?: string;
  /** The category of the tool */
  category: McpToolCategory;
  /** Whether the call should be logged for audit */
  shouldLog: boolean;
}

/**
 * Evaluate whether an MCP tool call should be allowed.
 *
 * WRITE tools are BLOCKED — the IA must use our `aplicar_diff` instead,
 * which goes through Bug Hunter → DataGuard → read-before-write → rollback.
 *
 * All other categories are ALLOWED (with logging for execute).
 *
 * @param prefixedName The full MCP tool name (e.g., "Roblox_Studio__multi_edit")
 * @param args The arguments the IA is trying to pass
 * @returns GuardResult indicating whether to allow or block
 */
export function evaluateMcpToolCall(
  prefixedName: string,
  args: Record<string, unknown>,
): GuardResult {
  // Only guard Roblox Studio MCP tools
  if (!isRobloxStudioMcpTool(prefixedName)) {
    return {
      allowed: true,
      category: "unknown",
      shouldLog: false,
    };
  }

  const toolName = extractToolName(prefixedName);
  const category = classifyMcpTool(toolName);

  switch (category) {
    case "read":
      // Safe — pass through directly
      return {
        allowed: true,
        category: "read",
        shouldLog: false,
      };

    case "write":
      // BLOCKED — must use our pipeline (aplicar_diff)
      return {
        allowed: false,
        category: "write",
        shouldLog: true,
        blockReason: formatWriteBlockMessage(toolName, args),
      };

    case "execute":
      // Allowed — but log for audit trail
      log.warn(`[MCP_GUARD] IA executing Luau via ${toolName} — output will be monitored`);
      return {
        allowed: true,
        category: "execute",
        shouldLog: true,
      };

    case "playtest":
    case "session":
      // Safe — controls game runtime or session, not code
      return {
        allowed: true,
        category,
        shouldLog: false,
      };

    case "unknown":
    default:
      // PHILISOPHY CHANGE (per user request): "se o usuário instala um mcp é
      // porque confia no mcp, então todas as tools daquele mcp deveriam não
      // serem bloqueadas".
      //
      // Default-allow: tools desconhecidas são PERMITIDAS (não bloqueadas).
      // Apenas tools WRITE conhecidas (multi_edit, generate_*, insert_*) são
      // bloqueadas porque elas explicitamente bypassam o pipeline de segurança
      // (Bug Hunter, DataGuard, read-before-write, rollback).
      //
      // Tools desconhecidas geralmente são tools novas do Roblox Studio MCP
      // (que a Roblox adiciona sem avisar) — bloquear gera falsos positivos.
      // Confiamos no usuário que instalou o MCP.
      log.info(`[MCP_GUARD] Allowing unknown tool "${toolName}" (default-allow policy)`);
      return {
        allowed: true,
        category: "unknown",
        shouldLog: false,  // não logar como WARN, é fluxo normal agora
      };
  }
}

/**
 * Format a HELPFUL message when an unknown tool is allowed but not classified.
 * (Kept for reference — currently not used because unknown tools are allowed
 * silently. If you want to surface a notice, return this as blockReason.)
 */
function formatUnknownAllowedMessage(toolName: string): string {
  return [
    `[MCP_GUARD] Tool "${toolName}" is not in the recognized list, but is ALLOWED.`,
    `(Default-allow policy: trust the user who installed the MCP.)`,
    ``,
    `If you want to add it to the classification for documentation:`,
    `  - Open src/robloxMcpGuard.ts`,
    `  - Add: "${toolName}": "<category>",  // <description>`,
    ``,
    `Categories: read | write | execute | playtest | session`,
  ].join("\n");
}

/**
 * Format the error message when a WRITE tool is blocked.
 * Tells the IA exactly which tool to use instead and why.
 */
function formatWriteBlockMessage(toolName: string, args: Record<string, unknown>): string {
  const scriptPath = args.path ?? args.scriptPath ?? args.caminho ?? "unknown";

  if (toolName === "multi_edit") {
    return [
      `[MCP_GUARD] BLOCKED: "${toolName}" bypasses safety validations.`,
      ``,
      `You tried to edit "${scriptPath}" directly via Studio MCP, which would skip:`,
      `  - Bug Hunter (logic bug detection)`,
      `  - DataGuard (data loss prevention — SetAsync/RemoveAsync checks)`,
      `  - Read-before-Write enforcement`,
      `  - Automatic rollback backup`,
      ``,
      `INSTEAD: Use the "aplicar_diff" tool with the same script path.`,
      `The file will be synced to Studio automatically via Rojo.`,
      ``,
      `aplicar_diff flow:`,
      `  1. Read-before-write check (forces you to read first)`,
      `  2. Bug Hunter reviews the diff for logic bugs`,
      `  3. DataGuard checks for data loss patterns`,
      `  4. Rollback backup created automatically`,
      `  5. Diff applied to file on disk`,
      `  6. Rojo syncs file → Studio (automatic)`,
      `  7. You can verify with script_read (read-only, allowed)`,
    ].join("\n");
  }

  if (toolName.startsWith("generate_")) {
    return [
      `[MCP_GUARD] BLOCKED: "${toolName}" generates assets directly in Studio.`,
      `This bypasses version control and backup systems.`,
      ``,
      `INSTEAD: Describe what you want to generate, and the developer`,
      `can run this tool manually from Studio. Alternatively, create`,
      `the asset procedurally via Luau script (using aplicar_diff to`,
      `write the script, which goes through all safety checks).`,
    ].join("\n");
  }

  if (toolName === "insert_from_creator_store") {
    return [
      `[MCP_GUARD] BLOCKED: "${toolName}" inserts assets directly into the game.`,
      `This bypasses version control (the asset won't be in your Rojo project).`,
      ``,
      `INSTEAD: Add the asset as a Wally dependency or download it to your`,
      `project's src/ folder, then sync via Rojo. This keeps everything`,
      `version-controlled and reproducible.`,
    ].join("\n");
  }

  return [
    `[MCP_GUARD] BLOCKED: "${toolName}" is a write operation that bypasses safety.`,
    `Use aplicar_diff instead for code edits (goes through Bug Hunter + DataGuard).`,
  ].join("\n");
}

/**
 * Get a list of all allowed (non-blocked) Roblox Studio MCP tools.
 * Used to build the tool definitions shown to the IA.
 */
export function getAllowedRobloxMcpTools(): string[] {
  return Object.entries(TOOL_CLASSIFICATION)
    .filter(([, cat]) => cat !== "write")
    .map(([name]) => name);
}

/**
 * Get a list of all BLOCKED Roblox Studio MCP tools.
 * Used for documentation and the /searx-style status command.
 */
export function getBlockedRobloxMcpTools(): string[] {
  return Object.entries(TOOL_CLASSIFICATION)
    .filter(([, cat]) => cat === "write")
    .map(([name]) => name);
}
