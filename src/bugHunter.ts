/**
 * bugHunter.ts — Sub-agente caçador de bugs extremamente crítico.
 *
 * Antes de finalizar qualquer tarefa que modificou arquivos, este módulo
 * dispara um sub-agente INDEPENDENTE com contexto limpo que age como um
 * reviewer sênior extremamente exigente.
 *
 * Diferente do goalVerifier (que só checa se a tarefa foi "completada"),
 * o Bug Hunter procura ATIVAMENTE por:
 *   - Bugs de lógica (off-by-one, race conditions, edge cases)
 *   - Variáveis não inicializadas
 *   - Falta de validação de input
 *   - Potenciais crashes (nil access, division by zero)
 *   - Problemas de segurança (exploits, DataStore sem validação)
 *   - Código morto ou redundante
 *   - Inconsistências entre módulos
 *   - Performance issues (loops O(n²) desnecessários)
 *
 * O Bug Hunter é:
 *   - REALISTA: não assume que "deve funcionar" — verifica
 *   - BRUTALMENTE HONESTO: diz o que encontra sem suavizar
 *   - EXTREMAMENTE CRÍTICO: procura bugs ativamente, não elogia
 *   - INDEPENDENTE: contexto limpo, sem bias do trabalho que fez
 *
 * Se encontrar bugs SÉRIOS (crash, segurança, dados corrompidos),
 * BLOQUEIA o finish e força a IA a corrigir.
 */

import { chat } from "./apiClient.js";
import * as history from "./history.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import { detectLanguage, runBugTest, getTestFilePath, isTestRunnerAvailable } from "./testRunner.js";

export interface BugFinding {
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line?: string;
  description: string;
  suggestion: string;
  testStatus?: "passed" | "failed" | "skipped";
  testFile?: string;
}

export interface BugHuntResult {
  /** Whether the hunt found any bugs that should block finish */
  shouldBlock: boolean;
  /** All findings (critical + high + medium + low) */
  findings: BugFinding[];
  /** Formatted message to inject into agent context */
  message: string;
  /** Whether the hunt completed successfully */
  completed: boolean;
}

// IDEIA A: Memória entre rounds — track previous findings to compare
let previousFindings: BugFinding[] = [];

/** Reset Bug Hunter state for a new turn (called by agent.ts on turn start) */
export function resetBugHunterState(): void {
  previousFindings = [];
  fileSnapshots.clear();
}

export function runTestsForFindings(findings: BugFinding[], projectRoot: string): BugFinding[] {
  let tested = 0, passed = 0, failed = 0, skipped = 0;
  for (const finding of findings) {
    if (finding.severity !== "critical" && finding.severity !== "high") continue;
    const language = detectLanguage(finding.file);
    if (language === "unknown" || !isTestRunnerAvailable(language)) {
      finding.testStatus = "skipped"; skipped++; continue;
    }
    let testFile = getTestFilePath(finding.file);
    if (!nodePath.isAbsolute(testFile)) testFile = nodePath.resolve(projectRoot, testFile);
    if (!nodeFs.existsSync(testFile)) continue;
    finding.testFile = testFile;
    tested++;
    const result = runBugTest(testFile, projectRoot);
    if (result.passed) { finding.testStatus = "passed"; passed++; console.log(`[BUG_HUNTER_TEST] ✓ PASSED: ${finding.file}`); }
    else if (result.ran) { finding.testStatus = "failed"; failed++; console.log(`[BUG_HUNTER_TEST] ✗ FAILED: ${finding.file}`); }
    else { finding.testStatus = "skipped"; skipped++; }
  }
  if (tested > 0) console.log(`[BUG_HUNTER_TEST] Summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${tested} tested)`);
  return findings;
}

export function allCriticalHighTestsPass(findings: BugFinding[]): boolean {
  const ch = findings.filter(f => f.severity === "critical" || f.severity === "high");
  if (ch.length === 0) return true;
  return !ch.some(f => f.testStatus === "failed");
}

