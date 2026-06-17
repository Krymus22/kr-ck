/**
 * selfValidation.ts - Forces model to self-validate before finishing.
 *
 * Inspired by Rakuten's report on Fable 5: "At the highest effort setting,
 * Claude Fable 5 reflects on and validates its own work. For us, that's what
 * makes highly autonomous operations possible."
 *
 * Implementation: when the agent is about to finish a turn (finish_reason
 * = "stop") AND it touched files in this turn, we inject a synthetic
 * system message that BLOCKS the finish and forces the model to answer:
 *   1. What did I change?
 *   2. What tests did I run to verify?
 *   3. What errors still remain?
 *   4. What edge cases did I consider?
 *
 * Only after the model has answered these questions (in a pensar() call
 * or as text) do we let it actually finish.
 *
 * Throttle: at most 1 self-validation per turn (don't loop forever).
 */

import * as history from "./history.js";
import * as log from "./logger.js";
import { getEffortLevel } from "./effortLevels.js";

let validationCountThisTurn = 0;
const MAX_VALIDATIONS_PER_TURN = 1;

/** Reset counter - call at the start of each user turn. */
export function resetSelfValidation(): void {
  validationCountThisTurn = 0;
}

/**
 * Returns true if we should block the finish_reason and force self-validation.
 * Conditions:
 *   - Model touched files this turn (otherwise it was just chatting)
 *   - Haven't already validated this turn
 *   - Effort level is Medium or higher (low effort = quick tasks, skip)
 */
export function shouldSelfValidate(touchedFilesCount: number): boolean {
  if (touchedFilesCount === 0) return false;
  if (validationCountThisTurn >= MAX_VALIDATIONS_PER_TURN) return false;
  const effort = getEffortLevel();
  if (effort === "low") return false; // user opted for speed
  return true;
}

/**
 * Inject the self-validation prompt as a system message.
 * Returns the prompt that was injected (for logging).
 */
export function injectSelfValidationPrompt(touchedFiles: string[]): string {
  validationCountThisTurn++;

  const fileList = touchedFiles.length > 5
    ? touchedFiles.slice(0, 5).join("\n  - ") + `\n  - ... e mais ${touchedFiles.length - 5}`
    : touchedFiles.join("\n  - ");

  const prompt = `[SELF-VALIDATION OBRIGATÓRIA] Antes de responder ao usuário, você DEVE usar a tool pensar() para responder explicitamente a estas 5 perguntas sobre os arquivos que você tocou neste turno:

Arquivos modificados:
  - ${fileList}

Perguntas obrigatórias (responda TODAS no pensar()):
1. O QUE MUDOU: Para cada arquivo, resuma em 1 linha o que foi alterado.
2. VERIFICAÇÃO: Quais testes/comandos você executou para validar? Se não executou nenhum, por quê?
3. ERROS RESTANTES: Há algum erro de tipo/lint/runtime que você sabe que ficou? Liste cada um.
4. EDGE CASES: Quais casos limítrofes você considerou? (ex: input vazio, null, concorrência, encoding)
5. HONESTIDADE: Você concordou com o usuário em algo que não verificou? Disse "sim" ou "funciona" sem checar? Se sim, corrija agora. Não minta para agradar.

Após validar, se descobrir algum problema, CORRIJA antes de responder.
Se tudo estiver OK, responda ao usuário normalmente com um resumo conciso das mudanças.

IMPORTANTE: Não pule esta validação. Mesmo que tenha certeza, faça o checklist.
Lembre-se: HONESTY OVER AGREEMENT. Se você disse algo que não verificou, corrija.`;

  history.addSystemMessage(prompt);
  log.debug(`[SELF_VAL] Injected self-validation prompt (turn validations: ${validationCountThisTurn})`);
  return prompt;
}
