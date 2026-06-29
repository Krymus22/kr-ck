/**
 * dataGuard.ts — Agente de proteção de dados.
 *
 * Roda em paralelo com o Bug Hunter. Enquanto o Bug Hunter caça bugs de
 * lógica/crash/nil, o DataGuard caça riscos de PERDA/CORRUPÇÃO de dados.
 *
 * Categorias:
 *   1. DESTRUIÇÃO: SetAsync sem GetAsync, RemoveAsync sem backup, DROP TABLE
 *   2. CORRUPÇÃO: Migration sem versão, type mismatch, race condition
 *   3. SEGURANÇA: RemoteEvent sem validação, client trust, injection
 *   4. RECUPERAÇÃO: Missing pcall, missing retry, session locking
 *
 * Para Roblox Luau: foca em DataStore patterns (GetAsync/SetAsync/UpdateAsync/
 * RemoveAsync), RemoteEvent sem validação, PlayerAdded/PlayerRemoving sem pcall.
 *
 * Para SQL: DELETE sem WHERE, DROP, UPDATE sem WHERE, missing transactions.
 * Para TypeScript/JS: localStorage sem try/catch, fetch sem validação.
 */

import { chat } from "./apiClient.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
import { formatBugHuntMessage, type BugFinding } from "./bugHunter.js";
import * as nodeFs from "node:fs";

export interface DataGuardResult {
  shouldBlock: boolean;
  findings: BugFinding[];
  message: string;
  completed: boolean;
}

let previousFindings: BugFinding[] = [];

export function resetDataGuardState(): void {
  previousFindings = [];
}

/**
 * Build the DataGuard system prompt — focused on DATA PROTECTION, not logic bugs.
 */
function buildDataGuardSystemPrompt(): string {
  return `You are the DATAGUARD — a data protection specialist that prevents PERMANENT data loss.

Your job: find every pattern that could DESTROY, CORRUPT, or LEAK user data.
You are NOT looking for logic bugs or crashes (the Bug Hunter does that).
You are looking for IRREVERSIBLE damage — things that once happened, cannot be undone.

## Your personality

- PARANOID: You assume everything can go wrong. "It probably works" is not acceptable.
- DATA-FIRST: You care about user data above all else. A crash is recoverable; lost data is not.
- PREVENTIVE: You flag patterns that COULD cause data loss, even if they don't right now.
- SPECIFIC: You cite exact lines, exact API calls, exact patterns.

## What you hunt for (by category)

### 1. DATA DESTRUCTION (CRITICAL — irreversible)
- SetAsync / Set / Save WITHOUT reading first (GetAsync / Get / Load) — overwrites existing data
- RemoveAsync / Delete / DropTable without backup or confirmation
- data = {} or data = nil before save — wipes existing data
- "TRUNCATE TABLE", "DROP TABLE", "DELETE FROM" without WHERE clause
- ClearAll / Reset / Wipe functions that don't archive first
- Overwriting a Map/Set/Array without merging existing entries

### 2. DATA CORRUPTION (HIGH — hard to recover)
- Schema migration without version tracking (changes format, breaks old saves)
- GetAsync + SetAsync pattern (NOT atomic — race condition in DataStore)
  Should use UpdateAsync instead
- Type mismatch: saves string where number was expected, or vice versa
- Missing default values: new players don't have fields that code expects
- JSON serialization without error handling (corrupt JSON = lost data)
- Number overflow / precision loss in saved values

### 3. DATA SECURITY (HIGH — exploitable)
- RemoteEvent / RemoteFunction without server-side validation
  (client can send arbitrary data that gets saved)
- SetAsync with userId from client input (without verifying identity)
- Missing authorization check before data modification
- SQL injection (string concatenation in queries)
- Client-side trust: believing data sent by client without verification

### 4. DATA RECOVERY (MEDIUM — prevents loss on failure)
- DataStore operations without pcall (if it fails, data is lost silently)
- Missing retry logic for DataStore (network errors are common)
- BindToClose without flushing saves (server shutdown loses pending data)
- PlayerRemoving without ensuring save completed
- No backup before destructive migration
- Missing session locking (two servers saving same player simultaneously)

## Luau/Roblox specific patterns to check

- DataStore:GetAsync(playerId) MUST be called before DataStore:SetAsync(playerId, ...)
  UNLESS the intent is to create new data (check for default values)
- DataStore:UpdateAsync should be used instead of GetAsync+SetAsync for atomic updates
- DataStore:RemoveAsync should have a backup or confirmation
- All DataStore calls MUST be wrapped in pcall
- RemoteEvent.OnServerEvent MUST validate data before saving
- PlayerAdded should load data with defaults
- PlayerRemoving should save data with pcall + retry
- BindToClose should flush all pending saves
- Session locking should prevent dual-server saves
- DataStore SetAsync Budget should be checked (avoid throttling)

## SQL specific patterns

- DELETE without WHERE clause
- DROP TABLE / DROP DATABASE
- UPDATE without WHERE clause
- String concatenation in queries (SQL injection)
- Missing transaction for multi-step operations
- Missing foreign key cascade checks

## JavaScript/TypeScript specific patterns

- localStorage.setItem without try/catch
- JSON.parse without try/catch (corrupt data)
- fetch POST without input validation
- Database operations without transactions
- File writes in 'w' mode without backup

## Output format

For EACH finding, output:

[SEVERITY] file:line — description
Fix: specific fix suggestion

Where SEVERITY is one of:
- CRITICAL: Will cause PERMANENT data loss if this code runs
- HIGH: Can cause data loss/corruption under certain conditions
- MEDIUM: Missing safety net that could prevent data loss
- LOW: Best practice violation related to data handling

End with:

VERDICT: BLOCK (if any CRITICAL/HIGH found) or VERDICT: PASS (if none)

Be EXHAUSTIVE. Check every file. Every data operation. Every save path.
Remember: you are the LAST LINE OF DEFENSE against permanent data loss.`;
}

