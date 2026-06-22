/**
 * configSchema.ts — Schema validation for mode config.json files.
 *
 * Sprint 12: Validates that mode config.json has all required fields
 * and that values are of the correct type. Returns a list of errors
 * (empty if valid).
 *
 * Sprint B (BUG-A prevention): rejeita config que mistura formato
 * legacy (enableTools/luauValidation) com formato novo (toolsDir/tools/
 * validators). Essa mistura era a causa do BUG-A onde o legacy sobrescrevia
 * o novo formato em getAllModes(). Rejeitar cedo impede que novos modos
 * sejam criados nesse estado inconsistente.
 */

export interface ConfigValidationError {
  field: string;
  message: string;
}

export function validateModeConfig(config: any): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // BUG FIX: guard against null/undefined input
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    errors.push({ field: "root", message: "config must be a non-null object" });
    return errors;
  }

  if (!config.name || typeof config.name !== "string") {
    errors.push({ field: "name", message: "name is required and must be a string" });
  }
  if (!config.label || typeof config.label !== "string") {
    errors.push({ field: "label", message: "label is required and must be a string" });
  }
  if (config.toolsDir && typeof config.toolsDir !== "string") {
    errors.push({ field: "toolsDir", message: "toolsDir must be a string" });
  }
  if (config.validators && !Array.isArray(config.validators)) {
    errors.push({ field: "validators", message: "validators must be an array" });
  }
  if (config.tools && !Array.isArray(config.tools)) {
    errors.push({ field: "tools", message: "tools must be an array" });
  }
  if (config.skills && !Array.isArray(config.skills)) {
    errors.push({ field: "skills", message: "skills must be an array" });
  }
  if (config.hooks && !Array.isArray(config.hooks)) {
    errors.push({ field: "hooks", message: "hooks must be an array" });
  }

  // Sprint B (BUG-A prevention): rejeitar formato misto.
  // Se tem toolsDir (novo formato), NÃO pode ter enableTools/enableSkills/
  // enableFeatures/luauValidation (legacy). Isso força o autor do modo a
  // escolher UM formato, evitando o bug onde legacy sobrescrevia novo.
  const hasNewFormat = !!config.toolsDir;
  const hasLegacyFields =
    !!config.enableTools ||
    !!config.enableSkills ||
    !!config.enableFeatures ||
    !!config.luauValidation;

  if (hasNewFormat && hasLegacyFields) {
    errors.push({
      field: "format",
      message:
        "Config mistura formato novo (toolsDir/tools/validators) com legacy " +
        "(enableTools/enableSkills/enableFeatures/luauValidation). Use APENAS um. " +
        "Modos novos devem usar o formato: toolsDir + tools[] + validators[]. " +
        "Modos legados (sem toolsDir) podem manter enableTools[] + luauValidation[]. " +
        "Misturar causa BUG-A: legacy sobrescreve novo em getAllModes().",
    });
  }

  // Sprint B (BUG-A prevention): se tem toolsDir, deve ter tools[] (não enableTools)
  if (hasNewFormat && !Array.isArray(config.tools)) {
    errors.push({
      field: "tools",
      message: "Modos com toolsDir (novo formato) DEVEM ter tools[] (não enableTools[]).",
    });
  }

  // Validate validators structure
  if (Array.isArray(config.validators)) {
    config.validators.forEach((v: any, i: number) => {
      if (!v.tool || typeof v.tool !== "string") {
        errors.push({ field: `validators[${i}].tool`, message: "tool is required" });
      }
      if (!v.filePattern || typeof v.filePattern !== "string") {
        errors.push({ field: `validators[${i}].filePattern`, message: "filePattern is required" });
      }
      if (typeof v.blocking !== "boolean") {
        errors.push({ field: `validators[${i}].blocking`, message: "blocking must be boolean" });
      }
    });
  }

  // Validate hooks structure
  if (Array.isArray(config.hooks)) {
    config.hooks.forEach((h: any, i: number) => {
      if (!h.name || typeof h.name !== "string") {
        errors.push({ field: `hooks[${i}].name`, message: "name is required" });
      }
      if (!h.file || typeof h.file !== "string") {
        errors.push({ field: `hooks[${i}].file`, message: "file is required" });
      }
      if (!h.trigger || !["before_write", "on_file", "on_task", "always"].includes(h.trigger)) {
        errors.push({ field: `hooks[${i}].trigger`, message: "trigger must be one of: before_write, on_file, on_task, always" });
      }
    });
  }

  return errors;
}

export function isValidModeConfig(config: any): boolean {
  return validateModeConfig(config).length === 0;
}
