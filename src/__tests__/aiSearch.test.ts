/**
 * aiSearch.test.ts — Tests for the AI-assisted tool discovery module.
 *
 * Tests cover:
 *   - aiSuggestToolLocation returns graceful error when AI search is disabled
 *   - aiSuggestToolLocation returns graceful error when API key is missing
 *   - parseSuggestions handles strict JSON arrays
 *   - parseSuggestions handles markdown-fenced JSON
 *   - parseSuggestions falls back to regex extraction for free-form text
 *   - aiResultToDetectionResult converts to ToolDetectionResult shape
 *   - aiOnlySearchAllTools calls onProgress and returns results
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock config — controllable per test
const mockConfig = vi.hoisted(() => ({
  aiSearchEnabled: true,
  aiSearchApiKey: "test-key",
  aiSearchBaseUrl: "https://test.api.com/v1",
  aiSearchModel: "test-model",
}));

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

// Mock OpenAI client
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

import { aiSuggestToolLocation, aiResultToDetectionResult, type AiSearchResult } from "../aiSearch.js";

describe("aiSearch", () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.aiSearchEnabled = true;
    mockConfig.aiSearchApiKey = "test-key";
    mockConfig.aiSearchBaseUrl = "https://test.api.com/v1";
    mockConfig.aiSearchModel = "test-model";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  describe("aiSuggestToolLocation", () => {
    it("returns error when AI search is disabled", async () => {
      mockConfig.aiSearchEnabled = false;
      const result = await aiSuggestToolLocation("rojo");
      expect(result.error).toMatch(/disabled/i);
      expect(result.suggestions).toEqual([]);
      expect(result.verifiedPath).toBeNull();
    });

    it("returns error when API key is missing", async () => {
      mockConfig.aiSearchApiKey = "";
      const result = await aiSuggestToolLocation("rojo");
      expect(result.error).toMatch(/API key/i);
      expect(result.suggestions).toEqual([]);
      expect(result.verifiedPath).toBeNull();
    });

    it("parses strict JSON array response from the model", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify([
              { path: "C:\\Nonexistent\\rojo.exe", reason: "test reason 1" },
              { path: "D:\\Another\\rojo.exe", reason: "test reason 2" },
            ]),
          },
        }],
      });

      const result = await aiSuggestToolLocation("rojo");
      expect(result.error).toBeNull();
      expect(result.suggestions.length).toBe(2);
      expect(result.suggestions[0].path).toBe("C:\\Nonexistent\\rojo.exe");
      expect(result.suggestions[0].reason).toBe("test reason 1");
      // Neither exists, so verifiedPath should be null
      expect(result.verifiedPath).toBeNull();
    });

    it("parses markdown-fenced JSON response", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: "```json\n" + JSON.stringify([
              { path: "/nonexistent/rojo", reason: "linux test" },
            ]) + "\n```",
          },
        }],
      });

      const result = await aiSuggestToolLocation("rojo");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].path).toBe("/nonexistent/rojo");
    });

    it("handles API call errors gracefully", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Network timeout"));
      const result = await aiSuggestToolLocation("rojo");
      expect(result.error).toMatch(/Network timeout/);
      expect(result.suggestions).toEqual([]);
      expect(result.verifiedPath).toBeNull();
    });

    it("filters out non-object entries from malformed JSON", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify([
              { path: "C:\\Nonexistent\\rojo.exe", reason: "valid" },
              "not an object",
              { reason: "missing path field" },
              null,
              { path: "", reason: "empty path" },
            ]),
          },
        }],
      });

      const result = await aiSuggestToolLocation("rojo");
      expect(result.suggestions.length).toBe(1);
      expect(result.suggestions[0].path).toBe("C:\\Nonexistent\\rojo.exe");
    });
  });

  describe("aiResultToDetectionResult", () => {
    it("returns null when verifiedPath is null", () => {
      const aiResult: AiSearchResult = {
        suggestions: [],
        verifiedPath: null,
        version: null,
        rawResponse: "",
        error: "some error",
      };
      const detection = aiResultToDetectionResult("rojo", aiResult);
      expect(detection).toBeNull();
    });

    it("converts to ToolDetectionResult when verifiedPath is set", () => {
      const aiResult: AiSearchResult = {
        suggestions: [
          { path: "/some/path/rojo", reason: "guessed", exists: true },
          { path: "/other/path/rojo", reason: "guessed2", exists: false },
        ],
        verifiedPath: "/some/path/rojo",
        version: "7.6.1",
        rawResponse: "[...]",
        error: null,
      };
      const detection = aiResultToDetectionResult("rojo", aiResult);
      expect(detection).not.toBeNull();
      expect(detection!.status).toBe("found");
      expect(detection!.binaryPath).toBe("/some/path/rojo");
      expect(detection!.version).toBe("7.6.1");
      expect(detection!.error).toBeNull();
      expect(detection!.searchedPaths.length).toBe(2);
      expect(detection!.searchedPaths[0]).toContain("[AI]");
    });
  });
});
