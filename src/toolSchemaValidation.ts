/**
 * toolSchemaValidation.ts - Validates tool call arguments against their JSON Schema.
 *
 * Prevents the model from calling tools with missing/invalid parameters.
 * Returns clear, actionable error messages that tell the model exactly
 * what's wrong and how to fix it - inspired by Anthropic's poka-yoke approach.
 */

import * as log from "./logger.js";

interface SchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string; properties?: Record<string, SchemaProperty> };
  properties?: Record<string, SchemaProperty>;
  enum?: string[];
  required?: string[];
}

interface Schema {
  type: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function formatType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function validateType(value: unknown, expectedType: string, path: string): string | null {
  if (expectedType === "string" && typeof value !== "string") {
    return `Parameter "${path}" must be a string, got ${formatType(value)}. Use quotes around string values.`;
  }
  if (expectedType === "number" && typeof value !== "number") {
    return `Parameter "${path}" must be a number, got ${formatType(value)}.`;
  }
  if (expectedType === "boolean" && typeof value !== "boolean") {
    return `Parameter "${path}" must be a boolean (true/false), got ${formatType(value)}.`;
  }
  if (expectedType === "array" && !Array.isArray(value)) {
    return `Parameter "${path}" must be an array, got ${formatType(value)}. Use square brackets: [item1, item2].`;
  }
  if (expectedType === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
    return `Parameter "${path}" must be an object, got ${formatType(value)}. Use curly braces: {key: value}.`;
  }
  return null;
}

function validateEnum(value: unknown, enumValues: string[], path: string): string | null {
  if (typeof value === "string" && !enumValues.includes(value)) {
    return `Parameter "${path}" value "${value}" is not valid. Allowed values: ${enumValues.join(", ")}.`;
  }
  return null;
}

function validateArrayItems(items: unknown, itemSchema: { type?: string; properties?: Record<string, SchemaProperty> } | undefined, path: string): string[] {
  if (!itemSchema || !Array.isArray(items)) return [];
  const errors: string[] = [];
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemPath = `${path}[${i}]`;
    
    if (itemSchema.type && itemSchema.type === "object" && itemSchema.properties) {
      if (typeof item !== "object" || item === null) {
        errors.push(`Item ${itemPath} must be an object, got ${formatType(item)}.`);
        continue;
      }
      const objErrors = validateObject(item as Record<string, unknown>, itemSchema.properties, itemPath);
      errors.push(...objErrors);
    } else if (itemSchema.type) {
      const typeErr = validateType(item, itemSchema.type, itemPath);
      if (typeErr) errors.push(typeErr);
    }
  }
  
  return errors;
}

function validateObject(obj: Record<string, unknown>, properties: Record<string, SchemaProperty>, basePath: string): string[] {
  const errors: string[] = [];
  for (const [key, propSchema] of Object.entries(properties)) {
    const value = obj[key];
    const propPath = basePath ? `${basePath}.${key}` : key;
    errors.push(...validateProperty(value, propSchema, propPath));
  }
  return errors;
}

function validateProperty(value: unknown, propSchema: SchemaProperty, propPath: string): string[] {
  if (value === undefined || value === null) return [];

  const errors: string[] = [];

  // Type check
  if (propSchema.type) {
    const typeErr = validateType(value, propSchema.type, propPath);
    if (typeErr) {
      errors.push(typeErr);
      return errors; // skip further checks if type is wrong
    }
  }

  // Enum check
  if (propSchema.enum) {
    const enumErr = validateEnum(value, propSchema.enum, propPath);
    if (enumErr) errors.push(enumErr);
  }

  // Array items check
  if (propSchema.type === "array" && Array.isArray(value) && propSchema.items) {
    errors.push(...validateArrayItems(value, propSchema.items, propPath));
  }

  // Nested object check
  if (propSchema.type === "object" && propSchema.properties && typeof value === "object" && value !== null) {
    errors.push(...validateObject(value as Record<string, unknown>, propSchema.properties, propPath));
  }

  return errors;
}

export function validateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  schema: Schema
): ValidationResult {
  const errors: string[] = [];
  
  if (schema.required) {
    for (const reqKey of schema.required) {
      if (args[reqKey] === undefined || args[reqKey] === null || args[reqKey] === "") {
        errors.push(
          `Required parameter "${reqKey}" is missing for tool "${toolName}". ` +
          (schema.properties?.[reqKey]?.description
            ? `Description: ${schema.properties[reqKey].description}`
            : "")
        );
      }
    }
  }
  
  if (schema.properties) {
    const objErrors = validateObject(args, schema.properties, "");
    errors.push(...objErrors);
  }
  
  if (errors.length > 0) {
    log.warn(`[SCHEMA VALIDATION] Tool "${toolName}" has ${errors.length} error(s): ${errors.join("; ")}`);
  }
  
  return { valid: errors.length === 0, errors };
}

export function formatValidationErrors(toolName: string, errors: string[]): string {
  return (
    `[ERRO: VALIDAÇÃO DE SCHEMA] A chamada "${toolName}" tem argumentos inválidos:\n\n` +
    errors.map((e) => `  X ${e}`).join("\n") +
    `\n\nCorrija os argumentos e tente novamente. Verifique os tipos e campos obrigatórios.`
  );
}