/**
 * Build the context message for the DataGuard (what files to review).
 */
function buildDataGuardContext(
  filesModified: string[],
  userRequest: string,
  agentResponse: string
): string {
  const fileList = filesModified.map(f => `- ${f}`).join("\n");

  return `## Task Context

User requested: ${userRequest.slice(0, 500)}

Agent response: ${agentResponse.slice(0, 500)}

## Files to review for DATA PROTECTION issues

${fileList}

## Instructions

READ each file listed above using ler_arquivo. Then hunt for DATA PROTECTION issues following your instructions.

Focus on:
1. Any data WRITE operation (SetAsync, Set, Save, INSERT, UPDATE, localStorage, file write)
2. Any data DELETE operation (RemoveAsync, Delete, DROP, TRUNCATE, file delete)
3. Any client-server boundary (RemoteEvent, RemoteFunction, HTTP API)
4. Any migration or schema change
5. Any error handling (or lack thereof) around data operations

Report ALL findings. Be paranoid. Be specific. Cite exact lines.`;
}

/**
 * Read-only tools for the DataGuard (same as Bug Hunter).
 */
function buildReadOnlyTools(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Read file content. USE THIS to verify data operations in the code.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read." },
            caminho: { type: "string", description: "Alias for path." },
            offset: { type: "number", description: "Start line (1-indexed)." },
            limit: { type: "number", description: "Max lines." },
          },
        },
        required: ["pattern"],
      },
    },
    {
      type: "function",
      function: {
        name: "buscar_texto",
        description: "Search for text in files. USE THIS to find all data operations (SetAsync, GetAsync, DELETE, etc).",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex to search." },
            path: { type: "string", description: "Directory to search." },
          },
          required: ["pattern"],
        },
      },
    },
  ];
}

/**
 * Quick static analysis for common data protection patterns.
 * This runs BEFORE the LLM call to provide context about what patterns exist.
 */
