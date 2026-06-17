/**
 * memory.ts - Persistent memory system for Claude Killer.
 *
 * 4-layer memory architecture:
 *   1. Session checkpoint (checkpoint.md) - current session state
 *   2. Project memory (MEMORY.md) - persistent project knowledge
 *   3. Global memory (~/.claude-killer/memory/global.md) - user preferences
 *   4. History (JSON files) - full session traces for search
 *
 * Storage structure:
 *   ~/.claude-killer/
 *   +-- memory/
 *   |   +-- global.md          # User preferences
 *   |   +-- history/           # Session traces
 *   |   +-- skills/            # Extracted reusable skills
 *   +-- <project>/
 *       +-- .claude-killer/
 *           +-- MEMORY.md      # Project knowledge
 *           +-- checkpoint.md  # Current session state
 *           +-- notes.md       # Scratch notes
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

export interface MemoryConfig {
  globalDir: string;
  projectDir: string;
  historyDir: string;
  skillsDir: string;
}

export interface SessionCheckpoint {
  timestamp: string;
  sessionId: string;
  taskTree: TaskNode[];
  currentTask: string;
  recentDecisions: string[];
  fileChanges: FileChange[];
  activeTools: string[];
  contextSummary: string;
  projectMemorySnapshot: string;
}

export interface TaskNode {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  children: TaskNode[];
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  path: string;
  action: "created" | "modified" | "deleted";
  timestamp: string;
  summary: string;
}

export interface MemoryEntry {
  id: string;
  content: string;
  source: "checkpoint" | "project" | "global" | "history";
  timestamp: string;
  tags: string[];
  relevanceScore?: number;
}

export interface SessionTrace {
  id: string;
  startTime: string;
  endTime: string;
  summary: string;
  decisions: string[];
  fileChanges: FileChange[];
  toolsUsed: string[];
  tokensUsed: number;
  messages: TraceMessage[];
}

export interface TraceMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
}

// --- Config ------------------------------------------------------------------

const HOME = os.homedir();

export function getMemoryConfig(projectRoot?: string): MemoryConfig {
  const globalDir = path.join(HOME, ".claude-killer", "memory");
  const projectDir = projectRoot
    ? path.join(projectRoot, ".claude-killer")
    : path.join(process.cwd(), ".claude-killer");

  return {
    globalDir,
    projectDir,
    historyDir: path.join(globalDir, "history"),
    skillsDir: path.join(globalDir, "skills"),
  };
}

// --- Directory Management ----------------------------------------------------

export function ensureMemoryDirs(config: MemoryConfig): void {
  const dirs = [
    config.globalDir,
    config.projectDir,
    config.historyDir,
    config.skillsDir,
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log.debug(`Created memory dir: ${dir}`);
    }
  }
}

// --- File Operations ---------------------------------------------------------

function readMarkdown(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch (err) {
    log.warn(`Failed to read memory file ${filePath}: ${(err as Error).message}`);
  }
  return "";
}

function writeMarkdown(filePath: string, content: string): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, "utf8");
    log.debug(`Wrote memory file: ${filePath}`);
  } catch (err) {
    log.warn(`Failed to write memory file ${filePath}: ${(err as Error).message}`);
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    }
  } catch (err) {
    log.warn(`Failed to read JSON file ${filePath}: ${(err as Error).message}`);
  }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    log.warn(`Failed to write JSON file ${filePath}: ${(err as Error).message}`);
  }
}

// --- Project Memory ----------------------------------------------------------

export function getProjectMemoryPath(config: MemoryConfig): string {
  return path.join(config.projectDir, "MEMORY.md");
}

export function readProjectMemory(config: MemoryConfig): string {
  return readMarkdown(getProjectMemoryPath(config));
}

export function writeProjectMemory(config: MemoryConfig, content: string): void {
  writeMarkdown(getProjectMemoryPath(config), content);
}

export function appendProjectMemory(config: MemoryConfig, entry: string): void {
  const existing = readProjectMemory(config);
  const timestamp = new Date().toISOString();
  const newEntry = `\n\n## ${timestamp}\n${entry}`;
  writeProjectMemory(config, existing + newEntry);
}

// --- Session Checkpoint ------------------------------------------------------

export function getCheckpointPath(config: MemoryConfig): string {
  return path.join(config.projectDir, "checkpoint.md");
}

export function readCheckpoint(config: MemoryConfig): SessionCheckpoint | null {
  const filePath = getCheckpointPath(config);
  const content = readMarkdown(filePath);
  if (!content) return null;

  // Parse checkpoint from markdown
  const checkpoint: SessionCheckpoint = {
    timestamp: "",
    sessionId: "",
    taskTree: [],
    currentTask: "",
    recentDecisions: [],
    fileChanges: [],
    activeTools: [],
    contextSummary: "",
    projectMemorySnapshot: "",
  };

  // Extract fields from markdown
  const timestampRegex = /Timestamp:\s*(.+)/;
  const timestampMatch = timestampRegex.exec(content);
  if (timestampMatch) checkpoint.timestamp = timestampMatch[1].trim();

  const sessionRegex = /Session:\s*(.+)/;
  const sessionMatch = sessionRegex.exec(content);
  if (sessionMatch) checkpoint.sessionId = sessionMatch[1].trim();

  const taskRegex = /Current Task:\s*(.+)/;
  const taskMatch = taskRegex.exec(content);
  if (taskMatch) checkpoint.currentTask = taskMatch[1].trim();

  const summaryRegex = /Summary:\s*([\s\S]*?)(?=\n## |\n$)/;
  const summaryMatch = summaryRegex.exec(content);
  if (summaryMatch) checkpoint.contextSummary = summaryMatch[1].trim();

  // Extract decisions
  const decisionsRegex = /Recent Decisions:\s*([\s\S]*?)(?=\n## |\n$)/;
  const decisionsMatch = decisionsRegex.exec(content);
  if (decisionsMatch) {
    checkpoint.recentDecisions = decisionsMatch[1]
      .split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean);
  }

  return checkpoint;
}

export function writeCheckpoint(config: MemoryConfig, checkpoint: SessionCheckpoint): void {
  const filePath = getCheckpointPath(config);

  let content = `# Session Checkpoint\n\n`;
  content += `Timestamp: ${checkpoint.timestamp}\n`;
  content += `Session: ${checkpoint.sessionId}\n`;
  content += `Current Task: ${checkpoint.currentTask}\n\n`;

  content += `## Summary\n\n${checkpoint.contextSummary || "(empty)"}\n\n`;

  content += `## Recent Decisions\n\n`;
  for (const decision of checkpoint.recentDecisions) {
    content += `- ${decision}\n`;
  }

  content += `\n## File Changes\n\n`;
  for (const change of checkpoint.fileChanges) {
    content += `- ${change.action}: ${change.path} - ${change.summary}\n`;
  }

  content += `\n## Active Tools\n\n`;
  content += checkpoint.activeTools.join(", ") || "(none)";
  content += "\n";

  writeMarkdown(filePath, content);
}

// --- Global Memory -----------------------------------------------------------

export function getGlobalMemoryPath(config: MemoryConfig): string {
  return path.join(config.globalDir, "global.md");
}

export function readGlobalMemory(config: MemoryConfig): string {
  return readMarkdown(getGlobalMemoryPath(config));
}

export function writeGlobalMemory(config: MemoryConfig, content: string): void {
  writeMarkdown(getGlobalMemoryPath(config), content);
}

export function appendGlobalMemory(config: MemoryConfig, entry: string): void {
  const existing = readGlobalMemory(config);
  const timestamp = new Date().toISOString();
  const newEntry = `\n\n## ${timestamp}\n${entry}`;
  writeGlobalMemory(config, existing + newEntry);
}

// --- Notes -------------------------------------------------------------------

export function getNotesPath(config: MemoryConfig): string {
  return path.join(config.projectDir, "notes.md");
}

export function readNotes(config: MemoryConfig): string {
  return readMarkdown(getNotesPath(config));
}

export function writeNotes(config: MemoryConfig, content: string): void {
  writeMarkdown(getNotesPath(config), content);
}

export function appendNotes(config: MemoryConfig, entry: string): void {
  const existing = readNotes(config);
  const timestamp = new Date().toISOString();
  const newEntry = `\n\n### ${timestamp}\n${entry}`;
  writeNotes(config, existing + newEntry);
}

// --- Session History ---------------------------------------------------------

export function saveSessionTrace(config: MemoryConfig, trace: SessionTrace): void {
  const fileName = `session_${trace.startTime.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  const filePath = path.join(config.historyDir, fileName);
  writeJson(filePath, trace);
  log.debug(`Saved session trace: ${filePath}`);
}

export function listSessionTraces(config: MemoryConfig): SessionTrace[] {
  const historyDir = config.historyDir;
  if (!fs.existsSync(historyDir)) return [];

  const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"));
  const traces: SessionTrace[] = [];

  for (const file of files) {
    const trace = readJson<SessionTrace>(path.join(historyDir, file), null as any);
    if (trace) traces.push(trace);
  }

  return traces.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
}

export function searchSessionTraces(
  config: MemoryConfig,
  query: string,
  maxResults = 10
): SessionTrace[] {
  const allTraces = listSessionTraces(config);
  const queryLower = query.toLowerCase();

  const scored = allTraces.map((trace) => ({
    trace,
    score: calculateTraceScore(trace, queryLower),
  }));

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.trace);
}

function calculateTraceScore(trace: SessionTrace, queryLower: string): number {
  let score = 0;
  if (trace.summary.toLowerCase().includes(queryLower)) score += 10;
  score += countMatches(trace.decisions, queryLower) * 5;
  score += countFileChangeMatches(trace.fileChanges, queryLower) * 3;
  score += countMatches(trace.toolsUsed, queryLower) * 2;
  return score;
}

function countMatches(items: string[], queryLower: string): number {
  let count = 0;
  for (const item of items) {
    if (item.toLowerCase().includes(queryLower)) count++;
  }
  return count;
}

function countFileChangeMatches(changes: FileChange[], queryLower: string): number {
  let count = 0;
  for (const change of changes) {
    if (change.path.toLowerCase().includes(queryLower)) count++;
    if (change.summary.toLowerCase().includes(queryLower)) count++;
  }
  return count;
}

// --- Skills ------------------------------------------------------------------

export interface Skill {
  id: string;
  name: string;
  description: string;
  trigger: string;
  steps: string[];
  createdAt: string;
  usageCount: number;
}

export function saveSkill(config: MemoryConfig, skill: Skill): void {
  const filePath = path.join(config.skillsDir, `${skill.id}.json`);
  writeJson(filePath, skill);
}

export function listSkills(config: MemoryConfig): Skill[] {
  const skillsDir = config.skillsDir;
  if (!fs.existsSync(skillsDir)) return [];

  const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith(".json"));
  const skills: Skill[] = [];

  for (const file of files) {
    const skill = readJson<Skill>(path.join(skillsDir, file), null as any);
    if (skill) skills.push(skill);
  }

  return skills;
}

export function findMatchingSkills(config: MemoryConfig, context: string): Skill[] {
  const allSkills = listSkills(config);
  const contextLower = context.toLowerCase();

  return allSkills
    .filter(
      (skill) =>
        skill.trigger.toLowerCase().includes(contextLower) ||
        skill.description.toLowerCase().includes(contextLower)
    )
    .sort((a, b) => b.usageCount - a.usageCount);
}

// --- Memory Injection --------------------------------------------------------

export interface InjectedMemory {
  projectMemory: string;
  checkpoint: SessionCheckpoint | null;
  globalMemory: string;
  relevantSkills: Skill[];
  recentHistory: SessionTrace[];
  totalTokensEstimate: number;
}

const CHARS_PER_TOKEN = 4;

export function injectMemory(
  config: MemoryConfig,
  maxTokens = 15000
): InjectedMemory {
  const projectMemory = readProjectMemory(config);
  const checkpoint = readCheckpoint(config);
  const globalMemory = readGlobalMemory(config);

  // Estimate tokens
  let totalChars =
    projectMemory.length + globalMemory.length + (checkpoint?.contextSummary.length ?? 0);

  // Add relevant skills (limited by budget)
  const relevantSkills = findMatchingSkills(config, projectMemory.slice(0, 500));
  const skillsChars = relevantSkills.reduce((sum, s) => sum + s.description.length + s.steps.join("").length, 0);
  totalChars += skillsChars;

  // Add recent history (limited by budget)
  const allTraces = listSessionTraces(config);
  const recentHistory: SessionTrace[] = [];
  let historyChars = 0;

  for (const trace of allTraces.slice(0, 5)) {
    const traceChars = trace.summary.length + trace.decisions.join("").length;
    if (historyChars + traceChars > maxTokens * CHARS_PER_TOKEN * 0.3) break;
    recentHistory.push(trace);
    historyChars += traceChars;
  }

  totalChars += historyChars;

  return {
    projectMemory,
    checkpoint,
    globalMemory,
    relevantSkills,
    recentHistory,
    totalTokensEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}

export function formatInjectedMemory(mem: InjectedMemory): string {
  let output = "";

  if (mem.projectMemory) {
    output += `## Project Memory\n\n${mem.projectMemory}\n\n`;
  }

  if (mem.checkpoint) {
    output += `## Session Checkpoint\n\n`;
    output += `- Current task: ${mem.checkpoint.currentTask}\n`;
    output += `- Last updated: ${mem.checkpoint.timestamp}\n`;
    if (mem.checkpoint.contextSummary) {
      output += `\n${mem.checkpoint.contextSummary}\n`;
    }
    output += "\n";
  }

  if (mem.globalMemory) {
    output += `## User Preferences\n\n${mem.globalMemory}\n\n`;
  }

  if (mem.relevantSkills.length > 0) {
    output += `## Relevant Skills\n\n`;
    for (const skill of mem.relevantSkills.slice(0, 5)) {
      output += `### ${skill.name}\n${skill.description}\n\n`;
    }
  }

  if (mem.recentHistory.length > 0) {
    output += `## Recent Sessions\n\n`;
    for (const trace of mem.recentHistory.slice(0, 3)) {
      output += `- ${trace.startTime}: ${trace.summary}\n`;
    }
    output += "\n";
  }

  output += `*(Estimated tokens: ${mem.totalTokensEstimate})*\n`;

  return output;
}

// --- Dream (Periodic Memory Review) ------------------------------------------

export interface DreamResult {
  reviewedSessions: number;
  deduplicatedEntries: number;
  updatedProjectMemory: boolean;
  extractedSkills: number;
  compressedHistory: number;
}

export async function runDream(config: MemoryConfig): Promise<DreamResult> {
  log.info("Starting /dream - reviewing and compressing memory...");

  const result: DreamResult = {
    reviewedSessions: 0,
    deduplicatedEntries: 0,
    updatedProjectMemory: false,
    extractedSkills: 0,
    compressedHistory: 0,
  };

  // 1. Review recent sessions
  const traces = listSessionTraces(config);
  result.reviewedSessions = traces.length;

  // 2. Extract patterns from sessions
  const patterns = extractPatterns(traces);

  // 3. Update project memory with new insights
  if (patterns.length > 0) {
    const existingMemory = readProjectMemory(config);
    const newInsights = patterns
      .map((p) => `- ${p}`)
      .join("\n");

    if (!existingMemory.includes(newInsights)) {
      appendProjectMemory(config, `### Auto-discovered patterns\n${newInsights}`);
      result.updatedProjectMemory = true;
    }
  }

  // 4. Extract reusable skills
  const extractedSkills = extractSkillsFromTraces(traces);
  for (const skill of extractedSkills) {
    saveSkill(config, skill);
    result.extractedSkills++;
  }

  // 5. Deduplicate project memory
  const projectMemory = readProjectMemory(config);
  const deduplicated = deduplicateMemory(projectMemory);
  if (deduplicated !== projectMemory) {
    writeProjectMemory(config, deduplicated);
    result.deduplicatedEntries++;
  }

  log.info(
    `Dream complete: ${result.reviewedSessions} sessions reviewed, ` +
    `${result.extractedSkills} skills extracted, ` +
    `${result.deduplicatedEntries} duplicates removed`
  );

  return result;
}

function extractPatterns(traces: SessionTrace[]): string[] {
  const patterns: string[] = [];
  const toolFrequency = new Map<string, number>();
  const fileFrequency = new Map<string, number>();

  for (const trace of traces) {
    for (const tool of trace.toolsUsed) {
      toolFrequency.set(tool, (toolFrequency.get(tool) ?? 0) + 1);
    }
    for (const change of trace.fileChanges) {
      fileFrequency.set(change.path, (fileFrequency.get(change.path) ?? 0) + 1);
    }
  }

  // Find frequently used tools
  for (const [tool, count] of toolFrequency) {
    if (count >= 5) {
      patterns.push(`Tool "${tool}" used ${count} times - consider optimizing workflow`);
    }
  }

  // Find frequently modified files
  for (const [file, count] of fileFrequency) {
    if (count >= 3) {
      patterns.push(`File "${file}" modified ${count} times - may need refactoring`);
    }
  }

  return patterns;
}

function extractSkillsFromTraces(traces: SessionTrace[]): Skill[] {
  const skills: Skill[] = [];
  const sequences = collectToolSequences(traces);

  for (const [sequence, data] of sequences) {
    if (data.count >= 3) {
      skills.push(createSkillFromSequence(sequence, data.count));
    }
  }

  return skills.slice(0, 10);
}

function collectToolSequences(traces: SessionTrace[]): Map<string, { count: number; traces: SessionTrace[] }> {
  const sequences = new Map<string, { count: number; traces: SessionTrace[] }>();

  for (const trace of traces) {
    if (trace.toolsUsed.length < 3) continue;
    generateNgrams(trace.toolsUsed, trace, sequences);
  }

  return sequences;
}

function generateNgrams(
  tools: string[],
  trace: SessionTrace,
  sequences: Map<string, { count: number; traces: SessionTrace[] }>
): void {
  for (let n = 3; n <= Math.min(5, tools.length); n++) {
    for (let i = 0; i <= tools.length - n; i++) {
      const sequence = tools.slice(i, i + n).join(" ->");
      const existing = sequences.get(sequence) ?? { count: 0, traces: [] };
      existing.count++;
      existing.traces.push(trace);
      sequences.set(sequence, existing);
    }
  }
}

function createSkillFromSequence(sequence: string, count: number): Skill {
  const parts = sequence.split(" ->");
  return {
    id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: `Auto: ${parts[0]} workflow`,
    description: `Repeated tool sequence: ${sequence}`,
    trigger: parts[0],
    steps: parts,
    createdAt: new Date().toISOString(),
    usageCount: count,
  };
}

function deduplicateMemory(memory: string): string {
  const lines = memory.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }

    // Check for duplicate non-empty lines
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(line);
    }
  }

  return result.join("\n");
}

// --- Distill (Extract Workflow Skills) ---------------------------------------

export interface DistillResult {
  skillsExtracted: number;
  skills: Skill[];
}

export async function runDistill(config: MemoryConfig): Promise<DistillResult> {
  log.info("Starting /distill - extracting reusable workflow skills...");

  const traces = listSessionTraces(config);
  const skills = extractSkillsFromTraces(traces);

  for (const skill of skills) {
    saveSkill(config, skill);
  }

  log.info(`Distill complete: ${skills.length} skills extracted`);

  return {
    skillsExtracted: skills.length,
    skills,
  };
}

// --- Checkpoint Writer -------------------------------------------------------

export interface CheckpointWriterConfig {
  contextBudget: number; // max tokens
  checkpointPercentages: number[]; // when to save checkpoints
}

const DEFAULT_CHECKPOINT_CONFIG: CheckpointWriterConfig = {
  contextBudget: 128000,
  checkpointPercentages: [0.2, 0.45, 0.7],
};

export function shouldWriteCheckpoint(
  currentTokens: number,
  config: CheckpointWriterConfig = DEFAULT_CHECKPOINT_CONFIG
): boolean {
  const usage = currentTokens / config.contextBudget;
  return config.checkpointPercentages.some((p) => Math.abs(usage - p) < 0.02);
}

export function createCheckpoint(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
  fileChanges: FileChange[],
  activeTools: string[]
): SessionCheckpoint {
  const recentDecisions = extractDecisionsFromMessages(messages);
  const summary = generateContextSummary(messages, fileChanges);

  return {
    timestamp: new Date().toISOString(),
    sessionId,
    taskTree: [],
    currentTask: extractCurrentTask(messages),
    recentDecisions: recentDecisions.slice(-5),
    fileChanges: fileChanges.slice(-10),
    activeTools,
    contextSummary: summary,
    projectMemorySnapshot: "",
  };
}

function extractDecisionsFromMessages(messages: Array<{ role: string; content: string }>): string[] {
  const decisions: string[] = [];
  const decisionPattern = /(?:decidi|vou|vamos|decisão|escolhi).*?(?:\.|$)/gi;

  for (const msg of messages.slice(-10)) {
    if (msg.role === "assistant") {
      const matches = msg.content.match(decisionPattern);
      if (matches) {
        decisions.push(...matches.slice(0, 2));
      }
    }
  }

  return decisions;
}

function extractCurrentTask(messages: Array<{ role: string; content: string }>): string {
  // Look for the most recent user message to determine current task
  for (const msg of [...messages].reverse()) {
    if (msg.role === "user") {
      return msg.content.slice(0, 200);
    }
  }
  return "(unknown)";
}

function generateContextSummary(
  messages: Array<{ role: string; content: string }>,
  fileChanges: FileChange[]
): string {
  const parts: string[] = [];

  // Count messages by role
  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter((m) => m.role === "assistant").length;
  parts.push(`${userMessages} user messages, ${assistantMessages} assistant responses`);

  // List file changes
  if (fileChanges.length > 0) {
    parts.push(`${fileChanges.length} file changes:`);
    for (const change of fileChanges.slice(-5)) {
      parts.push(`  - ${change.action}: ${change.path}`);
    }
  }

  return parts.join("\n");
}
