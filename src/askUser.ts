/**
 * askUser.ts — Sistema de Perguntas Interativas (AskUser)
 *
 * Inspirado no AskUserQuestion do Claude Code: quando a IA não tem certeza
 * de algo, ela faz uma pergunta com múltipla escolha + opção de resposta livre.
 * O agent loop PARA até o usuário responder.
 *
 * Funcionamento:
 * 1. IA chama tool `perguntar_usuario` com { pergunta, alternativas, contexto }
 * 2. Handler chama `currentOnAskUser` callback (setado pelo App.tsx)
 * 3. App.tsx mostra QuestionPrompt UI
 * 4. Usuário escolhe alternativa ou digita resposta
 * 5. Resposta retorna como tool result pra IA
 * 6. Agent loop CONTINUA
 *
 * O agent loop naturalmente pausa entre tool calls (await resultado),
 * então não precisa de mecanismo especial de pausa — só `await` no handler.
 */

import type OpenAI from "openai";

// --- Types -------------------------------------------------------------------

export interface AskUserQuestion {
  /** A pergunta em linguagem natural, clara e específica */
  pergunta: string;
  /** Lista de alternativas pré-definidas (mínimo 2, máximo 6) */
  alternativas: string[];
  /** Optional context explaining WHY you are asking */
  contexto?: string;
}

export interface AskUserResponse {
  /** Resposta do usuário (alternativa escolhida ou texto digitado) */
  value: string;
  /** Se o usuário cancelou (Esc) */
  cancelled: boolean;
  /** Se a resposta veio de uma alternativa (true) ou foi digitada (false) */
  fromAlternatives: boolean;
}

// --- Tool Definition ---------------------------------------------------------

export const ASK_USER_TOOL_DEFINITION: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "perguntar_usuario",
    description: "Ask the user a question with choices.",
    parameters: {
      type: "object",
      properties: {
        pergunta: {
          type: "string",
          description: "The question.",
        },
        alternativas: {
          type: "array",
          items: { type: "string" },
          description: "2-6 choices. User can also type freely.",
          minItems: 2,
          maxItems: 6,
        },
        contexto: {
          type: "string",
          description: "Optional context explaining WHY you are asking",
        },
      },
      required: ["pergunta", "alternativas"],
    },
  },
};

// --- Callback mechanism ------------------------------------------------------

/**
 * Callback type: receives a question, returns a promise that resolves
 * when the user answers. The App.tsx sets this callback to show the
 * QuestionPrompt UI and wait for user input.
 */
export type AskUserCallback = (question: AskUserQuestion) => Promise<AskUserResponse>;

/**
 * Module-level callback. Set by runAgentLoop, cleared in finally block.
 * When the `perguntar_usuario` handler runs, it calls this callback.
 */
let currentOnAskUser: AskUserCallback | undefined;

/**
 * Whether the current agent context allows user questions.
 * Main chat: true. Configurator: true. Sub-agents: false (default).
 */
let allowUserQuestions = true;

/** Set the callback + permission flag (called by runAgentLoop). */
export function setAskUserCallback(cb: AskUserCallback | undefined, allow: boolean = true): void {
  currentOnAskUser = cb;
  allowUserQuestions = allow;
}

/** Clear the callback (called in finally block of runAgentLoop). */
export function clearAskUserCallback(): void {
  currentOnAskUser = undefined;
  allowUserQuestions = true;
}

// --- Handler (called by dispatchToolCall → executeHandler) -------------------

/**
 * Handle the `perguntar_usuario` tool call.
 *
 * If no callback is set (sub-agent without permission), returns an error
 * so the IA knows it can't ask and should use its best judgment instead.
 *
 * If the callback is set, calls it and waits for the user's response.
 * The agent loop naturally pauses here (async/await).
 */
export async function handleAskUser(args: Record<string, unknown>): Promise<{ resultStr: string; usedHeal: boolean }> {
  // BUG FIX: guard against null/undefined args
  if (!args || typeof args !== "object") {
    return { resultStr: "[ERROR] invalid args (expected object)", usedHeal: false };
  }
  // BUG FIX: String() em objeto retorna '[object Object]'. Usar typeof check.
  const pergunta = typeof args.pergunta === "string" ? args.pergunta : "";
  const alternativas = Array.isArray(args.alternativas) ? (args.alternativas as string[]) : [];
  const contexto = typeof args.contexto === "string" ? args.contexto : undefined;

  // Validate
  if (!pergunta) {
    return { resultStr: "[ERROR] pergunta is required", usedHeal: false };
  }
  if (alternativas.length < 2) {
    return { resultStr: "[ERROR] alternativas must have at least 2 items", usedHeal: false };
  }
  if (alternativas.length > 6) {
    return { resultStr: "[ERROR] alternativas must have at most 6 items", usedHeal: false };
  }

  // BUG FIX (FIX-MISC HIGH 1): Powerful sub-agents (effort=max) bypass
  // runAgentLoop, call chat() directly, and perguntar_usuario would route
  // to this same handleAskUser with allowUserQuestions=true (inherited from
  // the main agent's context). Multiple parallel sub-agents calling
  // perguntar_usuario overwrite the single global pendingQuestion slot,
  // causing a deadlock. Guard by checking CLAUDE_KILLER_AGENT_ID — when set,
  // we're inside a sub-agent and must refuse WITHOUT invoking the callback.
  if (process.env.CLAUDE_KILLER_AGENT_ID) {
    return {
      resultStr:
        "[ERROR] perguntar_usuario is not available in sub-agent context. " +
        "Use your best judgment and continue without asking.",
      usedHeal: false,
    };
  }

  // Check permission
  if (!currentOnAskUser || !allowUserQuestions) {
    return {
      resultStr:
        "[ERROR] perguntar_usuario is not available in this context. " +
        "Use your best judgment and continue without asking.",
      usedHeal: false,
    };
  }

  // Ask the user — agent loop pauses here (async/await)
  const question: AskUserQuestion = { pergunta, alternativas, contexto };
  let response: AskUserResponse;
  try {
    response = await currentOnAskUser(question);
  } catch (err) {
    return {
      resultStr: `[ERROR] Failed to get user response: ${(err as Error).message}`,
      usedHeal: false,
    };
  }

  // Format response for the IA
  if (response.cancelled) {
    return {
      resultStr: "[USER CANCELLED QUESTION] User chose not to answer. Use your best judgment.",
      usedHeal: false,
    };
  }

  const prefix = response.fromAlternatives ? "[USER RESPONSE]" : "[USER RESPONSE (free text)]";
  return {
    resultStr: `${prefix} ${response.value}`,
    usedHeal: false,
  };
}
