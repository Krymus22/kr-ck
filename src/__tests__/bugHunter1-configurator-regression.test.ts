/**
 * bugHunter1-configurator-regression.test.ts — Regression test for Bug 5.
 *
 * Bug 5: toolConfigurator.configureTool — JSON.parse on malformed tool_call
 * arguments threw synchronously and aborted the ENTIRE configuration session.
 * One bad tool call (truncated streaming, model errors, etc.) killed the whole
 * loop because the parse was unguarded — the exception propagated to the outer
 * try/catch which returned immediately with an error.
 *
 * Fix: wrap JSON.parse in a local try/catch. A malformed-args tool call now
 * becomes an error string fed back to the model so it can retry, instead of
 * killing the session.
 *
 * This test verifies:
 *   1. A malformed-args tool call does NOT abort configureTool.
 *   2. The error is fed back to the model as a tool result.
 *   3. The loop continues and can still succeed on subsequent iterations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks (same pattern as integration-configurator-flow.test.ts) -----------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: { apiKey: "test-key", model: "test-model" },
}));

const chatMock = vi.hoisted(() => vi.fn());
vi.mock("../apiClient.js", () => ({
  chat: (...args: any[]) => chatMock(...args),
}));

vi.mock("../toolDetector.js", () => ({
  findToolBinary: vi.fn(() => null),
}));

vi.mock("../fileFinder.js", () => ({
  searchInDefinedFolders: vi.fn(() => []),
  copyToModeTools: vi.fn(() => null),
  isSafeFileName: vi.fn((name: string) => /^[A-Za-z0-9._-]+$/.test(name)),
  isSafeModeName: vi.fn((name: string) => /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== ".."),
}));

// --- Imports ----------------------------------------------------------------

import { configureTool } from "../toolConfigurator.js";

// --- Helpers ----------------------------------------------------------------

function mockStopResponse(content: string): any {
  return {
    choices: [{
      message: { role: "assistant", content, tool_calls: undefined },
      finish_reason: "stop" as const,
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mockToolCallsResponse(toolCalls: Array<{
  id: string;
  function: { name: string; arguments: string };
}>): any {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      },
      finish_reason: "tool_calls" as const,
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
  };
}

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-bh1-cfg-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  chatMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

// --- Tests ------------------------------------------------------------------

describe("Bug 5: configureTool handles malformed JSON tool_call arguments", () => {
  it("does NOT abort the session when a tool call has malformed JSON arguments", async () => {
    // Before the fix: JSON.parse threw, the outer try/catch caught it, and
    // configureTool returned immediately with `{ success: false, message: "Error: ..." }`.
    // The IA never got a chance to retry with valid args.
    //
    // After the fix: the malformed-args tool call becomes an error tool result
    // pushed back to the model. The loop continues, and the model can retry.
    chatMock
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_bad_json",
            function: {
              name: "executar_comando_seguro",
              arguments: "{not valid json", // malformed JSON
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockStopResponse("ok"));

    const result = await configureTool("darklua", "roblox");

    // The session did NOT abort — chat was called at least twice.
    expect(chatMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The second chat call received the error tool result for the malformed args.
    const secondCallMessages = chatMock.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
      tool_call_id?: string;
    }>;
    const toolMsgs = secondCallMessages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toMatch(/[ERROR]/);
    expect(toolMsgs[0].content).toMatch(/Invalid JSON arguments/i);
    // tool_call_id must be set so the API can correlate the error with the tool call.
    expect(toolMsgs[0].tool_call_id).toBe("call_bad_json");

    // configureTool completed (didn't throw). It returns failure because no
    // manifest was created, but the important thing is it didn't crash.
    expect(result.success).toBe(false);
    expect(result.message).not.toMatch(/^Error:/); // not an unhandled exception
  });

  it("can still succeed on a subsequent iteration after a malformed-args tool call", async () => {
    // 1st iteration: malformed args → error tool result.
    // 2nd iteration: valid tool call that creates a manifest.
    // 3rd iteration: stop — manifest exists, return success.
    const manifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");

    chatMock
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_bad",
            function: {
              name: "executar_comando_seguro",
              arguments: "{broken",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_good",
            function: {
              name: "criar_manifest",
              arguments: JSON.stringify({
                toolName: "darklua",
                manifest: { name: "darklua", description: "test" },
              }),
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockStopResponse("done"));

    const result = await configureTool("darklua", "roblox");

    // The manifest WAS created (proves the loop continued past the bad call).
    expect(fs.existsSync(path.join(manifestsDir, "darklua.json"))).toBe(true);
    expect(result.success).toBe(true);
    expect(result.manifestPath).toBeTruthy();
  });

  it("does NOT swallow the error silently — the IA sees the error message", async () => {
    // The error message must include the raw (truncated) arguments so the IA
    // can see what went wrong and retry with valid JSON.
    chatMock
      .mockResolvedValueOnce(
        mockToolCallsResponse([
          {
            id: "call_x",
            function: {
              name: "buscar_arquivo",
              arguments: "not json at all {{{{",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(mockStopResponse("ok"));

    await configureTool("darklua", "roblox");

    const secondCallMessages = chatMock.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = secondCallMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    // Error message includes the raw args (truncated) so the IA can debug.
    expect(toolMsg!.content).toMatch(/not json at all/);
  });
});
