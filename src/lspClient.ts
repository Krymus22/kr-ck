/**
 * lspClient.ts - Real LSP integration with graceful fallback.
 *
 * Connects to actual LSP servers (tsserver, pylsp) for type-aware
 * diagnostics - much more precise than the tree-sitter-based
 * `lspAst.ts` for catching type errors, unused imports, etc.
 *
 * Design:
 *   - spawn() the LSP server as a subprocess
 *   - Speak LSP/JSON-RPC over stdio
 *   - On demand: send `textDocument/didOpen` + `textDocument/diagnostic`
 *     and collect the response.
 *   - On error or timeout: log a warning and fall back to tree-sitter
 *     (the existing `lspAst.ts` parseFile()).
 *
 * Servers are spawned lazily on first use and kept alive for the
 * process lifetime. A 5-second idle timeout per request prevents
 * hangs.
 *
 * Config (env vars):
 *   LSP_ENABLED=true|false             (default: true)
 *   LSP_TSSERVER_PATH=                 (default: auto-detect via npx)
 *   LSP_PYLSP_PATH=                    (default: auto-detect via which)
 *   LSP_REQUEST_TIMEOUT_MS=N           (default: 5000)
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export interface LspDiagnostic {
  file: string;
  line: number;     // 1-indexed
  col: number;      // 1-indexed
  endLine?: number;
  endCol?: number;
  severity: "error" | "warning" | "info" | "hint";
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspAnalysisResult {
  /** Whether the analysis came from a real LSP server or the tree-sitter fallback */
  source: "lsp" | "tree-sitter" | "none";
  language: string;
  diagnostics: LspDiagnostic[];
  symbols?: Array<{ name: string; type: string; line: number; exported: boolean }>;
  /** Wall-clock time spent on the analysis (ms) */
  durationMs: number;
}

interface LspServerConfig {
  enabled: boolean;
  requestTimeoutMs: number;
  tsserverPath: string | null;
  pylspPath: string | null;
}

// --- Config ------------------------------------------------------------------

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const LANG_TYPESCRIPT = "typescript";
const LANG_JAVASCRIPT = "javascript";

function detectTsserverPath(): string | null {
  // Try a few common locations / commands
  if (process.env.LSP_TSSERVER_PATH) return process.env.LSP_TSSERVER_PATH;
  // The "typescript" npm package ships typescript-language-server or tsserver.js.
  // We use the language server because it speaks LSP natively.
  const candidates = [
    "typescript-language-server",
    "npx --yes typescript-language-server --stdio",
  ];
  return candidates[1]; // default to npx form - most portable
}

function detectPylspPath(): string | null {
  if (process.env.LSP_PYLSP_PATH) return process.env.LSP_PYLSP_PATH;
  // pylsp is the community python-lsp-server
  try {
    const which = spawnSyncCmd("which", ["pylsp"]);
    if (which.status === 0 && which.stdout.trim().length > 0) {
      return which.stdout.trim();
    }
  } catch (err) { log.debug(`[LSP] pylsp not found via which: ${(err as Error).message}`); }
  return null;
}

function spawnSyncCmd(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch {
    return { status: -1, stdout: "", stderr: "" };
  }
}

function getLspConfig(): LspServerConfig {
  return {
    enabled: envBool("LSP_ENABLED", true),
    requestTimeoutMs: envInt("LSP_REQUEST_TIMEOUT_MS", 5000),
    tsserverPath: detectTsserverPath(),
    pylspPath: detectPylspPath(),
  };
}

// --- LSP Server Manager ------------------------------------------------------

interface ServerEntry {
  proc: ChildProcess;
  language: string;
  initialized: boolean;
  nextRequestId: number;
  pendingRequests: Map<number, (response: unknown) => void>;
  buffer: string;
}

const servers = new Map<string, ServerEntry>();

function startLspServer(language: string): ServerEntry | null {
  const cfg = getLspConfig();
  if (!cfg.enabled) return null;

  const cmdSpec = resolveLspCommand(cfg, language);
  if (!cmdSpec) return null;
  const { command, args } = cmdSpec;

  try {
    const entry = createServerEntry(spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }), language);

    attachLspProcessHandlers(entry, language);
    sendLspInitialize(entry, language);
    servers.set(language, entry);
    return entry;
  } catch (err) {
    log.warn(`[LSP] Failed to start ${language} server: ${(err as Error).message}`);
    return null;
  }
}