// IDEIA E: Track file contents before edits for diff
const fileSnapshots = new Map<string, string>();

/**
 * IDEIA E: Capture a snapshot of a file before it's edited.
 * Called by the agent before editar_arquivo executes.
 */
export function snapshotFileBeforeEdit(filePath: string): void {
  try {
    const resolved = nodePath.resolve(filePath);
    if (nodeFs.existsSync(resolved)) {
      fileSnapshots.set(resolved, nodeFs.readFileSync(resolved, "utf8"));
    }
  } catch { /* ignore */ }
}

/**
 * IDEIA E: Generate a diff of what changed in a file after editing.
 * Returns a human-readable diff string.
 *
 * MEMORY FIX (Round 4 — memory + perf): after generating the diff we DELETE
 * the snapshot from `fileSnapshots`. The snapshot holds the FULL pre-edit
 * file content (potentially megabytes for large files). Before this fix the
 * entry stayed in the Map until `resetBugHunterState()` ran at the start of
 * the NEXT turn — so within a single turn that touched N files, ALL N
 * pre-edit contents were held in memory simultaneously. For a refactor
 * touching 50 files of ~100 KB each that's ~5 MB held just for diff
 * snapshots that have already served their purpose. The diff is the only
 * thing we need going forward; the raw snapshot is no longer referenced.
 */
export function generateDiffAfterEdit(filePath: string): string {
  try {
    const resolved = nodePath.resolve(filePath);
    const before = fileSnapshots.get(resolved);
    if (!before) return ""; // no snapshot — file was new

    const after = nodeFs.existsSync(resolved)
      ? nodeFs.readFileSync(resolved, "utf8")
      : "";

    // We have what we need (before + after). Release the snapshot NOW so the
    // pre-edit content doesn't linger in memory for the rest of the turn.
    fileSnapshots.delete(resolved);

    if (before === after) return ""; // no changes

    // Simple line-by-line diff
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const maxLen = Math.max(beforeLines.length, afterLines.length);

    const changes: string[] = [];
    for (let i = 0; i < maxLen; i++) {
      const b = beforeLines[i] ?? "";
      const a = afterLines[i] ?? "";
      if (b !== a) {
        if (b && !a) changes.push(`  - L${i+1}: ${b.trim().slice(0, 100)}`);
        else if (!b && a) changes.push(`  + L${i+1}: ${a.trim().slice(0, 100)}`);
        else {
          changes.push(`  - L${i+1}: ${b.trim().slice(0, 100)}`);
          changes.push(`  + L${i+1}: ${a.trim().slice(0, 100)}`);
        }
      }
    }

    if (changes.length === 0) return "";
    return `[DIFF] ${filePath.split("/").pop()} (${changes.length} lines changed):\n${changes.join("\n")}`;
  } catch { return ""; }
}

/**
 * IDEIA D: Run the project between Bug Hunter rounds.
 * Tries to run "npx tsx src/index.ts" or "npm test" and returns the result.
 */
export async function runProjectVerification(projectDir: string): Promise<string> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: projectDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
      resolve("(project timed out after 10s)");
    }, 10000);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 1024 - stdout.length); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 1024 - stderr.length); });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve("(could not run project)");
    });

    child.on("close", (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve(combined.slice(0, 500) || "(no output)");
    });
  });
}

/**
 * Walk up from a file's directory looking for the nearest project root
 * (a directory containing package.json or default.project.json). Falls back
 * to process.cwd() if neither is found within 10 levels — better to run in
 * the wrong place than to crash.
 *
 * BUG FIX: replaces the old `dirname(f).replace("/src", "")` heuristic
 * which mangled paths like `/x/src-project/` and broke for files in
 * `tests/` or nested `src/utils/` dirs.
 */
