/**
 * scoutAgent-real.test.ts — Real API test for the scout sub-agent.
 *
 * This test calls the REAL NVIDIA API with the scout model to verify
 * the scout can actually read files and return results.
 *
 * Requirements:
 * - NVIDIA_API_KEY env var must be set
 * - SCOUT_ENABLED=1
 * - A temp file must exist for the scout to read
 *
 * If NVIDIA_API_KEY is not set, the test is SKIPPED.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const hasApiKey = !!process.env.NVIDIA_API_KEY || !!process.env.NVIDIA_API_KEYS;

// Skip in CI — requires real API key and network access
const shouldSkip = !hasApiKey || process.env.CI === "true" || process.env.NODE_ENV === "test";

describe.skipIf(shouldSkip)("scoutAgent — real API test", () => {
  let tmpDir: string;
  let testFile: string;
  const testContent = `-- Test file for scout
local PlayerData = {}
PlayerData.Coins = 0
PlayerData.Level = 1

function PlayerData:SetAsync(player, data)
    local store = game:GetService("DataStoreService"):GetDataStore("PlayerData")
    store:SetAsync(player.UserId, data)
end

return PlayerData
`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-real-test-"));
    testFile = path.join(tmpDir, "PlayerData.luau");
    fs.writeFileSync(testFile, testContent);
    process.env.SCOUT_ENABLED = "1";
    // Use the test project's cwd so the scout can find the file
    process.chdir(tmpDir);
  });

  afterAll(() => {
    try { process.chdir(path.resolve(__dirname, "../..")); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    delete process.env.SCOUT_ENABLED;
  });

  it("scout reads a file and returns raw content", async () => {
    const { runScout } = await import("../scoutAgent.js");

    const result = await runScout({
      objective: "Read the PlayerData.luau file and return its contents",
      tasks: [{ type: "read_file", description: "read PlayerData.luau" }],
      maxToolCalls: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    expect(result!.toolResults.length).toBeGreaterThan(0);

    // At least one tool result should contain the file content
    const hasContent = result!.toolResults.some(
      tr => tr.success && tr.result.includes("PlayerData")
    );
    expect(hasContent).toBe(true);
  }, 60000); // 60s timeout for real API call

  it("scout searches for text in files", async () => {
    const { runScout } = await import("../scoutAgent.js");

    const result = await runScout({
      objective: "Search for 'SetAsync' in the project files",
      tasks: [{ type: "search_text", description: "search for SetAsync" }],
      maxToolCalls: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);

    // Should find SetAsync in the test file
    const hasSetAsync = result!.toolResults.some(
      tr => tr.success && tr.result.includes("SetAsync")
    );
    expect(hasSetAsync).toBe(true);
  }, 60000);

  it("formatScoutResult returns raw content (not summary)", async () => {
    const { runScout, formatScoutResult } = await import("../scoutAgent.js");

    const result = await runScout({
      objective: "Read PlayerData.luau",
      tasks: [{ type: "read_file", description: "read PlayerData.luau" }],
      maxToolCalls: 3,
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);

    const formatted = formatScoutResult(result!);
    expect(formatted).toContain("[SCOUT RESULTS");
    expect(formatted).toContain("ler_arquivo");
    // Should contain the actual file content, not a summary
    expect(formatted).toContain("PlayerData");
    expect(formatted).toContain("SetAsync");
  }, 60000);
});
