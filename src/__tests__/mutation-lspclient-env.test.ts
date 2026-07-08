/**
 * mutation-lspclient-env.test.ts — Kills survived mutations in src/lspClient.ts.
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L74: `if (!raw) return fallback;`  (envInt)
 *           mutation: `!raw` → `raw` (remove negation)
 *           Effect: for valid numeric strings like "200", `if ("200")` is
 *           truthy → returns fallback (5000) instead of parsed 200.
 *           Survived because tests set LSP_REQUEST_TIMEOUT_MS="200" but
 *           never assert the actual timeout duration — only that a timeout
 *           occurs (which happens at both 200ms and 5000ms).
 *
 *   - L99: `if (which.status === 0 && which.stdout.trim().length > 0)`
 *           (detectPylspPath)
 *           mutation: `=== 0` → `!== 0`  OR  `&&` → `||`  OR  `> 0` → `> 1`
 *           Survived because the spawnSync mock always returns status:1
 *           (failure), so the success branch is never exercised.
 *
 * Killing strategy:
 *   - L74: Set LSP_REQUEST_TIMEOUT_MS="200", make server not respond,
 *          measure elapsed time. Correct: ~200ms. Mutated: ~5000ms.
 *          Assert elapsed < 2000ms → kills `!raw` → `raw` mutation.
 *   - L99: Override spawnSync mock to return status:0 with non-empty
 *          stdout ("/usr/local/bin/pylsp"). Then isLspAvailable("python")
 *          must return true. Mutation `=== 0 → !== 0` makes condition
 *          false → returns null → isLspAvailable false. Test fails. ✓
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// --- Mock state for node:child_process ---------------------------------------
// Per-test configurable: spawn (LSP server) and spawnSync (which pylsp).
const lspState = vi.hoisted(() => ({
  spawnShouldThrow: false,
  autoRespondInitialize: true,
  spawnCallCount: 0,
}));
const syncState = vi.hoisted(() => ({
  status: 1 as number | null,
  stdout: "",
  stderr: "",
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_cmd: string, _args: string[], _opts: any) => {
    lspState.spawnCallCount++;
    if (lspState.spawnShouldThrow) {
      throw new Error("spawn ENOENT");
    }
    const dataListeners: Array<(d: Buffer) => void> = [];
    const closeListeners: Array<(c: number | null) => void> = [];
    const child: any = {
      stdout: {
        on: (ev: string, cb: any) => {
          if (ev === "data") {
            dataListeners.push(cb);
            if (lspState.autoRespondInitialize) {
              const resp = JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                result: { capabilities: { textDocumentSync: 1 } },
              });
              const header = `Content-Length: ${Buffer.byteLength(resp, "utf8")}\r\n\r\n`;
              process.nextTick(() => cb(Buffer.from(header + resp)));
            }
          }
        },
      },
      stderr: { on: () => {} },
      stdin: { write: () => true, end: () => {} },
      on: (ev: string, cb: any) => {
        if (ev === "close") closeListeners.push(cb);
      },
      kill: () => {
        process.nextTick(() => closeListeners.forEach((cb) => cb(0)));
      },
    };
    return child;
  }),
  spawnSync: vi.fn(() => ({
    status: syncState.status,
    stdout: syncState.stdout,
    stderr: syncState.stderr,
  })),
}));

import { spawnSync } from "node:child_process";
import { analyzeFileWithLsp, isLspAvailable, shutdownLspServers } from "../lspClient.js";

const mockedSpawnSync = vi.mocked(spawnSync);

const originalEnv = { ...process.env };
let tmpTsFile: string;

beforeAll(() => {
  tmpTsFile = path.join(os.tmpdir(), `lsp-mut-test-${process.pid}-${Date.now()}.ts`);
  fs.writeFileSync(tmpTsFile, "const x = 1;\nexport { x };");
});

afterAll(() => {
  try { fs.unlinkSync(tmpTsFile); } catch { /* ignore */ }
});

beforeEach(async () => {
  lspState.spawnShouldThrow = false;
  lspState.autoRespondInitialize = true;
  lspState.spawnCallCount = 0;
  syncState.status = 1;
  syncState.stdout = "";
  syncState.stderr = "";

  process.env.LSP_ENABLED = "true";
  process.env.LSP_TSSERVER_PATH = "/fake/typescript-language-server";
  process.env.LSP_PYLSP_PATH = "/fake/pylsp";
  process.env.LSP_REQUEST_TIMEOUT_MS = "200";

  await shutdownLspServers();
  vi.clearAllMocks();
});

afterEach(async () => {
  await shutdownLspServers();
  process.env = { ...originalEnv };
});

