/**
 * invariants.ts — Runtime assertions que disparam QUANDO algo está errado.
 *
 * Diferente de testes unitários, estes rodam em PRODUÇÃO (na CLI do usuário).
 * Se um invariant dispara, significa que um bug foi introduzido no código.
 *
 * Zero overhead quando tudo está correto (só um if que não dispara).
 * Quando dispara, mostra exatamente qual invariant foi violado e onde.
 *
 * Uso:
 *   import { invariant,InvariantError } from "./invariants.js";
 *   invariant(heartbeatKey !== poolKeys[0], "HEARTBEAT_USING_POOL_KEY_0",
 *     "Heartbeat não deve usar a key #0 do pool principal");
 */

/**
 * Check an invariant. If the condition is false, log an error with context.
 * Does NOT throw — the CLI continues running, but the user sees the warning.
 *
 * @param condition Must be true. If false, the invariant is violated.
 * @param id Short identifier (e.g. "HEARTBEAT_USING_POOL_KEY_0")
 * @param message Human-readable description of what went wrong
 * @param context Optional additional data for debugging
 */
export function invariant(
  condition: boolean,
  id: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (condition) return; // All good — zero overhead

  const ctxStr = context
    ? " " + Object.entries(context).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
    : "";

  console.error(`[INVARIANT VIOLATION] ${id}: ${message}${ctxStr}`);
}

/**
 * Same as invariant, but throws an error (for critical checks where
 * continuing would cause data loss or corruption).
 */
export function invariantFatal(
  condition: boolean,
  id: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  if (condition) return;

  const ctxStr = context
    ? " " + Object.entries(context).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")
    : "";

  const fullMsg = `[INVARIANT FATAL] ${id}: ${message}${ctxStr}`;
  console.error(fullMsg);
  throw new Error(fullMsg);
}