export function findProjectDirForVerification(filePath: string): string {
  let dir = nodePath.dirname(nodePath.resolve(filePath));
  for (let i = 0; i < 10; i++) {
    if (nodeFs.existsSync(nodePath.join(dir, "package.json"))) return dir;
    if (nodeFs.existsSync(nodePath.join(dir, "default.project.json"))) return dir;
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * IDEIA A: Compare current findings with previous round's findings.
 * Returns: fixed bugs, persisting bugs, and new bugs.
 */
export function compareFindings(current: BugFinding[], previous: BugFinding[]): {
  fixed: BugFinding[];
  persisting: BugFinding[];
  newBugs: BugFinding[];
} {
  const fixed: BugFinding[] = [];
  const persisting: BugFinding[] = [];
  const newBugs: BugFinding[] = [];

  // For each previous bug, check if it still exists (by file + description similarity)
  for (const prev of previous) {
    const stillExists = current.some(curr =>
      curr.file === prev.file &&
      (curr.description === prev.description ||
       curr.description.includes(prev.description.slice(0, 40)) ||
       prev.description.includes(curr.description.slice(0, 40)))
    );
    if (stillExists) {
      persisting.push(prev);
    } else {
      fixed.push(prev);
    }
  }

  // For each current bug, check if it's new (not in previous)
  for (const curr of current) {
    const existed = previous.some(prev =>
      prev.file === curr.file &&
      (prev.description === curr.description ||
       prev.description.includes(curr.description.slice(0, 40)) ||
       curr.description.includes(prev.description.slice(0, 40)))
    );
    if (!existed) {
      newBugs.push(curr);
    }
  }

  return { fixed, persisting, newBugs };
}

/**
 * Run the Bug Hunter sub-agent.
 *
 * @param filesModified - List of files that were modified this turn
 * @param userRequest - The original user request (for context)
 * @param agentResponse - The agent's final response (what it claims it did)
 * @returns BugHuntResult with findings and whether to block
 */
export async function runBugHunter(
  filesModified: string[],
  userRequest: string,
  agentResponse: string
): Promise<BugHuntResult> {
  if (filesModified.length === 0) {
    return { shouldBlock: false, findings: [], message: "", completed: false };
  }

  const done = pushActivity("bug_hunter", `reviewing ${filesModified.length} file(s)`);

  try {
    const context = buildBugHunterContext(filesModified, userRequest, agentResponse);
    const systemPrompt = buildBugHunterSystemPrompt();
    const readOnlyTools = buildReadOnlyTools();

    // BUG FIX: The Bug Hunter needs a MINI AGENT LOOP, not a single chat() call.
    // When tools are provided, the model responds with tool_calls (not content)
    // because it wants to READ the files first. Without a loop, we get
    // content=null → "Empty response". Now we loop: model reads files, we
    // execute the tool calls, send results back, until model gives final verdict.
    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ];

    log.info(`[BUG_HUNTER] Starting critical review of ${filesModified.length} file(s)`);

    const MAX_HUNTER_TURNS = 10; // safety limit
    const MAX_HUNTER_API_RETRIES = 3; // retry API calls within each turn
    let finalContent = "";

    for (let turn = 0; turn < MAX_HUNTER_TURNS; turn++) {
      let response;
      let apiSuccess = false;

      // Retry API calls (ETIMEDOUT etc) — same pattern as main agent
      for (let apiRetry = 0; apiRetry < MAX_HUNTER_API_RETRIES; apiRetry++) {
        try {
          response = await chat(messages, undefined, undefined, undefined, readOnlyTools);
          apiSuccess = true;
          break;
        } catch (err) {
          const errMsg = (err as Error).message;
          log.warn(`[BUG_HUNTER] LLM call failed (attempt ${apiRetry + 1}/${MAX_HUNTER_API_RETRIES}): ${errMsg.slice(0, 100)}`);
          if (apiRetry < MAX_HUNTER_API_RETRIES - 1) {
            // Exponential backoff: 2s, 4s
            const waitMs = (apiRetry + 1) * 2000;
            log.warn(`[BUG_HUNTER] Retrying in ${waitMs}ms...`);
            await new Promise(r => setTimeout(r, waitMs));
          }
        }
      }

      if (!apiSuccess || !response) {
        log.warn(`[BUG_HUNTER] All API retries exhausted — skipping review this round`);
        // Don't block finish if we can't review — better to let IA finish than hang
        return { shouldBlock: false, findings: [], message: "[BUG_HUNTER] Review skipped — API unavailable. Code not reviewed.", completed: false };
      }

      const choice = response.choices?.[0];
      if (!choice) {
        log.warn(`[BUG_HUNTER] No choice in response — breaking loop`);
        break;
      }

      const msg = choice.message;
      const content = msg?.content ?? "";
      const toolCalls = msg?.tool_calls;

      // DEBUG: log what the model returned so we can see why it's failing
      log.info(`[BUG_HUNTER] Turn ${turn}: finish_reason=${choice.finish_reason}, content=${content ? content.length + " chars" : "null"}, tool_calls=${toolCalls ? toolCalls.length + " calls" : "none"}`);

      // If model wants to use tools (read files), execute them and continue
      if (toolCalls && toolCalls.length > 0 && choice.finish_reason === "tool_calls") {
        // Add the assistant message with tool_calls to history
        messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });

        // Execute each tool call
        for (const tc of toolCalls) {
          const toolName = tc.function?.name ?? "";
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* ignore */ }

          let toolResult = "";
          if (toolName === "ler_arquivo") {
            try {
              const { readFileAdvanced } = await import("./fileRead.js");
              toolResult = readFileAdvanced({
                path: args.path ?? args.caminho ?? "",
                offset: args.offset,
                limit: args.limit,
              });
            } catch (e) { toolResult = `[ERROR] Could not read: ${(e as Error).message}`; }
          } else if (toolName === "buscar_texto") {
            try {
              const { grepSearch, formatGrepResults } = await import("./contentSearch.js");
              const matches = grepSearch({
                pattern: args.pattern ?? "",
                path: args.path,
              });
              toolResult = formatGrepResults(matches);
            } catch (e) { toolResult = `[ERROR] Search failed: ${(e as Error).message}`; }
          } else if (toolName === "parse_ast") {
            try {
              const { parseFile } = await import("./lspAst.js");
              const result = await parseFile(args.path ?? "");
              toolResult = `Language: ${result.language}\nSymbols: ${result.symbols.length}\n` +
                result.symbols.map((s: any) => `  ${s.type} ${s.name} (line ${s.line})`).join("\n");
            } catch (e) { toolResult = `[ERROR] Parse failed: ${(e as Error).message}`; }
          }

          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
          log.debug(`[BUG_HUNTER] Tool ${toolName} executed → ${toolResult.length} chars`);
        }

        // Continue the loop — model will process tool results and either
        // call more tools or give final verdict
        continue;
      }

      // No tool calls — this is the final verdict
      finalContent = content;
      log.info(`[BUG_HUNTER] Final verdict received: ${content.length} chars`);
      break;
    }

    if (!finalContent || finalContent.length < 20) {
      log.warn(`[BUG_HUNTER] Empty or too-short response after loop (finalContent=${finalContent ? finalContent.length + " chars" : "null"})`);
      return { shouldBlock: false, findings: [], message: "", completed: false };
    }

    // Parse the findings from the final response
    const findings = parseFindings(finalContent);
    log.info(`[BUG_HUNTER] Parsed ${findings.length} findings from ${finalContent.length} chars verdict`);
    if (findings.length === 0) {
      // Log first 500 chars of content to see what format the model used
      log.warn(`[BUG_HUNTER] Parser found 0 findings! Content preview: ${finalContent.slice(0, 500)}`);
    }
    const criticalAndHigh = findings.filter(f => f.severity === "critical" || f.severity === "high");
    const shouldBlock = criticalAndHigh.length > 0;

    // IDEIA A: Compare with previous round
    let comparison: { fixed: BugFinding[]; persisting: BugFinding[]; newBugs: BugFinding[] } | null = null;
    if (previousFindings.length > 0) {
      comparison = compareFindings(findings, previousFindings);
      log.info(`[BUG_HUNTER] Comparison: ${comparison.fixed.length} fixed, ${comparison.persisting.length} persisting, ${comparison.newBugs.length} NEW`);
    }

    // IDEIA D: Run project between rounds (if blocking)
    let projectOutput = "";
    if (shouldBlock && filesModified.length > 0) {
      // BUG FIX: the old computation
      //   `nodePath.dirname(filesModified[0]).replace("/src", "")`
      // was fragile — it assumed the file lives directly under `<root>/src/`,
      // and `.replace("/src", "")` would also mangle paths like
      // `/home/user/src-project/foo.ts` → `/home/user/-project/foo.ts`
      // (removing "/src" from a directory name that happens to start with
      // "src"). For files in `tests/`, `lib/`, or nested subdirs of `src/`,
      // it produced a wrong cwd and the project either failed to start or
      // ran from the wrong place. Now walk up from the file's directory
      // looking for the nearest package.json (the standard project marker);
      // fall back to process.cwd() if none is found.
      const projectDir = findProjectDirForVerification(filesModified[0]);
      log.info(`[BUG_HUNTER] Running project verification in ${projectDir}...`);
      projectOutput = await runProjectVerification(projectDir);
      log.info(`[BUG_HUNTER] Project output: ${projectOutput.slice(0, 200)}`);
    }

    const message = formatBugHuntMessage(findings, shouldBlock, comparison, projectOutput);

    if (shouldBlock) {
      log.warn(`[BUG_HUNTER] Found ${criticalAndHigh.length} critical/high bug(s) — BLOCKING finish`);
      for (const f of findings) {
        const icon = f.severity === "critical" ? "🔴" : f.severity === "high" ? "🟠" : f.severity === "medium" ? "🟡" : "🔵";
        log.warn(`[BUG_HUNTER] ${icon} [${f.severity.toUpperCase()}] ${f.file}${f.line ? ":" + f.line : ""} — ${f.description}`);
        log.warn(`[BUG_HUNTER]   Fix: ${f.suggestion}`);
      }
    } else {
      log.warn(`[BUG_HUNTER] No critical/high bugs found (${findings.length} medium/low findings) — allowing finish`);
      for (const f of findings) {
        log.warn(`[BUG_HUNTER] [${f.severity.toUpperCase()}] ${f.file}${f.line ? ":" + f.line : ""} — ${f.description}`);
      }
    }

    // IDEIA A: Save findings for next round comparison
    previousFindings = [...findings];

    return { shouldBlock, findings, message, completed: true };
  } finally {
    done();
  }
}

