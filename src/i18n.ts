/**
 * i18n.ts - Internationalization for slash command descriptions and UI text.
 *
 * Detects user's preferred language from:
 *   1. CLAUDE_KILLER_LANG env var (explicit override)
 *   2. process.env.LANG / LC_ALL / LANGUAGE (Unix standard)
 *   3. Windows: LANG is set by index.ts based on chcp
 *   4. Default: "pt-BR" (Portuguese-Brazil — the project's primary audience)
 *
 * Currently supported: pt-BR (default), en
 *
 * Usage in code:
 *   import { t } from "./i18n.js";
 *   console.log(t("tool.blocked_by_schema"));  // → "[ERRO: VALIDAÇÃO..." or "[ERROR: SCHEMA..."
 *
 * To add a new language: add a key to TRANSLATIONS and translate the strings.
 * To add a new string: add it to BOTH pt-BR and en in TRANSLATIONS.
 */

export type Language = "en" | "pt-BR";

let cachedLang: Language | null = null;
/** Explicit override via setLanguage() — takes precedence over everything. */
let forcedLang: Language | null = null;

/** Detect user's preferred language. Cached after first call. */
export function detectLanguage(): Language {
  if (forcedLang) return forcedLang;
  if (cachedLang) return cachedLang;

  // 1. Explicit env override
  const explicit = (process.env.CLAUDE_KILLER_LANG ?? "").toLowerCase();
  if (explicit.startsWith("pt")) {
    cachedLang = "pt-BR";
    return cachedLang;
  }
  if (explicit.startsWith("en")) {
    cachedLang = "en";
    return cachedLang;
  }

  // 2. Check LANG/LC_ALL/LANGUAGE env vars (Unix + our Windows setup)
  const candidates = [
    process.env.LANG,
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANGUAGE,
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (lower.includes("pt_br") || lower.includes("pt-br") || lower.startsWith("pt")) {
      cachedLang = "pt-BR";
      return cachedLang;
    }
    if (lower.startsWith("en")) {
      cachedLang = "en";
      return cachedLang;
    }
  }

  // 3. Default — Portuguese (project's primary audience is Brazilian)
  cachedLang = "pt-BR";
  return cachedLang;
}

/** Force a specific language (used by tests, /lang command, env override). */
export function setLanguage(lang: Language): void {
  forcedLang = lang;
  cachedLang = lang;
}

/** Reset cache (used by tests). Preserves forcedLang so setLanguage persists. */
export function resetLanguageCache(): void {
  cachedLang = null;
  // Note: forcedLang is NOT reset — setLanguage is an explicit override
}

/** Reset everything including forced language (used by tests that test env detection). */
export function resetAllLanguageState(): void {
  cachedLang = null;
  forcedLang = null;
}

// --- Translation table -----------------------------------------------------

/**
 * Translation keys. Naming convention: <module>.<purpose>
 *   tool.*       — tool call/result messages
 *   ui.*         — TUI / CLI user-facing strings
 *   error.*      — error messages shown to the user
 *   success.*    — success messages
 *   warn.*       — warning messages
 *   prompt.*     — prompts injected into the IA's system messages
 */
