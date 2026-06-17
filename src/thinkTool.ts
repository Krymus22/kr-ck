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
    description:
      "Structured thinking space. Use this BEFORE every write operation (aplicar_diff, editar_arquivo, editar_multi_arquivos) " +
      "to plan your changes. Follow this checklist:\n" +
      "1. REAFFIRM: What will I change and why?\n" +
      "2. VERIFY: Did I read the file first? Do I have the current content?\n" +
      "3. EDGE CASES: What could go wrong? Dependencies? Type errors?\n" +
      "4. MINIMAL: Is this the smallest change that solves the problem?\n" +
      "5. CORRECT: Does this match the user's intent exactly?\n\n" +
      "IMPORTANT: Always call `pensar` before any file edit, even if you think you know the answer. " +
      "This structured thinking dramatically reduces errors. " +
      "Example: pensar({ pensamento: \"I need to add error handling to the parseArgs function in agent.ts. I read the file at line 77-83. The current code has no try-catch around JSON.parse. I will add a try-catch that returns { _raw: raw } on failure. This matches the existing pattern and is minimal.\", categoria: \"verification\" })",
    parameters: {
      type: "object",
      properties: {
        pensamento: {
          type: "string",
          description: "Your structured thinking. Include: (1) what you're changing, (2) what the current code looks like, (3) edge cases, (4) why this is the minimal correct change.",
        },
        categoria: {
          type: "string",
          description: "Thinking category: 'planning' (before starting), 'verification' (before editing), 'debugging' (analyzing errors), 'architecture' (design decisions).",
          enum: ["planning", "verification", "debugging", "architecture", "general"],
        },
      },
      required: ["pensamento"],
    },
  },
};
