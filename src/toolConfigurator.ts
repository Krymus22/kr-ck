/**
 * toolConfigurator.ts — IA Configuradora (sub-agente limitado)
 *
 * Sprint 11: Sub-agente que configura tools desconhecidas.
 * Usa o modelo e chave principais, mas com tools limitadas e
 * system prompt restritivo. Não pode editar código fonte.
 *
 * Funcionalidades:
 *   1. Detectar tool sem manifest
 *   2. Rodar --help/--version pra entender a tool
 *   3. Pesquisar na web pra achar documentação
 *   4. Criar manifest JSON com schema correto
 *   5. Buscar arquivos na máquina (via fileFinder)
 *   6. Copiar arquivo encontrado pra pasta do modo
 *   7. Fazer perguntas ao usuário (via perguntar_usuario)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";
import { config } from "./config.js";
import { chat } from "./apiClient.js";
import { findToolBinary } from "./toolDetector.js";
import { searchInDefinedFolders, copyToModeTools } from "./fileFinder.js";
import type { AskUserCallback } from "./askUser.js";

// --- Types -------------------------------------------------------------------

export interface ConfiguratorResult {
  success: boolean;
  message: string;
  manifestPath?: string;
  toolPath?: string;
}

// --- System Prompt -----------------------------------------------------------

const CONFIGURATOR_SYSTEM_PROMPT = `Você é uma IA configuradora. Sua tarefa é ajudar o usuário a configurar tools, skills, hooks e MCPs for o modo ativo.

Você PODE:
- Rodar comandos pra entender tools (apenas --help, --version, where, find, ls)
- Pesquisar na web pra achar documentação
- Criar arquivos .json (manifests, configs) na pasta do modo
- Buscar arquivos na máquina do usuário (com permissão)
- Mover/copiar arquivos entre pastas do modo
- Fazer perguntas ao usuário quando incerta

Você NÃO PODE:
- Editar código fonte do projeto
- Deletar arquivos do usuário
- Rodar comandos arbitrários (só --help, --version, where, find, ls)
- Acessar arquivos fora das pastas do claude-killer

Sempre explique o que está fazendo antes de fazer.
Quando criar um manifest, use o formato correto:
{
  "name": "tool_name",
  "description": "O que a tool faz",
  "category": "action",
  "command": "binary_name",
  "args": ["base_args"],
  "flags": [
    { "name": "--flag", "type": "string", "description": "descrição" }
  ],
  "context": {
    "whenToUse": ["quando usar"],
    "examples": ["exemplo de uso"]
  }
}

Categorias válidas: "action" (IA decide chamar), "validator" (roda automático antes de salvar).
Para validators, inclua: filePattern, blocking.`;

// --- Tool Definitions (limited) ----------------------------------------------

function getConfiguratorTools() {
  return [
    {
      type: "function" as const,
      function: {
        name: "executar_comando_seguro",
        description: "Executa um comando SEGURO pra entender uma tool. Só permite: --help, --version, where, find, ls. NÃO permite outros comandos.",
        parameters: {
          type: "object",
          properties: {
            comando: { type: "string", description: "Comando completo (ex: 'darklua --help', 'where rojo')" },
          },
          required: ["comando"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "buscar_arquivo",
        description: "Procura um arquivo na máquina. Primeiro nas pastas padrão, depois (com permissão) em toda a máquina.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do arquivo (ex: 'darklua', 'rojo')" },
          },
          required: ["nome"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "criar_manifest",
        description: "Cria um arquivo manifest JSON for uma tool na pasta do modo ativo.",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", description: "Nome da tool (ex: 'darklua')" },
            manifest: { type: "object", description: "Objeto JSON do manifest" },
          },
          required: ["toolName", "manifest"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "copiar_para_tools",
        description: "Copia um arquivo encontrado for a pasta tools/ do modo ativo.",
        parameters: {
          type: "object",
          properties: {
            sourcePath: { type: "string", description: "Caminho completo do arquivo encontrado" },
          },
          required: ["sourcePath"],
        },
      },
    },
  ];
}

// --- Command Safety Check ----------------------------------------------------

// BUG FIX (Sprint 12): added $ anchor and dangerous char rejection.
// Previously, 'rojo --help > /etc/passwd' would pass as "safe" because
// the regex only checked the prefix without anchoring the end.
const ALLOWED_COMMAND_PATTERNS = [
  /^[\w./\\-]+\s+--help$/i,
  /^[\w./\\-]+\s+--version$/i,
  /^where\s+[\w./\\-]+$/i,
  /^find\s+[\w./\\\-: ]+$/i,
  /^ls\s+[\w./\\-]+$/i,
  /^dir\s+[\w./\\-]+$/i,
];

// Characters that indicate shell metacharacters (pipes, redirects, chaining).
// If ANY of these appear in the command, it's rejected immediately.
const DANGEROUS_CHARS = /[|;&<>`$]/;

/**
 * Verifica se um comando é seguro (apenas --help, --version, where, find, ls, dir).
 * Exportado no Sprint 12 for permitir testes diretos.
 *
 * BUG FIX: agora rejeita comandos com pipes (|), redirects (>, <), chaining (&&, ;),
 * backticks (`), e variable expansion ($). Antes, 'rojo --help > /etc/passwd' passava.
 */