export const TRANSLATIONS: Record<string, Record<Language, string>> = {
  // --- Tool result messages (shown to IA + user) ---------------------------
  "tool.no_results": {
    "pt-BR": "Nenhum resultado encontrado.",
    en: "No results found.",
  },
  "tool.no_results_for": {
    "pt-BR": (q: string) => `[INFO] Nenhum resultado encontrado para: "${q}"`,
    en: (q: string) => `[INFO] No results found for: "${q}"`,
  } as any,
  "tool.no_files_found": {
    "pt-BR": "Nenhum arquivo encontrado.",
    en: "No files found.",
  },
  "tool.web_results": {
    "pt-BR": (n: number, q: string) => `[RESULTADOS WEB] ${n} resultado(s) para "${q}":`,
    en: (n: number, q: string) => `[WEB RESULTS] ${n} result(s) for "${q}":`,
  } as any,
  "tool.web_search_failed": {
    "pt-BR": (e: string) => `[ERROR] Falha na busca web: ${e}`,
    en: (e: string) => `[ERROR] Web search failed: ${e}`,
  } as any,
  "tool.url_extract_failed": {
    "pt-BR": (u: string) => `[ERROR] Não foi possível extrair conteúdo de: ${u}`,
    en: (u: string) => `[ERROR] Could not extract content from: ${u}`,
  } as any,
  "tool.url_read_failed": {
    "pt-BR": (e: string) => `[ERROR] Falha ao ler URL: ${e}`,
    en: (e: string) => `[ERROR] Failed to read URL: ${e}`,
  } as any,
  "tool.content_truncated": {
    "pt-BR": (total: number, shown: number) => `\n\n[CONTEÚDO TRUNCADO — ${total} chars total, mostrando ${shown}]`,
    en: (total: number, shown: number) => `\n\n[CONTENT TRUNCATED — ${total} chars total, showing ${shown}]`,
  } as any,
  "tool.edited_files": {
    "pt-BR": (files: string) => `[SUCCESS] Editados: ${files}`,
    en: (files: string) => `[SUCCESS] Edited: ${files}`,
  } as any,
  "tool.edit_failures": {
    "pt-BR": (e: string) => `[ERROR] Falhas: ${e}`,
    en: (e: string) => `[ERROR] Failures: ${e}`,
  } as any,
  "tool.file_restored": {
    "pt-BR": (p: string) => `[SUCCESS] Arquivo restaurado a partir do backup: ${p}`,
    en: (p: string) => `[SUCCESS] File restored from backup: ${p}`,
  } as any,
  "tool.no_backup_available": {
    "pt-BR": (p: string) =>
      `[ERROR] Nenhum backup disponível para ${p}. ` +
      `Backups são criados automaticamente antes de cada editar_arquivo bem-sucedido em arquivos existentes, ` +
      `e expiram após 5 minutos.`,
    en: (p: string) =>
      `[ERROR] No backup available for ${p}. ` +
      `Backups are created automatically before each successful editar_arquivo on existing files, ` +
      `and expire after 5 minutes.`,
  } as any,
  "tool.restore_backup_failed": {
    "pt-BR": (p: string, n: number) =>
      `[ERROR] Falha ao restaurar backup para ${p}. ` +
      `Existem ${n} backup(s) registrado(s) mas a restauração falhou (arquivo de backup pode estar corrompido ou ausente).`,
    en: (p: string, n: number) =>
      `[ERROR] Failed to restore backup for ${p}. ` +
      `There are ${n} backup(s) registered but the restore failed (backup file may be corrupted or missing).`,
  } as any,
  "tool.command_no_output": {
    "pt-BR": "[OK] Comando concluído sem saída.",
    en: "[OK] Command completed with no output.",
  },
  "tool.command_timeout": {
    "pt-BR": (ms: number, out: string) => `[ERROR] Comando excedeu timeout de ${ms}ms e foi morto.\n${out}`,
    en: (ms: number, out: string) => `[ERROR] Command exceeded timeout of ${ms}ms and was killed.\n${out}`,
  } as any,
  "tool.command_failed": {
    "pt-BR": (code: number, out: string) => `[ERROR] Comando falhou (exit=${code}):\n${out}`,
    en: (code: number, out: string) => `[ERROR] Command failed (exit=${code}):\n${out}`,
  } as any,
  "tool.command_start_failed": {
    "pt-BR": (e: string) => `[ERROR] Falha ao iniciar comando: ${e}`,
    en: (e: string) => `[ERROR] Failed to start command: ${e}`,
  } as any,
  "tool.replacements_applied": {
    "pt-BR": (n: number, p: string) => `[SUCCESS] ${n} substituição(ões) aplicada(s) em ${p}`,
    en: (n: number, p: string) => `[SUCCESS] ${n} replacement(s) applied to ${p}`,
  } as any,
  "tool.zero_replacements": {
    "pt-BR": (p: string) =>
      `[AVISO] 0 substituições aplicadas em ${p}. ` +
      `Nenhuma ocorrência do texto de busca foi encontrada. ` +
      `Verifique se o 'search' corresponde exatamente ao conteúdo do arquivo. ` +
      `Use ler_arquivo para ver o conteúdo atual antes de editar.`,
    en: (p: string) =>
      `[WARNING] 0 replacements applied to ${p}. ` +
      `No occurrence of the search text was found. ` +
      `Make sure 'search' matches the file content exactly. ` +
      `Use ler_arquivo to see the current content before editing.`,
  } as any,
  "tool.file_lock_failed": {
    "pt-BR": (e: string) => `[ERROR] Não foi possível obter lock no arquivo: ${e}`,
    en: (e: string) => `[ERROR] Could not acquire file lock: ${e}`,
  } as any,
  "tool.task_state_updated": {
    "pt-BR": (u: string, d: number, t: number, dec: number, b: number) =>
      `[SUCCESS] TASK_STATE.md atualizado em ${u}.\nDone: ${d} | Todo: ${t} | Decisions: ${dec} | Bugs: ${b}`,
    en: (u: string, d: number, t: number, dec: number, b: number) =>
      `[SUCCESS] TASK_STATE.md updated at ${u}.\nDone: ${d} | Todo: ${t} | Decisions: ${dec} | Bugs: ${b}`,
  } as any,
  "tool.task_state_not_found": {
    "pt-BR": "[INFO] Nenhum TASK_STATE.md encontrado. Use atualizar_estado para criar um.",
    en: "[INFO] No TASK_STATE.md found. Use atualizar_estado to create one.",
  },
  "tool.item_moved_to_done": {
    "pt-BR": (i: string, n: number) => `[SUCCESS] Item movido para 'done': "${i}".\nTodo restante: ${n}`,
    en: (i: string, n: number) => `[SUCCESS] Item moved to 'done': "${i}".\nTodo remaining: ${n}`,
  } as any,
  "tool.subagent_disabled": {
    "pt-BR": "[INFO] Sub-agente não executou (effort level muito baixo ou falhou). Use effort=high ou max para habilitar.",
    en: "[INFO] Sub-agent did not execute (effort level too low or failed). Use effort=high or max to enable.",
  },
  "tool.thought_recorded": {
    "pt-BR": (cat: string, len: number) =>
      `[PENSAMENTO REGISTRADO - categoria: ${cat}, ${len} chars]\n` +
      `Use este espaço para raciocinar antes de agir. ` +
      `Agora prossiga com a ação planejada.`,
    en: (cat: string, len: number) =>
      `[THOUGHT RECORDED - category: ${cat}, ${len} chars]\n` +
      `Use this space to reason before acting. ` +
      `Now proceed with the planned action.`,
  } as any,

  // --- Poka-yoke errors (shown to IA) -------------------------------------
  "poka.empty_path": {
    "pt-BR": (t: string) =>
      `[POKA-YOKE] A ferramenta "${t}" requer um caminho de arquivo não vazio. ` +
      `Forneça "caminho" (ou "path") com uma string não vazia. ` +
      `Exemplo: ${t}({ caminho: "/abs/path/to/file.ts" })`,
    en: (t: string) =>
      `[POKA-YOKE] Tool "${t}" requires a non-empty file path. ` +
      `Provide "caminho" (or "path") with a non-empty string. ` +
      `Example: ${t}({ caminho: "/abs/path/to/file.ts" })`,
  } as any,
  "poka.editar_requires_args": {
    "pt-BR":
      `[POKA-YOKE] editar_arquivo requer OU "edits" (array de {search, replace, all?}) ` +
      `OU "search" + "replace" como strings. ` +
      `OU "replace" + "createIfMissing: true" (para criar novo arquivo ou append). ` +
      `Exemplo 1: editar_arquivo({ path: "/x.ts", search: "foo", replace: "bar" }) ` +
      `Exemplo 2: editar_arquivo({ path: "/x.ts", edits: [{search: "foo", replace: "bar"}] }) ` +
      `Exemplo 3: editar_arquivo({ path: "/new.ts", replace: "content", createIfMissing: true }) ` +
      `Exemplo 4 (append): editar_arquivo({ path: "/x.ts", search: "", replace: "// comment", createIfMissing: true })`,
    en:
      `[POKA-YOKE] editar_arquivo requires EITHER "edits" (array of {search, replace, all?}) ` +
      `OR "search" + "replace" as strings. ` +
      `OR "replace" + "createIfMissing: true" (to create new file or append). ` +
      `Example 1: editar_arquivo({ path: "/x.ts", search: "foo", replace: "bar" }) ` +
      `Example 2: editar_arquivo({ path: "/x.ts", edits: [{search: "foo", replace: "bar"}] }) ` +
      `Example 3: editar_arquivo({ path: "/new.ts", replace: "content", createIfMissing: true }) ` +
      `Example 4 (append): editar_arquivo({ path: "/x.ts", search: "", replace: "// comment", createIfMissing: true })`,
  },

  // --- Schema validation ---------------------------------------------------
  "schema.invalid_args": {
    "pt-BR": (t: string, errs: string) =>
      `[ERRO: VALIDAÇÃO DE SCHEMA] A chamada "${t}" tem argumentos inválidos:\n\n${errs}\n\n` +
      `Corrija os argumentos e tente novamente. Verifique os tipos e campos obrigatórios.`,
    en: (t: string, errs: string) =>
      `[ERROR: SCHEMA VALIDATION] The call to "${t}" has invalid arguments:\n\n${errs}\n\n` +
      `Fix the arguments and try again. Check the types and required fields.`,
  } as any,

  // --- API errors ----------------------------------------------------------
  "error.429_quota": {
    "pt-BR": (model: string, body: string) =>
      `\nx  Erro 429 da NVIDIA NIM API - Retry-After ausente ou muito longo - quota diária/mensal provavelmente esgotada.\n\n` +
      `   Possíveis causas:\n` +
      `     * Quota diária/mensal da sua API key esgotada\n` +
      `     * Plano gratuito sem acesso ao modelo ${model}\n` +
      `     * Verifique em: https://build.nvidia.com/ -> Usage & Billing\n\n` +
      `   Detalhes do erro: ${body}`,
    en: (model: string, body: string) =>
      `\nx  NVIDIA NIM API 429 error - Retry-After missing or too long - likely daily/monthly quota exhausted.\n\n` +
      `   Possible causes:\n` +
      `     * Daily/monthly API key quota exhausted\n` +
      `     * Free-tier plan without access to ${model}\n` +
      `     * Check: https://build.nvidia.com/ -> Usage & Billing\n\n` +
      `   Error details: ${body}`,
  } as any,

  // --- Read-before-write gate ---------------------------------------------
  "gate.read_before_write": {
    "pt-BR": (files: string) =>
      `[ERRO: READ-BEFORE-WRITE] Você tentou editar arquivos sem lê-los primeiro:\n${files}\n\n` +
      `REGRAS: SEMPRE use ler_arquivo para ler um arquivo ANTES de editá-lo. ` +
      `Isso garante que você conhece o conteúdo atual e evita alucinações.\n` +
      `Chame ler_arquivo para cada arquivo acima e DEPOIS faça a edição.`,
    en: (files: string) =>
      `[ERROR: READ-BEFORE-WRITE] You tried to edit files without reading them first:\n${files}\n\n` +
      `RULES: ALWAYS use ler_arquivo to read a file BEFORE editing it. ` +
      `This ensures you know the current content and avoids hallucinations.\n` +
      `Call ler_arquivo for each file above and THEN do the edit.`,
  } as any,

  // --- Impact analysis ----------------------------------------------------
  "impact.header": {
    "pt-BR": (f: string) => `[ANÁLISE DE IMPACTO] Antes de editar ${f}:`,
    en: (f: string) => `[IMPACT ANALYSIS] Before editing ${f}:`,
  } as any,
  "impact.symbols_count": {
    "pt-BR": (n: number) => `Encontrei ${n} símbolo(s) definido(s) neste arquivo.`,
    en: (n: number) => `Found ${n} symbol(s) defined in this file.`,
  } as any,
  "impact.usages_count": {
    "pt-BR": (u: number, f: number) => `${u} uso(s) encontrado(s) em ${f} arquivo(s) do projeto:`,
    en: (u: number, f: number) => `${u} usage(s) found in ${f} file(s):`,
  } as any,
  "impact.more_usages": {
    "pt-BR": (n: number) => `    ... e mais ${n} uso(s)`,
    en: (n: number) => `    ... and ${n} more usage(s)`,
  } as any,
  "impact.rename_warning": {
    "pt-BR":
      `Se você for RENOMEAR ou REMOVER algum desses símbolos, precisa editar ` +
      `todos os arquivos acima também. Caso contrário, vai quebrar em runtime.`,
    en:
      `If you RENAME or REMOVE any of these symbols, you must also edit ` +
      `all the files listed above. Otherwise, it will break at runtime.`,
  },
  "impact.summary": {
    "pt-BR": (u: number, f: number) => `${u} uso(s) em ${f} arquivo(s)`,
    en: (u: number, f: number) => `${u} usage(s) in ${f} file(s)`,
  } as any,

  // --- Self-validation prompt (injected into IA) -------------------------
  "prompt.self_validation": {
    "pt-BR": (files: string) =>
      `[SELF-VALIDATION OBRIGATÓRIA] Antes de responder ao usuário, você DEVE usar a tool pensar() para responder explicitamente a estas 5 perguntas sobre os arquivos que você tocou neste turno:\n\n` +
      `Arquivos modificados:\n  - ${files}\n\n` +
      `Perguntas obrigatórias (responda TODAS no pensar()):\n` +
      `1. O QUE MUDOU: Para cada arquivo, resuma em 1 linha o que foi alterado.\n` +
      `2. VERIFICAÇÃO: Quais testes/comandos você executou para validar? Se nenhum, por quê?\n` +
      `3. ERROS RESTANTES: Há algum erro de tipo/lint/runtime que você sabe que ficou? Liste cada um.\n` +
      `4. EDGE CASES: Quais casos limítrofes você considerou? (ex: input vazio, null, concorrência, encoding)\n` +
      `5. HONESTIDADE: Você concordou com o usuário em algo que não verificou? Disse "sim" ou "funciona" sem checar? Se sim, corrija agora. Não minta para agradar.\n\n` +
      `After validating, if you discover any problem, FIX it before responding.\n` +
      `Se tudo estiver OK, responda ao usuário normalmente com um resumo conciso das mudanças.\n\n` +
      `IMPORTANTE: Não pule esta validação. Mesmo que tenha certeza, faça o checklist.\n` +
      `Lembre-se: HONESTY OVER AGREEMENT. Se você disse algo que não verificou, corrija.`,
    en: (files: string) =>
      `[MANDATORY SELF-VALIDATION] Before responding to the user, you MUST use the pensar() tool to explicitly answer these 5 questions about the files you touched this turn:\n\n` +
      `Modified files:\n  - ${files}\n\n` +
      `Required questions (answer ALL in pensar()):\n` +
      `1. WHAT CHANGED: For each file, summarize in 1 line what was changed.\n` +
      `2. VERIFICATION: Which tests/commands did you run to validate? If none, why?\n` +
      `3. REMAINING ERRORS: Are there any type/lint/runtime errors you know are still there? List each one.\n` +
      `4. EDGE CASES: Which boundary cases did you consider? (e.g. empty input, null, concurrency, encoding)\n` +
      `5. HONESTY: Did you agree with the user on something you didn't verify? Did you say "yes" or "it works" without checking? If so, correct it now. Don't lie to please.\n\n` +
      `After validating, if you discover any problem, FIX it before responding.\n` +
      `If everything is OK, respond to the user normally with a concise summary of the changes.\n\n` +
      `IMPORTANT: Do not skip this validation. Even if you are sure, do the checklist.\n` +
      `Remember: HONESTY OVER AGREEMENT. If you said something you didn't verify, correct it.`,
  } as any,

  // --- False promise detector --------------------------------------------
  "promise.false_detected": {
    "pt-BR": (phrase: string, attempt: number) => {
      const suffix = attempt > 1 ? ` (tentativa ${attempt} de 2)` : "";
      return [
        `[FALSE_PROMISE_DETECTED${suffix}]`,
        ``,
        `Sua última mensagem disse "${phrase}..." mas você não chamou nenhuma ferramenta nem editou nenhum arquivo.`,
        ``,
        `Isto é um problema porque o usuário espera que você execute a ação prometida. Para o usuário, parece que você "parou sem fazer nada".`,
        ``,
        `Você tem duas opções:`,
        ``,
        `1. **Chame uma ferramenta AGORA** para cumprir a promessa:`,
        `   - ler_arquivo({ path: "..." }) para investigar um arquivo`,
        `   - buscar_texto({ padrao: "...", caminho: "..." }) para procurar algo`,
        `   - explorar_subagente({ questao: "..." }) para delegar a investigação`,
        `   - executar_comando({ comando: "..." }) para rodar algo`,
        ``,
        `2. **Explique explicitamente POR QUE não pode agir agora** (ex.: "não tenho acesso a X", "preciso que você confirme Y"):`,
        `   - Em vez de "vou investigar", diga "não consigo investigar porque Z. Você pode me fornecer W?"`,
        ``,
        `NÃO repita "vou investigar" sem chamar uma ferramenta — isso será detectado novamente e após 2 tentativas o agente terminará.`,
      ].join("\n");
    },
    en: (phrase: string, attempt: number) => {
      const suffix = attempt > 1 ? ` (attempt ${attempt} of 2)` : "";
      return [
        `[FALSE_PROMISE_DETECTED${suffix}]`,
        ``,
        `Your last message said "${phrase}..." but you didn't call any tool or edit any file.`,
        ``,
        `This is a problem because the user expects you to fulfill the promised action. To the user, it looks like you "stopped without doing anything".`,
        ``,
        `You have two options:`,
        ``,
        `1. **Call a tool NOW** to fulfill the promise:`,
        `   - ler_arquivo({ path: "..." }) to investigate a file`,
        `   - buscar_texto({ padrao: "...", caminho: "..." }) to search for something`,
        `   - explorar_subagente({ questao: "..." }) to delegate the investigation`,
        `   - executar_comando({ comando: "..." }) to run something`,
        ``,
        `2. **Explicitly explain WHY you cannot act now** (e.g. "I don't have access to X", "I need you to confirm Y"):`,
        `   - Instead of "I will investigate", say "I cannot investigate because Z. Can you provide W?"`,
        ``,
        `DO NOT repeat "I will investigate" without calling a tool — this will be detected again and after 2 attempts the agent will terminate.`,
      ].join("\n");
    },
  } as any,

  // --- Honesty system -----------------------------------------------------
  "honesty.unverified_claim": {
    "pt-BR": (c: string) => `"${c}" (nenhuma tool de verificação foi chamada)`,
    en: (c: string) => `"${c}" (no verification tool was called)`,
  } as any,
  "honesty.contradiction": {
    "pt-BR": (items: string) =>
      `[CONTRADICTION DETECTED] Você fez claims que contradizem claims anteriores:\n${items}\n\nQual está correta? Verifique antes de continuar.`,
    en: (items: string) =>
      `[CONTRADICTION DETECTED] You made claims that contradict earlier claims:\n${items}\n\nWhich one is correct? Verify before continuing.`,
  } as any,

  // --- Loop abort ---------------------------------------------------------
  "abort.loop_detected": {
    "pt-BR": (t: string, n: number) =>
      `[LOOP-ABORT] O agente foi terminado porque a tool "${t}" foi chamada ${n} vezes ` +
      `com os mesmos argumentos e continuou falhando. O modelo parece incapaz de se recuperar deste estado. ` +
      `Por favor, tente novamente com um prompt diferente ou modelo.`,
    en: (t: string, n: number) =>
      `[LOOP-ABORT] The agent was terminated because tool "${t}" was called ${n} times ` +
      `with the same arguments and kept failing. The model appears unable to recover from this state. ` +
      `Please retry with a different prompt or model.`,
  } as any,
  "abort.stop_duplicate": {
    "pt-BR": (t: string, n: number) =>
      `[STOP] Você chamou "${t}" com os mesmos argumentos ${n} vezes e continua falhando. ` +
      `PARE de tentar a mesma chamada. Responda ao usuário agora com o que você tem, ` +
      `explique o problema claramente e peça orientação se necessário. NÃO chame "${t}" novamente com os mesmos argumentos.`,
    en: (t: string, n: number) =>
      `[STOP] You have called "${t}" with the same arguments ${n} times and it keeps failing. ` +
      `STOP retrying the same call. Respond to the user now with what you have so far, ` +
      `explain the issue clearly, and ask for guidance if needed. Do NOT call "${t}" again with the same arguments.`,
  } as any,

  // --- Safety reviewer ----------------------------------------------------
  "safety.block_high": {
    "pt-BR": "[BLOQUEIO DE SEGURANÇA] Revisor detectou risco ALTO para dados:",
    en: "[SECURITY BLOCK] Reviewer detected HIGH risk to data:",
  },
  "safety.warn_low": {
    "pt-BR": "[AVISO DE SEGURANÇA] Revisor detectou risco BAIXO:",
    en: "[SECURITY WARNING] Reviewer detected LOW risk:",
  },
  "safety.ok": {
    "pt-BR": "[SEGURANÇA OK] Revisor analisou e confirmou: sem risco a dados.",
    en: "[SECURITY OK] Reviewer analyzed and confirmed: no data risk.",
  },
  "safety.patterns_detected": {
    "pt-BR": "Padrões detectados:",
    en: "Patterns detected:",
  },
  "safety.patterns_careful": {
    "pt-BR": "Padrões detectados (tratar com cuidado):",
    en: "Patterns detected (handle with care):",
  },
  "safety.do_not_write": {
    "pt-BR": "[!] NÃO escreva este código sem:",
    en: "[!] DO NOT write this code without:",
  },
  "safety.recommendations": {
    "pt-BR": [
      "  1. Confirmar explicitamente com o usuário que ele quer essa operação",
      "  2. Adicionar guardrails (ex: if not IS_TEST_SERVER then return end)",
      "  3. Implementar backup/rollback antes da operação destrutiva",
      "  4. Para DataStore: usar :UpdateAsync em vez de :SetAsync (merge em vez de overwrite)",
    ].join("\n"),
    en: [
      "  1. Explicitly confirming with the user that they want this operation",
      "  2. Adding guardrails (e.g. if not IS_TEST_SERVER then return end)",
      "  3. Implementing backup/rollback before the destructive operation",
      "  4. For DataStore: use :UpdateAsync instead of :SetAsync (merge instead of overwrite)",
    ].join("\n"),
  },
  "safety.review_retry": {
    "pt-BR":
      `Revise o código e tente novamente. Se você tem CERTEZA que o usuário pediu isso, ` +
      `explique o risco no seu response e peça confirmação antes de prosseguir.`,
    en:
      `Review the code and try again. If you are CERTAIN the user asked for this, ` +
      `explain the risk in your response and ask for confirmation before proceeding.`,
  },

  // --- Misc UI ------------------------------------------------------------
  "ui.untitled": {
    "pt-BR": "(sem título)",
    en: "(untitled)",
  },
  "ui.no_tool_suggested": {
    "pt-BR": "Nenhuma tool sugerida para esta mensagem.",
    en: "No tool suggested for this message.",
  },

  // --- Fix suggestions ---------------------------------------------------
  "fix.no_suggestions": {
    "pt-BR":
      `[INFO] Nenhuma sugestão de fix disponível. Esta tool analisa falhas de teste — ` +
      `se o projeto não tem framework de teste (vitest/jest/pytest/cargo/go) ou nenhum teste falhou, ` +
      `nenhuma sugestão pode ser gerada. Para análise estática de código, use parse_ast.`,
    en:
      `[INFO] No fix suggestions available. This tool analyzes test failures — ` +
      `if the project has no test framework (vitest/jest/pytest/cargo/go) or no tests failed, ` +
      `no suggestions can be generated. For static code analysis, use parse_ast instead.`,
  },
};

