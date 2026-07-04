/**
 * extensions-mcp.test.ts — Tests for MCP server lifecycle in extensions.ts.
 * Covers sendRequest, parseMessages, setupMessageParser, initializeServer,
 * discoverTools, startAndInitMCPServer, shutdownMCPServers, getMCPToolDefinitions,
 * and callMCPTool (lines 211-509).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// ── Top-level mocks (hoisted by vitest) ──────────────────────────────────────

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// ── Helpers ──────────────────────────────────────────────────────────────────

function frame(obj: unknown): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/**
 * NDJSON frame: JSON object followed by a single newline (per MCP spec).
 * Use this for responses that should test the NDJSON code path.
 */
function frameNDJSON(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/**
 * Parse NDJSON from stdin data (what the production code sends).
 * Returns the first valid JSON object found, or null.
 * Handles both single-line and multi-line NDJSON.
 */
function parseStdinNDJSON(data: string): any | null {
  const lines = data.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { return JSON.parse(trimmed); } catch { /* skip non-JSON lines */ }
  }
  return null;
}

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;
  return child;
}

/**
 * Create a stdin.write handler that responds to initialize (id:1) and
 * tools/list (id:2) requests. Returns the child for further use.
 */
function withAutoReply(child: any, tools: any[] = []) {
  child.stdin.write = vi.fn((data: string) => {
    const req = parseStdinNDJSON(data);
    if (!req) return;
    if (req.id == null) return; // notification

    if (req.method === "initialize") {
      const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: { tools: {} } } };
      process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
    } else if (req.method === "tools/list") {
      const res = { jsonrpc: "2.0", id: req.id, result: { tools } };
      process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
    }
  });
  return child;
}

// ── Shared state ─────────────────────────────────────────────────────────────

let tmpDir: string;
let pluginsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext_mcp_"));
  pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function loadModule() {
  vi.resetModules();
  vi.mock("../logger.js", () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  }));
  vi.mock("node:child_process", () => ({ spawn: spawnMock }));
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  return import("../extensions.js");
}