describe("lspClient — envInt mutation killer (L74: `!raw`)", () => {
  it("LSP_REQUEST_TIMEOUT_MS=200 makes initialize timeout in <2000ms (kills `!raw` → `raw`)", async () => {
    // Server does NOT respond to initialize → request times out → tree-sitter fallback.
    lspState.autoRespondInitialize = false;
    process.env.LSP_REQUEST_TIMEOUT_MS = "200";

    const start = Date.now();
    const result = await analyzeFileWithLsp(tmpTsFile);
    const elapsed = Date.now() - start;

    // With correct envInt: timeout=200ms → elapsed ~200-400ms.
    // With mutation (!raw → raw): envInt returns fallback 5000 → elapsed ~5000ms.
    // Threshold 2000ms reliably distinguishes the two.
    expect(result.source).toBe("tree-sitter");
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("lspClient — detectPylspPath mutation killer (L99: `which.status === 0`)", () => {
  it("which pylsp succeeds (status 0, non-empty stdout) → isLspAvailable(python)=true (kills ===0 → !==0)", () => {
    process.env.LSP_ENABLED = "true";
    delete process.env.LSP_PYLSP_PATH;
    // Simulate `which pylsp` finding the binary at /usr/local/bin/pylsp
    mockedSpawnSync.mockImplementationOnce(() => ({
      status: 0,
      stdout: "/usr/local/bin/pylsp\n",
      stderr: "",
    }));

    // With correct code: status===0 && stdout.trim().length>0 → returns path
    // → isLspAvailable(python) = true.
    // Mutation `===0 → !==0`: 0!==0 is false → condition false → returns null
    // → isLspAvailable(python) = false. Test fails. ✓ KILLED.
    expect(isLspAvailable("python")).toBe(true);
  });

  it("which pylsp succeeds with single-char path → isLspAvailable(python)=true (kills `> 0` → `> 1`)", () => {
    process.env.LSP_ENABLED = "true";
    delete process.env.LSP_PYLSP_PATH;
    // A single-character path (e.g. "/x") has trim().length === 1.
    // Mutation `> 0` → `> 1` would reject this (1 > 1 is false) → returns
    // null → isLspAvailable false. Test fails. ✓ KILLED.
    mockedSpawnSync.mockImplementationOnce(() => ({
      status: 0,
      stdout: "x",
      stderr: "",
    }));

    expect(isLspAvailable("python")).toBe(true);
  });

  it("which pylsp fails (status 1) → isLspAvailable(python)=false (confirms baseline)", () => {
    process.env.LSP_ENABLED = "true";
    delete process.env.LSP_PYLSP_PATH;
    mockedSpawnSync.mockImplementationOnce(() => ({
      status: 1,
      stdout: "",
      stderr: "",
    }));

    expect(isLspAvailable("python")).toBe(false);
  });

  it("which pylsp succeeds but stdout empty → isLspAvailable(python)=false (kills `&&` → `||`)", () => {
    process.env.LSP_ENABLED = "true";
    delete process.env.LSP_PYLSP_PATH;
    // status=0 but stdout is empty → correct code: false (&& short-circuits).
    // Mutation `&&` → `||`: status===0 is true → || is true → returns "".
    // Then detectPylspPath returns "" (empty string, truthy in JS but...)
    // Actually: the condition is `which.status === 0 && which.stdout.trim().length > 0`.
    // With `||`: `0 === 0 || "".length > 0` → `true || false` → true → returns
    // `which.stdout.trim()` = "" → detectPylspPath returns "" (falsy) → null.
    // Hmm, "" is falsy, so `if (which.status...) return which.stdout.trim()`
    // returns "" which is falsy → detectPylspPath returns null.
    // Wait, let me re-read: `if (cond) { return which.stdout.trim(); }` — if
    // cond is true (with || mutation), returns "". But "" is returned, not
    // null. detectPylspPath returns "" (empty string).
    // Then in getLspConfig: `pylspPath: detectPylspPath()` → "" (empty string).
    // isLspAvailable: `cfg.pylspPath !== null` → "" !== null → true!
    // So with the mutation, isLspAvailable returns true even when path is "".
    // Correct code: returns null → isLspAvailable false.
    // So this test kills the `&&` → `||` mutation.
    mockedSpawnSync.mockImplementationOnce(() => ({
      status: 0,
      stdout: "   \n",
      stderr: "",
    }));

    // Correct: condition false (stdout.trim().length is 0) → returns null →
    // isLspAvailable false.
    // Mutation `&& → ||`: condition true → returns "" → isLspAvailable true.
    expect(isLspAvailable("python")).toBe(false);
  });
});