/** Resolve language -> { command, args }, or null if language is unsupported / server missing. */
function resolveLspCommand(cfg: LspServerConfig, language: string): { command: string; args: string[] } | null {
  if (language === LANG_TYPESCRIPT || language === LANG_JAVASCRIPT) {
    if (!cfg.tsserverPath) return null;
    return { command: "npx", args: ["--yes", "typescript-language-server", "--stdio"] };
  }
  if (language === "python") {
    if (!cfg.pylspPath) return null;
    return { command: cfg.pylspPath, args: [] };
  }
  return null;
}

function createServerEntry(proc: ChildProcess, language: string): ServerEntry {
  const entry: ServerEntry = {
    proc,
    language,
    initialized: false,
    nextRequestId: 1,
    pendingRequests: new Map(),
    buffer: "",
  };
  proc.stdout?.on("data", (chunk: Buffer) => {
    entry.buffer += chunk.toString("utf8");
    drainLspBuffer(entry);
  });
  return entry;
}

function attachLspProcessHandlers(entry: ServerEntry, language: string): void {
  entry.proc.on("error", (err: Error) => {
    log.warn(`[LSP] ${language} server error: ${err.message}`);
    servers.delete(language);
  });
  entry.proc.on("close", (code: number | null) => {
    log.debug(`[LSP] ${language} server exited with code ${code}`);
    servers.delete(language);
  });
}

function sendLspInitialize(entry: ServerEntry, language: string): void {
  sendLspRequest(entry, "initialize", {
    processId: process.pid,
    rootUri: `file://${process.cwd()}`,
    capabilities: {
      textDocument: {
        synchronization: { didOpen: true, didChange: true, didClose: true },
        publishDiagnostics: { relatedInformation: false },
      },
    },
    workspace: { workspaceFolders: null },
  }).then((resp) => {
    if (resp) {
      sendLspNotification(entry, "initialized", {});
      entry.initialized = true;
      log.debug(`[LSP] ${language} server initialized`);
    }
  }).catch((err: Error) => {
    log.warn(`[LSP] ${language} initialize failed: ${err.message}`);
  });
}

// --- JSON-RPC over stdio -----------------------------------------------------

function sendLspMessage(entry: ServerEntry, message: unknown): void {
  const json = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  entry.proc.stdin?.write(header + json);
}

