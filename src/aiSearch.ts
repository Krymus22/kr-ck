/**
 * aiSearch.ts — AI-assisted tool discovery.
 *
 * When the smart/extreme searches fail to find a tool, we ask an LLM to suggest
 * unlikely-but-plausible locations where the binary might be hiding. The model
 * knows about common Roblox/Luau tool install patterns (rokit, aftman, cargo,
 * scoop, foreman, raw GitHub releases, etc.) and can reason about the user's
 * OS + working directory to produce targeted guesses.
 *
 * We then verify each suggested path with `fs.existsSync` — we never trust
 * the model's output blindly, we only use it as a hint generator.
 *
 * Provider-agnostic: works with NVIDIA NIM, ZenMux, Zhipu, OpenAI, Ollama,
 * any OpenAI-compatible /chat/completions endpoint. Configured via:
 *   AI_SEARCH_API_KEY  (defaults to main provider key)
 *   AI_SEARCH_BASE_URL (defaults to main provider URL)
 *   AI_SEARCH_MODEL    (defaults to "moonshotai/kimi-k2.6")
 */

import OpenAI from "openai";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { config } from "./config.js";
import * as log from "./logger.js";
import type { ToolDetectionResult } from "./toolDetector.js";

// --- Types -------------------------------------------------------------------

export interface AiSearchSuggestion {
  /** Suggested full path. */
  path: string;
  /** Why the model thinks it's here (e.g., "rokit bin in user profile"). */
  reason: string;
  /** Whether the file actually exists on disk (verified post-suggestion). */
  exists: boolean;
}

export interface AiSearchResult {
  /** All suggestions returned by the model. */
  suggestions: AiSearchSuggestion[];
  /** The first suggestion that exists on disk (null if none). */
  verifiedPath: string | null;
  /** Version of the binary at verifiedPath (null if not found or --version failed). */
  version: string | null;
  /** Raw model output for debugging. */
  rawResponse: string;
  /** Error message if the API call failed. */
  error: string | null;
}

// --- Public API --------------------------------------------------------------

/**
 * Ask the LLM to suggest where a tool might be installed.
 *
 * The prompt includes:
 *   - The tool name (e.g., "rojo")
 *   - The OS (Windows/Linux/macOS) and arch (x64/arm64)
 *   - The current working directory
 *   - The user's home directory
 *   - The list of paths we ALREADY checked (so the model doesn't repeat them)
 *
 * The model is instructed to return a STRICT JSON array of {path, reason}.
 * We parse defensively — if parsing fails, we extract paths via regex fallback.
 *
 * @param toolName  Binary name (e.g., "rojo", "selene", "stylua")
 * @param alreadyChecked  Paths we already searched (to avoid duplicate suggestions)
 * @returns  AiSearchResult with suggestions and verification
 */
