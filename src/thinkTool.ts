/**
 * thinkTool.ts - Structured thinking space for the model.
 *
 * Inspired by Anthropic's "Think Tool" research (+54% on tau-Bench).
 * The tool itself does nothing except return a confirmation - but it gives
 * the model a dedicated space to reason BEFORE acting, which dramatically
 * improves multi-step consistency and reduces hallucinations.
 *
 * The system prompt instructs the model to use `pensar` before EVERY write
 * operation, following a structured checklist:
 *   1. Reaffirm what will change and why
 *   2. Verify the file was read first
 *   3. Check edge cases
 *   4. Confirm the change is minimal and correct
 */

export interface ThinkArgs {
  /** The structured thinking content */
  pensamento: string;
  /** Optional: category of thinking (planning, verification, debugging, architecture) */
  categoria?: string;
}

export interface ThinkResult {
  confirmed: boolean;
  message: string;
}

export async function think(args: ThinkArgs): Promise<ThinkResult> {
  const category = args.categoria ?? "general";
  const thoughtLength = args.pensamento.length;
  
  return {
    confirmed: true,
    message: `[PENSAMENTO REGISTRADO - categoria: ${category}, ${thoughtLength} chars]\n` +
      `Use este espaço para raciocinar antes de agir. ` +
      `Agora prossiga com a ação planejada.`,
  };
}

export const THINK_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "pensar",
    description: "Structured thinking. Call before writes.",
    parameters: {
      type: "object",
      properties: {
        pensamento: {
          type: "string",
          description: "What will I change, did I read it, edge cases, minimal change.",
        },
        categoria: {
          type: "string",
          description: "Category.",
          enum: ["planning", "verification", "debugging", "architecture", "general"],
        },
      },
      required: ["pensamento"],
    },
  },
};
