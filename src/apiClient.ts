/**
 * apiClient.ts - NVIDIA NIM OpenAI-compatible client with:
 *   1. Single-concurrency Mutex (only ONE in-flight request at a time)
 *   2. Sliding-window rate limiter (<= N requests per minute)
 *
 * Consumers call `chat()` without worrying about throttling - the module
 * handles queuing transparently.
 */

import OpenAI from "openai";
import https from "node:https";
import { config } from "./config.js";
import { getModelMaxOutputTokens } from "./modelRegistry.js";
import * as log from "./logger.js";
import { initApiKeyPool, acquireKeyForStreaming, tryAcquireKeyImmediate, getPoolSize, getAvailableKeyCount, getTotalKeyCount } from "./apiKeyPool.js";
import { providerSendsThinkingMode, getProviderReasoningField, providerNeedsHedging } from "./apiProvider.js";
import { getModelInfo } from "./modelRegistry.js";

// --- OpenAI Client (pointed at NVIDIA NIM) ----------------------------------

// TCP keepalive agent: sends probes every 3s during idle periods.
// This prevents intermediate load balancers/proxies from killing
// the connection while the model is still "thinking" but hasn't
// started emitting tokens yet (cold-start / warm-up phase).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,   // probe every 1 second (extra aggressive to prevent proxy cuts)
  timeout: 0,               // no socket-level timeout
  maxSockets: 10,           // allow slightly more concurrent sockets if needed
  scheduling: "lifo",       // re-use the most recently used connections to keep them warm
});

const client = new OpenAI({
  apiKey: config.nvidiaApiKey,
  baseURL: config.nvidiaBaseUrl,
  timeout: 5 * 60 * 1000,   // 5 min max request timeout (generous for long thinking)
  httpAgent: keepAliveAgent,
});

// --- Rate Limiter (Sliding Window Token Bucket) -----------------------------

/**
 * A minimal sliding-window rate limiter.
 * Tracks the timestamps of all requests sent in the last 60 s window;
 * if the window is full, it delays the caller until the oldest timestamp
 * falls outside the 60 s boundary.
 */
class SlidingWindowRateLimiter {
  private readonly windowMs = 60_000; // 1 minute
  private readonly maxRequests: number;
  private timestamps: number[] = [];

  constructor(requestsPerMinute: number) {
    this.maxRequests = requestsPerMinute;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      // Drop timestamps older than the window
      this.timestamps = this.timestamps.filter(
        (t) => now - t < this.windowMs
      );

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return; // slot available - proceed immediately
      }

      // Window is full: calculate how long to sleep until the oldest
      // timestamp leaves the window, then retry
      const oldestTs = this.timestamps[0];
      const sleepMs = this.windowMs - (now - oldestTs) + 1;
      log.throttle(
        `Rate limit reached (${this.maxRequests} rpm). ` +
          `Waiting ${Math.ceil(sleepMs / 1000)} s...`
      );
      await sleep(sleepMs);
    }
  }
}

// --- Mutex (Binary Semaphore) ------------------------------------------------

/**
 * A promise-based mutex that guarantees at most ONE concurrent API call.
 * Callers awaiting `.lock()` are queued in FIFO order.
 */
class Mutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    log.throttle("Another request is in-flight. Queuing...");
    return new Promise((resolve) => this._queue.push(resolve));
  }

  unlock(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// --- Singletons --------------------------------------------------------------

const mutex = new Mutex();
const rateLimiter = new SlidingWindowRateLimiter(config.rateLimitRpm);

// --- Utility -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Tool Definitions for the API --------------------------------------------

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "ler_arquivo",
      description:
        "Reads the complete content of a local file or lists directory contents from the filesystem. " +
        "If the path is a directory, it returns the list of files and subdirectories. " +
        "Use this to inspect any source file or explore folder structure before making changes.",
      parameters: {
        type: "object",
        properties: {
          caminho: {
            type: "string",
            description: "Relative or absolute path to the file or directory.",
          },
        },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_arquivo_avancado",
      description:
        "Reads file content with offset, limit, line numbers, and optional grep filtering. " +
        "Supports reading specific line ranges and searching within file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
          offset: { type: "number", description: "1-indexed start line." },
          limit: { type: "number", description: "Max lines to return." },
          grep: { type: "string", description: "Regex pattern to filter lines." },
          contextLines: { type: "number", description: "Lines of context around grep matches." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aplicar_diff",
      description:
        "Applies a Search & Replace diff block to a local file. " +
        "The file content is parsed, and sections matching SEARCH are replaced with REPLACE. " +
        "A syntax guardrail will validate the entire file after the patch is applied. " +
        "Use this tool to make edits instead of writing full files.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Relative or absolute path to the file to modify." },
          bloco_diff: {
            type: "string",
            description:
              "The diff contents following the strict format:\n" +
              "<<<<<<< SEARCH\n[exact old code to replace]\n=======\n[new code replacement]\n>>>>>>> REPLACE",
          },
        },
        required: ["caminho", "bloco_diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_arquivo",
      description:
        "Edit a file using string match/replace. Supports multiple edits and create-if-missing. " +
        "More precise than aplicar_diff for simple changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          search: { type: "string", description: "Exact string to find and replace." },
          replace: { type: "string", description: "Replacement string." },
          all: { type: "boolean", description: "Replace all occurrences (default: first only)." },
          createIfMissing: { type: "boolean", description: "Create file if it doesn't exist." },
          edits: {
            type: "array",
            description: "Array of {search, replace, all?} operations for multiple edits.",
            items: {
              type: "object",
              properties: {
                search: { type: "string" },
                replace: { type: "string" },
                all: { type: "boolean" },
              },
              required: ["search", "replace"],
            },
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_arquivos",
      description:
        "Search for files by glob pattern (e.g. **/*.ts, src/**/*.test.ts). " +
        "Returns matching file paths relative to cwd.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files." },
          cwd: { type: "string", description: "Directory to search in (default: cwd)." },
          maxDepth: { type: "number", description: "Max directory depth." },
          ignore: { type: "array", items: { type: "string" }, description: "Patterns to ignore." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_texto",
      description:
        "Search file contents using regex (like grep). Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for." },
          path: { type: "string", description: "File or directory to search in." },
          include: { type: "string", description: "File pattern filter (e.g. *.ts)." },
          caseInsensitive: { type: "boolean", description: "Case-insensitive search." },
          wholeWord: { type: "boolean", description: "Match whole words only." },
          contextLines: { type: "number", description: "Context lines around matches." },
          maxResults: { type: "number", description: "Max results to return." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Shows the working tree status (branch, staged, modified, untracked files).",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Shows file changes. Use staged=true for staged changes.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          file: { type: "string", description: "Specific file to diff." },
          staged: { type: "boolean", description: "Show staged changes." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Shows recent commit history.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          count: { type: "number", description: "Number of commits (default 10)." },
          file: { type: "string", description: "Show history for specific file." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Create a git commit. Optionally stage files first.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message." },
          files: { type: "array", items: { type: "string" }, description: "Files to stage." },
          cwd: { type: "string" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_blame",
      description: "Show who changed each line of a file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "File to blame." },
          cwd: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "Show details of a specific commit.",
      parameters: {
        type: "object",
        properties: {
          commitHash: { type: "string", description: "Commit hash to show." },
          cwd: { type: "string" },
        },
        required: ["commitHash"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "List all branches (local and remote).",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_checkout",
      description: "Switch to a branch.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch name." },
          cwd: { type: "string" },
        },
        required: ["branch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_multi_arquivos",
      description: "Edit multiple files atomically. All edits succeed or all are rolled back.",
      parameters: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: "Array of {filePath, edits, createIfMissing?}.",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                edits: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      search: { type: "string" },
                      replace: { type: "string" },
                      all: { type: "boolean" },
                    },
                    required: ["search", "replace"],
                  },
                },
                createIfMissing: { type: "boolean" },
              },
              required: ["filePath", "edits"],
            },
          },
        },
        required: ["requests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "salvar_sessao",
      description: "Save the current conversation session to disk for later restoration.",
      parameters: { type: "object", properties: { id: { type: "string", description: "Optional session ID." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "carregar_sessao",
      description: "Load a previously saved session from disk.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Session ID to load." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_sessoes",
      description: "List all saved sessions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "parse_ast",
      description:
        "Parse a source file and extract symbols (functions, classes, interfaces, etc.), imports, and exports. " +
        "Language-agnostic: supports TypeScript, JavaScript, Python, Rust, Go, Java.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source file to parse." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_paralelo",
      description: "Execute multiple tool calls in parallel for performance.",
      parameters: {
        type: "object",
        properties: {
          tools: { type: "array", items: { type: "string" }, description: "Tool names to call." },
          args: { type: "array", items: { type: "object" }, description: "Arguments for each tool." },
        },
        required: ["tools", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Update the visible todo list for the current task. Use this to plan and track multi-step work. " +
        "Call repeatedly as work progresses to mark items as `in_progress` or `completed`. " +
        "Only one item should be `in_progress` at a time. Pass an empty array to clear the list.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Full replacement list of todos.",
            items: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current status of this todo item.",
                },
                content: {
                  type: "string",
                  description: "Imperative form describing what was done.",
                  maxLength: 200,
                },
                active_form: {
                  type: "string",
                  description: "Present continuous form shown when status is in_progress.",
                  maxLength: 200,
                },
              },
              required: ["status", "content"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_comando",
      description:
        "Executes a shell command in the terminal and returns its combined stdout/stderr output. " +
        "Use this tool to run tests, linters, or compilation commands locally.",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "The shell command to execute." },
        },
        required: ["comando"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_testes",
      description:
        "Runs the project's test suite and returns structured results. " +
        "Auto-detects test framework (vitest, jest, pytest, cargo, go). " +
        "Can optionally run tests for a specific file. Returns pass/fail counts and failure details.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file path to run tests for." },
          dir: { type: "string", description: "Project directory (defaults to cwd)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sugerir_fixes",
      description:
        "Analyzes test failures and suggests fixes. " +
        "Use after running tests to get actionable fix suggestions for each failure.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Project directory (defaults to cwd)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "desfazer_edicao",
      description:
        "Desfaz a última edição aplicada via aplicar_diff / editar_arquivo no arquivo informado. " +
        "Restaura o conteúdo do backup mais recente salvo automaticamente antes da edição. " +
        "Cada chamada remove O backup mais recente da pilha - chamadas sucessivas desfezem edições mais antigas. " +
        "Backups expiram após 5 minutos. " +
        "Use quando uma edição introduzir um erro e você quiser voltar ao estado anterior.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho absoluto do arquivo a restaurar." },
        },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_backups",
      description:
        "Lista os backups de rollback disponíveis. Se 'caminho' for fornecido, filtra apenas os backups daquele arquivo. " +
        "Use para inspecionar o histórico de edições antes de desfazer.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho absoluto opcional para filtrar backups de um arquivo específico." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atualizar_estado",
      description:
        "Atualiza o arquivo TASK_STATE.md com o estado estruturado da tarefa. " +
        "Use para manter registro do que já foi feito, do que falta, das decisões tomadas e dos bugs encontrados. " +
        "O arquivo é lido automaticamente após compaction para que o modelo recupere o contexto. " +
        "Todos os campos são opcionais - apenas os fornecidos serão atualizados.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Título curto da tarefa atual." },
          done: { type: "array", items: { type: "string" }, description: "Lista de itens concluídos (substitui a atual)." },
          todo: { type: "array", items: { type: "string" }, description: "Lista de itens pendentes (substitui a atual)." },
          decisions: { type: "array", items: { type: "string" }, description: "Decisões tomadas (com justificativa breve)." },
          bugs: { type: "array", items: { type: "string" }, description: "Bugs encontrados (com arquivo:linha se possível)." },
          dependencies: { type: "array", items: { type: "string" }, description: "Dependências ou bloqueadores." },
          notes: { type: "string", description: "Notas livres." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "marcar_feito",
      description:
        "Move um item de 'todo' para 'done' no TASK_STATE.md. " +
        "Forneça uma substring que identifique o item - o primeiro 'todo' que contiver a substring será movido.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "Substring do item em 'todo' a ser marcado como feito." },
        },
        required: ["item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pesquisar_api_atualizada",
      description:
        "Pesquisa na web a documentação atual de uma API específica (última versão). " +
        "USE quando: (1) for escrever código usando uma API que pode ter mudado recentemente, " +
        "(2) selene/luau-lsp/linter reclamar de 'undefined global' que você acha que é uma API nova, " +
        "(3) o usuário pedir 'versão atual' ou 'latest API', " +
        "(4) em modo Roblox, antes de usar qualquer API de serviço (TweenService, Players, ReplicatedStorage, etc). " +
        "A pesquisa inclui a data atual do sistema para priorizar fontes recentes. " +
        "Resultados ficam em cache por 7 dias. Sempre chame ANTES de escrever código com APIs que " +
        "você não tem certeza absoluta que estão atualizadas - especialmente em Roblox onde APIs mudam toda semana.",
      parameters: {
        type: "object",
        properties: {
          nome: {
            type: "string",
            description: "Nome da API a pesquisar. Exemplos: 'TweenService:Create', 'FindFirstChild', 'Players:GetPlayerByUserId', 'React.useState', 'fetch', 'axios.get'.",
          },
          linguagem: {
            type: "string",
            description: "Linguagem ou plataforma da API. Exemplos: 'roblox', 'typescript', 'python', 'rust', 'lua', 'javascript'.",
          },
          contexto: {
            type: "string",
            description: "Contexto opcional do que você está tentando fazer. Ajuda a refinar a busca. Exemplo: 'quero criar um tween que move uma parte suavemente'.",
          },
          forcar_refresh: {
            type: "boolean",
            description: "Se true, ignora o cache e faz uma pesquisa fresca. Default: false.",
          },
        },
        required: ["nome", "linguagem"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "criar_plano",
      description:
        "Cria um plano de execução numerado ANTES de fazer qualquer edição. " +
        "OBRIGATÓRIO para tarefas complexas (2+ passos, multi-arquivo, refactoring). " +
        "Cada passo deve ser uma ação específica e atômica. " +
        "O plano aparece na TUI com checkboxes visuais. " +
        "Você NÃO pode finalizar (finish_reason) até todos os passos estarem DONE. " +
        "Use marcar_passo para atualizar o status de cada passo conforme progride.",
      parameters: {
        type: "object",
        properties: {
          passos: {
            type: "array",
            items: { type: "string" },
            description: "Lista de passos do plano. Ex: ['Ler InventoryService.luau', 'Adicionar validação nil', 'Rodar testes']",
          },
        },
        required: ["passos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "marcar_passo",
      description:
        "Marca um passo do plano como concluído (done=true) ou reaberto (done=false). " +
        "Use o índice (0-based) do passo no plano criado por criar_plano. " +
        "Chame após completar cada passo para manter a TUI atualizada.",
      parameters: {
        type: "object",
        properties: {
          indice: { type: "number", description: "Índice do passo (0-based)" },
          feito: { type: "boolean", description: "true = concluído, false = reaberto" },
        },
        required: ["indice", "feito"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escrever_spec",
      description:
        "Escreve uma especificação técnica ANTES de implementar código. " +
        "OBRIGATÓRIO para features complexas. Define: inputs, outputs, edge cases, constraints. " +
        "A spec vira um contrato que a implementação deve satisfazer.",
      parameters: {
        type: "object",
        properties: {
          nome: { type: "string", description: "Nome da função/feature" },
          descricao: { type: "string", description: "Descrição do que faz" },
          inputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                required: { type: "boolean" },
                description: { type: "string" },
              },
            },
            description: "Lista de inputs da função",
          },
          outputs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                type: { type: "string" },
                description: { type: "string" },
              },
            },
            description: "Lista de outputs",
          },
          edgeCases: { type: "array", items: { type: "string" }, description: "Casos limítrofes a tratar" },
          constraints: { type: "array", items: { type: "string" }, description: "Restrições" },
        },
        required: ["nome", "descricao"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "criar_tdd",
      description:
        "Registra que TDD está ativo: testes foram escritos ANTES da implementação. " +
        "Use APENAS quando você já escreveu os testes (em arquivo .spec). " +
        "Os testes viram oráculo - a implementação deve fazê-los passar. " +
        "NÃO modifique os testes depois de criá-los.",
      parameters: {
        type: "object",
        properties: {
          arquivo_teste: { type: "string", description: "Caminho do arquivo de teste" },
          arquivo_impl: { type: "string", description: "Caminho do arquivo de implementação" },
          linguagem: { type: "string", description: "Linguagem (typescript, python, rust, luau, etc)" },
          casos: { type: "array", items: { type: "string" }, description: "Lista de casos de teste" },
        },
        required: ["arquivo_teste", "arquivo_impl", "linguagem"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "capturar_snapshot",
      description:
        "Captura o output de uma função ANTES de editá-la. " +
        "Depois da edição, o sistema re-roda a função e compara. " +
        "Se o output mudou inesperadamente, alerta sobre possível regressão. " +
        "Use em funções puras (sem side effects).",
      parameters: {
        type: "object",
        properties: {
          funcao: { type: "string", description: "Nome da função" },
          arquivo: { type: "string", description: "Caminho do arquivo" },
          inputs: { type: "string", description: "JSON string dos inputs (ex: [1, 2] ou {x: 5})" },
        },
        required: ["funcao", "arquivo", "inputs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_workflow",
      description:
        "Executa um workflow dinâmico em JavaScript determinístico. " +
        "Use para tarefas multi-step complexas onde prompt é ambíguo. " +
        "Funções disponíveis: agent(pergunta) - sub-agente, parallel(...perguntas) - paralelo, log(msg). " +
        "PROIBIDO: require, import, process, fs, child_process. " +
        "O workflow roda em sandbox com timeout de 60s.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "Código JavaScript do workflow" },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_estado",
      description:
        "Lê o conteúdo atual do TASK_STATE.md e retorna como string formatada. " +
        "Use após context compaction para recuperar o estado da tarefa.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "explorar_subagente",
      description:
        "Spawna um sub-agente em-processo com contexto LIMPO para explorar o codebase e retornar apenas um resumo. " +
        "Use para tarefas como 'entenda como o auth funciona', 'encontre todos os lugares que chamam X', 'mapeie o fluxo de Y'. " +
        "O sub-agente tem apenas tools de leitura (ler_arquivo, buscar_texto, buscar_arquivos, parse_ast) e faz até 8 chamadas. " +
        "Retorna resumo de 500-2000 tokens. DISPONÍVEL APENAS com effort=high ou max (consome tokens da mesma API key).",
      parameters: {
        type: "object",
        properties: {
          questao: { type: "string", description: "Pergunta específica que o sub-agente deve responder." },
          cwd: { type: "string", description: "Diretório base para a exploração (default: cwd atual)." },
          max_tool_calls: { type: "number", description: "Máximo de tool calls do sub-agente (default: 8)." },
        },
        required: ["questao"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "status_pool",
      description:
        "Mostra o status do pool de API keys (multi-key): quantas chaves ativas, chamadas por chave, erros 429, latência média. " +
        "Use para diagnosticar problemas de rate limit ou verificar se o pool está funcionando.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// --- Main Chat Function -------------------------------------------------------

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatResponse = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Maximum retry-after seconds we are willing to wait for a 429.
 * If the API says "wait longer than this", it's treated as quota-exhausted
 * and we throw immediately with a clear diagnostic message.
 */
const MAX_RETRY_AFTER_S     = 90;
const MAX_429_RETRIES       = 4;
const MAX_NETWORK_RETRIES   = 8;   // ECONNRESET etc. - more generous, fast retry

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "EPIPE", "ECONNREFUSED", "EAI_AGAIN",
]);

// Exported for use by sub-agents (so they can use the same retry heuristics)
export const SUB_AGENT_MAX_CHAT_RETRIES = 2;  // outer-level chat() retries per call
export const SUB_AGENT_MAX_NETWORK_RETRIES = MAX_NETWORK_RETRIES;
export const SUB_AGENT_TRANSIENT_NETWORK_CODES = TRANSIENT_NETWORK_CODES;

/** Returns true if the error is a transient network error that warrants a retry. */
export function isTransientNetworkErrorPublic(err: unknown): boolean {
  const anyErr = err as any;
  const errCode = anyErr?.code ?? anyErr?.cause?.code;
  return typeof errCode === "string" && TRANSIENT_NETWORK_CODES.has(errCode);
}

/** Returns true if the error is a 429 (rate limit). */
export function is429ErrorPublic(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  return status === 429;
}

type ToolCallAccumulator = Record<number, {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}>;

interface StreamState {
  isFirstChunk: boolean;
  finishReason: string | null;
  responseId: string;
  responseModel: string;
  responseCreated: number;
  totalContent: string;
  toolCallsAccumulator: ToolCallAccumulator;
  promptTokens: number;
  completionTokens: number;
}

function createStreamState(): StreamState {
  return {
    isFirstChunk: true,
    finishReason: null,
    responseId: "",
    responseModel: "",
    responseCreated: 0,
    totalContent: "",
    toolCallsAccumulator: {},
    promptTokens: 0,
    completionTokens: 0,
  };
}

function createStreamRequest(
  messages: Message[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
  clientOverride?: OpenAI
) {
  const c = clientOverride ?? client;

  // Dynamic thinking mode: only send chat_template_kwargs when:
  //   1. Provider supports it (NVIDIA: yes, ZenMux: no — thinking is built-in)
  //   2. Model has thinking (checked from modelRegistry)
  // This prevents errors on ZenMux (which doesn't accept chat_template_kwargs)
  // and on models that don't support thinking at all (kimi-k2.7-code-free).
  const modelInfo = getModelInfo(config.model);
  const shouldSendThinking = providerSendsThinkingMode() && modelInfo.hasThinking;

  const requestBody: any = {
    model: config.model,
    messages,
    tools: tools ?? TOOL_DEFINITIONS,
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    max_tokens: Math.min(config.maxTokens, getModelMaxOutputTokens(config.model)),
    temperature: config.temperature,
    top_p: config.topP,
  };

  // Only add chat_template_kwargs for NVIDIA provider with thinking-capable models.
  // ZenMux models have thinking built-in (GLM) or don't have it (Kimi Code Free).
  // Sending chat_template_kwargs to ZenMux may cause 400 errors.
  if (shouldSendThinking) {
    requestBody.chat_template_kwargs = { thinking_mode: "enabled" };
  }

  return c.chat.completions.create(requestBody);
}

// BUG FIX (BUG 5): processReasoningChunk antes retornava `!wasFirst` (boolean
// indicando se NÃO foi o primeiro chunk), mas `processStreamChunk` ignorava o
// retorno — código morto. Mudado para `void` e o retorno foi removido.
//
// BUG FIX (BUG 3 complemento): antes, esta função também consumia o flag
// `isFirstChunk` (setava para false). Mas `isFirstChunk` é usado por
// `processContentChunk` para disparar `onStreamStart` no PRIMEIRO chunk de
// CONTEÚDO. Como `processReasoningChunk` NÃO chama `onStreamStart`, consumir o
// flag aqui fazia com que `onStreamStart` nunca fosse chamado quando o stream
// começava com reasoning. Removida a manipulação de `isFirstChunk` — o flag
// só é consumido quando o primeiro CONTENT chunk chega.
function processReasoningChunk(
  state: StreamState,
  onThinking?: () => void,
): void {
  // state é recebido apenas para manter a assinatura consistente com as outras
  // funções processXxxChunk. Não há estado a mutar aqui.
  void state;
  onThinking?.();
}

function processContentChunk(
  state: StreamState,
  content: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
): void {
  // BUG FIX (BUG 3): antes havia um `else if (state.totalContent === "")`
  // morto — totalContent só cresce, nunca volta a ser "". onStreamStart deve
  // ser chamado APENAS na primeira vez que isFirstChunk é true.
  if (state.isFirstChunk) {
    state.isFirstChunk = false;
    onStreamStart?.();
  }
  // BUG FIX (BUG 2): antes, o caller usava `if (delta.content)` (falsy para
  // string vazia), então chunks com content="" nunca chegavam aqui. Agora o
  // caller testa `typeof delta.content === "string"`, então strings vazias
  // chegam. Chamamos onToken mesmo com string vazia (alguns provedores enviam
  // chunks vazios como heartbeats). totalContent += "" é no-op, então a
  // contagem de tokens no conteúdo final não é afetada.
  onToken?.(content);
  state.totalContent += content;
}

function processToolCallDelta(
  accumulator: ToolCallAccumulator,
  toolCalls: any[],
): void {
  for (const tc of toolCalls) {
    const idx: number = tc.index ?? 0;
    if (accumulator[idx]) {
      const acc = accumulator[idx];
      if (tc.id && !acc.id) acc.id = tc.id;
    } else {
      accumulator[idx] = {
        id: tc.id ?? "",
        type: "function",
        function: { name: tc.function?.name ?? "", arguments: "" },
      };
    }
    if (tc.function?.arguments) {
      accumulator[idx].function.arguments += tc.function.arguments;
    }
  }
}

function processStreamChunk(
  chunk: any,
  state: StreamState,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
): void {
  // BUG FIX: previously, this function did `if (!choice) return;` at the top,
  // which meant that chunks containing ONLY `usage` (no `choices` array, or
  // empty `choices`) were discarded before we could read the token counts.
  //
  // The NVIDIA NIM API (and OpenAI-compatible APIs in general) sends the
  // final `usage` object in a separate chunk that has NO choices. This
  // chunk is the only one that contains accurate prompt_tokens and
  // completion_tokens. By returning early, we never captured them, so
  // state.promptTokens and state.completionTokens stayed at 0 forever,
  // and the StatusBar always showed "0/256k 0%".
  //
  // Fix: process `usage` BEFORE the `if (!choice) return` guard.

  // Process usage FIRST — it may arrive in a chunk without choices.
  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? 0;
    state.completionTokens = chunk.usage.completion_tokens ?? 0;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;

  if (!state.responseId) state.responseId = chunk.id ?? "";
  if (!state.responseModel) state.responseModel = chunk.model ?? "";
  if (!state.responseCreated) state.responseCreated = chunk.created ?? 0;

  const delta = choice.delta ?? {};

  const reasoning = delta.reasoning_content ?? ("reasoning" in delta ? delta.reasoning : undefined);
  if (reasoning) {
    processReasoningChunk(state, onThinking);
    return;
  }

  if (delta.tool_calls) {
    processToolCallDelta(state.toolCallsAccumulator, delta.tool_calls);
  }

  // BUG FIX (BUG 2): antes era `if (delta.content)` (falsy para string vazia),
  // então chunks com content="" nunca chamavam onToken. Agora testamos
  // `typeof delta.content === "string"` para que chunks vazios (heartbeats)
  // também sejam processados. O acúmulo em totalContent não é afetado porque
  // somar "" é no-op.
  if (typeof delta.content === "string") {
    processContentChunk(state, delta.content, onStreamStart, onToken);
  }

  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  // Note: usage was already processed above (before the choice guard).
  // Some APIs also send usage in the final choice chunk, so check again
  // in case it wasn't in the separate usage-only chunk.
  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? state.promptTokens;
    state.completionTokens = chunk.usage.completion_tokens ?? state.completionTokens;
  }
}

async function consumeStream(
  rawStream: any,
  state: StreamState,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
): Promise<void> {
  for await (const chunk of rawStream) {
    processStreamChunk(chunk, state, onStreamStart, onToken, onThinking);
  }
}

function buildChatResponse(state: StreamState): ChatResponse {
  const toolCallsList = Object.values(state.toolCallsAccumulator);
  return {
    id: state.responseId,
    object: "chat.completion",
    created: state.responseCreated,
    model: state.responseModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.totalContent || null,
          tool_calls: toolCallsList.length > 0 ? toolCallsList : undefined,
          refusal: null,
        },
        // BUG FIX (BUG 4): antes, quando o stream terminava sem finish_reason
        // explícito, o default era "stop" — isso mascarava streams que
        // terminaram abruptamente. Agora o default é null, e o caller é
        // responsável por interpretar a ausência de finish_reason. O tipo
        // ChatCompletion do OpenAI SDK aceita null para finish_reason.
        finish_reason: (state.finishReason as any) ?? null,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_tokens: state.promptTokens + state.completionTokens,
    },
  };
}

function logApiDiagnostics(err: unknown, attempt: number): void {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const anyErr = err as any;

  const diagLines: string[] = [
    `[API Error] attempt=${attempt}`,
    `  type        : ${apiErr ? "OpenAI.APIError" : (anyErr?.constructor?.name ?? typeof err)}`,
    `  message     : ${apiErr?.message ?? anyErr?.message ?? String(err)}`,
    `  code        : ${anyErr?.code ?? anyErr?.cause?.code ?? "-"}`,
    `  http status : ${apiErr?.status ?? anyErr?.status ?? "-"}`,
    `  request_id  : ${apiErr?.headers?.["x-request-id"] ?? "-"}`,
    `  nvcf-reqid  : ${apiErr?.headers?.["nvcf-reqid"] ?? "-"}`,
  ];

  if (apiErr?.headers) {
    const h = Object.entries(apiErr.headers).map(([k, v]) => `    ${k}: ${v}`).join("\n");
    diagLines.push(`  headers:\n${h}`);
  }

  if (anyErr?.stack) {
    diagLines.push(`  stack:\n${anyErr.stack}`);
  }

  log.debug(diagLines.join("\n"));
}

function extractRetryAfter(err: unknown): number {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const rawRetryAfter =
    apiErr?.headers?.["retry-after"] ??
    (err as { headers?: Record<string, string> })?.headers?.["retry-after"];
  return rawRetryAfter ? Number(rawRetryAfter) : Number.NaN;
}

function buildQuotaExhaustedMessage(retryAfterS: number, errBody: string): string {
  const isQuotaExhausted = Number.isNaN(retryAfterS) || retryAfterS > MAX_RETRY_AFTER_S;
  const retryAfterLabel = Number.isNaN(retryAfterS) ? "N/A" : retryAfterS + "s";
  const hint = isQuotaExhausted
    ? `Retry-After ausente ou muito longo (${retryAfterLabel}) - provável quota diária/mensal esgotada.`
    : `Limite de ${MAX_429_RETRIES} retentativas atingido.`;

  return (
    `\nx  Erro 429 da NVIDIA NIM API - ${hint}\n\n` +
    `   Possíveis causas:\n` +
    `     * Quota diária/mensal da sua API key esgotada\n` +
    `     * Plano gratuito sem acesso ao modelo minimaxai/minimax-m3\n` +
    `     * Verifique em: https://build.nvidia.com/ -> Usage & Billing\n\n` +
    `   Detalhes do erro: ${errBody}`
  );
}

function is429Error(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  return apiErr?.status === 429 ||
    (apiErr == null && (err as { status?: number })?.status === 429);
}

// BUG FIX (BUG 1): antes, só 429 e erros de rede (ECONNRESET, ETIMEDOUT) eram
// retried. 502/503 frequentemente são transientes (gateway restart, deploy,
// overload momentâneo) e deveriam ser retried. 500 NÃO é retriable (geralmente
// é bug real no servidor). 504 também não (gateway timeout — retry provável de
// falhar da mesma forma; o cliente de HTTP já tem seu próprio timeout).
const RETRIABLE_5XX_STATUSES = new Set([502, 503]);

function is5xxRetryableError(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status;
  return typeof status === "number" && RETRIABLE_5XX_STATUSES.has(status);
}

function handleStreamError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> | null {
  if (is429Error(err)) {
    return handle429Error(err, attempt);
  }
  if (is5xxRetryableError(err)) {
    return handle5xxRetryableError(err, attempt);
  }
  if (isTransientNetworkError(err)) {
    return handleTransientNetworkError(err, attempt);
  }
  return null;
}

function isTransientNetworkError(err: unknown): boolean {
  return isTransientNetworkErrorPublic(err);
}

function getErrCode(err: unknown): string {
  const anyErr = err as any;
  return anyErr?.code ?? anyErr?.cause?.code ?? "unknown";
}

async function handle429Error(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  const retryAfterS = extractRetryAfter(err);
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const errBody = apiErr?.message ?? String(err);

  const isQuotaExhausted =
    Number.isNaN(retryAfterS) || retryAfterS > MAX_RETRY_AFTER_S;

  if (isQuotaExhausted || attempt >= MAX_429_RETRIES) {
    throw new Error(buildQuotaExhaustedMessage(retryAfterS, errBody));
  }

  return retryWithDelay(retryAfterS, attempt);
}

async function retryWithDelay(retryAfterS: number, attempt: number): Promise<{ retried: boolean; newAttempt: number }> {
  const newAttempt = attempt + 1;
  const waitMs = retryAfterS * 1000 + 500;
  log.throttle(
    `API retornou 429. Retry-After: ${retryAfterS}s. ` +
    `Aguardando ${retryAfterS}s (tentativa ${newAttempt}/${MAX_429_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

// BUG FIX (BUG 1): handler de retry para 502/503 (transientes). Usa o mesmo
// limite e backoff de erros de rede (MAX_NETWORK_RETRIES = 8, 500ms..3000ms),
// porque 5xx transiente tem perfil de recuperação similar a um erro de rede.
async function handle5xxRetryableError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  if (attempt >= MAX_NETWORK_RETRIES) {
    return { retried: false, newAttempt: attempt };
  }

  const newAttempt = attempt + 1;
  const waitMs = Math.min(newAttempt * 500, 3000);
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status ?? "?";
  log.warn(
    `Erro ${status} do servidor (transiente). ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

async function handleTransientNetworkError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  if (attempt >= MAX_NETWORK_RETRIES) {
    return { retried: false, newAttempt: attempt };
  }

  const newAttempt = attempt + 1;
  const waitMs = Math.min(newAttempt * 500, 3000);
  log.warn(
    `Erro de rede (${getErrCode(err)}). ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

/**
 * Send a complete message history to the Kimi K2.6 model.
 *
 * Enforces:
 *  - Single-flight concurrency (Mutex)
 *  - Sliding-window rate limiting (<= rateLimitRpm rpm)
 *  - Smart 429 retry: only retries short-lived rate limits (Retry-After <= 90 s).
 *    Quota-exhausted 429s (no Retry-After, or Retry-After > 90 s) are thrown
 *    immediately with a clear diagnostic.
 *
 * @param messages  Full conversation history to send.
 * @returns         The raw OpenAI ChatCompletion response.
 */
export async function chat(
  messages: Message[],
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
): Promise<ChatResponse> {
  // IDEIA: Multi-key pool - if NVIDIA_API_KEYS is configured, use the pool
  // instead of the single-key mutex+rateLimiter. Each call picks a free key,
  // allowing sub-agents to run truly in parallel without contending.
  const poolActive = getPoolSize() > 0 || initApiKeyPool();

  if (poolActive) {
    try {
      return await chatWithPool(messages, tools, onStreamStart, onToken, onThinking);
    } catch (err) {
      // Pool acquisition failed entirely - fall back to single-key mode
      log.warn(`[POOL] Falling back to single-key mode: ${(err as Error).message}`);
    }
  }
  return chatSingleKey(messages, tools, onStreamStart, onToken, onThinking);
}

// BUG FIX (BUG 6): helper para cancelar/abortar um stream perdedor do hedging.
// Tenta várias APIs comuns: OpenAI SDK Stream expõe `.controller` (AbortController);
// Node streams têm `.destroy()`; alguns objetos têm `.abort()`. Se nada for
// disponível (ex: mock async iterable em testes), a função é no-op.
function abortStreamSafe(s: any): void {
  if (s == null) return;
  try { s?.controller?.abort?.(); } catch { /* noop */ }
  try { s?.abort?.(); } catch { /* noop */ }
  try { s?.destroy?.(); } catch { /* noop */ }
  try { s?.return?.(); } catch { /* noop */ } // encerra async iterators
}

/** Pool-mode chat: pick a free key from the pool, run the request, release. */
async function chatWithPool(
  messages: Message[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  onStreamStart: (() => void) | undefined,
  onToken: ((token: string) => void) | undefined,
  onThinking: (() => void) | undefined
): Promise<ChatResponse> {
  let attempt = 0;
  for (;;) {
    const poolHandle = await acquireKeyForStreaming();
    const start = Date.now();
    let httpStatus: number | null = null;
    let releaseSuccess!: boolean;
    try {
      log.debug(`Sending ${messages.length} messages to ${config.model} (pool mode)` +
        (attempt > 0 ? ` (retry ${attempt}/${MAX_429_RETRIES})` : ""));

      // ─── Delayed Hedging ────────────────────────────────────────────
      // If there are 2+ free keys in the pool, send a backup request on
      // a 2nd key after HEDGE_TIMEOUT_MS (5s). The first stream to
      // produce output wins; the other is cancelled.
      //
      // This is "delayed" hedging — we don't fire 2 requests at once.
      // We fire 1, wait 5s, and only fire the 2nd if the 1st hasn't
      // produced output yet. This way:
      //   - Fast requests (<5s): 1 key used, 0 waste
      //   - Slow requests (>5s): 2 keys used, 1 waste, but faster response
      //
      // The pool's mutex guarantees we never steal a key that's already
      // in use by the main agent or a sub-agent. If only 1 key is free,
      // hedging is skipped (no backup).
      const HEDGE_TIMEOUT_MS = 5000;
      // Hedging only makes sense for NVIDIA (GPU queue contention).
      // ZenMux has no queue (10+ concurrent, no cold start) — hedging would
      // just waste requests for no benefit.
      // Also requires at least 1 free key in the pool for backup.
      const canHedge = providerNeedsHedging() && getAvailableKeyCount() >= 1 && getTotalKeyCount() >= 2;

      let hedgeHandle: { client: OpenAI; entry: any; release: (success: boolean, httpStatus: number | null, latencyMs: number) => void } | null = null;
      let hedgeWinner: "primary" | "hedge" | null = null;
      let primaryStreamStarted = false;

      // Start primary stream
      const primaryStreamPromise = createStreamRequest(messages, tools, poolHandle.client);

      // If hedging is possible, set a timer to fire the backup
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      if (canHedge) {
        hedgeTimer = setTimeout(() => {
          // Only fire hedge if primary hasn't started streaming yet
          if (primaryStreamStarted) return;
          hedgeHandle = tryAcquireKeyImmediate() as any;
          if (hedgeHandle) {
            log.debug(`[HEDGE] Primary slow after ${HEDGE_TIMEOUT_MS}ms — firing backup on key #${(hedgeHandle.entry as any).index}`);
          }
        }, HEDGE_TIMEOUT_MS);
      }

      try {
        // Wait for primary stream to be created (the initial HTTP request)
        const rawStream = await primaryStreamPromise;
        primaryStreamStarted = true;

        // Check if hedge was already fired (meaning primary took >5s to even
        // get the initial response). If so, race both streams.
        if (hedgeHandle) {
          // Primary was slow to start — race both streams
          log.debug(`[HEDGE] Primary eventually started, but hedge was already fired — racing`);

          const primaryState = createStreamState();
          const hedgeState = createStreamState();

          // Race: first stream to produce content wins
          // BUG FIX (BUG 6): antes, o `.catch(() => {})` do perdedor era
          // registrado APÓS o `Promise.race` resolver. Se o stream perdedor
          // rejeitasse antes do catch ser anexado, vira unhandled rejection.
          // Agora anexamos o catch ANTES da race em AMBAS as promises —
          // qualquer rejeição é silenciada imediatamente.
          const primaryPromise = consumeStream(rawStream, primaryState, undefined, undefined, undefined).then(() => "primary" as const);
          primaryPromise.catch(() => {}); // suppress unhandled rejection no perdedor

          let hedgeRawStream: any = null;
          const hedgeStreamPromise = createStreamRequest(messages, tools, (hedgeHandle as any)!.client)
            .then(hs => {
              hedgeRawStream = hs;
              return consumeStream(hs, hedgeState, undefined, undefined, undefined).then(() => "hedge" as const);
            });
          hedgeStreamPromise.catch(() => {}); // suppress unhandled rejection no perdedor

          const winner = await Promise.race([primaryPromise, hedgeStreamPromise]);
          hedgeWinner = winner as "primary" | "hedge";

          // BUG FIX (BUG 6): cancelar/abortar o stream perdedor para evitar
          // leak. Tenta chamar `.abort()` / `.destroy()` / `.controller.abort()`
          // se disponível (OpenAI SDK Stream expõe `.controller`). Se o stream
          // for um mock/async iterable sem esses métodos, nada acontece.
          if (hedgeWinner === "primary") {
            // Hedge lost — aborta o stream subjacente do hedge
            abortStreamSafe(hedgeRawStream);
            const response = buildChatResponse(primaryState);
            // But we need to call onStreamStart/onToken with the winner's content
            if (onStreamStart) onStreamStart();
            if (onToken && response.choices[0]?.message?.content) {
              onToken(response.choices[0].message.content);
            }
            releaseSuccess = true;
            return response;
          } else {
            // Primary lost — aborta o stream subjacente do primary
            abortStreamSafe(rawStream);
            const response = buildChatResponse(hedgeState);
            if (onStreamStart) onStreamStart();
            if (onToken && response.choices[0]?.message?.content) {
              onToken(response.choices[0].message.content);
            }
            releaseSuccess = true;
            return response;
          }
        }

        // Normal path: no hedge fired, consume primary stream
        const state = createStreamState();
        await consumeStream(rawStream, state, onStreamStart, onToken, onThinking);
        const response = buildChatResponse(state);
        releaseSuccess = true;
        log.debug(
          `Response: stop_reason=${response.choices[0]?.finish_reason}, ` +
            `tokens=${response.usage?.total_tokens ?? "?"}`
        );
        return response;
      } finally {
        if (hedgeTimer) clearTimeout(hedgeTimer);
        if (hedgeHandle) {
          (hedgeHandle as any).release(hedgeWinner === "hedge", null, Date.now() - start);
        }
      }
    } catch (err: unknown) {
      releaseSuccess = false;
      httpStatus = (err as any)?.status ?? null;
      logApiDiagnostics(err, attempt);
      const retryResult = await handleStreamError(err, attempt);
      if (retryResult?.retried && attempt < MAX_429_RETRIES + MAX_NETWORK_RETRIES) {
        attempt = retryResult.newAttempt;
        continue;
      }
      throw err;
    } finally {
      poolHandle.release(releaseSuccess, httpStatus, Date.now() - start);
    }
  }
}

/** Single-key chat path - uses global mutex + rateLimiter (backwards compat). */
async function chatSingleKey(
  messages: Message[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  onStreamStart: (() => void) | undefined,
  onToken: ((token: string) => void) | undefined,
  onThinking: (() => void) | undefined
): Promise<ChatResponse> {
  let attempt = 0;
  for (;;) {
    await mutex.lock();
    try {
      await rateLimiter.acquire();
      log.debug(`Sending ${messages.length} messages to ${config.model}` +
        (attempt > 0 ? ` (retry ${attempt}/${MAX_429_RETRIES})` : ""));
      const rawStream = await createStreamRequest(messages, tools);
      const state = createStreamState();
      await consumeStream(rawStream, state, onStreamStart, onToken, onThinking);
      const response = buildChatResponse(state);
      log.debug(
        `Response: stop_reason=${response.choices[0]?.finish_reason}, ` +
          `tokens=${response.usage?.total_tokens ?? "?"}`
      );
      return response;
    } catch (err: unknown) {
      logApiDiagnostics(err, attempt);
      const retryResult = await handleStreamError(err, attempt);
      if (retryResult?.retried) {
        attempt = retryResult.newAttempt;
        continue;
      }
      throw err;
    } finally {
      mutex.unlock();
    }
  }
}