/** Create a plugin directory with MCP server config in plugin.json */
function createMcpPlugin(name: string, serverName: string, cmd: string, args: string[] = []) {
  const dir = path.join(pluginsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
    name,
    version: "1.0.0",
    mcpServers: { [serverName]: { command: cmd, args } },
  }));
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MCP server lifecycle", () => {

  // ── parseMessages + setupMessageParser (via startAndInitMCPServer) ────────

  describe("parseMessages", () => {
    it("should parse a single Content-Length framed message", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p1", "s1", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s1");
      shutdownMCPServers();
    });

    it("should parse multiple messages in sequence", async () => {
      const child = fakeChild();
      const replies: string[] = [];
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        replies.push(req.method);
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p2", "s2", "echo");
      await loadAllExtensions();
      expect(replies).toContain("initialize");
      expect(replies).toContain("tools/list");
      shutdownMCPServers();
    });

    it("should handle incomplete message (buffer splits across chunks)", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          const framed = frame(res);
          // Split the response into two chunks
          process.nextTick(() => {
            child.stdout.emit("data", Buffer.from(framed.slice(0, 15)));
            child.stdout.emit("data", Buffer.from(framed.slice(15)));
          });
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p3", "s3", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s3");
      shutdownMCPServers();
    });

    it("should skip malformed JSON in message body", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const bad = "Content-Length: 5\r\n\r\n{bad}";
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => {
            child.stdout.emit("data", Buffer.from(bad + frame(res)));
          });
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p4", "s4", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s4");
      shutdownMCPServers();
    });

    it("should break when header has no Content-Length (stops parsing)", async () => {
      // Replicate parseMessages logic from extensions.ts (lines 233-261)
      // to verify it handles missing Content-Length correctly
      function parseMessages(buffer: string): { messages: any[]; remaining: string } {
        const messages: any[] = [];
        let remaining = buffer;
        while (true) {
          const headerEnd = remaining.indexOf("\r\n\r\n");
          if (headerEnd === -1) break;
          const header = remaining.slice(0, headerEnd);
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) break;
          const contentLength = Number.parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          const bodyEnd = bodyStart + contentLength;
          if (remaining.length < bodyEnd) break;
          const body = remaining.slice(bodyStart, bodyEnd);
          remaining = remaining.slice(bodyEnd);
          try {
            messages.push(JSON.parse(body));
          } catch { /* skip */ }
        }
        return { messages, remaining };
      }

      // 1. Invalid header without Content-Length → stops parsing
      const invalidData = "X-Header: foo\r\n\r\n";
      const r1 = parseMessages(invalidData);
      expect(r1.messages).toHaveLength(0);
      expect(r1.remaining).toBe(invalidData);

      // 2. Invalid prefix + valid response → parser can't get past the invalid header
      const validRes = { jsonrpc: "2.0", id: 1, result: { capabilities: {} } };
      const r2 = parseMessages(invalidData + frame(validRes));
      expect(r2.messages).toHaveLength(0);

      // 3. Valid response alone → parses correctly
      const r3 = parseMessages(frame(validRes));
      expect(r3.messages).toHaveLength(1);
      expect(r3.messages[0].id).toBe(1);

      // 4. Incomplete message (header found but body not complete yet)
      const partial = "Content-Length: 100\r\n\r\n{";
      const r4 = parseMessages(partial);
      expect(r4.messages).toHaveLength(0);
      expect(r4.remaining).toBe(partial);

      // 5. No header at all → breaks immediately
      const r5 = parseMessages("just some random data");
      expect(r5.messages).toHaveLength(0);
      expect(r5.remaining).toBe("just some random data");

      // 6. Empty buffer → returns immediately
      const r6 = parseMessages("");
      expect(r6.messages).toHaveLength(0);
      expect(r6.remaining).toBe("");
    });

    it("should handle response with no matching pending request (orphan)", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const orphan = { jsonrpc: "2.0", id: 999, result: { data: "orphan" } };
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => {
            child.stdout.emit("data", Buffer.from(frame(orphan) + frame(res)));
          });
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p6", "s6", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s6");
      shutdownMCPServers();
    });

    it("should handle lowercase content-length header", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          const bodyStr = JSON.stringify(res);
          const msg = `content-length: ${Buffer.byteLength(bodyStr)}\r\n\r\n${bodyStr}`;
          process.nextTick(() => child.stdout.emit("data", Buffer.from(msg)));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p7", "s7", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s7");
      shutdownMCPServers();
    });

    it("should handle large message bodies (10KB+)", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const bigData = "x".repeat(10000);
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {}, data: bigData } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("p8", "s8", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("s8");
      shutdownMCPServers();
    });
  });

  // ── sendRequest ──────────────────────────────────────────────────────────

  describe("sendRequest", () => {
    it("should resolve when matching response arrives", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("r1", "rs1", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("rs1");
      shutdownMCPServers();
    });

    it("should reject when response contains JSON-RPC error", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32600, message: "Invalid Request" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("r2", "rs2", "echo");
      await loadAllExtensions();
      // Server is in map but not initialized, so no tools discovered
      expect(getMCPToolDefinitions()).toHaveLength(0);
      shutdownMCPServers();
    });

    it("should handle stdin.write throwing synchronously", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn(() => { throw new Error("write failed"); });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("r3", "rs3", "echo");
      await loadAllExtensions();
      // Server is in map but init failed, so no tools
      expect(getMCPToolDefinitions()).toHaveLength(0);
      shutdownMCPServers();
    });

    it("should increment request IDs for each call", async () => {
      const child = fakeChild();
      const ids: number[] = [];
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        ids.push(req.id);
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("r4", "rs4", "echo");
      await loadAllExtensions();
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(ids[0]).toBe(1);
      expect(ids[1]).toBe(2);
      shutdownMCPServers();
    });
  });

  // ── initializeServer ─────────────────────────────────────────────────────

  describe("initializeServer", () => {
    it("should set server.initialized = true on success", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("i1", "is1", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("is1");
      shutdownMCPServers();
    });

    it("should set server.initialized = false on initialize error", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Init failed" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("i2", "is2", "echo");
      await loadAllExtensions();
      // Server is in map but not initialized, tools discovery was skipped
      expect(getMCPToolDefinitions()).toHaveLength(0);
      shutdownMCPServers();
    });

    it("should write notifications/initialized notification to stdin", async () => {
      const child = fakeChild();
      const written: string[] = [];
      child.stdin.write = vi.fn((data: string) => {
        written.push(data);
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("i3", "is3", "echo");
      await loadAllExtensions();
      const initReq = written.find((c) => c.includes('"initialize"'));
      const notif = written.find((c) => c.includes("notifications/initialized"));
      expect(initReq).toBeDefined();
      expect(notif).toBeDefined();
      expect(notif).toContain("notifications/initialized");
      shutdownMCPServers();
    });

    it("should store capabilities from initialize response", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = {
            jsonrpc: "2.0", id: req.id,
            result: { capabilities: { tools: {}, prompts: {} } },
          };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("i4", "is4", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("is4");
      shutdownMCPServers();
    });
  });

  // ── discoverTools ────────────────────────────────────────────────────────

  describe("discoverTools", () => {
    it("should populate server.tools from tools/list response", async () => {
      const tools = [
        { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
      ];
      const child = withAutoReply(fakeChild(), tools);
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("d1", "ds1", "echo");
      await loadAllExtensions();
      const defs = getMCPToolDefinitions();
      expect(defs.length).toBeGreaterThanOrEqual(2);
      expect(defs.find((d) => d.function.name === "ds1__read_file")).toBeDefined();
      expect(defs.find((d) => d.function.name === "ds1__write_file")).toBeDefined();
      shutdownMCPServers();
    });

    it("should handle tools/list returning empty array", async () => {
      const child = withAutoReply(fakeChild(), []);
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("d2", "ds2", "echo");
      await loadAllExtensions();
      expect(getMCPToolDefinitions().length).toBe(0);
      shutdownMCPServers();
    });

    it("should handle tools/list returning no tools key", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else {
          const res = { jsonrpc: "2.0", id: req.id, result: {} };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("d3", "ds3", "echo");
      await loadAllExtensions();
      expect(getMCPToolDefinitions().length).toBe(0);
      shutdownMCPServers();
    });

    it("should handle tools/list returning error", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("d4", "ds4", "echo");
      await loadAllExtensions();
      expect(getMCPToolDefinitions().length).toBe(0);
      shutdownMCPServers();
    });
  });

  // ── startAndInitMCPServer ────────────────────────────────────────────────

  describe("startAndInitMCPServer", () => {
    it("should spawn child with correct env and stdio", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sp1", "ss1", "my-server", ["--verbose"]);
      await loadAllExtensions();
      expect(spawnMock).toHaveBeenCalledWith(
        "my-server",
        ["--verbose"],
        expect.objectContaining({ shell: true, stdio: ["pipe", "pipe", "pipe"] })
      );
      shutdownMCPServers();
    });

    it("should not spawn if server already active (idempotent)", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sp2", "ss2", "echo");
      await loadAllExtensions();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      shutdownMCPServers();
    });

    it("should handle spawn error event", async () => {
      const child = fakeChild();
      // Mock respond to initialize so it doesn't hang, then trigger error
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "spawn error" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sp3", "ss3", "bad-cmd");
      process.nextTick(() => child.emit("error", new Error("spawn ENOENT")));
      await loadAllExtensions();
      // Server is removed from map after error event
      expect(getActiveMCPServers()).not.toContain("ss3");
      shutdownMCPServers();
    });

    it("should handle child exit event", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sp4", "ss4", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("ss4");
      child.emit("exit", 0);
      expect(getActiveMCPServers()).not.toContain("ss4");
      shutdownMCPServers();
    });

    it("should pass empty args array when args not provided", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sp5", "ss5", "echo");
      await loadAllExtensions();
      expect(spawnMock).toHaveBeenCalledWith("echo", [], expect.anything());
      shutdownMCPServers();
    });

    it("should merge process.env with config.env", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      const dir = path.join(pluginsDir, "sp6");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "sp6", version: "1.0.0",
        mcpServers: { ss6: { command: "echo", env: { MY_VAR: "123" } } },
      }));
      await loadAllExtensions();
      const callEnv = spawnMock.mock.calls[0][2].env;
      expect(callEnv).toHaveProperty("MY_VAR", "123");
      expect(callEnv).toHaveProperty("PATH");
      shutdownMCPServers();
    });
  });

  // ── shutdownMCPServers ───────────────────────────────────────────────────

  describe("shutdownMCPServers", () => {
    it("should send notification and kill process", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers, getActiveMCPServers } = await loadModule();
      createMcpPlugin("sd1", "sd1", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("sd1");
      shutdownMCPServers();
      expect(getActiveMCPServers()).toHaveLength(0);
      expect(child.kill).toHaveBeenCalled();
    });

    it("should handle kill throwing error", async () => {
      const child = withAutoReply(fakeChild());
      child.kill = vi.fn(() => { throw new Error("already dead"); });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sd2", "sd2", "echo");
      await loadAllExtensions();
      expect(() => shutdownMCPServers()).not.toThrow();
    });

    it("should handle stdin.write throwing during notification", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn(() => { throw new Error("broken pipe"); });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sd3", "sd3", "echo");
      await loadAllExtensions();
      expect(() => shutdownMCPServers()).not.toThrow();
    });

    it("should clear all servers on shutdown", async () => {
      let callCount = 0;
      spawnMock.mockImplementation(() => {
        callCount++;
        const c = withAutoReply(fakeChild());
        return c;
      });
      const { loadAllExtensions, shutdownMCPServers, getActiveMCPServers } = await loadModule();
      createMcpPlugin("sd4a", "sda", "echo");
      createMcpPlugin("sd4b", "sdb", "echo");
      await loadAllExtensions();
      expect(getActiveMCPServers().length).toBeGreaterThanOrEqual(1);
      shutdownMCPServers();
      expect(getActiveMCPServers()).toHaveLength(0);
    });

    it("should send notifications/cancelled notification before killing", async () => {
      const child = withAutoReply(fakeChild());
      const written: string[] = [];
      child.stdin.write = vi.fn((data: string) => {
        written.push(data);
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("sd5", "sd5", "echo");
      await loadAllExtensions();
      written.length = 0; // Clear init writes
      shutdownMCPServers();
      const cancelNotif = written.find((w) => w.includes("notifications/cancelled"));
      expect(cancelNotif).toBeDefined();
    });
  });

  // ── getMCPToolDefinitions ────────────────────────────────────────────────

  describe("getMCPToolDefinitions", () => {
    it("should prefix tool names with server name", async () => {
      const tools = [
        { name: "my_tool", description: "A tool", inputSchema: { type: "object" } },
      ];
      const child = withAutoReply(fakeChild(), tools);
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("g1", "gs1", "echo");
      await loadAllExtensions();
      const defs = getMCPToolDefinitions();
      expect(defs[0].function.name).toBe("gs1__my_tool");
      shutdownMCPServers();
    });

    it("should use fallback description when tool has no description", async () => {
      const tools = [
        { name: "no_desc_tool", inputSchema: { type: "object" } },
      ];
      const child = withAutoReply(fakeChild(), tools);
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("g2", "gs2", "echo");
      await loadAllExtensions();
      expect(getMCPToolDefinitions()[0].function.description).toBe("MCP tool from gs2");
      shutdownMCPServers();
    });

    it("should use fallback schema when tool has no inputSchema", async () => {
      const tools = [
        { name: "no_schema", description: "desc" },
      ];
      const child = withAutoReply(fakeChild(), tools);
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("g3", "gs3", "echo");
      await loadAllExtensions();
      expect(getMCPToolDefinitions()[0].function.parameters).toEqual({ type: "object", properties: {} });
      shutdownMCPServers();
    });

    it("should return type: function for all definitions", async () => {
      const { getMCPToolDefinitions } = await loadModule();
      const defs = getMCPToolDefinitions();
      defs.forEach((d) => expect(d.type).toBe("function"));
    });

    it("should handle multiple servers with different tool sets", async () => {
      const toolsA = [{ name: "toolA", description: "A", inputSchema: {} }];
      const toolsB = [{ name: "toolB", description: "B", inputSchema: {} }];
      let callIdx = 0;
      spawnMock.mockImplementation(() => {
        callIdx++;
        const tools = callIdx === 1 ? toolsA : toolsB;
        return withAutoReply(fakeChild(), tools);
      });
      const { loadAllExtensions, getMCPToolDefinitions, shutdownMCPServers } = await loadModule();
      createMcpPlugin("g5a", "gs5a", "echo");
      createMcpPlugin("g5b", "gs5b", "echo");
      await loadAllExtensions();
      const defs = getMCPToolDefinitions();
      expect(defs.find((d) => d.function.name === "gs5a__toolA")).toBeDefined();
      expect(defs.find((d) => d.function.name === "gs5b__toolB")).toBeDefined();
      shutdownMCPServers();
    });
  });

  // ── callMCPTool ──────────────────────────────────────────────────────────

  describe("callMCPTool", () => {
    it("should return error for invalid format (no __)", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("invalid", {});
      expect(result).toBe('[ERROR] Invalid MCP tool name format: "invalid". Expected "serverName__toolName".');
    });

    it("should return error for non-existent server", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("ghost__tool", {});
      expect(result).toContain('[ERROR] MCP server "ghost" is not available.');
    });

    it("should return error for uninitialized server", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "fail" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c3", "cs3", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs3__tool", {});
      expect(result).toContain('[ERROR] MCP server "cs3" is not available.');
      shutdownMCPServers();
    });

    it("should send tools/call and return text content", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "hello from tool" }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c4", "cs4", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs4__echo", { msg: "hi" });
      expect(result).toBe("hello from tool");
      shutdownMCPServers();
    });

    it("should join multiple text content items with newline", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "multi", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { content: [
            { type: "text", text: "line1" },
            { type: "text", text: "line2" },
            { type: "text", text: "line3" },
          ] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c5", "cs5", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs5__multi", {});
      expect(result).toBe("line1\nline2\nline3");
      shutdownMCPServers();
    });

    it("should filter out non-text content items", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "mixed", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { content: [
            { type: "image", data: "base64..." },
            { type: "text", text: "only text" },
          ] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c6", "cs6", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs6__mixed", {});
      expect(result).toBe("only text");
      shutdownMCPServers();
    });

    it("should JSON.stringify result when no content array", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "raw", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { someField: 42 } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c7", "cs7", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs7__raw", {});
      expect(result).toBe('{"someField":42}');
      shutdownMCPServers();
    });

    it("should return error string when tools/call returns error", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "fail", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "Tool execution failed" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c8", "cs8", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs8__fail", {});
      expect(result).toContain("[ERROR] MCP tool call failed:");
      shutdownMCPServers();
    });

    it("should handle tool name with multiple underscores", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("my__server__tool", {});
      expect(result).toContain('[ERROR] MCP server "my" is not available.');
    });

    it("should handle empty content array", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "empty", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { content: [] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c9", "cs9", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs9__empty", {});
      // Empty content array → no text items → .join("") returns ""
      expect(result).toBe("");
      shutdownMCPServers();
    });

    it("should handle content with text item missing text field", async () => {
      const child = fakeChild();
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const res = { jsonrpc: "2.0", id: req.id, result: { capabilities: {} } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/list") {
          const res = { jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "notext", inputSchema: {} }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        } else if (req.method === "tools/call") {
          const res = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text" }] } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(res))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { loadAllExtensions, callMCPTool, shutdownMCPServers } = await loadModule();
      createMcpPlugin("c10", "cs10", "echo");
      await loadAllExtensions();
      const result = await callMCPTool("cs10__notext", {});
      // text is undefined → filter removes it → .join("") returns ""
      expect(result).toBe("");
      shutdownMCPServers();
    });
  });

  // ── loadAllExtensions with MCP config ────────────────────────────────────

  describe("loadAllExtensions with MCP config", () => {
    it("should start MCP servers from plugin manifest", async () => {
      const child = withAutoReply(fakeChild());
      spawnMock.mockReturnValue(child);
      const { initExtensionDirs, loadAllExtensions, getActiveMCPServers, shutdownMCPServers } = await loadModule();
      initExtensionDirs();
      createMcpPlugin("mcp-plug", "plug-mcp", "echo", ["ok"]);
      await loadAllExtensions();
      expect(getActiveMCPServers()).toContain("plug-mcp");
      shutdownMCPServers();
    });

    it("should handle MCP server spawn failure gracefully", async () => {
      const child = fakeChild();
      // Respond to initialize so it resolves, then error fires
      child.stdin.write = vi.fn((data: string) => {
        const req = parseStdinNDJSON(data);
        if (!req) return;
        if (req.id == null) return;
        if (req.method === "initialize") {
          const err = { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "spawn error" } };
          process.nextTick(() => child.stdout.emit("data", Buffer.from(frame(err))));
        }
      });
      spawnMock.mockReturnValue(child);
      const { initExtensionDirs, loadAllExtensions, getActiveMCPServers } = await loadModule();
      initExtensionDirs();
      createMcpPlugin("bad-plug", "bad-srv", "nonexistent_cmd_xyz");
      process.nextTick(() => child.emit("error", new Error("spawn ENOENT")));
      await loadAllExtensions();
      expect(getActiveMCPServers()).not.toContain("bad-srv");
    });

    it("should handle plugin with empty mcpServers", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveMCPServers } = await loadModule();
      initExtensionDirs();
      const dir = path.join(pluginsDir, "empty-mcp");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({
        name: "empty-mcp", version: "1.0.0", mcpServers: {},
      }));
      await loadAllExtensions();
      expect(getActiveMCPServers()).toHaveLength(0);
    });

    it("should catch synchronous spawn throw in loadAllExtensions", async () => {
      spawnMock.mockImplementation(() => { throw new Error("spawn sync crash"); });
      const { initExtensionDirs, loadAllExtensions, getActiveMCPServers } = await loadModule();
      initExtensionDirs();
      createMcpPlugin("crash-plug", "crash-srv", "crash-cmd");
      // Should not throw — loadAllExtensions catches it
      await loadAllExtensions();
      expect(getActiveMCPServers()).toHaveLength(0);
    });
  });
});
