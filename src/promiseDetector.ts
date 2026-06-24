/**
 * promiseDetector.ts - Detect "false promises" in the agent's last message.
 *
 * Problem solved: the model sometimes says things like:
 *   "Achei algo concreto. Vou investigar mais."
 *   "Let me check that for you."
 *   "I'll look into this and get back to you."
 *
 * ...and then emits `finish_reason=stop` WITHOUT calling any tool. The agent
 * loop terminates, the spinner clears, and the user is left staring at a
 * message that promises action but performs none. From the user's POV the
 * agent just "stopped" without explanation.
 *
 * Detection strategy:
 *   1. After the agent's stop response, scan the message for promise phrases
 *      (Portuguese + English): "vou investigar", "vou verificar", "deixa eu",
 *      "I'll check", "let me look", "I will investigate", etc.
 *   2. If a promise phrase is found AND no tools were called in this turn
 *      AND no files were touched, that's a false promise.
 *   3. Inject a system message instructing the model to either:
 *        a) call a tool to investigate (ler_arquivo, buscar_texto, etc.)
 *        b) explicitly explain WHY it can't investigate right now
 *
 * Bounded retries: max 2 false-promise injections per turn (prevents
 * infinite loop if model keeps promising).
 */

export interface PromiseDetectionResult {
  detected: boolean;
  matchedPhrase: string | null;
  reason: string;
}

/**
 * Phrases that indicate a promise to take action.
 *
 * NOTA: Cada frase é um "vou + verbo de ação" específico. NÃO incluir frases
 * genéricas como "eu vou" (que apareceriam em "eu vou explicar", "eu vou
 * pensar", etc. — falsos positivos). A correspondência usa word boundaries
 * (`\b`) for evitar matches no meio de palavras.
 */
const PROMISE_PHRASES_PT = [
  "vou investigar",
  "vou verificar",
  "vou checar",
  "vou olhar",
  "vou analisar",
  "vou explorar",
  "vou pesquisar",
  "vou procurar",
  "vou testar",
  "vou rodar",
  "vou executar",
  "vou ver",
  "vou ler",
  "vou ler o arquivo",
  "vou abrir",
  "vou acessar",
  "vou buscar",
  "vou consultar",
  "vou criar",
  "vou escrever",
  "vou editar",
  "vou modificar",
  "vou atualizar",
  "vou implementar",
  "vou desenvolver",
  "vou construir",
  "vou refatorar",
  "vou corrigir",
  "vou arrumar",
  "vou consertar",
  "vou fazer",
  "vou fazer isso",
  "vou continuar",
  "vou seguir",
  "vou prosseguir",
  "vou avançar",
  "deixa eu ver",
  "deixa eu verificar",
  "deixa eu olhar",
  "deixa eu checar",
  "deixa eu procurar",
  "deixa eu pensar",
  "deixa eu ler",
  "deixa eu testar",
  "pergunta deixa eu",
  "aguarde um momento",
  "aguarde enquanto",
  "um momento,",
  "instante,",
];

const PROMISE_PHRASES_EN = [
  "i'll check",
  "i'll look",
  "i'll investigate",
  "i'll verify",
  "i'll explore",
  "i'll search",
  "i'll find",
  "i'll test",
  "i'll run",
  "i'll implement",
  "i will check",
  "i will look",
  "i will investigate",
  "i will verify",
  "i will explore",
  "i will search",
  "i will test",
  "i will run",
  "i will implement",
  "let me check",
  "let me look",
  "let me investigate",
  "let me verify",
  "let me explore",
  "let me search",
  "let me find",
  "let me test",
  "let me run",
  "let me try",
  "give me a moment",
  "give me a second",
  "one moment",
  "hold on",
  "wait a moment",
  "i'll continue",
  "i will continue",
  "i'll proceed",
  "i will proceed",
  "i'll get back",
  "i will get back",
];

/** Phrases that indicate the agent is REFUSING to act (acceptable stop). */
const REFUSAL_PHRASES = [
  "não posso",
  "nao posso",
  "não consegui",
  "nao consegui",
  "infelizmente não",
  "infelizmente nao",
  "não foi possível",
  "nao foi possivel",
  "i can't",
  "i cannot",
  "i could not",
  "i wasn't able",
  "i was not able",
  "unable to",
  "unfortunately",
];

/** Combine and lowercase for case-insensitive matching. */
const ALL_PROMISE_PHRASES = [...PROMISE_PHRASES_PT, ...PROMISE_PHRASES_EN];
const ALL_REFUSAL_PHRASES = REFUSAL_PHRASES.map((s) => s.toLowerCase());

/**
 * Pré-compila um regex por frase com word boundaries (`\b`).
 *
 * BUGFIX: Antes usávamos `String.includes(phrase)`, que matcheava substrings
 * sem considerar fronteiras de palavra. Isso gerava falsos positivos quando
 * frases genéricas como "eu vou " ou "i'll try" apareciam em respostas
 * explicativas (ex.: "eu vou explicar X", "i'll try to think").
 *
 * Agora cada frase vira um regex `\b<frase>\b` (case-insensitive). O `\b`
 * inicial é sempre adicionado (todas as frases começam com caractere de
 * palavra). O `\b` final só é adicionado quando a frase termina com caractere
 * de palavra — frases terminadas em vírgula (ex.: "um momento,") não
 * recebem `\b` final porque não há fronteira após a pontuação.
 */
function buildPhraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^\w/.test(phrase) ? "\\b" : "";
  const suffix = /\w$/.test(phrase) ? "\\b" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "i");
}

const ALL_PROMISE_REGEXES = ALL_PROMISE_PHRASES.map(buildPhraseRegex);

/**
 * Detect whether the agent's final message contains a "false promise" —
 * i.e. it promises to take action but the turn ends without any tool call
 * or file edit.
 *
 * @param agentMessage   The agent's stop-reason message content.
 * @param toolsCalled    Number of tool calls made during this turn.
 * @param filesTouched   Number of files written/edited during this turn.
 * @returns              Detection result with the matched phrase.
 */
export function detectFalsePromise(
  agentMessage: string,
  toolsCalled: number,
  filesTouched: number,
): PromiseDetectionResult {
  // Only flag if NO tools were called AND NO files were touched.
  // If the agent did call a tool, even if it also promised more, that's fine —
  // it's a partial-progress situation, not a false promise.
  if (toolsCalled > 0 || filesTouched > 0) {
    return { detected: false, matchedPhrase: null, reason: "actions were taken this turn" };
  }

  if (!agentMessage || agentMessage.length === 0) {
    return { detected: false, matchedPhrase: null, reason: "empty message" };
  }

  const lower = agentMessage.toLowerCase();

  // If the message contains a refusal phrase, don't flag — it's an explicit
  // "I can't do this" rather than a false promise.
  for (const phrase of ALL_REFUSAL_PHRASES) {
    if (lower.includes(phrase)) {
      return { detected: false, matchedPhrase: null, reason: `message contains refusal phrase: "${phrase}"` };
    }
  }

  // Look for promise phrases (com word boundaries for evitar falsos positivos)
  for (let i = 0; i < ALL_PROMISE_REGEXES.length; i++) {
    const regex = ALL_PROMISE_REGEXES[i];
    if (regex.test(lower)) {
      const phrase = ALL_PROMISE_PHRASES[i];
      return {
        detected: true,
        matchedPhrase: phrase,
        reason: `promised action ("${phrase}") but no tools were called and no files were touched`,
      };
    }
  }

  return { detected: false, matchedPhrase: null, reason: "no promise phrase detected" };
}

/**
 * Build the system message to inject when a false promise is detected.
 *
 * The message is deliberately firm but constructive — it tells the model
 * what it did wrong and what to do instead.
 */
export function buildFalsePromiseRejectionMessage(matchedPhrase: string, attempt: number): string {
  const attemptSuffix = attempt > 1 ? ` (attempt ${attempt} of 2)` : "";
  return [
    `[FALSE_PROMISE_DETECTED${attemptSuffix}]`,
    ``,
    `Your last message said "${matchedPhrase}..." but you didn't call any tool or edit any file.`,
    ``,
    `This is a problem because the user expects you to fulfill the promised action. To the user, it looks like you "stopped without doing anything".`,
    ``,
    `You have two options:`,
    ``,
    `1. **Call a tool NOW** to fulfill the promise:`,
    `   - ler_arquivo({ path: "..." }) to investigate a file`,
    `   - buscar_texto({ padrao: "...", caminho: "..." }) to search for something`,
    `   - explorar_subagente({ questao: "..." }) to delegate the investigation`,
    `   - executar_comando({ comando: "..." }) to run something`,
    ``,
    `2. **Explicitly explain WHY you cannot act now** (e.g. "I don't have access to X", "I need you to confirm Y"):`,
    `   - Instead of "I will investigate", say "I cannot investigate because Z. Can you provide W?"`,
    ``,
    `DO NOT repeat "I will investigate" without calling a tool — this will be detected again and after 2 attempts the agent will terminate.`,
  ].join("\n");
}

/**
 * Should the false-promise detector block the turn from finishing?
 *
 * Returns true if:
 *   - A false promise was detected
 *   - We haven't already retried MAX_FALSE_PROMISE_RETRIES times this turn
 */
export const MAX_FALSE_PROMISE_RETRIES = 2;

/**
 * Tracks how many times the false-promise detector has fired this turn.
 * Reset by the agent loop at the start of each user turn.
 */
let falsePromiseCountThisTurn = 0;

export function resetFalsePromiseCounter(): void {
  falsePromiseCountThisTurn = 0;
}

export function getFalsePromiseCount(): number {
  return falsePromiseCountThisTurn;
}

/**
 * Composite check: detect a false promise AND decide whether to block.
 * Side-effect: increments the false-promise counter.
 *
 * @returns true if the agent should recurse (continue working), false if
 *          the turn should be allowed to finish.
 */
export function shouldBlockForFalsePromise(
  agentMessage: string,
  toolsCalled: number,
  filesTouched: number,
): { block: boolean; reason: string; rejectionMessage?: string } {
  const detection = detectFalsePromise(agentMessage, toolsCalled, filesTouched);
  if (!detection.detected) {
    return { block: false, reason: detection.reason };
  }

  falsePromiseCountThisTurn++;
  if (falsePromiseCountThisTurn > MAX_FALSE_PROMISE_RETRIES) {
    return {
      block: false,
      reason: `max false-promise retries (${MAX_FALSE_PROMISE_RETRIES}) reached - letting turn finish`,
    };
  }

  return {
    block: true,
    reason: detection.reason,
    rejectionMessage: buildFalsePromiseRejectionMessage(detection.matchedPhrase ?? "?", falsePromiseCountThisTurn),
  };
}