export function isSafeCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Reject any command with shell metacharacters
  if (DANGEROUS_CHARS.test(trimmed)) return false;
  return ALLOWED_COMMAND_PATTERNS.some((p) => p.test(trimmed));
}

// --- Tool Handlers -----------------------------------------------------------

async function handleConfiguratorTool(
  toolName: string,
  args: Record<string, unknown>,
  modeName: string | null,
  onAskUser?: AskUserCallback,
): Promise<string> {
  switch (toolName) {
    case "executar_comando_seguro": {
      const cmd = String(args.comando ?? "");
      if (!isSafeCommand(cmd)) {
        return `[ERROR] Comando não permitido: "${cmd}". Só --help, --version, where, find, ls.`;
      }
      try {
        const result = execSync(cmd, {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 1024 * 1024,
        });
        return result.trim() || "(sem output)";
      } catch (err: any) {
        return `Exit code ${err.status ?? "unknown"}: ${(err.stderr ?? err.message ?? "").trim()}`;
      }
    }

    case "buscar_arquivo": {
      const fileName = String(args.nome ?? "");
      if (!fileName) return "[ERROR] nome é obrigatório";
      const results = searchInDefinedFolders(fileName, modeName);
      if (results.length === 0) {
        return `Não encontrei "${fileName}" nas pastas padrão. O usuário pode ter o arquivo em outro lugar.`;
      }
      return results.map((r) => `${r.path} (encontrado em: ${r.source})`).join("\n");
    }

    case "criar_manifest": {
      const toolName = String(args.toolName ?? "");
      const manifest = args.manifest;
      if (!toolName || !manifest) return "[ERROR] toolName e manifest são obrigatórios";
      if (!modeName) return "[ERROR] nenhum modo ativo";

      const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
      const manifestsDir = path.join(home, ".claude-killer", "modes", modeName, "manifests");
      if (!fs.existsSync(manifestsDir)) {
        fs.mkdirSync(manifestsDir, { recursive: true });
      }
      const manifestPath = path.join(manifestsDir, `${toolName}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      log.success(`[CONFIGURATOR] Manifest criado: ${manifestPath}`);
      return `Manifest criado em: ${manifestPath}`;
    }

    case "copiar_para_tools": {
      const sourcePath = String(args.sourcePath ?? "");
      if (!sourcePath) return "[ERROR] sourcePath is required";
      if (!modeName) return "[ERROR] no active mode";
      if (!fs.existsSync(sourcePath)) return `[ERROR] File not found: ${sourcePath}`;
      const destPath = copyToModeTools(sourcePath, modeName);
      if (destPath) {
        return `File copied to: ${destPath}`;
      }
      return "[ERROR] Failed to copy file";
    }

    case "perguntar_usuario": {
      if (!onAskUser) return "[ERROR] perguntar_usuario not available in this context";
      const pergunta = String(args.pergunta ?? "");
      const alternativas = Array.isArray(args.alternativas) ? (args.alternativas as string[]) : [];
      if (!pergunta || alternativas.length < 2) return "[ERROR] pergunta and alternativas (min 2) are required";
      const response = await onAskUser({ pergunta, alternativas });
      return response.cancelled ? "[USER CANCELLED]" : `[ANSWER] ${response.value}`;
    }

    default:
      return `[ERROR] Unknown tool: ${toolName}`;
  }
}

// --- Public API --------------------------------------------------------------

/**
 * Start a configuration session for a tool.
 *
 * This runs a mini agent loop with limited tools and a restrictive system prompt.
 * The IA can: run --help/--version, search files, create manifests, ask questions.
 *
 * @param toolName    Name of the tool to configure (e.g., "darklua")
 * @param modeName    Active mode name
 * @param onAskUser   Callback for asking user questions (AskUser integration)
 * @param onMessage   Callback for showing messages to user (mini chat)
 * @returns ConfiguratorResult with success/failure
 */
export async function configureTool(
  toolName: string,
  modeName: string | null,
  onAskUser?: AskUserCallback,
  onMessage?: (msg: string) => void,
): Promise<ConfiguratorResult> {
  if (!modeName) {
    return { success: false, message: "Nenhum modo ativo. Ative um modo primeiro." };
  }

  onMessage?.(`Iniciando configuração de "${toolName}" for o modo "${modeName}"...`);

  // Build initial message
  const initialMessage = `Configure a tool "${toolName}" for o modo "${modeName}".

Passos:
1. Tente rodar "${toolName} --help" e "${toolName} --version" for entender o que ela faz.
2. Se não encontrar o binary, use buscar_arquivo for procurá-lo.
3. Se encontrar, use copiar_para_tools for copiá-lo for a pasta do modo.
4. Com base no --help, crie um manifest usando criar_manifest.
5. Se não tiver certeza de algo, use perguntar_usuario.

Comece agora.`;

  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
    { role: "system", content: CONFIGURATOR_SYSTEM_PROMPT },
    { role: "user", content: initialMessage },
  ];

  const tools: any[] = getConfiguratorTools();
  // Add perguntar_usuario if available
  if (onAskUser) {
    tools.push({
      type: "function" as const,
      function: {
        name: "perguntar_usuario",
        description: "Faça uma pergunta ao usuário quando não tem certeza.",
        parameters: {
          type: "object",
          properties: {
            pergunta: { type: "string" },
            alternativas: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
          },
          required: ["pergunta", "alternativas"],
        },
      },
    });
  }

  // Mini agent loop (max 10 iterations)
  const MAX_ITERATIONS = 10;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    try {
      const response = await chat(messages as any, undefined, undefined, undefined, tools as any);
      const choice = response.choices[0];
      if (!choice) break;

      // Add assistant message
      messages.push({ role: "assistant", content: choice.message.content ?? "" });

      if (choice.message.content) {
        onMessage?.(choice.message.content);
      }

      // Check for tool calls
      if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
        for (const toolCall of choice.message.tool_calls) {
          const name = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);

          onMessage?.(`[Tool: ${name}]`);

          const result = await handleConfiguratorTool(name, args, modeName, onAskUser);
          messages.push({ role: "tool", content: result } as any);
        }
        continue; // next iteration
      }

      // finish_reason === "stop" — check if manifest was created
      if (choice.finish_reason === "stop") {
        const manifestPath = path.join(
          os.homedir(), ".claude-killer", "modes", modeName, "manifests", `${toolName}.json`
        );
        if (fs.existsSync(manifestPath)) {
          return {
            success: true,
            message: `Tool "${toolName}" configurada com sucesso!`,
            manifestPath,
          };
        }
        return {
          success: false,
          message: `Configuração terminou mas nenhum manifest foi criado.`,
        };
      }
    } catch (err) {
      log.error(`[CONFIGURATOR] Error: ${(err as Error).message}`);
      return { success: false, message: `Error: ${(err as Error).message}` };
    }
  }

  return { success: false, message: "Limite de iterações atingido." };
}

/**
 * Detect tools in the mode's tools/ folder that don't have a manifest.
 */
export function detectToolsWithoutManifest(modeName: string | null): string[] {
  if (!modeName) return [];

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const toolsDir = path.join(home, ".claude-killer", "modes", modeName, "tools");
  const manifestsDir = path.join(home, ".claude-killer", "modes", modeName, "manifests");

  if (!fs.existsSync(toolsDir)) return [];

  const existingManifests = new Set<string>();
  if (fs.existsSync(manifestsDir)) {
    for (const file of fs.readdirSync(manifestsDir)) {
      if (file.endsWith(".json")) {
        existingManifests.add(file.replace(/\.json$/, ""));
      }
    }
  }

  const toolsWithoutManifest: string[] = [];
  for (const file of fs.readdirSync(toolsDir)) {
    const toolName = process.platform === "win32" ? file.replace(/\.exe$/i, "") : file;
    try {
      if (fs.statSync(path.join(toolsDir, file)).isFile() && !existingManifests.has(toolName)) {
        toolsWithoutManifest.push(toolName);
      }
    } catch { /* skip */ }
  }

  return toolsWithoutManifest;
}
