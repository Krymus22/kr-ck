/**
 * goalVerifier.ts - Independent task completion verifier.
 *
 * When the agent tries to finish (finish_reason=stop), this module spawns
 * an INDEPENDENT verifier with a CLEAN context. The verifier receives:
 *   - The user's original request
 *   - The list of files that were modified
 *   - The agent's final response
 *
 * The verifier answers ONE question: "Was the task actually completed?"
 *
 * If NOT_DONE, the verifier lists what's still missing. This feedback is
 * injected back into the agent, forcing it to continue.
 *
 * Difference from self-validation:
 *   - Self-validation: SAME model reflects on its own work (biased)
 *   - Goal verifier: INDEPENDENT call with clean context (unbiased)
 *
 * Activation: effort=high/max + files were modified this turn.
 */

import { chat } from "./apiClient.js";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface GoalVerifyResult {
  done: boolean;
  missingItems: string[];
  reasoning: string;
  verified: boolean;
}

// --- Public API -------------------------------------------------------------

/**
 * Verify whether a task was actually completed.
 *
 * @param userRequest - The original user message
 * @param modifiedFiles - List of files that were modified this turn
 * @param agentResponse - The agent's final response
 * @returns GoalVerifyResult with done=true/false + what's missing
 */
export async function verifyGoalCompletion(
  userRequest: string,
  modifiedFiles: string[],
  agentResponse: string
): Promise<GoalVerifyResult> {
  const messages = [
    {
      role: "system" as const,
      content: `You are an INDEPENDENT task completion verifier. You did NOT participate in the work - you have no bias.

Your ONLY job: determine if the task was ACTUALLY completed.

Respond in JSON:
{
  "done": true/false,
  "missing": ["item1", "item2"],
  "reasoning": "1-2 sentences"
}

Rules:
- "done": true ONLY if ALL parts of the user's request were addressed.
- "done": false if ANYTHING is missing, incomplete, or unverified.
- "missing": list SPECIFIC items that are still needed.
- Be STRICT. "I think it's done" is NOT sufficient. Either it's done or it isn't.
- If the agent says "tests pass" but didn't run tests, that's NOT done.
- If the agent says "fixed the bug" but didn't verify the fix, that's NOT done.`,
    },
    {
      role: "user" as const,
      content: `USER REQUEST: ${userRequest.slice(0, 500)}

FILES MODIFIED:
${modifiedFiles.map((f) => `  - ${f}`).join("\n")}

AGENT'S FINAL RESPONSE:
${agentResponse.slice(0, 2000)}

Was this task actually completed? Answer in JSON.`,
    },
  ];

  try {
    const response = await chat(messages);
    const content = response.choices?.[0]?.message?.content ?? "";

    // Parse JSON from response
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = content.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonStr);

      return {
        done: parsed.done === true,
        missingItems: Array.isArray(parsed.missing) ? parsed.missing : [],
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        verified: true,
      };
    }

    // Fallback: keyword matching
    const lower = content.toLowerCase();
    const done = !lower.includes("not done") && !lower.includes("not_complete") && !lower.includes("missing");
    return {
      done,
      missingItems: [],
      reasoning: content.slice(0, 500),
      verified: true,
    };
  } catch (err) {
    log.warn(`[GOAL_VERIFIER] LLM call failed: ${(err as Error).message}`);
    return {
      done: true,  // Don't block on verifier failure
      missingItems: [],
      reasoning: `[VERIFIER UNAVAILABLE: ${(err as Error).message}]`,
      verified: false,
    };
  }
}

/**
 * Format the verification result as a message for the agent.
 * If done=false, returns a blocking message with missing items.
 */
export function formatGoalVerification(result: GoalVerifyResult): string {
  if (result.done) {
    return `[GOAL VERIFIED] Tarefa confirmada como completa por verificador independente.`;
  }

  const lines: string[] = [
    `[GOAL NOT VERIFIED] Verificador independente detectou que a tarefa NÃO está completa:`,
    `Justificativa: ${result.reasoning}`,
  ];

  if (result.missingItems.length > 0) {
    lines.push(`Itens faltantes:`);
    for (const item of result.missingItems) {
      lines.push(`  - ${item}`);
    }
  }

  lines.push(`\nContinue trabalhando. NÃO finalize até resolver todos os itens acima.`);

  return lines.join("\n");
}
