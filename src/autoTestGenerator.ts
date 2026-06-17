/**
 * autoTestGenerator.ts - Suggests test generation after each diff.
 *
 * IDEIA 7: After a successful aplicar_diff / editar_arquivo, inject a
 * system message nudging the model to write a test for the change.
 *
 * Language detection: only suggest tests for languages where we have a
 * reasonable chance of generating something useful:
 *   - .ts / .tsx        -> vitest / jest
 *   - .js / .jsx / .mjs -> jest / node:test
 *   - .py               -> pytest
 *   - .rs                -> cargo test
 *   - .go                -> go test
 *   - .java              -> JUnit
 *
 * SKIP (no test suggestion - avoid noise):
 *   - .luau / .rbxl / .rbxmx  -> Roblox Luau (no standard test runner, model would hallucinate)
 *   - .cs / .cpp / .c         -> too project-specific, would generate broken code
 *   - .md / .json / .yml      -> not code
 *   - config files, etc.
 *
 * Throttle: at most 1 suggestion per file per turn.
 */

import * as path from "node:path";
import * as log from "./logger.js";
import { shouldAutoGenerateTests } from "./effortLevels.js";

const testedExtensions = new Map<string, { framework: string; template: string }>([
  [".ts", { framework: "vitest", template: "import { describe, it, expect } from 'vitest';" }],
  [".tsx", { framework: "vitest", template: "import { describe, it, expect } from 'vitest';" }],
  [".js", { framework: "jest", template: "const { describe, it, expect } = require('jest');" }],
  [".jsx", { framework: "jest", template: "const { describe, it, expect } = require('jest');" }],
  [".mjs", { framework: "node:test", template: "import { test } from 'node:test'; import assert from 'node:assert/strict';" }],
  [".py", { framework: "pytest", template: "import pytest" }],
  [".rs", { framework: "cargo test", template: "#[cfg(test)]\nmod tests { use super::*;" }],
  [".go", { framework: "go test", template: "package main\n\nimport \"testing\"" }],
  [".java", { framework: "JUnit", template: "import org.junit.jupiter.api.Test;" }],
]);

// Extensions we explicitly skip (no point in suggesting tests)
const skippedExtensions = new Set([
  ".luau", ".rbxl", ".rbxmx", ".rbxlx", // Roblox Luau - no standard test runner
  ".cs", ".cpp", ".c", ".h", ".hpp",     // too project-specific
  ".md", ".json", ".yml", ".yaml",       // not code
  ".txt", ".csv", ".xml", ".html", ".css", ".scss",
  ".sh", ".bash", ".zsh",                // shell scripts rarely need unit tests
  ".env", ".ini", ".toml", ".properties",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
]);

const recentSuggestions = new Set<string>();

/**
 * Returns the test-suggestion message to append to a tool result, or
 * empty string if no suggestion should be made for this file.
 *
 * @param filePath  Path of the file that was just edited
 * @returns         Suggestion message, or "" to skip
 */
export function generateTestSuggestionForFile(filePath: string): string {
  if (!shouldAutoGenerateTests()) return "";

  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return "";

  // Skip explicitly unsupported languages (Luau, Roblox, etc.)
  if (skippedExtensions.has(ext)) {
    log.debug(`[AUTO_TEST] Skipped ${ext} file (language not supported for auto-test)`);
    return "";
  }

  // Look up the test framework for this extension
  const testInfo = testedExtensions.get(ext);
  if (!testInfo) {
    // Unknown extension - skip silently
    return "";
  }

  // Throttle: at most 1 suggestion per file per turn
  if (recentSuggestions.has(filePath)) return "";
  recentSuggestions.add(filePath);

  const fileName = path.basename(filePath);
  const testFileName = suggestTestFileName(filePath, ext);

  return `

--- [SUGESTÃO DE TESTE] ---
Você acabou de editar ${fileName}. Considere adicionar um teste unitário para validar a mudança.

Framework sugerido: ${testInfo.framework}
Arquivo de teste sugerido: ${testFileName}

Template inicial:
\`\`\`
${testInfo.template}
\`\`\`

Cobre pelo menos:
1. O caso principal (caminho feliz) da função/modificação que você fez
2. Um edge case (input vazio, null, ou valor limite)
3. Se aplicável, o caso de erro (ex.: lança exceção esperada)

Se a mudança NÃO merece teste (config, comentário, refactor cosmético), ignore esta sugestão.
--- [FIM DA SUGESTÃO] ---`;
}

function suggestTestFileName(filePath: string, ext: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  // Conventional test file names per language
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
      return path.join(dir, `${base}.test${ext}`);
    case ".py":
      return path.join(dir, `test_${base}.py`);
    case ".rs":
      return filePath; // Rust tests live in the same file under #[cfg(test)]
    case ".go":
      return path.join(dir, `${base}_test.go`);
    case ".java":
      return path.join(dir, `${base}Test.java`);
    default:
      return path.join(dir, `${base}.test${ext}`);
  }
}

/**
 * Reset throttle - call at the start of a new user turn.
 */
export function resetAutoTestSuggestions(): void {
  recentSuggestions.clear();
}
