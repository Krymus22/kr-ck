/**
 * thinkTool.ts — Pensamento estruturado para TODOS os modelos.
 *
 * O pensar() agora é sempre ativo (mesmo no low). A profundidade muda
 * por nível de esforço, mas a IA sempre pensa antes de agir.
 *
 * Categorias:
 *   - planning: antes de começar uma tarefa (plano de implementação)
 *   - pre_edit: antes de editar um arquivo (checklist anti-bug)
 *   - pre_research: antes de pesquisar API (o que sei, o que preciso)
 *   - pre_response: antes de responder ao usuário (honestidade)
 *   - debugging: investigando um bug
 *   - architecture: decisões de design
 *   - general: outro
 *
 * A resposta do pensar() inclui um checklist estruturado que pressiona
 * a IA a verificar antes de prosseguir — não é só "THOUGHT RECORDED".
 */

import { getEffortLevel } from "./effortLevels.js";
import { t } from "./i18n.js";

export interface ThinkArgs {
  pensamento: string;
  categoria?: string;
  category?: string;
}

export interface ThinkResult {
  confirmed: boolean;
  message: string;
}

/**
 * Categorias válidas para o pensar().
 * Estendidas com pre_edit, pre_research, pre_response.
 */
export const THINK_CATEGORIES = [
  "planning",
  "pre_edit",
  "pre_research",
  "pre_response",
  "debugging",
  "architecture",
  "general",
] as const;

/**
 * Checklist por categoria — injetado na resposta do pensar()
 * para pressionar a IA a verificar antes de prosseguir.
 */
function getChecklist(category: string): string {
  switch (category) {
    case "planning":
      return `📋 Checklist do plano:
□ Listei todos os arquivos que vou criar/modificar?
□ Defini a ordem de execução?
□ Considerei o que pode dar errado?
□ Vou precisar pesquisar alguma API? (buscar_web)
□ Vou precisar explorar o código existente? (explorar_subagente)
□ Posso reuse código que já existe no projeto?`;

    case "pre_edit":
      return `🔍 Checklist anti-bug antes de editar:
□ Li o arquivo? (ler_arquivo)
□ O search string EXISTE no arquivo atual?
□ O replace pode quebrar imports/exports/tipos?
□ Que bugs posso introduzir? (liste cada um)
□ Tem edge case: null, undefined, vazio, negativo?
□ O Bug Hunter aprovaria esta mudança?
→ Se não passou no checklist, RELEIA o arquivo antes de editar.`;

    case "pre_research":
      return `🔎 Checklist antes de pesquisar:
□ O que eu já sei sobre esta API?
□ O que preciso confirmar? (versão, parâmetros, retorno)
□ Vou usar buscar_web ou ler_url?
□ Que versão da API/documentação estou procurando?`;

    case "pre_response":
      return `✓ Checklist de honestidade antes de responder:
□ O que vou dizer é VERDADE? (verifiquei ou estou alucinando?)
□ Disse "funciona" sem rodar/testar? Se sim, RODE antes.
□ Estou sendo honesto ou apenas agradando o usuário?
□ Se não sei algo, vou dizer "não sei" em vez de inventar?
□ HONESTY OVER AGREEMENT.`;

    case "debugging":
      return `🐛 Checklist de debugging:
□ Li o arquivo onde está o bug?
□ Identifiquei a linha exata?
□ Qual é a causa raiz (não o sintoma)?
□ Minha correção pode introduzir outro bug?
□ Vou rodar o projeto depois de corrigir?`;

    case "architecture":
      return `🏗️ Checklist de arquitetura:
□ Esta estrutura é a mais simples possível? (YAGNI)
□ Posso reuse algo que já existe?
□ Esta abstração é necessária AGORA ou é "para o futuro"?
□ Que arquivos serão afetados?
□ O Bug Hunter encontraria problemas de design?`;

    default:
      return `🤔 Checklist geral:
□ Pensei no que vou fazer?
□ Considerei o que pode dar errado?
□ Estou sendo honesto comigo mesmo?`;
  }
}

/**
 * Profundidade do pensar() por nível de esforço.
 * Mesmo no low, a IA deve pensar (1 frase).
 */
function getDepthInstruction(): string {
  const level = getEffortLevel();
  switch (level) {
    case "low":
      return `Pense em 1 frase: "vou fazer X porque Y".`;
    case "medium":
      return `Pense em 2-3 frases: o que, por quê, o que pode dar errado.`;
    case "high":
      return `Pense em 4-6 frases. Responda o checklist completo.`;
    case "max":
      return `Pense em 6+ frases. Estruture: (1) o que, (2) por quê, (3) o que li, (4) edge cases, (5) alternativas, (6) impacto. Responda o checklist completo.`;
    default:
      return `Pense em 2-3 frases.`;
  }
}

export async function think(args: ThinkArgs): Promise<ThinkResult> {
  const category = args.categoria ?? args.category ?? "general";
  const thoughtLength = args.pensamento.length;
  const checklist = getChecklist(category);
  const depth = getDepthInstruction();

  // A resposta do pensar() inclui:
  // 1. Confirmação de que pensou (i18n)
  // 2. Checklist estruturado por categoria
  // 3. Instrução de profundidade por nível
  // Isso pressiona a IA a verificar antes de prosseguir
  const message =
    `[THINK] ✓ Pensamento registrado (${category}, ${thoughtLength} chars)\n` +
    `${checklist}\n` +
    `Próximo passo: ${depth}`;

  return {
    confirmed: true,
    message,
  };
}

export const THINK_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "pensar",
    description:
      "Structured thinking. ALWAYS call before any action (edit, research, respond). " +
      "Categories: planning (before task), pre_edit (before editing file), " +
      "pre_research (before searching API), pre_response (before answering user), " +
      "debugging (investigating bug), architecture (design decisions), general.",
    parameters: {
      type: "object",
      properties: {
        pensamento: {
          type: "string",
          description:
            "Your structured thought. What are you about to do, why, what can go wrong, edge cases. " +
            "Think in the project's language (PT-BR). Be concise but complete.",
        },
        categoria: {
          type: "string",
          description: "Category of thinking.",
          enum: ["planning", "pre_edit", "pre_research", "pre_response", "debugging", "architecture", "general"],
        },
      },
      required: ["pensamento"],
    },
  },
};
