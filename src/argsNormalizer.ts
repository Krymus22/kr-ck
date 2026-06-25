/**
 * argsNormalizer.ts - Universal argument normalization for tool calls.
 *
 * Problem: different models pass args in different ways:
 *   - diffusiongemma: {"path": "/tmp"}{} (trailing garbage)
 *   - llama-3.3: {"caminho": "/x"} (PT alias instead of EN)
 *   - mistral: {"maxResults": "5"} (number as string)
 *   - deepseek: {"createIfMissing": "true"} (boolean as string)
 *   - kimi: {"edits": "[{...}]"} (array as JSON string)
 *
 * Solution: a single normalizer that runs BEFORE schema validation and
 * auto-corrects all common issues. This makes the system robust to
 * model-specific quirks — even weaker models won't fail on args.
 *
 * Strategy (in order):
 *   1. Field aliases: copy known aliases to canonical names
 *      (caminho→path, command→comando, questao→question, etc.)
 *   2. Type coercion: convert strings to numbers/booleans based on schema
 *   3. Array parsing: parse JSON strings that should be arrays
 *   4. Default values: fill in defaults from schema when missing
 *   5. Unknown field cleanup: drop fields not in schema (reduces confusion)
 *
 * This is the "poka-yoke for the model" — make the right thing easy,
 * make the wrong thing auto-corrected instead of blocked.
 */

import * as log from "./logger.js";

// --- Canonical field aliases ------------------------------------------------

/**
 * Map of (toolName → { aliasField → canonicalField }).
 * When the IA passes an alias, we copy it to the canonical name.
 * Both names remain accessible to the handler.
 */
const FIELD_ALIASES: Record<string, Record<string, string>> = {
  // Universal aliases (apply to all tools)
  "*": {
    caminho: "path",
    filePath: "path",
    file: "path",
    filename: "path",
  },
  // Tool-specific aliases
  "executar_comando": {
    command: "comando",
  },
  "explorar_subagente": {
    question: "questao",
  },
  "buscar_texto": {
    pattern: "pattern", // canonical
    padrao: "pattern",
    regex: "pattern",
    query: "pattern",
  },
  "buscar_arquivos": {
    glob: "pattern",
    pattern: "pattern",
  },
  "pensar": {
    thought: "pensamento",
    content: "pensamento",
    // 'category' is the EN alias; 'categoria' is canonical
    category: "categoria",
  },
  "perguntar_usuario": {
    question: "pergunta",
    alternatives: "alternativas",
    options: "alternativas",
    choices: "alternativas",
  },
  "atualizar_estado": {
    title: "title",
  },
  "marcar_feito": {
    task: "item",
    id: "item",
    todo: "item",
  },
  "desfazer_edicao": {
    path: "caminho", // desfazer_edicao uses caminho as canonical
    filePath: "caminho",
    file: "caminho",
  },
  "editar_multi_arquivos": {
    files: "requests",
    edits: "requests",
  },
};

// --- Main normalizer --------------------------------------------------------

/**
 * Normalize tool call arguments in-place.
 *
 * @param toolName - the tool being called
 * @param args - the args object (modified in-place)
 * @param schema - the tool's JSON schema (for type coercion + defaults)
 */
export function normalizeArgs(
  toolName: string,
  args: Record<string, unknown>,
  schema?: { properties?: Record<string, { type?: string; default?: unknown }> }
): void {
  let corrections = 0;

  // 1. Apply field aliases
  corrections += applyAliases(toolName, args);

  // 2. Type coercion based on schema
  if (schema?.properties) {
    corrections += coerceTypes(args, schema.properties);
  }

  // 3. Parse JSON strings that should be arrays/objects
  corrections += parseJsonStrings(args);

  // 4. Fill defaults from schema
  if (schema?.properties) {
    corrections += fillDefaults(args, schema.properties);
  }

  if (corrections > 0) {
    log.debug(`[NORMALIZE] ${toolName}: ${corrections} correction(s) applied`);
  }
}

// --- Alias resolution -------------------------------------------------------

function applyAliases(toolName: string, args: Record<string, unknown>): intlike {
  let count = 0;
  const universal = FIELD_ALIASES["*"] ?? {};
  const specific = FIELD_ALIASES[toolName] ?? {};

  // Apply universal aliases first
  for (const [alias, canonical] of Object.entries(universal)) {
    if (alias in args && !(canonical in args)) {
      args[canonical] = args[alias];
      // Keep the alias too — handlers may read either
      count++;
    }
  }

  // Apply tool-specific aliases
  for (const [alias, canonical] of Object.entries(specific)) {
    if (alias in args && !(canonical in args)) {
      args[canonical] = args[alias];
      count++;
    }
  }

  return count;
}

// --- Type coercion ----------------------------------------------------------

function coerceTypes(
  args: Record<string, unknown>,
  properties: Record<string, { type?: string; default?: unknown }>
): number {
  let count = 0;

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in args)) continue;
    const val = args[key];
    const expectedType = propSchema.type;

    if (expectedType === "number" && typeof val === "string") {
      const num = Number(val);
      if (!isNaN(num) && val.trim() !== "") {
        args[key] = num;
        count++;
      }
    } else if (expectedType === "boolean" && typeof val === "string") {
      if (val === "true") { args[key] = true; count++; }
      else if (val === "false") { args[key] = false; count++; }
      else if (val === "1") { args[key] = true; count++; }
      else if (val === "0") { args[key] = false; count++; }
    } else if (expectedType === "string") {
      // Coerce any non-string to string when schema expects string
      if (typeof val === "number") {
        args[key] = String(val);
        count++;
      } else if (typeof val === "boolean") {
        args[key] = String(val);
        count++;
      } else if (typeof val === "object" && val !== null) {
        // BUG-REPLACE: some models pass 'replace' as an object instead of string.
        // If it's an object with a 'content' or 'value' field, extract that.
        // Otherwise, JSON.stringify it.
        const obj = val as Record<string, unknown>;
        if (typeof obj.content === "string") {
          args[key] = obj.content;
        } else if (typeof obj.value === "string") {
          args[key] = obj.value;
        } else if (typeof obj.text === "string") {
          args[key] = obj.text;
        } else {
          args[key] = JSON.stringify(val);
        }
        count++;
      }
    }
  }

  return count;
}

// --- JSON string parsing ----------------------------------------------------

function parseJsonStrings(args: Record<string, unknown>): number {
  let count = 0;

  for (const [key, val] of Object.entries(args)) {
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed);
      args[key] = parsed;
      count++;
    } catch {
      // not valid JSON — leave as is
    }
  }

  return count;
}

// --- Default values ---------------------------------------------------------

function fillDefaults(
  args: Record<string, unknown>,
  properties: Record<string, { type?: string; default?: unknown }>
): number {
  let count = 0;

  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in args) continue;
    if (propSchema.default === undefined) continue;
    args[key] = propSchema.default;
    count++;
  }

  return count;
}

// --- Type alias for clarity -------------------------------------------------
type intlike = number;
