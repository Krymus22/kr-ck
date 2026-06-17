/**
 * dynamicWorkflow.ts - Deterministic task orchestration via JS sandbox.
 *
 * MiMo Code proved: "Natural language is ambiguous, forgettable, and
 * unverifiable. An if statement will not forget a branch, a for loop
 * will not exit prematurely."
 *
 * This module lets the AI generate a JavaScript workflow script that
 * orchestrates sub-agents deterministically. The script is executed
 * in a sandboxed Node.js VM, not followed via prompt.
 *
 * Example workflow:
 *   const files = await agent("find all .luau files using ProfileStore");
 *   for (const file of files) {
 *     await agent(`update ${file} to use new ProfileStore API`);
 *   }
 *   await agent("run selene on all modified files");
 *
 * The AI generates this script, we execute it deterministically.
 * Each agent() call spawns a sub-agent (read-only or powerful).
 */

import * as vm from "node:vm";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface WorkflowResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  stepsExecuted: number;
}

export interface WorkflowStep {
  description: string;
  result: string;
  success: boolean;
}

// --- Public API -------------------------------------------------------------

/**
 * Execute a dynamic workflow script.
 *
 * The script has access to:
 *   - agent(question): spawns a sub-agent to answer a question
 *   - parallel(...questions): spawns multiple sub-agents in parallel
 *   - log(msg): logs a message
 *
 * The script runs in a sandboxed VM context with a 60-second timeout.
 *
 * @param script - JavaScript code to execute
 * @returns WorkflowResult with output and step count
 */
export async function executeWorkflow(script: string): Promise<WorkflowResult> {
  const start = Date.now();
  const steps: WorkflowStep[] = [];
  let output = "";

  log.info(`[WORKFLOW] Starting dynamic workflow (${script.length} chars)`);

  // Create sandbox context
  const sandbox = {
    agent: async (question: string) => {
      try {
        const { runSubAgent } = await import("./subAgents.js");
        const result = await runSubAgent({ question, powerful: false, maxToolCalls: 8 });
        steps.push({ description: question.slice(0, 100), result: result ?? "null", success: result !== null });
        output += `[AGENT] ${question.slice(0, 80)}\n  → ${(result ?? "null").slice(0, 200)}\n\n`;
        return result;
      } catch (err) {
        steps.push({ description: question.slice(0, 100), result: (err as Error).message, success: false });
        output += `[AGENT ERROR] ${question.slice(0, 80)}: ${(err as Error).message}\n\n`;
        return null;
      }
    },
    parallel: async (...questions: string[]) => {
      try {
        const { runSubAgent } = await import("./subAgents.js");
        const promises = questions.map((q) => runSubAgent({ question: q, powerful: false, maxToolCalls: 5 }));
        const results = await Promise.all(promises);
        for (let i = 0; i < questions.length; i++) {
          steps.push({ description: questions[i]!.slice(0, 100), result: results[i] ?? "null", success: results[i] !== null });
          output += `[PARALLEL] ${questions[i]!.slice(0, 80)}\n  → ${(results[i] ?? "null").slice(0, 200)}\n\n`;
        }
        return results;
      } catch (err) {
        output += `[PARALLEL ERROR]: ${(err as Error).message}\n\n`;
        return [];
      }
    },
    log: (msg: string) => {
      output += `[LOG] ${msg}\n`;
      log.info(`[WORKFLOW:log] ${msg}`);
    },
    console: { log: (msg: string) => { output += `${msg}\n`; } },
  };

  try {
    // Execute in VM with timeout
    const context = vm.createContext(sandbox);
    const wrappedScript = `(async () => {\n${script}\n})()`;
    await vm.runInNewContext(wrappedScript, context, {
      timeout: 60_000,
      displayErrors: true,
    });

    const durationMs = Date.now() - start;
    log.info(`[WORKFLOW] Completed in ${durationMs}ms, ${steps.length} steps`);

    return {
      success: true,
      output,
      durationMs,
      stepsExecuted: steps.length,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = (err as Error).message;
    log.error(`[WORKFLOW] Failed after ${durationMs}ms: ${errorMsg}`);

    return {
      success: false,
      output,
      error: errorMsg,
      durationMs,
      stepsExecuted: steps.length,
    };
  }
}

/**
 * Validate a workflow script before execution.
 * Checks for syntax errors and forbidden patterns.
 *
 * @returns { valid: boolean, error?: string }
 */
export function validateWorkflow(script: string): { valid: boolean; error?: string } {
  // Check for forbidden patterns
  const forbidden = [
    { pattern: /require\s*\(/, reason: "require() is not allowed in workflows" },
    { pattern: /import\s+/, reason: "import is not allowed in workflows" },
    { pattern: /process\./, reason: "process.* is not allowed in workflows" },
    { pattern: /fs\./, reason: "fs.* is not allowed in workflows (use agent() instead)" },
    { pattern: /child_process/, reason: "child_process is not allowed in workflows" },
  ];

  for (const { pattern, reason } of forbidden) {
    if (pattern.test(script)) {
      return { valid: false, error: reason };
    }
  }

  // Try to parse as JavaScript
  try {
    new vm.Script(`(async () => {\n${script}\n})()`);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Syntax error: ${(err as Error).message}` };
  }
}

/**
 * Get example workflow script for the AI to learn from.
 */
export function getExampleWorkflow(): string {
  return `// Example: Update all files using deprecated API
const files = await agent("find all .luau files using FindFirstChild without WaitForChild");
const fileList = files.split("\\n").filter(f => f.trim());

for (const file of fileList) {
  log("Updating " + file);
  await agent("replace FindFirstChild with WaitForChild in " + file);
}

await agent("run selene on all modified files to check for errors");
log("Done! Updated " + fileList.length + " files.");`;
}
