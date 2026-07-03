/**
 * extensions.ts - Skills & MCP (Model Context Protocol) plugin system.
 *
 * MCP Implementation:
 *   Uses JSON-RPC 2.0 over stdio (Content-Length framing) per the MCP spec.
 *   On startup, each configured MCP server is spawned, initialized via the
 *   `initialize` handshake, and queried for available tools via `tools/list`.
 *   Discovered tools are stored and can be invoked via `callMCPTool()`.
 *
 * Skills:
 *   Markdown files with YAML frontmatter loaded from ~/.claude-killer/skills/
 *   and ./.claude-killer/skills/ directories.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";

import os from "node:os";

// --- Types ------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  path: string;
  content: string;
}

export interface MCPConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  autoStart?: boolean;
  /** Platform-specific overrides for command/args */
  platformOverrides?: {
    win32?: { command: string; args?: string[] };
    darwin?: { command: string; args?: string[] };
    linux?: { command: string; args?: string[] };
  };
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  skills?: string[];
  mcpServers?: Record<string, MCPConfig>;
}

/** JSON-RPC 2.0 request envelope */
interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope */
interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition as returned by tools/list */
export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Active MCP server with protocol state */
export interface ActiveMCPServer {
  name: string;
  process: ChildProcess;
  capabilities?: Record<string, unknown>;
  tools: MCPToolDef[];
  nextRequestId: number;
  pendingRequests: Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>;
  buffer: string;
  initialized: boolean;
}

// --- Directory Paths --------------------------------------------------------

const GLOBAL_DIR = path.join(os.homedir(), ".claude-killer");
const LOCAL_DIR = path.join(process.cwd(), ".claude-killer");

// --- State ------------------------------------------------------------------

let activeSkills: Skill[] = [];
let activeMCPServers: Map<string, ActiveMCPServer> = new Map();

// --- Skills (unchanged) ----------------------------------------------------

export function initExtensionDirs() {
  const dirs = [
    path.join(GLOBAL_DIR, "skills"),
    path.join(GLOBAL_DIR, "plugins"),
    path.join(LOCAL_DIR, "skills"),
    path.join(LOCAL_DIR, "plugins"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  const data: Record<string, string> = {};
  if (!match) return { data, body: content };

  const yamlLines = match[1].split("\n");
  for (const line of yamlLines) {
    const parts = line.split(":");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const val = parts.slice(1).join(":").trim().replaceAll(/(^['"])|(['"]$)/g, "");
      data[key] = val;
    }
  }
  return { data, body: match[2] };
}

function loadSkillsFromDir(dirPath: string): Skill[] {
  const skills: Skill[] = [];
  if (!fs.existsSync(dirPath)) return skills;

  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        const skillMd = path.join(fullPath, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, "utf8");
          const { data, body } = parseFrontmatter(content);
          skills.push({
            name: data.name || path.basename(fullPath),
            description: data.description || "Sem descrição",
            path: skillMd,
            content: body.trim(),
          });
        }
      } else if (file.endsWith(".md")) {
        const content = fs.readFileSync(fullPath, "utf8");
        const { data, body } = parseFrontmatter(content);
        skills.push({
          name: data.name || path.basename(file, ".md"),
          description: data.description || "Sem descrição",
          path: fullPath,
          content: body.trim(),
        });
      }
    }
  } catch { /* silently fail */ }

  return skills;
}

function loadPluginSkills(fullPath: string, manifest: PluginManifest): Skill[] {
  const skills: Skill[] = [];
  if (!manifest.skills || !Array.isArray(manifest.skills)) return skills;

  for (const skillRelPath of manifest.skills) {
    const skillPath = path.join(fullPath, skillRelPath);
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, "utf8");
    const { data, body } = parseFrontmatter(content);
    skills.push({
      name: data.name || `${manifest.name}:${path.basename(skillPath, ".md")}`,
      description: data.description || "Sem descrição",
      path: skillPath,
      content: body.trim(),
    });
  }
  return skills;
}