/**
 * Build the system prompt for the Bug Hunter.
 * This is what makes it brutally honest and extremely critical.
 */
function buildBugHunterSystemPrompt(): string {
  return `You are the BUG HUNTER — an extremely critical, brutally honest code reviewer.

Your job: find EVERY bug, vulnerability, and problem in the code. You are NOT here to praise. You are here to BREAK things.

## Your personality

- REALISTIC: You don't assume "it should work." You VERIFY. If you can't verify, you say so.
- BRUTALLY HONEST: You say what you find without sugar-coating. "This will crash" not "this might have an issue."
- EXTREMELY CRITICAL: You actively hunt for bugs. You don't wait for them to be obvious. You look for edge cases, race conditions, nil access, missing validation.
- SKEPTICAL: You don't trust the agent's claims. The agent says "I fixed the bug"? You check if it's ACTUALLY fixed.
- INDEPENDENT: You have NO bias. You didn't write this code. You don't care about the agent's feelings.

## What you hunt for

1. CRASHES: nil/undefined access, division by zero, indexing errors, type mismatches
2. LOGIC BUGS: off-by-one, wrong condition, inverted logic, missing return
3. RACE CONDITIONS: shared state without locks, DataStore without UpdateAsync
4. SECURITY: client-side trust, RemoteEvent without server validation, exploitable patterns
5. EDGE CASES: empty input, nil input, negative numbers, very large numbers, concurrent access
6. MISSING VALIDATION: function parameters not checked, return values not validated
7. INCONSISTENCIES: function signature doesn't match usage, types don't match
8. PERFORMANCE: O(n²) loops, unnecessary allocations, repeated expensive operations
9. DEAD CODE: unused variables, unreachable code, redundant checks
10. DATA LOSS: operations that can lose data silently, no error handling on writes

## How you work

1. READ the actual files using ler_arquivo. Don't trust the summary — read the code.
2. TRACE the data flow. Where does input come from? Where does it go? What happens at each step?
3. THINK about edge cases. What if input is nil? Empty? Negative? Very large? Concurrent?
4. CHECK claims. The agent says "validates email"? Find the validation. Does it actually work?
5. LOOK for what's MISSING. Not just what's wrong, but what SHOULD be there and isn't.

## Output format

Respond in EXACTLY this format (no preamble, no praise, no "overall good code"):

\`\`\`
FINDINGS:

[CRITICAL] file.luau:line — description of the bug
  Impact: what breaks when this bug triggers
  Fix: specific code change to fix it

[HIGH] file.luau:line — description
  Impact: ...
  Fix: ...

[MEDIUM] file.luau:line — description
  Fix: ...

[LOW] file.luau:line — description
  Fix: ...

VERDICT: PASS | BLOCK
\`\`\`

Rules:
- VERDICT: BLOCK if there are ANY [CRITICAL] or [HIGH] findings
- VERDICT: PASS only if there are zero [CRITICAL] and zero [HIGH] findings
- If you find NO bugs at all, say "FINDINGS: none" and "VERDICT: PASS"
- Do NOT say "good code" or "well structured" — that's not your job
- Do NOT skip checking because "it looks fine" — READ and VERIFY
- Every finding MUST have a concrete Fix, not "you should fix this"`;
}

