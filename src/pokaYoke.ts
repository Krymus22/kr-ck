/**
 * pokaYoke.ts - Error-proofing helpers for tool calls.
 *
 * Enforces invariants that prevent common model mistakes BEFORE
 * the tool actually runs:
 *
 *   1. File-path tools (aplicar_diff, editar_arquivo, desfazer_edicao,
 *      ler_arquivo, etc.) MUST receive a non-empty path.
 *   2. Edit tools (aplicar_diff, editar_arquivo) should resolve to
 *      absolute paths - relative paths work but are ambiguous when
 *      the agent's cwd differs from the user's mental model.
 *   3. aplicar_diff requires a non-empty `bloco_diff` with at least
 *      one `<<<<<<< SEARCH` / `>>>>>>> REPLACE` pair.
 *   4. editar_arquivo requires either `edits` (array) OR `search`+`replace`.
 *
 * Returns clear, actionable error messages telling the model exactly
 * what's wrong - inspired by Anthropic's poka-yoke approach.
 */

import * as path from "node:path";

// --- Types -------------------------------------------------------------------

export interface PokaYokeResult {
  ok: boolean;
  error?: string;
  /** Resolved absolute path (when applicable) */
  resolvedPath?: string;
}

// --- Tools that take a single file path --------------------------------------

const PATH_TAKING_TOOLS = new Set([
  "ler_arquivo",
  "ler_arquivo_avancado",
  "aplicar_diff",
  "editar_arquivo",
  "desfazer_edicao",
  "git_blame",
  "git_show",
  "parse_ast",
]);

// --- Helpers -----------------------------------------------------------------

function isNonEmptyString(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

// --- Public API --------------------------------------------------------------

/**
 * Validate a tool call's arguments against poka-yoke rules.
 * Returns { ok: true } if the call is safe to dispatch, or
 * { ok: false, error: "..." } with a clear message the model can act on.
 */
export function pokaYokeCheck(
  toolName: string,
  args: Record<string, unknown>
): PokaYokeResult {
  // -- Path-taking tools: must have a non-empty path ----------------------
  if (PATH_TAKING_TOOLS.has(toolName)) {
    const rawPath = args.caminho ?? args.path ?? args.filePath ?? args.file;
    if (!isNonEmptyString(rawPath)) {
      return {
        ok: false,
        error:
          `[POKA-YOKE] A ferramenta "${toolName}" requer um caminho de arquivo não vazio. ` +
          `Forneça "caminho" (ou "path") com uma string não vazia. ` +
          `Exemplo: ${toolName}({ caminho: "/abs/path/to/file.ts" })`,
      };
    }
    // Null bytes em paths são PERIGOSOS: em bindings nativos/C, "\0" é
    // terminador de string — permite path injection (ex.: "/tmp/foo\0.txt"
    // pode virar "/tmp/foo" em certas chamadas C). Rejeitamos sempre.
    if (rawPath.includes("\0")) {
      return {
        ok: false,
        error:
          `[POKA-YOKE] Caminho inválido para "${toolName}": contém null byte (\\0). ` +
          `Null bytes em paths podem causar path injection em bindings nativos ` +
          `(ex.: "/tmp/foo\\0.txt" pode ser interpretado como "/tmp/foo" em C). ` +
          `Remova o caractere nulo do caminho e tente novamente.`,
      };
    }
    // path is present and safe - fall through to tool-specific checks below
    // (we'll attach resolvedPath to the final return)
  }

  // -- Tool-specific structural checks ------------------------------------
  const toolCheck = TOOL_SPECIFIC_CHECKS.get(toolName);
  if (toolCheck) {
    const result = toolCheck(args);
    if (!result.ok) return result;
  }

  // All checks passed - return ok with resolved path (if applicable)
  if (PATH_TAKING_TOOLS.has(toolName)) {
    const rawPath = (args.caminho ?? args.path ?? args.filePath ?? args.file) as string;
    return { ok: true, resolvedPath: path.resolve(rawPath) };
  }
  return { ok: true };
}

// --- Tool-specific check functions -------------------------------------------

type ToolSpecificCheck = (args: Record<string, unknown>) => PokaYokeResult;

const TOOL_SPECIFIC_CHECKS = new Map<string, ToolSpecificCheck>([
  ["aplicar_diff", checkAplicarDiff],
  ["editar_arquivo", checkEditarArquivo],
  ["desfazer_edicao", checkDesfazerEdicao],
  ["executar_comando", checkExecutarComando],
  ["editar_multi_arquivos", checkEditarMultiArquivos],
]);

function checkAplicarDiff(args: Record<string, unknown>): PokaYokeResult {
  const bloco = args.bloco_diff;
  if (!isNonEmptyString(bloco)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] aplicar_diff requer "bloco_diff" não vazio. ` +
        `Formato esperado:\n` +
        `<<<<<<< SEARCH\n[código exato do arquivo]\n=======\n[novo código]\n>>>>>>> REPLACE`,
    };
  }
  if (!bloco.includes("<<<<<<< SEARCH") || !bloco.includes(">>>>>>> REPLACE")) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] "bloco_diff" não contém a estrutura esperada. ` +
        `Cada bloco deve ter marcadores "<<<<<<< SEARCH" no início e ">>>>>>> REPLACE" no fim, ` +
        `separados por uma linha "=======".`,
    };
  }
  return { ok: true };
}

