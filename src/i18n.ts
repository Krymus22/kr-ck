/**
 * i18n.ts - Internationalization for slash command descriptions and UI text.
 *
 * Detects user's preferred language from:
 *   1. CLAUDE_KILLER_LANG env var (explicit override)
 *   2. process.env.LANG / LC_ALL / LANGUAGE (Unix standard)
 *   3. process.env.LANG on Windows (set by index.ts based on chcp)
 *   4. Default: "en" (English)
 *
 * Currently supported: en, pt-BR
 * To add a new language: add a key to TRANSLATIONS and translate the strings.
 */

export type Language = "en" | "pt-BR";

let cachedLang: Language | null = null;

/** Detect user's preferred language. Cached after first call. */
export function detectLanguage(): Language {
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

  // 3. Default
  cachedLang = "en";
  return cachedLang;
}

/** Force a specific language (used by tests and /lang command if added). */
export function setLanguage(lang: Language): void {
  cachedLang = lang;
}

/**
 * Translation table for slash command descriptions.
 * Each command has a description in each supported language.
 */
export interface CommandI18n {
  desc: string;
  /** Optional subcommands shown in autocomplete after the command + space */
  subcommands?: string[];
}

export const COMMAND_I18N: Record<string, Record<Language, CommandI18n>> = {
  "/help": {
    en: { desc: "Show help" },
    "pt-BR": { desc: "Mostrar ajuda" },
  },
  "/hub": {
    en: { desc: "Extension Hub (control center)" },
    "pt-BR": { desc: "Hub de Extensões (centro de controle)" },
  },
  "/mode": {
    en: {
      desc: "List/switch/create project modes",
      subcommands: ["roblox", "devops", "off", "create", "confirm", "new", "keep"],
    },
    "pt-BR": {
      desc: "Listar/trocar/criar modos de projeto",
      subcommands: ["roblox", "devops", "off", "create", "confirm", "new", "keep"],
    },
  },
  "/reset": {
    en: { desc: "Clear history" },
    "pt-BR": { desc: "Limpar histórico" },
  },
  "/history": {
    en: { desc: "History summary" },
    "pt-BR": { desc: "Resumo do histórico" },
  },
  "/skills": {
    en: { desc: "List skills" },
    "pt-BR": { desc: "Listar skills" },
  },
  "/plugins": {
    en: { desc: "List MCP servers" },
    "pt-BR": { desc: "Listar servidores MCP" },
  },
  "/tools": {
    en: { desc: "List external tools" },
    "pt-BR": { desc: "Listar ferramentas externas" },
  },
  "/toolinfo": {
    en: { desc: "Show tool details" },
    "pt-BR": { desc: "Mostrar detalhes da ferramenta" },
  },
  "/effort": {
    en: {
      desc: "Set effort level (low/medium/high/max)",
      subcommands: ["low", "medium", "high", "max"],
    },
    "pt-BR": {
      desc: "Definir nível de esforço (low/medium/high/max)",
      subcommands: ["low", "medium", "high", "max"],
    },
  },
  "/pool": {
    en: { desc: "Show API key pool status" },
    "pt-BR": { desc: "Mostrar status do pool de chaves API" },
  },
  "/caveman": {
    en: { desc: "Toggle caveman mode" },
    "pt-BR": { desc: "Alternar modo caveman" },
  },
  "/memory": {
    en: { desc: "Show project memory" },
    "pt-BR": { desc: "Mostrar memória do projeto" },
  },
  "/todos": {
    en: { desc: "Show todo list" },
    "pt-BR": { desc: "Mostrar lista de tarefas" },
  },
  "/plan": {
    en: { desc: "Toggle plan mode" },
    "pt-BR": { desc: "Alternar modo planejamento" },
  },
  "/compact": {
    en: { desc: "Compact context" },
    "pt-BR": { desc: "Compactar contexto" },
  },
  "/dream": {
    en: { desc: "Review & compress memory" },
    "pt-BR": { desc: "Revisar e comprimir memória" },
  },
  "/distill": {
    en: { desc: "Extract workflow skills" },
    "pt-BR": { desc: "Extrair skills de workflow" },
  },
  "/exit": {
    en: { desc: "Exit" },
    "pt-BR": { desc: "Sair" },
  },
  "/organize": {
    en: { desc: "Organize files in the active mode's inbox" },
    "pt-BR": { desc: "Organizar arquivos do inbox do modo ativo" },
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
