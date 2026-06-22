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
  /** Contexto adicional opcional explicando POR QUE está perguntando */
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
    description:
      "Faça uma pergunta ao usuário quando você não tem certeza de algo. " +
      "O usuário vai escolher uma das alternativas ou digitar a própria resposta. " +
      "USE SEMPRE que: não entendeu perfeitamente o pedido, há múltiplas interpretações, " +
      "precisa de informação que não está no contexto, ou precisa confirmar uma decisão importante. " +
      "NUNCA assuma — pergunte. É melhor perguntar e errar 0 vezes do que assumir e errar 5. " +
      "Dê alternativas específicas (não genéricas). O usuário sempre pode digitar resposta livre.",
    parameters: {
      type: "object",
      properties: {
        pergunta: {
          type: "string",
          description: "A pergunta em linguagem natural, clara e específica",
        },
        alternativas: {
          type: "array",
          items: { type: "string" },
          description:
            "Lista de alternativas pré-definidas (mínimo 2, máximo 6). " +
            "O usuário pode escolher uma OU digitar resposta livre.",
          minItems: 2,
          maxItems: 6,
        },
        contexto: {
          type: "string",
          description: "Contexto adicional opcional explicando POR QUE está perguntando",
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
    return { resultStr: "[ERRO] args inválidos (esperado objeto)", usedHeal: false };
  }
  const pergunta = String(args.pergunta ?? "");
  const alternativas = Array.isArray(args.alternativas) ? (args.alternativas as string[]) : [];
  const contexto = args.contexto ? String(args.contexto) : undefined;

  // Validate
  if (!pergunta) {
    return { resultStr: "[ERRO] pergunta é obrigatória", usedHeal: false };
  }
  if (alternativas.length < 2) {
    return { resultStr: "[ERRO] alternativas deve ter no mínimo 2 itens", usedHeal: false };
  }
  if (alternativas.length > 6) {
    return { resultStr: "[ERRO] alternativas deve ter no máximo 6 itens", usedHeal: false };
  }

  // Check permission
  if (!currentOnAskUser || !allowUserQuestions) {
    return {
      resultStr:
        "[ERRO] perguntar_usuario não está disponível neste contexto. " +
        "Use seu melhor julgamento e continue sem perguntar.",
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
      resultStr: `[ERRO] Falha ao obter resposta do usuário: ${(err as Error).message}`,
      usedHeal: false,
    };
  }

  // Format response for the IA
  if (response.cancelled) {
    return {
      resultStr: "[USUÁRIO CANCELOU A PERGUNTA] O usuário optou por não responder. Use seu melhor julgamento.",
      usedHeal: false,
    };
  }

  const prefix = response.fromAlternatives ? "[RESPOSTA DO USUÁRIO]" : "[RESPOSTA DO USUÁRIO (texto livre)]";
  return {
    resultStr: `${prefix} ${response.value}`,
    usedHeal: false,
  };
}