function loadPluginsFromDir(dirPath: string): { skills: Skill[]; mcps: Record<string, MCPConfig> } {
  const result = { skills: [] as Skill[], mcps: {} as Record<string, MCPConfig> };
  if (!fs.existsSync(dirPath)) return result;

  try {
    const pluginDirs = fs.readdirSync(dirPath);
    for (const pluginDir of pluginDirs) {
      const fullPath = path.join(dirPath, pluginDir);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const manifestPath = path.join(fullPath, "plugin.json");
      if (!fs.existsSync(manifestPath)) continue;

      const manifest: PluginManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      result.skills.push(...loadPluginSkills(fullPath, manifest));

      if (manifest.mcpServers) {
        Object.assign(result.mcps, manifest.mcpServers);
      }
    }
  } catch { /* ignore */ }

  return result;
}

// --- MCP Protocol (JSON-RPC 2.0 over stdio) --------------------------------

/**
 * Send a JSON-RPC request to an MCP server via its stdin.
 * Framing: "Content-Length: <n>\r\n\r\n<json body>"
 */
function sendRequest(server: ActiveMCPServer, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = server.nextRequestId++;
    const request: JSONRPCRequest = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(request);
    const message = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;

    server.pendingRequests.set(id, { resolve, reject });

    try {
      server.process.stdin!.write(message);
    } catch (err) {
      server.pendingRequests.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Parse Content-Length framed messages from the server's stdout buffer.
 * Returns an array of parsed JSON-RPC response objects.
 */
function parseMessages(buffer: string): { messages: JSONRPCResponse[]; remaining: string } {
  const messages: JSONRPCResponse[] = [];
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

    if (remaining.length < bodyEnd) break; // incomplete message

    const body = remaining.slice(bodyStart, bodyEnd);
    remaining = remaining.slice(bodyEnd);

    try {
      const parsed = JSON.parse(body) as JSONRPCResponse;
      messages.push(parsed);
    } catch { /* skip malformed messages */ }
  }

  return { messages, remaining };
}

/**
 * Set up stdout line parsing for a server. Buffers data and extracts
 * Content-Length framed JSON-RPC messages.
 */
function setupMessageParser(server: ActiveMCPServer): void {
  server.process.stdout!.on("data", (chunk: Buffer) => {
    server.buffer += chunk.toString();

    const { messages, remaining } = parseMessages(server.buffer);
    server.buffer = remaining;

    for (const msg of messages) {
      if (msg.id !== undefined && server.pendingRequests.has(msg.id)) {
        const pending = server.pendingRequests.get(msg.id)!;
        server.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(`MCP Error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  });
}

/**
 * Initialize an MCP server: send `initialize`, then `notifications/initialized`.
 */
async function initializeServer(server: ActiveMCPServer): Promise<boolean> {
  try {
    const result = await sendRequest(server, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: "claude-killer",
        version: "1.0.0",
      },
    });

    const initResult = result as Record<string, unknown>;
    server.capabilities = initResult.capabilities as Record<string, unknown> | undefined;

    // Send initialized notification (no id = notification)
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const framed = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`;
    server.process.stdin!.write(framed);

    server.initialized = true;
    return true;
  } catch (err) {
    console.error(`[MCP] Failed to initialize server "${server.name}": ${(err as Error).message}`);
    return false;
  }
}

/**
 * Discover tools from an initialized MCP server via `tools/list`.
 */
async function discoverTools(server: ActiveMCPServer): Promise<MCPToolDef[]> {
  try {
    const result = await sendRequest(server, "tools/list");
    const toolsResult = result as { tools?: MCPToolDef[] };
    return toolsResult.tools ?? [];
  } catch (err) {
    console.error(`[MCP] Failed to list tools from "${server.name}": ${(err as Error).message}`);
    return [];
  }
}

/**
 * Start an MCP server, initialize it, and discover its tools.
 */
async function startAndInitMCPServer(name: string, config: MCPConfig): Promise<void> {
  if (activeMCPServers.has(name)) return;

  // Apply platform-specific overrides if available
  const platform = process.platform;
  const override = config.platformOverrides?.[platform as "win32" | "darwin" | "linux"];
  const command = override?.command ?? config.command;
  const args = override?.args ?? config.args ?? [];

  const env = { ...process.env, ...config.env };
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });

  const server: ActiveMCPServer = {
    name,
    process: child,
    tools: [],
    nextRequestId: 1,
    pendingRequests: new Map(),
    buffer: "",
    initialized: false,
  };

  // Set up message parsing before initializing
  setupMessageParser(server);

  child.on("error", (err) => {
    console.error(`[MCP] Server "${name}" spawn error: ${err.message}`);
    activeMCPServers.delete(name);
  });

  child.on("exit", (code) => {
    if (server.initialized) {
      console.error(`[MCP] Server "${name}" exited with code ${code}`);
    }
    activeMCPServers.delete(name);
  });

  activeMCPServers.set(name, server);

  // Initialize and discover tools
  const ok = await initializeServer(server);
  if (ok) {
    server.tools = await discoverTools(server);
    if (server.tools.length > 0) {
      console.error(`[MCP] Server "${name}": discovered ${server.tools.length} tool(s)`);
    }
  }
}

// --- Public API -------------------------------------------------------------

/**
 * Sprint 7: Load MCP configs from a mode's mcps/ directory.
 * Each .json file is an MCP config: { name, command, args, env }
 * or a plugin.json-style { mcpServers: { name: { command, args, env } } }
 */
function loadMCPsFromModeDir(modeName: string): Record<string, MCPConfig> {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const result: Record<string, MCPConfig> = {};

  // Try user's mode dir first
  const dirs = [
    path.join(home, ".claude-killer", "modes", modeName, "mcps"),
    path.join(process.cwd(), "defaults", "modes", modeName, "mcps"),
    path.join(__dirname, "..", "defaults", "modes", modeName, "mcps"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(dir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
          if (content.command) {
            // Simple format: { command, args, env }
            const name = file.replace(/\.json$/, "");
            if (!result[name]) result[name] = content;
          } else if (content.mcpServers) {
            // Plugin format: { mcpServers: { name: { command, args, env } } }
            for (const [name, cfg] of Object.entries(content.mcpServers)) {
              if (!result[name]) result[name] = cfg as MCPConfig;
            }
          } else if (content.name && content.command) {
            // Named format: { name, command, args, env }
            if (!result[content.name]) result[content.name] = content;
          }
        } catch { /* skip invalid JSON */ }
      }
    } catch { /* skip dir */ }
  }

  return result;
}

/**
 * Scans, loads, and initializes all plugins, skills, and MCP servers.
 *
 * Sprint 5: Now also loads skills from the active mode's skills/ folder.
 * Sprint 7: Now also loads MCPs from the active mode's mcps/ folder.
 * Priority: mode-specific > global > local.
 */
export async function loadAllExtensions() {
  initExtensionDirs();

  const globalSkills = loadSkillsFromDir(path.join(GLOBAL_DIR, "skills"));
  const localSkills = loadSkillsFromDir(path.join(LOCAL_DIR, "skills"));

  // Sprint 5: Load skills from the active mode's folder
  let modeSkills: Skill[] = [];
  try {
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    if (mode) {
      // User's mode skills (highest priority)
      const userModeSkillsDir = path.join(GLOBAL_DIR, "modes", mode.name, "skills");
      modeSkills = loadSkillsFromDir(userModeSkillsDir);

      // If user dir is empty, try bundled defaults
      if (modeSkills.length === 0) {
        const bundledDir = path.join(process.cwd(), "defaults", "modes", mode.name, "skills");
        if (fs.existsSync(bundledDir)) {
          modeSkills = loadSkillsFromDir(bundledDir);
        }
        // Also try relative to __dirname (when running from dist/)
        if (modeSkills.length === 0) {
          const distDir = path.join(__dirname, "..", "defaults", "modes", mode.name, "skills");
          if (fs.existsSync(distDir)) {
            modeSkills = loadSkillsFromDir(distDir);
          }
        }
      }
    }
  } catch {
    // modes.js not available — skip mode skills
  }

  // Merge: mode-specific skills override global/local by name
  const allSkills = [...globalSkills, ...localSkills];
  const skillMap = new Map(allSkills.map((s) => [s.name, s]));
  for (const ms of modeSkills) {
    skillMap.set(ms.name, ms); // mode-specific wins
  }
  activeSkills = Array.from(skillMap.values());

  const globalPlugins = loadPluginsFromDir(path.join(GLOBAL_DIR, "plugins"));
  const localPlugins = loadPluginsFromDir(path.join(LOCAL_DIR, "plugins"));
  activeSkills = [...activeSkills, ...globalPlugins.skills, ...localPlugins.skills];

  const mcpConfigs = { ...globalPlugins.mcps, ...localPlugins.mcps };

  // Sprint 7: Load MCPs from the active mode's mcps/ folder
  try {
    const { getActiveMode } = await import("./modes.js");
    const mode = getActiveMode();
    if (mode) {
      const modeMCPs = loadMCPsFromModeDir(mode.name);
      // Mode-specific MCPs override global/local with same name
      Object.assign(mcpConfigs, modeMCPs);
    }
  } catch {
    // modes.js not available — skip mode MCPs
  }

  for (const [name, cfg] of Object.entries(mcpConfigs)) {
    try {
      await startAndInitMCPServer(name, cfg);
    } catch (e) {
      console.error(`[MCP] Failed to start server "${name}": ${(e as Error).message}`);
    }
  }
}

/**
 * Stop all active MCP Server subprocesses.
 */
export function shutdownMCPServers() {
  for (const [, server] of activeMCPServers.entries()) {
    try {
      // Send shutdown notification before killing
      const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" });
      const framed = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`;
      server.process.stdin!.write(framed);
    } catch { /* ignore */ }
    try {
      server.process.kill();
    } catch { /* ignore */ }
  }
  activeMCPServers.clear();
}

/**
 * Get active skills list.
 */
export function getActiveSkills(): Skill[] {
  return activeSkills;
}

/**
 * Get active MCP Servers list (names).
 */
export function getActiveMCPServers(): string[] {
  return Array.from(activeMCPServers.keys());
}

/**
 * Get all tools discovered from all active MCP servers.
 * These are formatted as OpenAI-compatible ChatCompletionTool definitions.
 */
export function getMCPToolDefinitions(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const tools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> = [];

  for (const [serverName, server] of activeMCPServers.entries()) {
    for (const tool of server.tools) {
      // Prefix tool name with server name to avoid collisions
      const prefixedName = `${serverName}__${tool.name}`;
      tools.push({
        type: "function",
        function: {
          name: prefixedName,
          description: tool.description ?? `MCP tool from ${serverName}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      });
    }
  }

  return tools;
}

/**
 * Call an MCP tool by its prefixed name (serverName__toolName).
 * Returns the tool result as a string.
 */
export async function callMCPTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
  const separatorIdx = prefixedName.indexOf("__");
  if (separatorIdx === -1) {
    return `[ERROR] Invalid MCP tool name format: "${prefixedName}". Expected "serverName__toolName".`;
  }

  const serverName = prefixedName.slice(0, separatorIdx);
  const toolName = prefixedName.slice(separatorIdx + 2);

  const server = activeMCPServers.get(serverName);
  if (!server?.initialized) {
    return `[ERROR] MCP server "${serverName}" is not available.`;
  }

  try {
    const result = await sendRequest(server, "tools/call", {
      name: toolName,
      arguments: args,
    });

    const callResult = result as { content?: Array<{ type: string; text?: string }> };
    if (callResult.content && Array.isArray(callResult.content)) {
      return callResult.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
    }

    return JSON.stringify(result);
  } catch (err) {
    return `[ERROR] MCP tool call failed: ${(err as Error).message}`;
  }
}
