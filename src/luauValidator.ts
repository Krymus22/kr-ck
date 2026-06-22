/**
 * luauValidator.ts — DEPRECATED compatibility shim.
 *
 * Sprint A refatoração: este módulo foi substituído por fileValidator.ts
 * (genérico, sem switch hardcoded, mode-aware). Este arquivo mantém a API
 * antiva exportando de fileValidator.ts para não quebrar imports existentes.
 *
 * IMPORTANTE: novo código deve importar de fileValidator.ts diretamente.
 * Este shim será removido em versão futura.
 *
 * Bugs corrigidos no fileValidator.ts que existiam aqui:
 *   - BUG-B: --no-global-check hardcoded (não existe em selene 0.28.0+)
 *   - BUG-C: checava só stdout (selene 0.28.0+ manda pra stderr)
 *   - BUG-D: usava detectTool() (não mode-aware) — pulava validação
 *            quando tools estavam em modes/<mode>/tools/
 */

export {
  matchesPattern,
  validateFile as validateLuauBeforeWrite,
  getActiveValidationRules,
  shouldValidateFile,
} from "./fileValidator.js";

export type { ValidationRule, ValidationResult } from "./fileValidator.js";