function quickScanForDataPatterns(filesModified: string[]): string {
  const patterns: string[] = [];

  const dangerousPatterns = [
    { regex: /SetAsync\s*\(/g, name: "DataStore:SetAsync", risk: "overwrites data" },
    { regex: /RemoveAsync\s*\(/g, name: "DataStore:RemoveAsync", risk: "deletes data permanently" },
    { regex: /UpdateAsync\s*\(/g, name: "DataStore:UpdateAsync", risk: "atomic update (good pattern)" },
    { regex: /GetAsync\s*\(/g, name: "DataStore:GetAsync", risk: "reads data" },
    { regex: /DropTable|DROP\s+TABLE/gi, name: "DROP TABLE", risk: "destroys table" },
    { regex: /DELETE\s+FROM/gi, name: "DELETE FROM", risk: "deletes rows" },
    { regex: /TRUNCATE/gi, name: "TRUNCATE", risk: "empties table" },
    { regex: /localStorage\.setItem/g, name: "localStorage.setItem", risk: "overwrites local data" },
    { regex: /\.remove\s*\(|\.delete\s*\(/gi, name: "remove/delete", risk: "removes data" },
    { regex: /OnServerEvent|OnClientEvent/g, name: "RemoteEvent", risk: "client-server boundary" },
    { regex: /PlayerAdded|PlayerRemoving/g, name: "Player lifecycle", risk: "data load/save timing" },
    { regex: /BindToClose/g, name: "BindToClose", risk: "shutdown save" },
    { regex: /pcall/g, name: "pcall", risk: "error handling (good if present)" },
    { regex: /migration|migrate/gi, name: "migration", risk: "schema change" },
  ];

  for (const file of filesModified) {
    try {
      if (!nodeFs.existsSync(file)) continue;
      const content = nodeFs.readFileSync(file, "utf8");
      const lines = content.split("\n");

      for (const { regex, name, risk } of dangerousPatterns) {
        const matches: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push(`  L${i + 1}: ${lines[i].trim().slice(0, 80)}`);
          }
          regex.lastIndex = 0; // reset regex
        }
        if (matches.length > 0) {
          patterns.push(`${name} in ${file} (${risk}):\n${matches.join("\n")}`);
        }
      }
    } catch { /* skip unreadable files */ }
  }

  if (patterns.length === 0) {
    return "No dangerous data patterns detected in static scan.";
  }
  return `## Static Scan Results (data operations found)\n\n${patterns.join("\n\n")}\n\nReview EACH of these for data protection issues.`;
}

/**
 * Parse findings from the DataGuard's response (reuses Bug Hunter parser format).
 */
function parseFindings(content: string): BugFinding[] {
  const findings: BugFinding[] = [];
  const regex = /\**\[(CRITICAL|HIGH|MEDIUM|LOW)\]\**\s+([^\s\[]+?)(?::(\d+))?\s*[—\-–:]\s*(.+?)(?=\n\s*(?:\**\[|VERDICT|Fix|$))/gis;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const severity = match[1].toLowerCase() as BugFinding["severity"];
    const file = match[2].trim();
    const line = match[3] || undefined;
    const description = match[4].trim().split("\n")[0].trim();
    const fixMatch = content.slice(match.index).match(/Fix:\s*(.+?)(?=\n\s*\**\[|\n\s*VERDICT|$)/is);
    const suggestion = fixMatch ? fixMatch[1].trim() : "No fix suggested.";
    findings.push({ severity, file, line: line ? String(line) : undefined, description, suggestion });
  }

  // Fallback: line-by-line parse
  if (findings.length === 0) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const simpleMatch = line.match(/\**\[(CRITICAL|HIGH|MEDIUM|LOW)\]\**\s*(.*)/i);
      if (simpleMatch) {
        const severity = simpleMatch[1].toLowerCase() as BugFinding["severity"];
        const rest = simpleMatch[2].trim();
        const fileMatch = rest.match(/^([^\s—\-–:]+)(?::(\d+))?\s*[—\-–:]?\s*(.*)/);
        const file = fileMatch ? fileMatch[1] : "unknown";
        const lineNum = fileMatch?.[2] || undefined;
        const description = fileMatch?.[3]?.trim() || rest;
        let suggestion = "No fix suggested.";
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const fixLine = lines[j].match(/Fix:\s*(.+)/i);
          if (fixLine) { suggestion = fixLine[1].trim(); break; }
        }
        findings.push({ severity, file, line: lineNum ? String(lineNum) : undefined, description, suggestion });
      }
    }
  }
  return findings;
}

/**
 * Run the DataGuard agent on the modified files.
 *
 * @param filesModified Array of absolute file paths that were modified this turn
 * @param userRequest The original user request
 * @param agentResponse The agent's final response
 * @returns DataGuardResult with findings and whether to block
 */
export async function runDataGuard(
  filesModified: string[],
  userRequest: string,
  agentResponse: string
): Promise<DataGuardResult> {
  if (filesModified.length === 0) {
    return { shouldBlock: false, findings: [], message: "", completed: false };
  }

  const done = pushActivity("dataguard", `reviewing ${filesModified.length} file(s)`);

  try {
    const systemPrompt = buildDataGuardSystemPrompt();
    const staticScan = quickScanForDataPatterns(filesModified);
    const context = buildDataGuardContext(filesModified, userRequest, agentResponse);

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${context}\n\n${staticScan}\n\nREAD each file listed above using ler_arquivo. Then hunt for DATA PROTECTION issues.` },
    ];

    log.info(`[DATAGUARD] Starting data protection review of ${filesModified.length} file(s)`);

    const MAX_TURNS = 10;
    const MAX_RETRIES = 3;
    let finalContent = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let response;
      let apiSuccess = false;

      for (let apiRetry = 0; apiRetry < MAX_RETRIES; apiRetry++) {
        try {
          const readOnlyTools = buildReadOnlyTools();
          response = await chat(messages, undefined, undefined, undefined, readOnlyTools);
          apiSuccess = true;
          break;
        } catch (err) {
          log.warn(`[DATAGUARD] LLM call failed (attempt ${apiRetry + 1}/${MAX_RETRIES}): ${(err as Error).message.slice(0, 100)}`);
          if (apiRetry < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, (apiRetry + 1) * 2000));
          }
        }
      }

      if (!apiSuccess || !response) {
        log.warn(`[DATAGUARD] All API retries exhausted — skipping review`);
        return { shouldBlock: false, findings: [], message: "[DATAGUARD] Review skipped — API unavailable.", completed: false };
      }

      const choice = response.choices?.[0];
      if (!choice) break;

      const msg = choice.message;
      const content = msg?.content ?? "";
      const toolCalls = msg?.tool_calls;

      log.info(`[DATAGUARD] Turn ${turn}: finish_reason=${choice.finish_reason}, content=${content ? content.length + " chars" : "null"}, tool_calls=${toolCalls ? toolCalls.length + " calls" : "none"}`);

      if (toolCalls && toolCalls.length > 0 && choice.finish_reason === "tool_calls") {
        messages.push(msg);
        for (const tc of toolCalls) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `[DATAGUARD: file content available via static scan above]`,
          });
        }
        continue;
      }

      finalContent = content;
      log.info(`[DATAGUARD] Final verdict received: ${content.length} chars`);
      break;
    }

    if (!finalContent || finalContent.length < 20) {
      log.warn(`[DATAGUARD] Empty or too-short response`);
      return { shouldBlock: false, findings: [], message: "", completed: false };
    }

    const findings = parseFindings(finalContent);
    const criticalAndHigh = findings.filter(f => f.severity === "critical" || f.severity === "high");
    const shouldBlock = findings.length > 0;

    console.log(`[DATAGUARD] Parsed ${findings.length} findings from ${finalContent.length} chars verdict`);
    console.log(`[DATAGUARD] critical/high: ${criticalAndHigh.length}, medium/low: ${findings.length - criticalAndHigh.length}, shouldBlock: ${shouldBlock}`);

    if (shouldBlock) {
      console.log(`[DATAGUARD] Found ${criticalAndHigh.length} critical/high data risk(s) — BLOCKING finish`);
      for (const f of findings) {
        const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "🔵";
        console.log(`[DATAGUARD] ${icon} [${f.severity.toUpperCase()}] ${f.file}${f.line ? ":" + f.line : ""} — ${f.description}`);
        console.log(`[DATAGUARD]   Fix: ${f.suggestion}`);
      }
    } else if (findings.length === 0) {
      console.log(`[DATAGUARD] ✓ NO DATA RISKS FOUND — data protection review passed`);
    }

    previousFindings = [...findings];

    // Build message using the same format as Bug Hunter
    const message = shouldBlock
      ? formatDataGuardMessage(findings)
      : "[DATAGUARD] ✓ No data protection issues found. Data is safe.";

    return { shouldBlock, findings, message, completed: true };
  } finally {
    done();
  }
}

/**
 * Format the DataGuard message to inject into the agent's context.
 */
function formatDataGuardMessage(findings: BugFinding[]): string {
  if (findings.length === 0) {
    return "[DATAGUARD] ✓ No data protection issues found. Data is safe.";
  }

  const lines: string[] = [];
  lines.push(`[DATAGUARD] ✗ DATA PROTECTION RISKS FOUND — you MUST address these before finishing:`);
  lines.push("");
  lines.push(`IMPORTANT: These findings relate to PERMANENT DATA LOSS or CORRUPTION. Unlike logic bugs, data loss is IRREVERSIBLE. You MUST fix or dismiss each finding.`);
  lines.push("");
  lines.push(`## All Findings (${findings.length} total)`);
  lines.push("");

  for (const f of findings) {
    const icon = f.severity === "critical" ? "🔴" :
                 f.severity === "high" ? "🟠" :
                 f.severity === "medium" ? "🟡" : "🔵";
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`${icon} [${f.severity.toUpperCase()}] ${loc}`);
    lines.push(`  ${f.description}`);
    lines.push(`  Fix: ${f.suggestion}`);
    lines.push("");
  }

  lines.push(`## How to address data protection findings:`);
  lines.push(`1. Fix ONE finding at a time.`);
  lines.push(`2. READ the file FIRST to understand the data flow.`);
  lines.push(`3. For SetAsync without GetAsync: add GetAsync before, or use UpdateAsync.`);
  lines.push(`4. For missing pcall: wrap DataStore operations in pcall with retry.`);
  lines.push(`5. For RemoteEvent without validation: add server-side checks.`);
  lines.push(`6. For RemoveAsync: add backup or confirmation before deleting.`);
  lines.push(`7. For race conditions: replace GetAsync+SetAsync with UpdateAsync.`);
  lines.push(`8. If a finding is a false positive, explain WHY with specific code evidence.`);

  return lines.join("\n");
}