/**
 * Build the context message for the Bug Hunter.
 * Includes: what was requested, what was done, and which files to review.
 */
function buildBugHunterContext(
  filesModified: string[],
  userRequest: string,
  agentResponse: string
): string {
  return `## Task Context

### What the user requested:
${userRequest.slice(0, 1000)}

### What the agent claims it did:
${agentResponse.slice(0, 1500)}

### Files modified this turn (READ these and verify):
${filesModified.map(f => `- ${f}`).join("\n")}

## Your mission

READ each file listed above using ler_arquivo. Then hunt for bugs following your instructions.

Remember: you are INDEPENDENT. The agent's summary may be wrong or incomplete. Verify everything by reading the actual code.

Start by reading the files, then report your findings.`;
}

/**
 * Build read-only tools for the Bug Hunter.
 * The hunter can read files and search, but NOT edit.
 */
function buildReadOnlyTools(): any[] {
  return [
    {
      type: "function" as const,
      function: {
        name: "ler_arquivo",
        description: "Read file content. USE THIS to verify the actual code.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read." },
            caminho: { type: "string", description: "Alias for path." },
            offset: { type: "number", description: "Start line (1-indexed)." },
            limit: { type: "number", description: "Max lines." },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "buscar_texto",
        description: "Search for text in files. USE THIS to trace data flow.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex to search." },
            path: { type: "string", description: "Directory to search." },
          },
        },
        required: ["pattern"],
      },
    },
    {
      type: "function" as const,
      function: {
        name: "parse_ast",
        description: "Parse file AST. USE THIS to understand structure.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to parse." },
          },
        },
        required: ["path"],
      },
    },
  ];
}