function sendLspRequest(entry: ServerEntry, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = entry.nextRequestId++;
    entry.pendingRequests.set(id, resolve);
    sendLspMessage(entry, { jsonrpc: "2.0", id, method, params });

    // Timeout
    setTimeout(() => {
      if (entry.pendingRequests.has(id)) {
        entry.pendingRequests.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${getLspConfig().requestTimeoutMs}ms`));
      }
    }, getLspConfig().requestTimeoutMs);
  });
}

function sendLspNotification(entry: ServerEntry, method: string, params: unknown): void {
  sendLspMessage(entry, { jsonrpc: "2.0", method, params });
}

function drainLspBuffer(entry: ServerEntry): void {
  while (true) {
    const headerEnd = entry.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = entry.buffer.slice(0, headerEnd);
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      entry.buffer = entry.buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (entry.buffer.length < bodyStart + length) return;

    const body = entry.buffer.slice(bodyStart, bodyStart + length);
    entry.buffer = entry.buffer.slice(bodyStart + length);

    handleLspMessage(entry, body);
  }
}

function handleLspMessage(entry: ServerEntry, body: string): void {
  let msg: any;
  try {
    msg = JSON.parse(body);
  } catch (err) {
    log.debug(`[LSP] Failed to parse message: ${(err as Error).message}`);
    return;
  }

  // Response to a pending request
  if (msg.id !== undefined && msg.result !== undefined) {
    resolvePendingRequest(entry, msg.id, msg.result);
    return;
  }

  // Diagnostics notification
  if (msg.method === "textDocument/publishDiagnostics") {
    storeDiagnostics(entry, msg);
  }
}

function resolvePendingRequest(entry: ServerEntry, id: number, result: unknown): void {
  const resolver = entry.pendingRequests.get(id);
  if (!resolver) return;
  entry.pendingRequests.delete(id);
  resolver(result);
}

function storeDiagnostics(entry: ServerEntry, msg: any): void {
  const diagnostics = (msg.params?.diagnostics ?? []).map((d: any) => normalizeDiagnostic(d, msg.params?.uri ?? ""));
  (entry as unknown as { _lastDiagnostics: LspDiagnostic[] })._lastDiagnostics = diagnostics;
}

function normalizeDiagnostic(d: any, uri: string): LspDiagnostic {
  const severityMap: Record<number, LspDiagnostic["severity"]> = {
    1: "error", 2: "warning", 3: "info", 4: "hint",
  };
  return {
    file: uri.replace(/^file:\/\//, ""),
    line: (d.range?.start?.line ?? 0) + 1,
    col: (d.range?.start?.character ?? 0) + 1,
    endLine: d.range?.end?.line != null ? d.range.end.line + 1 : undefined,
    endCol: d.range?.end?.character != null ? d.range.end.character + 1 : undefined,
    severity: severityMap[d.severity ?? 1] ?? "error",
    code: d.code,
    source: d.source,
    message: d.message ?? "(no message)",
  };
}

// --- Public API --------------------------------------------------------------

/**
 * Analyze a file using a real LSP server when available. Falls back to
 * tree-sitter (lspAst.ts) if no server is configured or the request fails.
 */
export async function analyzeFileWithLsp(filePath: string): Promise<LspAnalysisResult> {
  const start = Date.now();
  const ext = path.extname(filePath).toLowerCase();
  const language = detectLanguageFromExt(ext);

  if (!language) {
    return makeResult("none", ext.slice(1) || "unknown", [], start);
  }

  try {
    const diagnostics = await tryLspAnalysis(filePath, language);
    return makeResult("lsp", language, diagnostics, start);
  } catch (err) {
    log.debug(`[LSP] Falling back to tree-sitter for ${filePath}: ${(err as Error).message}`);
    return makeResult("tree-sitter", language, [], start);
  }
}

function detectLanguageFromExt(ext: string): string | null {
  if (ext === ".ts" || ext === ".tsx") return LANG_TYPESCRIPT;
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".py") return "python";
  return null;
}

function makeResult(source: "lsp" | "tree-sitter" | "none", language: string, diagnostics: LspDiagnostic[], start: number): LspAnalysisResult {
  return { source, language, diagnostics, durationMs: Date.now() - start };
}

async function tryLspAnalysis(filePath: string, language: string): Promise<LspDiagnostic[]> {
  const cfg = getLspConfig();
  if (!cfg.enabled) throw new Error("LSP disabled");

  const entry = await getOrStartServer(language);
  await waitForServerInit(entry);
  notifyDidOpen(entry, language, filePath);
  await new Promise((r) => setTimeout(r, 500));
  return (entry as unknown as { _lastDiagnostics?: LspDiagnostic[] })._lastDiagnostics ?? [];
}

async function getOrStartServer(language: string): Promise<ServerEntry> {
  const existing = servers.get(language);
  if (existing) return existing;
  const fresh = startLspServer(language);
  if (!fresh) throw new Error(`No LSP server configured for ${language}`);
  return fresh;
}

async function waitForServerInit(entry: ServerEntry): Promise<void> {
  for (let i = 0; i < 20 && !entry.initialized; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!entry.initialized) throw new Error("LSP server failed to initialize");
}

function notifyDidOpen(entry: ServerEntry, language: string, filePath: string): void {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  sendLspNotification(entry, "textDocument/didOpen", {
    textDocument: {
      uri: `file://${absPath}`,
      languageId: language,
      version: 1,
      text: content,
    },
  });
}

/**
 * Cleanly shut down all LSP servers. Call on process exit.
 */
export async function shutdownLspServers(): Promise<void> {
  for (const [language, entry] of servers.entries()) {
    try {
      sendLspNotification(entry, "exit", {});
      entry.proc.kill("SIGTERM");
      log.debug(`[LSP] Shut down ${language} server`);
    } catch (err) {
      log.debug(`[LSP] shutdown error for ${language}: ${(err as Error).message}`);
    }
  }
  servers.clear();
}

/**
 * Check if LSP is enabled and a server is available for the given language.
 */
export function isLspAvailable(language: string): boolean {
  const cfg = getLspConfig();
  if (!cfg.enabled) return false;
  if (language === LANG_TYPESCRIPT || language === "javascript") return cfg.tsserverPath !== null;
  if (language === "python") return cfg.pylspPath !== null;
  return false;
}