// --- Public API -----------------------------------------------------------

/**
 * Translate a key. Supports parameterized strings via (...args) => string.
 * Usage:
 *   t("tool.no_results")                          // → static string
 *   t("tool.no_results_for", "foo")               // → parameterized
 *   t("tool.replacements_applied", 3, "/x.ts")    // → multiple params
 */
export function t(key: string, ...args: unknown[]): string {
  const lang = detectLanguage();
  const entry = TRANSLATIONS[key];
  if (!entry) {
    // Unknown key — return the key itself so the bug is visible
    return `[?${key}?]`;
  }
  const val = entry[lang] ?? entry["pt-BR"];
  if (typeof val === "function") {
    return (val as (...a: unknown[]) => string)(...args);
  }
  return val as string;
}

// --- Slash command descriptions (kept separate for autocomplete) ----------

export interface CommandI18n {
  desc: string;
  /** Optional subcommands shown in autocomplete after the command + space */
  subcommands?: string[];
}

export const COMMAND_I18N: Record<string, Record<Language, CommandI18n>> = {
  "/help": {
    "pt-BR": { desc: "Mostrar ajuda" },
    en: { desc: "Show help" },
  },
  "/hub": {
    "pt-BR": { desc: "Extension Hub (central de controle)" },
    en: { desc: "Extension Hub (control center)" },
  },
  "/mode": {
    "pt-BR": {
      desc: "Listar/trocar/criar modos de projeto",
      subcommands: ["roblox", "devops", "off", "create", "confirm", "new", "keep"],
    },
    en: {
      desc: "List/switch/create project modes",
      subcommands: ["roblox", "devops", "off", "create", "confirm", "new", "keep"],
    },
  },
  "/reset": {
    "pt-BR": { desc: "Limpar histórico" },
    en: { desc: "Clear history" },
  },
  "/history": {
    "pt-BR": { desc: "Resumo do histórico" },
    en: { desc: "History summary" },
  },
  "/skills": {
    "pt-BR": { desc: "Listar skills" },
    en: { desc: "List skills" },
  },
  "/plugins": {
    "pt-BR": { desc: "Listar servidores MCP" },
    en: { desc: "List MCP servers" },
  },
  "/tools": {
    "pt-BR": { desc: "Listar ferramentas externas" },
    en: { desc: "List external tools" },
  },
  "/toolinfo": {
    "pt-BR": { desc: "Mostrar detalhes da ferramenta" },
    en: { desc: "Show tool details" },
  },
  "/effort": {
    "pt-BR": {
      desc: "Definir nível de esforço (low/medium/high/max)",
      subcommands: ["low", "medium", "high", "max"],
    },
    en: {
      desc: "Set effort level (low/medium/high/max)",
      subcommands: ["low", "medium", "high", "max"],
    },
  },
  "/pool": {
    "pt-BR": { desc: "Mostrar status do pool de chaves API" },
    en: { desc: "Show API key pool status" },
  },
  "/caveman": {
    "pt-BR": { desc: "Alternar modo caveman" },
    en: { desc: "Toggle caveman mode" },
  },
  "/memory": {
    "pt-BR": { desc: "Mostrar memória do projeto" },
    en: { desc: "Show project memory" },
  },
  "/todos": {
    "pt-BR": { desc: "Mostrar lista de tarefas" },
    en: { desc: "Show todo list" },
  },
  "/plan": {
    "pt-BR": { desc: "Alternar modo planejamento" },
    en: { desc: "Toggle plan mode" },
  },
  "/compact": {
    "pt-BR": { desc: "Compactar contexto" },
    en: { desc: "Compact context" },
  },
  "/dream": {
    "pt-BR": { desc: "Revisar e comprimir memória" },
    en: { desc: "Review & compress memory" },
  },
  "/distill": {
    "pt-BR": { desc: "Extrair skills de workflow" },
    en: { desc: "Extract workflow skills" },
  },
  "/lang": {
    "pt-BR": {
      desc: "Trocar idioma (pt-BR, en)",
      subcommands: ["pt-BR", "en"],
    },
    en: {
      desc: "Switch language (pt-BR, en)",
      subcommands: ["pt-BR", "en"],
    },
  },
  "/exit": {
    "pt-BR": { desc: "Sair" },
    en: { desc: "Exit" },
  },
  "/organize": {
    "pt-BR": { desc: "Organizar arquivos do inbox do modo ativo" },
    en: { desc: "Organize files in the active mode's inbox" },
  },
  "/searx": {
    "pt-BR": {
      desc: "Status da busca local Searx (instalação é automática)",
    },
    en: {
      desc: "Searx local search status (install is automatic)",
    },
  },
};

/** Get the localized description + subcommands for a slash command. */
export function getCommandI18n(cmd: string): CommandI18n {
  const lang = detectLanguage();
  const entry = COMMAND_I18N[cmd];
  if (!entry) return { desc: "" };
  return entry[lang] ?? entry.en;
}

/** Get all slash commands with localized descriptions. */
export function getLocalizedSlashCommands(): Array<{ cmd: string; desc: string; subcommands?: string[] }> {
  return Object.keys(COMMAND_I18N).map((cmd) => {
    const i18n = getCommandI18n(cmd);
    return { cmd, desc: i18n.desc, subcommands: i18n.subcommands };
  });
}
