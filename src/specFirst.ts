/**
 * specFirst.ts - Spec-first mode: write spec before code.
 *
 * Forces the AI to write a technical specification (inputs, outputs, types,
 * edge cases) BEFORE implementing any code. The spec becomes a contract
 * that the implementation must satisfy.
 *
 * Flow:
 *   1. User requests feature
 *   2. AI is forced to call escrever_spec({ name, inputs, outputs, edgeCases })
 *   3. Spec is saved and displayed in TUI
 *   4. AI implements the code following the spec
 *   5. Before finish_reason, spec is checked against implementation
 *
 * Integration:
 *   - apiClient.ts: add escrever_spec tool
 *   - agent.ts: dispatch tool + block finish if spec not written
 *   - App.tsx: display spec in a panel (reuse TodoPanel area)
 */

import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface Spec {
  name: string;
  description: string;
  inputs: Array<{ name: string; type: string; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: string; description?: string }>;
  edgeCases: string[];
  constraints: string[];
  createdAt: number;
}

// --- State ------------------------------------------------------------------

let currentSpec: Spec | null = null;

// --- Public API -------------------------------------------------------------

/**
 * Create a spec. Called by the AI via escrever_spec tool.
 * Replaces any existing spec.
 */
export function createSpec(spec: Omit<Spec, "createdAt">): Spec {
  currentSpec = { ...spec, createdAt: Date.now() };
  log.info(`[SPEC] Created spec: ${spec.name} (${spec.inputs.length} inputs, ${spec.outputs.length} outputs, ${spec.edgeCases.length} edge cases)`);
  return currentSpec;
}

/**
 * Get the current spec (or null).
 */
export function getSpec(): Spec | null {
  return currentSpec;
}

/**
 * Check if a spec has been written for the current task.
 */
export function hasSpec(): boolean {
  return currentSpec !== null;
}

/**
 * Clear the current spec (for new task or /reset).
 */
export function clearSpec(): void {
  currentSpec = null;
}

/**
 * Format the spec as a readable string for the AI.
 */
export function formatSpec(): string {
  if (!currentSpec) return "";

  const lines: string[] = [`[SPEC: ${currentSpec.name}]`];
  lines.push(`Description: ${currentSpec.description}`);

  if (currentSpec.inputs.length > 0) {
    lines.push(`Inputs:`);
    currentSpec.inputs.forEach((i) => {
      const req = i.required ? "required" : "optional";
      lines.push(`  - ${i.name} (${i.type}, ${req})${i.description ? ": " + i.description : ""}`);
    });
  }

  if (currentSpec.outputs.length > 0) {
    lines.push(`Outputs:`);
    currentSpec.outputs.forEach((o) => {
      lines.push(`  - ${o.name} (${o.type})${o.description ? ": " + o.description : ""}`);
    });
  }

  if (currentSpec.edgeCases.length > 0) {
    lines.push(`Edge cases to handle:`);
    currentSpec.edgeCases.forEach((e) => lines.push(`  - ${e}`));
  }

  if (currentSpec.constraints.length > 0) {
    lines.push(`Constraints:`);
    currentSpec.constraints.forEach((c) => lines.push(`  - ${c}`));
  }

  return lines.join("\n");
}
