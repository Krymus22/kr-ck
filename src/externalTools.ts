/**
 * externalTools.ts - Framework for external CLI tools
 * 
 * This module provides a unified interface for invoking external tools
 * like Rojo, Wally, pytest, cargo, npm, etc. Tools are self-describing
 * and can be added dynamically by the AI itself.
 * 
 * Architecture:
 * - Tool: Interface for external tool definitions
 * - ToolRegistry: Central registry for all tools
 * - ToolDetector: Detects tools via binary, config, or package detection
 * - ToolExecutor: Executes tools with proper error handling
 * - ToolSuggester: Suggests tools based on user intent
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export type ToolCategory = 
  | "roblox" 
  | "python" 
  | "node" 
  | "rust" 
  | "go" 
  | "docker" 
  | "system"
  | "custom";

export type ToolFlagType = "string" | "number" | "boolean";

export interface ToolFlag {
  name: string;
  type: ToolFlagType;
  required?: boolean;
  default?: any;
  description?: string;
}

export type DetectionMethod = "binary" | "config" | "package" | "manual";

export interface ToolDetection {
  method: DetectionMethod;
  check: string;                    // Command or file to check
  installed?: boolean;              // Cache status
  lastChecked?: number;             // Timestamp of last check
  binaryPath?: string | null;       // Path where binary was found (from toolDetector)
  version?: string | null;          // Version string (from toolDetector)
}

export interface ToolContext {
  whenToUse: string[];              // Intent patterns
  requiresProject?: string[];       // Required config files
  examples: string[];               // Example commands
}

export interface ToolResult {
  success: boolean;
  output: string;
  errors?: string[];
  suggestions?: string[];
  metadata?: Record<string, any>;
  exitCode?: number;
  duration?: number;
}

export interface Tool {
  // Identification
  name: string;
  description: string;
  category: ToolCategory;
  
  // Command
  command: string;
  args: string[];
  flags: ToolFlag[];
  
  // Detection
  detection: ToolDetection;
  
  // Context
  context: ToolContext;
  
  // Output parsing
  outputParser: "raw" | "json" | "structured" | "custom";
  customParser?: (output: string) => ToolResult;
}

export interface ToolInvocation {
  tool: string;
  args: Record<string, any>;
  context?: string;
}

// --- Tool Registry ----------------------------------------------------------

export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();
  private readonly userToolsPath: string;
  private readonly userToolsDir: string;
  
  constructor() {
    const base = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".claude-killer"
    );
    this.userToolsPath = path.join(base, "tools.json");
    this.userToolsDir = path.join(base, "tools");
  }
  
  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      log.warn(`Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    log.debug(`Registered tool: ${tool.name}`);
  }
  
  /**
   * Register multiple tools
   */
  registerAll(tools: Tool[]): void {
    tools.forEach(t => this.register(t));
  }
  
  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
  
  /**
   * Get all tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }
  
  /**
   * Get tools by category
   */
  getByCategory(category: ToolCategory): Tool[] {
    return this.getAll().filter(t => t.category === category);
  }
  
  /**
   * Search tools by intent pattern
   */
  searchByIntent(intent: string): Tool[] {
    const lower = intent.toLowerCase();
    return this.getAll().filter(tool => 
      tool.context.whenToUse.some(pattern => 
        lower.includes(pattern.toLowerCase())
      )
    );
  }
  
  /**
   * Check if tool is installed — uses deep detector when available.
   */
  isInstalled(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    if (tool.detection.installed !== undefined) {
      if (tool.detection.lastChecked &&
          Date.now() - tool.detection.lastChecked < 5 * 60 * 1000) {
        return tool.detection.installed;
      }
    }

    // Sprint A: use findToolBinary (mode-aware) for installation check.
    // NEVER use detectTool() directly outside toolDetector.ts — it's not
    // mode-aware and would miss tools in modes/<mode>/tools/ (BUG-D).
    try {
      const { findToolBinary } = require("./toolDetector.js");
      let modeName: string | null = null;
      try {
        const { getActiveModeName } = require("./modes.js");
        modeName = getActiveModeName();
      } catch {
        // ignore
      }
      const binaryPath = findToolBinary(tool.command, modeName);
      const installed = !!binaryPath;
      tool.detection.installed = installed;
      tool.detection.lastChecked = Date.now();
      tool.detection.binaryPath = binaryPath;
      tool.detection.version = null; // version detection is expensive, skip here
      return installed;
    } catch {
      // Fall back to simple check
    }

    const installed = this.checkInstallation(tool);
    tool.detection.installed = installed;
    tool.detection.lastChecked = Date.now();
    return installed;
  }

  /**
   * Get detailed status of a tool (missing/found/working).
   */
  getToolStatus(toolName: string): "missing" | "found" | "working" {
    const tool = this.tools.get(toolName);
    if (!tool) return "missing";
    if (!this.isInstalled(toolName)) return "missing";
    // If we have binaryPath from detector, it's "found", otherwise "missing"
    return tool.detection.binaryPath ? "found" : "missing";
  }
  
  /**
   * Check installation of a tool
   */
  // sonar-disable-next-line typescript:S3776