function checkEditarArquivo(args: Record<string, unknown>): PokaYokeResult {
  const hasEditsArray = Array.isArray(args.edits) && args.edits.length > 0;
  const hasSearchReplace = isNonEmptyString(args.search) && typeof args.replace === "string";
  if (!hasEditsArray && !hasSearchReplace) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] editar_arquivo requer OU "edits" (array de {search, replace, all?}) ` +
        `OU "search" + "replace" como strings. ` +
        `Exemplo 1: editar_arquivo({ path: "/x.ts", search: "foo", replace: "bar" }) ` +
        `Exemplo 2: editar_arquivo({ path: "/x.ts", edits: [{search: "foo", replace: "bar"}] })`,
    };
  }
  return { ok: true };
}

function checkDesfazerEdicao(args: Record<string, unknown>): PokaYokeResult {
  if (!isNonEmptyString(args.caminho)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] desfazer_edicao requer "caminho" (string não vazia) ` +
        `apontando para o arquivo cuja última edição deve ser desfeita.`,
    };
  }
  return { ok: true };
}

function checkExecutarComando(args: Record<string, unknown>): PokaYokeResult {
  if (!isNonEmptyString(args.comando)) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] executar_comando requer "comando" (string não vazia). ` +
        `Exemplo: executar_comando({ comando: "npm test" })`,
    };
  }
  return { ok: true };
}

function checkEditarMultiArquivos(args: Record<string, unknown>): PokaYokeResult {
  if (!Array.isArray(args.requests) || args.requests.length === 0) {
    return {
      ok: false,
      error:
        `[POKA-YOKE] editar_multi_arquivos requer "requests" como array não vazio ` +
        `de { filePath, edits: [{search, replace, all?}], createIfMissing? }.`,
    };
  }
  return { ok: true };
}

// --- Expanded Tool Descriptions ----------------------------------------------
//
// These are appended to the existing tool descriptions in apiClient.ts to
// provide the model with concrete examples and edge-case guidance, in line
// with Anthropic's poka-yoke "make the right thing easy" philosophy.

export const EXPANDED_TOOL_DESCRIPTIONS: Record<string, string> = {
  aplicar_diff: `

EXAMPLES:
  # Replace a single line
  aplicar_diff({
    caminho: "/abs/path/src/foo.ts",
    bloco_diff: "<<<<<<< SEARCH\\nconst x = 1;\\n=======\\nconst x = 2;\\n>>>>>>> REPLACE"
  })

  # Add a new function (empty SEARCH block = create-if-missing style)
  aplicar_diff({
    caminho: "/abs/path/src/newfile.ts",
    bloco_diff: "<<<<<<< SEARCH\\n=======\\nexport function hello() { return 'hi'; }\\n>>>>>>> REPLACE"
  })