export async function aiSuggestToolLocation(
  toolName: string,
  alreadyChecked: string[] = [],
): Promise<AiSearchResult> {
  // Skip if disabled
  if (!config.aiSearchEnabled) {
    return {
      suggestions: [],
      verifiedPath: null,
      version: null,
      rawResponse: "",
      error: "AI search disabled (set AI_SEARCH_ENABLED=true to enable)",
    };
  }

  if (!config.aiSearchApiKey) {
    return {
      suggestions: [],
      verifiedPath: null,
      version: null,
      rawResponse: "",
      error: "No API key configured (set AI_SEARCH_API_KEY or main NVIDIA_API_KEY/ZENMUX_API_KEY)",
    };
  }

  try {
    const client = new OpenAI({
      apiKey: config.aiSearchApiKey,
      baseURL: config.aiSearchBaseUrl,
      timeout: 30_000, // 30s — this should be a fast call
      maxRetries: 1,
    });

    const platform = process.platform;
    const arch = process.arch;
    const home = os.homedir();
    const cwd = process.cwd();
    const exeName = platform === "win32" ? `${toolName}.exe` : toolName;
    const username = os.userInfo().username;

    const systemPrompt = `You are a tool discovery assistant. The user is looking for an executable binary on their system that previous searches could not find. Your job is to suggest UNLIKELY-BUT-POSSIBLE locations where the binary might be installed.

Respond with a STRICT JSON array (no markdown, no commentary). Each element must be an object with two string fields:
  - "path": the absolute file path to CHECK (must include the filename and extension)
  - "reason": a one-sentence explanation of why this location is plausible

Rules:
1. Suggest 5 to 10 paths, ordered from most-likely to least-likely.
2. NEVER suggest paths the user already checked (listed below).
3. Use the OS-appropriate path separator (backslashes on Windows, forward slashes on Linux/macOS).
4. Use the OS-appropriate executable extension (.exe on Windows, no extension on Unix).
5. Consider: non-standard install dirs (Downloads, Desktop, custom Tools folders), game engine plugins, project-specific vendor folders, WSL paths, portable install zip extractions, sideloaded shims, etc.
6. If you genuinely cannot think of 5 plausible paths, return fewer. Do NOT pad with duplicates or paths you know don't exist.
7. Output ONLY the JSON array — no text before or after.`;

    const userPrompt = `Looking for: ${toolName} (executable name: ${exeName})
OS: ${platform} ${arch}
Username: ${username}
Home directory: ${home}
Current working directory: ${cwd}

Already checked (DO NOT suggest these again):
${alreadyChecked.length > 0 ? alreadyChecked.map((p) => `  - ${p}`).join("\n") : "  (none — first attempt)"}

Return the JSON array now.`;

    log.debug(`[AI-SEARCH] Asking ${config.aiSearchModel} for ${toolName} location...`);

    const completion = await client.chat.completions.create({
      model: config.aiSearchModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3, // low temp for more deterministic path suggestions
      max_tokens: 1024,
      stream: false,
    });

    const rawResponse = completion.choices[0]?.message?.content ?? "";

    // Parse the JSON array (with regex fallback if the model adds markdown fences)
    const suggestions = parseSuggestions(rawResponse, exeName, platform);

    // Verify each suggestion with fs.existsSync
    let verifiedPath: string | null = null;
    let version: string | null = null;
    for (const suggestion of suggestions) {
      try {
        if (fs.existsSync(suggestion.path)) {
          suggestion.exists = true;
          if (!verifiedPath) {
            verifiedPath = suggestion.path;
            version = getVersion(suggestion.path);
            log.debug(`[AI-SEARCH] Found ${toolName} at AI-suggested path: ${suggestion.path}`);
            break; // take the first verified hit
          }
        }
      } catch {
        // stat failed — skip
      }
    }

    return {
      suggestions,
      verifiedPath,
      version,
      rawResponse,
      error: null,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.warn(`[AI-SEARCH] Failed: ${msg}`);
    return {
      suggestions: [],
      verifiedPath: null,
      version: null,
      rawResponse: "",
      error: msg,
    };
  }
}

// --- Helpers -----------------------------------------------------------------

/**
 * Parse the model's response into a list of suggestions.
 *
 * Handles:
 *   - Pure JSON arrays (the happy path)
 *   - Markdown-fenced JSON (```json ... ```)
 *   - Free-form text with embedded absolute paths (regex fallback)
 */
function parseSuggestions(
  raw: string,
  exeName: string,
  platform: NodeJS.Platform,
): AiSearchSuggestion[] {
  // Try strict JSON parse first
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item) => item && typeof item === "object" && typeof item.path === "string")
        .map((item) => ({
          path: String(item.path).trim(),
          reason: String(item.reason ?? "").trim(),
          exists: false,
        }))
        .filter((s) => s.path.length > 0);
    }
  } catch {
    // not pure JSON — fall through to regex
  }

  // Regex fallback: extract any absolute path that ends with the exe name
  const sep = platform === "win32" ? "[\\\\/]" : "/";
  const pathRegex = new RegExp(
    platform === "win32"
      ? `[A-Z]:${sep}(?:[^<>:"|?*\\n\\r]+${sep})*${escapeRegex(exeName)}`
      : `/(?:[^\\n\\r/]+/)*${escapeRegex(exeName)}`,
    "gi",
  );
  const matches = raw.match(pathRegex) ?? [];
  return matches.map((p) => ({
    path: p.trim(),
    reason: "(extracted from free-form model response)",
    exists: false,
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run `<binary> --version` and return the version string.
 * Returns null on failure.
 */
function getVersion(binaryPath: string): string | null {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const result = execSync(`"${binaryPath}" --version`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32" ? "powershell.exe" : undefined,
    });
    const match = result.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? result.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert an AiSearchResult into the ToolDetectionResult shape that
 * the rest of toolDetector.ts expects.
 */
export function aiResultToDetectionResult(
  toolName: string,
  aiResult: AiSearchResult,
): ToolDetectionResult | null {
  if (!aiResult.verifiedPath) {
    return null;
  }
  return {
    status: "found",
    binaryPath: aiResult.verifiedPath,
    version: aiResult.version,
    error: null,
    searchedPaths: aiResult.suggestions.map((s) => `[AI] ${s.path} — ${s.reason}`),
  };
}