/**
 * Parse findings from the Bug Hunter's response.
 */
export function parseFindings(content: string): BugFinding[] {
  const findings: BugFinding[] = [];

  // Match patterns like:
  // [CRITICAL] file.luau:42 — description
  // [CRITICAL] /abs/path/file.ts:42 - description
  // **[CRITICAL]** file.ts — description
  // [CRITICAL] file.ts:42: description
  // [CRITICAL] file.ts:42 — description
  // Flexível: aceita vários separadores (—, -, –, :) e paths absolutos
  const regex = /\**\[(CRITICAL|HIGH|MEDIUM|LOW)\]\**\s+([^\s\[]+?)(?::(\d+))?\s*[—\-–:]\s*(.+?)(?=\n\s*(?:\**\[|VERDICT|Impact|Fix|$))/gis;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const severity = match[1].toLowerCase() as BugFinding["severity"];
    const file = match[2].trim();
    const line = match[3] || undefined;
    const description = match[4].trim().split("\n")[0].trim();

    // Try to extract Fix
    const fixMatch = content.slice(match.index).match(/Fix:\s*(.+?)(?=\n\s*\**\[|\n\s*VERDICT|$)/is);
    const suggestion = fixMatch ? fixMatch[1].trim() : "No fix suggested.";

    findings.push({
      severity,
      file,
      line: line ? String(line) : undefined,
      description,
      suggestion,
    });
  }

  // Fallback: if regex found nothing but content has severity keywords, 
  // try a simpler line-by-line parse
  if (findings.length === 0) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const simpleMatch = line.match(/\**\[(CRITICAL|HIGH|MEDIUM|LOW)\]\**\s*(.*)/i);
      if (simpleMatch) {
        const severity = simpleMatch[1].toLowerCase() as BugFinding["severity"];
        const rest = simpleMatch[2].trim();
        // Try to extract file and description from rest
        const fileMatch = rest.match(/^([^\s—\-–:]+)(?::(\d+))?\s*[—\-–:]?\s*(.*)/);
        const file = fileMatch ? fileMatch[1] : "unknown";
        const lineNum = fileMatch?.[2] || undefined;
        const description = fileMatch?.[3]?.trim() || rest;

        // Look for Fix in next few lines
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
 * Format the bug hunt message to inject into the agent's context.
 */
export function formatBugHuntMessage(
  findings: BugFinding[],
  shouldBlock: boolean,
  comparison?: { fixed: BugFinding[]; persisting: BugFinding[]; newBugs: BugFinding[] } | null,
  projectOutput?: string
): string {
  if (findings.length === 0) {
    return `[BUG_HUNTER] ✓ No bugs found. Code passed critical review.`;
  }

  const lines: string[] = [];
  // BUG FIX: when `findings.length > 0` but `shouldBlock === false` (only
  // medium/low findings), the old header said "Review complete. No issues
  // found." — directly contradicting the findings listed just below. The AI
  // would read "No issues found" and skip addressing them. Distinguish the
  // two cases explicitly so the model knows whether it MUST act.
  lines.push(shouldBlock
    ? `[BUG_HUNTER] ✗ ISSUES FOUND — you MUST fix or dismiss EACH finding before finishing:`
    : `[BUG_HUNTER] Review complete. No CRITICAL/HIGH issues found, but ${findings.length} medium/low finding(s) below should be reviewed:`
  );
  lines.push("");
  lines.push(`IMPORTANT: You are NOT allowed to finish until every finding below is either FIXED (with a real code change) or EXPLICITLY DISMISSED with a valid reason (e.g., "false positive because X"). Saying "looks fine" without addressing each finding = blocking.`);
  lines.push("");

  // IDEIA A: Show comparison with previous round
  if (comparison) {
    lines.push(`## Round Comparison`);
    lines.push(`✓ FIXED: ${comparison.fixed.length} bug(s) were correctly fixed`);
    for (const f of comparison.fixed) {
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.file} — ${f.description.slice(0, 80)}`);
    }
    lines.push(`⚠ PERSISTING: ${comparison.persisting.length} bug(s) still exist — your previous fix did NOT work`);
    for (const f of comparison.persisting) {
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.file} — ${f.description.slice(0, 80)}`);
    }
    lines.push(`✗ NEW: ${comparison.newBugs.length} bug(s) were INTRODUCED by your fix — you broke something!`);
    for (const f of comparison.newBugs) {
      lines.push(`  - [${f.severity.toUpperCase()}] ${f.file} — ${f.description.slice(0, 80)}`);
    }
    lines.push("");
    if (comparison.newBugs.length > 0) {
      lines.push(`⚠ WARNING: You introduced ${comparison.newBugs.length} NEW bug(s) while fixing others.`);
      lines.push(`This usually happens when you edit without re-reading the file first, or when you change`);
      lines.push(`too many things at once. Fix ONE bug at a time, re-read after each edit.`);
      lines.push("");
    }
  }

  // IDEIA D: Show project output
  if (projectOutput && projectOutput !== "(could not run project)") {
    lines.push(`## Project Run Result`);
    lines.push(`\`\`\``);
    lines.push(projectOutput.slice(0, 300));
    lines.push(`\`\`\``);
    lines.push("");
  }

  // List all findings
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

  if (shouldBlock) {
    lines.push(`## How to address these findings:`);
    lines.push(`1. Fix ONE finding at a time — don't try to fix multiple in a single edit.`);
    lines.push(`2. READ the file FIRST (ler_arquivo) to see the current content before editing.`);
    lines.push(`3. Edit with editar_arquivo (NOT cat > or executar_comando).`);
    lines.push(`4. For each finding: either FIX it (with a real code change) or DISMISS it with a concrete reason.`);
    lines.push(`5. If you dismiss, you MUST cite the line/code that proves it's a false positive.`);
    lines.push(`6. After fixing, run the project (executar_comando "npx tsx src/index.ts") to verify nothing broke.`);
    lines.push(`7. The Bug Hunter will re-review after you finish.`);
    lines.push(`8. For MEDIUM/LOW findings: prioritize fixing the ones that affect correctness.`);

    // TEST-BASED VERIFICATION
    lines.push(``);
    lines.push(`## TEST-BASED VERIFICATION (required for critical/high):`);
    lines.push(`For EACH critical/high finding, WRITE A TEST that reproduces the bug:`);
    lines.push(``);
    lines.push(`- TypeScript (.ts): create a test file in src/__tests__/ using vitest.`);
    lines.push(`  Example: editar_arquivo({ path: "src/__tests__/ComboSystem.bughunt.test.ts", createIfMissing: true })`);
    lines.push(`  Template:`);
    lines.push(`    import { describe, it, expect } from "vitest";`);
    lines.push(`    import { ComboSystem } from "../ComboSystem";`);
    lines.push(`    it("combo multiplier at hit 10 should be 2.0", () => {`);
    lines.push(`      const cs = new ComboSystem();`);
    lines.push(`      expect(result).toBe(2.0);`);
    lines.push(`    });`);
    lines.push(`  Run: executar_comando({ comando: "npx vitest run src/__tests__/ComboSystem.bughunt.test.ts" })`);
    lines.push(``);
    lines.push(`- Python (.py): create test_bug.py with assert. Run: python3 test_bug.py`);
    lines.push(`- Luau (.luau): create test.luau with pcall + assert. Run: luau test.luau`);
    lines.push(`  (For Roblox Luau, use the MCP Roblox Studio integration if available)`);
    lines.push(`- JavaScript (.js): create test.js with assert. Run: node test.js`);
    lines.push(``);
    lines.push(`AFTER fixing each finding:`);
    lines.push(`1. Write the test that reproduces the ORIGINAL bug`);
    lines.push(`2. Run the test — it should PASS now (bug is fixed)`);
    lines.push(`3. If test FAILS, the bug persists — try a different fix`);
    lines.push(`4. If you can't write a test, explain why in your response`);
    lines.push(``);
    lines.push(`The Bug Hunter will check test results to determine if bugs are truly fixed.`);
  }

  return lines.join("\n");
}