EDGE CASES:
  - Whitespace differences are tolerated (the matcher normalizes runs of whitespace).
  - If SEARCH matches multiple locations, only the FIRST is replaced. To replace all, use multiple blocks.
  - After applying, a syntax validator runs. If it fails, the file is STILL saved - you'll receive the validator log as a warning. Use desfazer_edicao to roll back if needed.
  - Always read the file with ler_arquivo BEFORE calling aplicar_diff - the system enforces this.
  - Use ABSOLUTE paths to avoid ambiguity. Relative paths are resolved against the agent's cwd.`,

  editar_arquivo: `

EXAMPLES:
  # Simple replace (first match only)
  editar_arquivo({ path: "/abs/path/foo.ts", search: "const x = 1;", replace: "const x = 2;" })

  # Replace all occurrences
  editar_arquivo({ path: "/abs/path/foo.ts", search: "oldName", replace: "newName", all: true })

  # Multiple edits in one call (applied in order)
  editar_arquivo({
    path: "/abs/path/foo.ts",
    edits: [
      { search: "foo", replace: "bar" },
      { search: "baz", replace: "qux", all: true }
    ]
  })

  # Create a new file (only if it doesn't exist)
  editar_arquivo({ path: "/abs/path/new.ts", search: "", replace: "export const x = 1;", createIfMissing: true })

EDGE CASES:
  - If search string is not found, the tool returns an error - nothing is written.
  - Empty search string + createIfMissing=true creates a new file with the replace content.
  - For multi-file atomic edits with rollback, use editar_multi_arquivos instead.
  - Use ABSOLUTE paths to avoid ambiguity.`,

  desfazer_edicao: `

Restaura o conteúdo mais antigo salvo em backup para o caminho informado.
Cada aplicar_diff / editar_arquivo bem-sucedido em um arquivo EXISTENTE salva um backup automático.
Backups expiram após 5 minutos.

EXAMPLE:
  desfazer_edicao({ caminho: "/abs/path/foo.ts" })

EDGE CASES:
  - Se não houver backup (arquivo era novo, ou backup expirou), retorna erro.
  - Cada chamada restaura O backup mais recente e o remove da pilha - chamadas sucessivas desfezem edições mais antigas.
  - Não desfaz criações de arquivo (apenas edições em arquivos existentes).`,

  executar_comando: `

Executa um comando shell de forma ASSÍNCRONA com streaming de stdout/stderr.
Não bloqueia o event loop. Timeout padrão: 60s.

EXAMPLES:
  executar_comando({ comando: "npm test" })
  executar_comando({ comando: "npm run lint", cwd: "/abs/path" })
  executar_comando({ comando: "npx tsc --noEmit", timeoutMs: 120000 })

EDGE CASES:
  - Comandos que não terminam (ex.: servidores dev) serão mortos após timeoutMs.
  - Saída combinada é limitada a 512 KB. Trunca silenciosamente além disso.
  - Em Windows, usa powershell.exe; em Unix, /bin/bash.
  - Exit code != 0 retorna mensagem com [ERRO] prefixado, mas o output é preservado para análise.`,

  ler_arquivo: `

Lê o conteúdo COMPLETO de um arquivo OU lista o conteúdo de um diretório.
Retorna o conteúdo como string (arquivo) ou uma listagem formatada (diretório).

EXAMPLES:
  ler_arquivo({ caminho: "/abs/path/src/foo.ts" })
  ler_arquivo({ caminho: "/abs/path/src" })  # lista o diretório

EDGE CASES:
  - Arquivos muito grandes (>1MB) serão lidos inteiros - use ler_arquivo_avancado com offset/limit para arquivos grandes.
  - Para buscar linhas específicas com grep, use ler_arquivo_avancado({ path, grep: "pattern" }).
  - SEMPRE chame ler_arquivo ANTES de aplicar_diff/editar_arquivo - o sistema BLOQUEIA edições em arquivos não lidos.
  - Use ABSOLUTE paths.`,
};