private checkInstallation(tool: Tool): boolean {
    try {
      switch (tool.detection.method) {
        case "binary":
          execSync(`${tool.command} --version`, { 
            stdio: "pipe",
            timeout: 5000 
          });
          return true;
          
        case "config":
          return fs.existsSync(tool.detection.check);
          
        case "package":
          // Check package.json or similar
          return fs.existsSync(tool.detection.check);
          
        case "manual":
          return tool.detection.installed ?? false;
          
        default:
          return false;
      }
    } catch {
      return false;
    }
  }
  
  /**
   * Add a tool dynamically (for AI self-extension)
   */
  addTool(tool: Tool): { success: boolean; message: string } {
    try {
      // Validate tool
      if (!tool.name || !tool.command) {
        return { success: false, message: "Tool must have name and command" };
      }
      
      // Register
      this.register(tool);
      
      // Save to user tools file
      this.saveUserTools();
      
      log.info(`Dynamically added tool: ${tool.name}`);
      return { success: true, message: `Tool "${tool.name}" added successfully` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Failed to add tool: ${msg}` };
    }
  }
  
  /**
   * Save user-defined tools to file
   */
  private saveUserTools(): void {
    try {
      const dir = path.dirname(this.userToolsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const userTools = this.getAll()
        .filter(t => t.category === "custom")
        .map(t => ({
          name: t.name,
          description: t.description,
          command: t.command,
          args: t.args,
          flags: t.flags,
          detection: { method: t.detection.method, check: t.detection.check },
          context: t.context,
          outputParser: t.outputParser
        }));
      
      fs.writeFileSync(
        this.userToolsPath,
        JSON.stringify(userTools, null, 2),
        "utf-8"
      );
    } catch (error) {
      log.error(`Failed to save user tools: ${error}`);
    }
  }
  
  /**
   * Load user-defined tools from `~/.claude-killer/tools.json` (legacy single file).
   * Preserves the original category from JSON (e.g. "roblox") instead of forcing "custom".
   */
  loadUserTools(): void {
    try {
      // New: prefer loading from the tools/ directory (one file per CLI binary).
      // This keeps user extensions organized and avoids one giant JSON.
      const loadedFromDir = this.loadToolsFromDir();
      if (loadedFromDir > 0) {
        log.info(`Loaded ${loadedFromDir} tools from ${this.userToolsDir}`);
        return;
      }

      // Fallback: legacy single-file tools.json (for backward compatibility)
      if (!fs.existsSync(this.userToolsPath)) {
        return;
      }

      const data = fs.readFileSync(this.userToolsPath, "utf-8");
      const userTools = JSON.parse(data) as Tool[];

      let loadedCount = 0;
      for (const tool of userTools) {
        if (this.validateUserTool(tool)) {
          // Preserve original category if present (roblox, python, etc.).
          // Only fall back to "custom" when JSON omits category entirely.
          if (!tool.category || tool.category === "custom") {
            tool.category = "custom";
          }
          this.register(tool);
          loadedCount++;
        } else {
          log.warn(`Skipped invalid user tool: ${tool.name ?? "unnamed"}`);
        }
      }

      log.info(`Loaded ${loadedCount} user-defined tools from ${this.userToolsPath}`);
    } catch (error) {
      log.error(`Failed to load user tools: ${error}`);
    }
  }

  /**
   * Load tools from `~/.claude-killer/tools/*.json` directory.
   * Each file may contain a single Tool object or an array of Tools.
   * Returns the number of tools successfully loaded.
   */
  private loadToolsFromDir(): number {
    try {
      if (!fs.existsSync(this.userToolsDir)) return 0;
      const files = fs.readdirSync(this.userToolsDir).filter((f) => f.endsWith(".json"));
      if (files.length === 0) return 0;

      let count = 0;
      for (const file of files) {
        const filePath = path.join(this.userToolsDir, file);
        try {
          const data = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(data);
          const tools: Tool[] = Array.isArray(parsed) ? parsed : [parsed];
          for (const tool of tools) {
            if (this.validateUserTool(tool)) {
              if (!tool.category || tool.category === "custom") {
                tool.category = "custom";
              }
              this.register(tool);
              count++;
            } else {
              log.warn(`Skipped invalid tool in ${file}: ${tool.name ?? "unnamed"}`);
            }
          }
        } catch (err) {
          log.warn(`Failed to parse ${file}: ${(err as Error).message}`);
        }
      }
      return count;
    } catch {
      return 0;
    }
  }
  
  /**
   * Validate a user tool
   */
  private validateUserTool(tool: Partial<Tool>): boolean {
    if (!tool.name || typeof tool.name !== "string") return false;
    if (!tool.command || typeof tool.command !== "string") return false;
    if (!tool.description || typeof tool.description !== "string") return false;
    return true;
  }
  
  /**
   * Get user tools path
   */
  getUserToolsPath(): string {
    return this.userToolsPath;
  }
  
  /**
   * Get user tools count
   */
  getUserToolsCount(): number {
    return this.getAll().filter(t => t.category === "custom").length;
  }
  
  /**
   * Remove a user tool
   */
  removeUserTool(toolName: string): { success: boolean; message: string } {
    try {
      const tool = this.get(toolName);
      if (!tool) {
        return { success: false, message: `Tool "${toolName}" not found` };
      }
      
      if (tool.category !== "custom") {
        return { success: false, message: `Tool "${toolName}" is not a user tool` };
      }
      
      this.tools.delete(toolName);
      this.saveUserTools();
      
      return { success: true, message: `Tool "${toolName}" removed` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Failed to remove tool: ${msg}` };
    }
  }
  
  /**
   * Update a user tool
   */
  updateUserTool(toolName: string, updates: Partial<Tool>): { success: boolean; message: string } {
    try {
      const tool = this.get(toolName);
      if (!tool) {
        return { success: false, message: `Tool "${toolName}" not found` };
      }
      
      if (tool.category !== "custom") {
        return { success: false, message: `Tool "${toolName}" is not a user tool` };
      }
      
      // Apply updates
      const updatedTool = { ...tool, ...updates, category: "custom" as const };
      
      if (!this.validateUserTool(updatedTool)) {
        return { success: false, message: "Invalid tool updates" };
      }
      
      this.register(updatedTool);
      this.saveUserTools();
      
      return { success: true, message: `Tool "${toolName}" updated` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `Failed to update tool: ${msg}` };
    }
  }
}

// --- Tool Detector ----------------------------------------------------------

export class ToolDetector {
  private readonly registry: ToolRegistry;
  
  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }
  
  /**
   * Detect tool from user message (intent-based)
   */
  detectFromIntent(message: string): ToolInvocation | null {
    const tools = this.registry.getAll();
    
    for (const tool of tools) {
      for (const pattern of tool.context.whenToUse) {
        if (message.toLowerCase().includes(pattern.toLowerCase())) {
          return { tool: tool.name, args: {} };
        }
      }
    }
    
    return null;
  }
  
  /**
   * Detect tool from project context (config files)
   */
  detectFromContext(dir?: string): Tool[] {
    const cwd = dir ?? process.cwd();
    const detected: Tool[] = [];
    
    const tools = this.registry.getAll();
    for (const tool of tools) {
      if (tool.context.requiresProject) {
        const hasAll = tool.context.requiresProject.every(
          config => fs.existsSync(path.join(cwd, config))
        );
        if (hasAll) {
          detected.push(tool);
        }
      }
    }
    
    return detected;
  }
  
  /**
   * Detect both intent and context
   */
  detect(message: string, dir?: string): {
    intent: ToolInvocation | null;
    context: Tool[];
  } {
    return {
      intent: this.detectFromIntent(message),
      context: this.detectFromContext(dir)
    };
  }
}

// --- Tool Executor ----------------------------------------------------------

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  
  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }
  
  /**
   * Execute a tool
   */
  async execute(
    toolName: string,
    args: Record<string, any> = {},
    options: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    } = {}
  ): Promise<ToolResult> {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return {
        success: false,
        output: "",
        errors: [`Tool "${toolName}" not found`]
      };
    }
    
    // Check if installed
    if (!this.registry.isInstalled(toolName)) {
      return {
        success: false,
        output: "",
        errors: [`Tool "${toolName}" is not installed`],
        suggestions: [`Install ${toolName} first`]
      };
    }
    
    const startTime = Date.now();
    
    try {
      // Build command
      const cmd = this.buildCommand(tool, args);
      log.debug(`Executing: ${cmd}`);
      
      // Execute
      const output = execSync(cmd, {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeout ?? 60000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...options.env
        }
      });
      
      const duration = Date.now() - startTime;
      
      // Parse output
      const result = this.parseOutput(tool, output);
      result.duration = duration;
      
      return result;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      // Parse error output
      const stderr = error.stderr ?? "";
      const stdout = error.stdout ?? "";
      
      return {
        success: false,
        output: stdout,
        errors: [stderr ?? error.message],
        exitCode: error.status,
        duration
      };
    }
  }
  
  /**
   * Build command string from tool and args
   */
  private buildCommand(tool: Tool, args: Record<string, any>): string {
    const parts: string[] = [tool.command, ...tool.args];
    
    // Add flags
    for (const flag of tool.flags) {
      const value = args[flag.name] ?? flag.default;
      
      if (value !== undefined) {
        if (flag.type === "boolean") {
          if (value) {
            parts.push(flag.name);
          }
        } else {
          parts.push(flag.name, String(value));
        }
      }
    }
    
    return parts.join(" ");
  }
  
  /**
   * Parse tool output
   */
  private parseOutput(tool: Tool, output: string): ToolResult {
    if (tool.customParser) {
      return tool.customParser(output);
    }
    
    switch (tool.outputParser) {
      case "json":
        try {
          const parsed = JSON.parse(output);
          return {
            success: true,
            output,
            metadata: parsed
          };
        } catch {
          return {
            success: true,
            output
          };
        }
        
      case "structured":
        return this.parseStructuredOutput(output);
        
      case "raw":
      default:
        return {
          success: true,
          output
        };
    }
  }
  
  /**
   * Parse structured output (lines with common patterns)
   */
  private parseStructuredOutput(output: string): ToolResult {
    const lines = output.split("\n").filter(l => l.trim());
    const errors: string[] = [];
    const warnings: string[] = [];
    
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (lower.includes("error") || lower.includes("failed")) {
        errors.push(line);
      } else if (lower.includes("warning") || lower.includes("warn")) {
        warnings.push(line);
      }
    }
    
    return {
      success: errors.length === 0,
      output,
      errors: errors.length > 0 ? errors : undefined,
      suggestions: warnings.length > 0 ? warnings : undefined
    };
  }
}

// --- Tool Suggester ---------------------------------------------------------

export class ToolSuggester {
  private readonly registry: ToolRegistry;
  
  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }
  
  /**
   * Suggest tools based on user message
   */
  suggest(message: string): Array<{
    tool: Tool;
    confidence: number;
    reason: string;
  }> {
    const suggestions: Array<{
      tool: Tool;
      confidence: number;
      reason: string;
    }> = [];
    
    const lower = message.toLowerCase();
    const tools = this.registry.getAll();
    
    for (const tool of tools) {
      let confidence = 0;
      const reasons: string[] = [];
      
      // Check intent patterns
      for (const pattern of tool.context.whenToUse) {
        if (lower.includes(pattern.toLowerCase())) {
          confidence += 0.5;
          reasons.push(`matches pattern: "${pattern}"`);
        }
      }
      
      // Check command name
      if (lower.includes(tool.command)) {
        confidence += 0.3;
        reasons.push(`mentions command: "${tool.command}"`);
      }
      
      // Check category
      if (lower.includes(tool.category)) {
        confidence += 0.2;
        reasons.push(`mentions category: "${tool.category}"`);
      }
      
      // Check if installed
      if (this.registry.isInstalled(tool.name)) {
        confidence += 0.1;
        reasons.push("tool is installed");
      }
      
      if (confidence > 0) {
        suggestions.push({
          tool,
          confidence: Math.min(confidence, 1),
          reason: reasons.join("; ")
        });
      }
    }
    
    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence);
    
    return suggestions;
  }
  
  /**
   * Get best suggestion
   */
  getBest(message: string): Tool | null {
    const suggestions = this.suggest(message);
    return suggestions.length > 0 ? suggestions[0].tool : null;
  }
}

// --- Singleton Instances ----------------------------------------------------

let _registry: ToolRegistry | null = null;
let _detector: ToolDetector | null = null;
let _executor: ToolExecutor | null = null;
let _suggester: ToolSuggester | null = null;

export function getRegistry(): ToolRegistry {
  if (!_registry) {
    _registry = new ToolRegistry();
    _registry.loadUserTools();
  }
  return _registry;
}

export function getDetector(): ToolDetector {
  _detector ??= new ToolDetector(getRegistry());
  return _detector;
}

export function getExecutor(): ToolExecutor {
  _executor ??= new ToolExecutor(getRegistry());
  return _executor;
}

export function getSuggester(): ToolSuggester {
  _suggester ??= new ToolSuggester(getRegistry());
  return _suggester;
}

/**
 * Initialize the tool system.
 *
 * No tools are hardcoded anymore — everything is loaded from external JSON
 * files at `~/.claude-killer/tools/*.json`. The seed step (see configSeeder.ts)
 * copies bundled defaults (Roblox CLI tools) into that directory on first run.
 *
 * Note: getRegistry() already calls loadUserTools() lazily on first access,
 * so this function is mostly a no-op for backward compat. It exists so callers
 * can explicitly initialize before the first getRegistry() call.
 */
export async function initializeTools(): Promise<void> {
  const registry = getRegistry();
  // getRegistry() already calls loadUserTools() on first construction,
  // so we don't need to call it again here.
  log.info(`Initialized ${registry.getAll().length} external tools`);
}