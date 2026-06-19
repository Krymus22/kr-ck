# Plano de Refatoração: Modos Completos + Tools Declarativas + Inbox

> **Criado em:** 2026-06-19
> **Atualizado em:** 2026-06-20
> **Status:** Aprovado (reordenado + sandbox madura + edge cases resolvidos)
> **Estimativa total:** ~64h (12 sprints em 3 fases)

## Contexto

O sistema atual de tools tem problemas:
1. Busca em 15+ lugares diferentes (complexo, frágil)
2. IA não sabe args corretos das tools (`executar_tool` genérico)
3. Tools/skills/MCPs espalhados em pastas diferentes
4. Sem classificação clara (validator vs action vs background)
5. Adicionar tool nova requer código ou conhecimento técnico

Este plano resolve tudo com:
- **Pasta por modo** (self-contained)
- **Manifests declarativos** (.json descreve cada tool)
- **Classificação** (validator/action/background/hook)
- **IA configuradora** (cria manifest de tool desconhecida)
- **Inbox** (usuário joga arquivos, IA organiza)

---

## Estrutura final de diretórios

```
~/.claude-killer/modes/<mode-name>/
├── inbox/              ← drop zone (IA organiza)
│   └── README.md       ← explica "jogue arquivos aqui e rode /organize"
├── tools/              ← binaries (.exe / sem extensão unix)
├── manifests/          ← .json descrevendo cada tool
├── skills/             ← .md com conhecimento pra IA
├── hooks/              ← .js hooks customizados
├── mcps/               ← MCP servers (código + config)
└── config.json         ← tudo conectado

defaults/modes/<mode-name>/    ← defaults bundled (read-only)
├── tools/              ← vazia (user copia binaries)
├── manifests/          ← pré-feitos
├── skills/             ← pré-feitos
├── hooks/              ← pré-feitos (vazio inicialmente)
├── mcps/               ← configs pré-feitas (vazio inicialmente)
└── config.json         ← config default
```

### Pastas globais (herdadas por todos os modos)

```
~/.claude-killer/
├── skills/             ← skills globais (todos modos herdam)
├── mcps/               ← MCPs globais
└── modes/
    └── <mode-name>/    ← específico do modo (sobrescreve global)
```

**Regra:** específico do modo > global. Se skill existe nos 2, modo ganha.

---

## Formato do `config.json`

```json
{
  "name": "roblox",
  "label": "Roblox Development",
  "description": "Modo completo para desenvolvimento Roblox com Luau",
  "icon": "R",
  "effortLevel": "high",
  "strictMode": false,
  "readBeforeWrite": true,
  "advancedThinking": false,
  
  "tools": {
    "dir": "tools",
    "manifestsDir": "manifests",
    "items": ["rojo", "selene", "stylua", "wally", "lune", "rokit"]
  },
  
  "skills": {
    "dir": "skills",
    "items": [
      "rojo-cli",
      "wally-cli",
      "selene-cli",
      "stylua-cli",
      "lune-cli",
      "rokit-cli",
      "wally-package-types-cli"
    ]
  },
  
  "hooks": {
    "dir": "hooks",
    "items": [
      { "name": "auto-build", "file": "auto-build.js", "trigger": "on_file" },
      { "name": "validate-config", "file": "validate-config.js", "trigger": "on_task" }
    ]
  },
  
  "mcps": {
    "dir": "mcps",
    "items": [
      {
        "name": "roblox-api",
        "command": "node",
        "args": ["mcps/roblox-api.js"],
        "env": {}
      }
    ]
  },
  
  "validators": [
    { "tool": "selene", "filePattern": "*.luau", "blocking": true },
    { "tool": "selene", "filePattern": "*.lua", "blocking": true },
    { "tool": "stylua", "filePattern": "*.luau", "blocking": false },
    { "tool": "stylua", "filePattern": "*.lua", "blocking": false }
  ],
  
  "systemPrompt": "Você é um assistente especializado em Roblox Development..."
}
```

---

## Formato do manifest (por tool)

Arquivo: `manifests/<tool-name>.json`

```json
{
  "name": "rojo",
  "description": "Roblox project sync tool",
  "category": "action",
  "version": ">=7.0.0",
  
  "detection": {
    "versionCommand": "--version",
    "versionRegex": "(\\d+\\.\\d+\\.\\d+)"
  },
  
  "actions": {
    "build": {
      "description": "Build .rbxl place file from Rojo project",
      "args": ["build", "{projectFile}", "-o", "{outputPath}"],
      "schema": {
        "type": "object",
        "properties": {
          "projectFile": { 
            "type": "string", 
            "default": "default.project.json",
            "description": "Path to .project.json file"
          },
          "outputPath": { 
            "type": "string", 
            "default": "build.rbxl",
            "description": "Output .rbxl or .rbxmx path"
          }
        }
      }
    },
    "serve": {
      "description": "Start Rojo live sync with Roblox Studio",
      "args": ["serve", "{projectFile}", "--port", "{port}"],
      "longRunning": true,
      "schema": {
        "type": "object",
        "properties": {
          "projectFile": { 
            "type": "string", 
            "default": "default.project.json"
          },
          "port": { 
            "type": "number", 
            "default": 34872 
          }
        }
      }
    },
    "sourcemap": {
      "description": "Generate sourcemap / dependency graph",
      "args": ["sourcemap", "{projectFile}", "-o", "{outputPath}"],
      "schema": {
        "type": "object",
        "properties": {
          "projectFile": { "type": "string", "default": "default.project.json" },
          "outputPath": { "type": "string", "default": "sourcemap.json" }
        }
      }
    }
  }
}
```

### Categorias de tools

| Categoria | Quando roda | Como IA interage |
|---|---|---|
| `validator` | Antes de salvar arquivo (gate) | Não vê — roda sozinho |
| `action` | IA decide chamar | Function call específica |
| `background` | Modo ativa (loop) | Não vê — roda em background |
| `hook` | Em eventos do agent loop | Não vê — roda em triggers |

### Placeholders nos args

| Placeholder | Substituído por |
|---|---|
| `{binary}` | Caminho pro binary (ex: `tools/rojo.exe`) |
| `{file}` | Arquivo temporário (validators) |
| `{input}` | Arg `input` da IA |
| `{output}` | Arg `output` da IA |
| `{projectFile}` | Arg `projectFile` da IA |
| Qualquer `{argName}` | Arg correspondente do schema |

---

## Formato dos hooks

Arquivo: `hooks/<hook-name>.js`

```javascript
// hooks/auto-build.js
module.exports = {
  name: "auto-build",
  trigger: "on_file",  // on_file | on_task | always | before_write
  
  // Roda em evento específico
  // Retorno null = não faz nada
  // Retorno { blocking: true, message } = bloqueia ação
  // Retorno { modifiedContent } = sobrescreve conteúdo (só before_write)
  async run({ filePath, content, toolExecutor, mode }) {
    if (!filePath.endsWith(".luau")) return null;
    
    // Auto-build depois de editar .luau
    await toolExecutor.execute("rojo_build", {
      projectFile: "default.project.json",
      outputPath: "build.rbxl"
    });
    
    return null;
  }
};
```

### Triggers de hooks

| Trigger | Quando roda | Args recebidos |
|---|---|---|
| `before_write` | Antes de salvar arquivo | `{ filePath, content, toolExecutor, mode }` |
| `on_file` | Após editar arquivo | `{ filePath, content, toolExecutor, mode }` |
| `on_task` | Após completar task | `{ toolExecutor, mode }` |
| `always` | A cada iteração do agent loop | `{ toolExecutor, mode }` |

### Retorno de hooks

```typescript
type HookResult = 
  | null  // não faz nada
  | { blocking: true, message: string }  // bloqueia ação
  | { modifiedContent: string }  // sobrescreve (só before_write)
  | { warning: string };  // avisa mas não bloqueia
```

---

## Fluxo: ativar modo

```
Usuário: /mode roblox
         ↓
applyMode("roblox"):
  1. Carrega config.json do modo
  2. Registra tools (lê manifests/, conecta com tools/)
  3. Carrega skills (skills/*.md → injeta no system prompt)
  4. Carrega hooks (hooks/*.js → registra em triggers)
  5. Inicia MCPs (spawn processes dos mcps/)
  6. Configura validators (gates automáticos)
  7. Configura hooks (on_file, on_task, always)
  8. Seta effortLevel, strictMode, readBeforeWrite
  9. Atualiza system prompt com skills + modo description
         ↓
IA agora tem:
  - Skills injetadas (sabe workflow)
  - Function calls disponíveis (rojo_build, wally_install, etc.)
  - Validators automáticos (selene/stylua antes de salvar)
  - Hooks rodando em eventos
  - MCPs conectados (tools adicionais via JSON-RPC)
  - Gates programáticos ativos
```

---

## Fluxo: inbox organize

```
Usuário joga arquivos no inbox/
         ↓
Usuário: /organize  (ou tecla 'O' no Hub)
         ↓
IA organizadora:
  1. Lista arquivos do inbox/
  2. Pra cada arquivo:
     a. Heurística por extensão (.exe → tool, .md → skill, etc.)
     b. Inspeção de conteúdo (.js → plugin? mcp? .json → manifest? config?)
     c. Se ambíguo → pergunta IA configuradora
     d. Move pro lugar certo
     e. Cria manifest se necessário (tools sem manifest)
  3. Atualiza config.json com novos itens
  4. Mostra resumo do que foi feito
         ↓
Tudo configurado. IA principal já pode usar.
```

### Detecção por tipo

| Extensão | Heurística | Inspeção | IA configuradora |
|---|---|---|---|
| `.exe` / sem ext | TOOL | Roda `--version`, `--help` | Cria manifest |
| `.md` | SKILL | Procura `## When to use` | - |
| `.js` | PLUGIN/MCP? | Procura `module.exports.run` (hook) vs `JSON-RPC` (mcp) | Pergunta |
| `.json` | MANIFEST/CONFIG/MCP? | Schema check | - |
| `.zip`/`.tar.gz` | ARQUIVO | Extrai e re-processa | - |
| `.txt` | DOCS | - | Pergunta |
| Outros | UNKNOWN | - | Pergunta |

---

## Fluxo: IA configuradora (tool sem manifest)

```
Usuário copia darklua.exe pra tools/ (sem darklua.json)
         ↓
Sistema detecta: "tool sem manifest"
         ↓
Pergunta: "darklua.exe encontrado sem config. Configurar? (s/n)"
         ↓
IA configuradora (sub-agente limitado):
  System prompt:
    "Você é uma IA configuradora. Descubra como usar a tool X
     e crie um manifest JSON. NÃO edite código fonte.
     Só pode: rodar --help/--version, pesquisar web, criar .json"
  
  Tools disponíveis (limitadas):
    - executar_comando (só pra --help, --version)
    - pesquisar (web search)
    - criar_arquivo (só pra criar o .json)
  
  Não tem acesso a:
    - editar_arquivo
    - aplicar_diff
    - ler_arquivo no projeto
         ↓
IA trabalha:
  1. Roda: darklua --help → vê args
  2. Roda: darklua --version → vê versão
  3. Pesquisa: "darklua CLI documentation"
  4. Entende: "minifier/transformer pra Luau"
  5. Cria manifests/darklua.json
         ↓
Sistema valida JSON (schema check)
         ↓
Tool configurada. IA principal já pode usar.
```

---

## Sprints de implementação

O plano está organizado em **3 fases**:

- **FASE 1 — Fundação (28h):** MVP que já tem valor isolado. Cada sprint entrega valor independente.
- **FASE 2 — Sistema Completo (34h):** Features que dependem da fundação. Completam o sistema de modos.
- **FASE 3 — Robustez (11h):** Schema validation + cobertura completa de testes.

**Total:** ~64h (12 sprints)

---

### FASE 1 — Fundação (MVP que já tem valor)

#### Sprint 1: AskUser — Sistema de Perguntas Interativas (7h)

**Objetivo:** Implementar sistema de perguntas igual ao Claude Code — IA faz pergunta, PARA, e usuário escolhe alternativa ou digita resposta. Disponível tanto no chat normal quanto no configurador.

> **Inspirado em:** Claude Code's `AskUserQuestion` tool — quando a IA não tem certeza de algo, ela faz uma pergunta com múltipla escolha + opção de resposta livre. O agent loop PARA até o usuário responder. Isso reduz MUITO os erros em casos reais.

> **Independente do sistema de modos:** Este sprint não depende de pastas, manifests, ou qualquer outra feature. Pode ser implementado e testado isoladamente. É a feature de maior impacto individual — reduz erros desde cedo no chat normal.

##### 1.A — Tool `perguntar_usuario` (2h)

**Objetivo:** Nova function call que IA pode usar pra fazer perguntas.

**Tarefas:**
- [ ] **F1.1** Definir tool `perguntar_usuario` em `agent.ts`:
  ```typescript
  {
    type: "function",
    function: {
      name: "perguntar_usuario",
      description: "Faça uma pergunta ao usuário quando você não tem certeza de algo. " +
        "O usuário vai escolher uma das alternativas ou digitar a própria resposta. " +
        "USE SEMPRE que: não entendeu perfeitamente o pedido, há múltiplas interpretações, " +
        "precisa de informação que não está no contexto, ou precisa confirmar uma decisão importante. " +
        "NUNCA assuma — pergunte.",
      parameters: {
        type: "object",
        properties: {
          pergunta: { 
            type: "string", 
            description: "A pergunta em linguagem natural, clara e específica" 
          },
          alternativas: {
            type: "array",
            items: { type: "string" },
            description: "Lista de alternativas pré-definidas (mínimo 2, máximo 6). " +
              "O usuário pode escolher uma OU digitar resposta livre.",
            minItems: 2,
            maxItems: 6
          },
          contexto: {
            type: "string",
            description: "Contexto adicional opcional explicando POR QUE está perguntando"
          }
        },
        required: ["pergunta", "alternativas"]
      }
    }
  }
  ```
- [ ] **F1.2** Handler de `perguntar_usuario`:
  - Quando IA chama essa tool, o agent loop PARA
  - Renderiza UI de pergunta (1.B)
  - Aguarda usuário responder (escolher alternativa ou digitar)
  - Retorna resposta como tool result pra IA
  - Agent loop CONTINUA com a resposta
- [ ] **F1.3** Disponibilizar `perguntar_usuario` no chat normal E no configurador:
  - Chat normal: sempre disponível
  - Configurador: sempre disponível (já estava no prompt do 11.A)
  - Sub-agentes: disponível se `allowUserQuestions: true` (default: false)

##### 1.B — UI de Pergunta no Terminal (3h)

**Objetivo:** Interface visual igual Claude Code — alternativas numeradas + input livre.

**Tarefas:**
- [ ] **F1.4** Criar `src/tui/QuestionPrompt.tsx`:
  - Componente Ink que renderiza pergunta + alternativas
  - Layout:
    ```
    ┌─────────────────────────────────────────────┐
    │ ❓ Pergunta                                  │
    │                                             │
    │ Qual framework você quer usar pra UI?       │
    │                                             │
    │ Contexto: Você mencionou "interface" mas    │
    │ não especificou qual framework.             │
    │                                             │
    │ [1] React                                   │
    │ [2] Vue                                     │
    │ [3] Svelte                                  │
    │ [4] Nenhum — HTML puro                      │
    │                                             │
    │ Digite o número da alternativa              │
    │ OU digite sua própria resposta:             │
    │                                             │
    │ > _                                         │
    │                                             │
    │ [Enter] confirmar  [Esc] cancelar           │
    └─────────────────────────────────────────────┘
    ```
- [ ] **F1.5** Interação:
  - Setas ↑↓ ou números 1-6 selecionam alternativa
  - Enter confirma seleção
  - OU usuário digita resposta livre (qualquer texto que não seja número)
  - Esc cancela pergunta → retorna "usuário cancelou"
  - Tab alterna entre "escolher alternativa" e "digitar resposta"
- [ ] **F1.6** Estado de "aguardando resposta":
  - Quando `perguntar_usuario` é chamada, App entra em modo "aguardando"
  - Agent loop PAUSA (não continua pra próxima iteração)
  - UI mostra QuestionPrompt
  - Input normal do chat fica desabilitado
  - Status bar mostra "Aguardando resposta..."
  - Após resposta, agent loop CONTINUA
- [ ] **F1.7** Render da pergunta no histórico do chat:
  - Pergunta aparece como mensagem especial no chat
  - Resposta do usuário também aparece
  - Histórico preserva pergunta+resposta pra contexto futuro

##### 1.C — Integração com Agent Loop (2h)

**Objetivo:** Agent loop pausa/resume corretamente quando IA pergunta.

**Tarefas:**
- [ ] **F1.8** Modificar `runAgentLoop`:
  ```typescript
  // Quando dispatchToolCall recebe "perguntar_usuario":
  if (toolName === "perguntar_usuario") {
    const { pergunta, alternativas, contexto } = args;
    
    // PAUSA agent loop — renderiza UI e aguarda
    const resposta = await waitForUserResponse(pergunta, alternativas, contexto);
    
    // Retorna resposta como tool result
    return { 
      resultStr: resposta.cancelled 
        ? "[USUÁRIO CANCELOU A PERGUNTA]"
        : `[RESPOSTA DO USUÁRIO] ${resposta.value}`,
      usedHeal: false 
    };
  }
  ```
- [ ] **F1.9** `waitForUserResponse()`:
  - Cria Promise que resolve quando usuário responde
  - Renderiza QuestionPrompt via callback
  - Resolve com `{ value: string, cancelled: boolean, fromAlternatives: boolean }`
  - Pode ser cancelado (Esc) → `{ cancelled: true }`
- [ ] **F1.10** System prompt atualizado pra encorajar perguntas:
  ```
  REGRAS:
  - Se você NÃO tem certeza do que o usuário quer, USE perguntar_usuario.
  - NUNCA assuma — pergunte.
  - É melhor perguntar e errar 0 vezes do que assumir e errar 5.
  - Pergunte quando: há múltiplas interpretações, falta contexto,
    precisa confirmar decisão importante, usuário foi vago.
  - Dê alternativas específicas (não genéricas).
  - Sempre inclua "Outro" implícito (usuário pode digitar resposta livre).
  ```

##### 1.D — Disponibilidade Seletiva (0.5h)

**Objetivo:** Nem todo sub-agente pode perguntar (evita spam).

**Tarefas:**
- [ ] **F1.11** Configuração por agente:
  - Chat principal: `allowUserQuestions: true` (sempre)
  - Configurador: `allowUserQuestions: true` (sempre)
  - Sub-agentes paralelos: `allowUserQuestions: false` (default)
  - Sub-agentes podem ter `allowUserQuestions: true` se explicitamente configurado
- [ ] **F1.12** Se IA tenta `perguntar_usuario` sem permissão:
  - Retorna erro: "perguntar_usuario não disponível neste contexto"
  - IA deve continuar sem perguntar (usar melhor juízo)

**Entregável:** IA faz pergunta → agent pausa → usuário responde → IA continua. Funciona no chat normal e configurador.

---

#### Sprint 2: Limpeza + Migration (12h)

**Objetivo:** Remover sistema antigo de busca, criar estrutura de pastas, toolDetector simples, E migrar usuários existentes pro novo formato. Juntamos limpeza + migration porque não dá pra mudar a estrutura de pastas sem migrar o que existe — separar deixaria usuários quebrados entre os dois sprints.

##### 2.A — Limpeza + Estrutura + Tools (8h)

**Tarefas:**
- [ ] **F2.1** Remover `src/aiSearch.ts` (~250 linhas)
- [ ] **F2.2** Remover funções de busca do `src/toolDetector.ts`:
  - `smartSearch()`, `findToolchainConfig()`, `getRegistryPathDirs()`
  - `queryPackageManagers()`, `extremeFilesystemSearch()`
  - `deepFilesystemSearch()`, `extremeSearchAllTools()`, `aiOnlySearchAllTools()`
  - `searchAllTools()` (versão antiga)
  - Manter só `detectTool()` (sem busca profunda) e `getModeToolNames()`
- [ ] **F2.3** Remover do `ExtensionHub.tsx`:
  - Estados: `searching`, `extremeSearching`, `aiSearching` + progress
  - Funções: `triggerToolSearch()`, `triggerExtremeSearch()`, `triggerAiSearch()`
  - Keybinds: S, A, X
  - Painéis de busca
- [ ] **F2.4** Criar estrutura de pastas:
  - `defaults/modes/roblox/{tools,manifests,skills,hooks,mcps,inbox}/`
  - `defaults/modes/devops/{tools,manifests,skills,hooks,mcps,inbox}/`
- [ ] **F2.5** Refatorar `toolDetector.ts`:
  - Nova função `findToolBinary(toolName, modeName)` — olha só em `modes/<mode>/tools/`
  - 5 linhas em vez de 1500
- [ ] **F2.6** Atualizar `externalTools.ts`:
  - `ToolRegistry` lê tools da pasta do modo ativo
  - `isInstalled()` verifica se binary existe (sem cache de 5min)
- [ ] **F2.7** Migrar binaries existentes (opcional, migration tool):
  - Script que copia `~/.rokit/bin/*.exe` → `~/.claude-killer/modes/roblox/tools/`
- [ ] **F2.8** Deletar testes antigos de busca:
  - `hub-manual-search.test.tsx`
  - `hub-e2e.test.tsx` ( partes de search)
  - `toolDetector-extended.test.ts` (partes de search)
  - `aiSearch.test.ts`, `aiSearch-extended.test.ts`
  - `tool-detection-hub.test.tsx`

**Entregável:** Hub sem S/A/X, tools sendo detectadas só na pasta do modo.

##### 2.B — Migration Automático (4h)

**Objetivo:** Migration de usuários existentes pro novo formato de estrutura + config.

**Tarefas:**
- [ ] **F2.9** Migration automático de config:
  - Detecta `roblox.json` antigo → converte pra novo formato
  - Detecta tools em `~/.rokit/bin/` → sugere copiar pra `modes/roblox/tools/`
- [ ] **F2.10** Backup do config antigo antes de migrar
- [ ] **F2.11** Testar migration com configs reais

**Detalhes do migration de config antigo:**
- Detecta roblox.json antigo (sem "tools" structure)
- Converte pra novo formato (com tools/manifests/skills/hooks/mcps)
- Preserva enableTools → tools.items
- Preserva enableSkills → skills.items
- Preserva luauValidation → validators
- Preserva effortLevel, strictMode, readBeforeWrite
- Cria backup do config antigo (.bak)
- Não migra se já tá no novo formato

**Detalhes do migration de binaries:**
- Detecta tools em ~/.rokit/bin/
- Sugere copiar pra modes/roblox/tools/
- Copia binaries quando usuário confirma
- Não deleta originais (só copia)
- Lida com tools que já existem na pasta do modo

**Detalhes do migration de skills:**
- Move skills de defaults/skills/ pra defaults/modes/roblox/skills/
- Skills globais ficam em ~/.claude-killer/skills/
- Não duplica skills

**Detalhes do migration de MCPs:**
- Move mcp-config.json pra modes/<mode>/mcps/
- MCPs globais ficam em ~/.claude-killer/mcps/

**Entregável:** Usuário existente atualiza claude-killer → migration automático → modo roblox ativa sem erro.

---

#### Sprint 3: Manifests + Function Calls Dinâmicas (6h)

**Objetivo:** Tools viram function calls específicas baseadas em manifests.

**Tarefas:**
- [ ] **F3.1** Definir schema do manifest (TypeScript interface)
- [ ] **F3.2** Criar manifests pré-feitos:
  - `defaults/modes/roblox/manifests/rojo.json`
  - `defaults/modes/roblox/manifests/selene.json`
  - `defaults/modes/roblox/manifests/stylua.json`
  - `defaults/modes/roblox/manifests/wally.json`
  - `defaults/modes/roblox/manifests/lune.json`
  - `defaults/modes/roblox/manifests/rokit.json`
- [ ] **F3.3** Criar `src/manifestLoader.ts`:
  - `loadToolManifest(toolName, modeName)` — lê custom ou bundled
  - `loadAllManifests(modeName)` — carrega todos do modo
- [ ] **F3.4** Refatorar `getExternalToolDefinitions()` em `agent.ts`:
  - Em vez de `executar_tool` genérico, gera function calls dos manifests
  - Cada action vira 1 function call (ex: `rojo_build`, `rojo_serve`)
- [ ] **F3.5** Refatorar handler de tool calls em `agent.ts`:
  - Despachar `${toolName}_${actionName}` → `toolExecutor.execute(toolName, actionName, args)`
- [ ] **F3.6** Refatorar `ToolExecutor.execute()`:
  - Lê manifest, substitui placeholders nos args
  - Spawn com args corretos
  - Retorna output estruturado

**Entregável:** IA vê `rojo_build({projectFile, outputPath})` em vez de `executar_tool({tool: "rojo_build"})`.

---

#### Sprint 4: Validators do Config (3h)

**Objetivo:** Validators (selene, stylua) rodam automáticos baseados em config.

**Tarefas:**
- [ ] **F4.1** Refatorar `luauValidator.ts`:
  - Lê validators do config.json do modo ativo (em vez de hardcoded)
  - Cada validator tem: tool, filePattern, blocking
- [ ] **F4.2** Atualizar `fileEdit.ts`:
  - `validateLuauBeforeWrite()` lê validators do config
  - Suporte a qualquer validator (não só selene/stylua)
- [ ] **F4.3** Generalizar pra outras linguagens:
  - `validateBeforeWrite()` (não só Luau)
  - Python mode → validators com black, mypy, ruff
  - TS mode → validators com tsc, eslint

**Entregável:** Adicionar validator novo = só editar config.json, sem código.

---

### FASE 2 — Sistema Completo

#### Sprint 5: Skills por Modo (3h)

**Objetivo:** Skills moram na pasta do modo, são injetadas no system prompt.

**Tarefas:**
- [ ] **F5.1** Mover skills existentes:
  - `defaults/skills/*-cli.md` → `defaults/modes/roblox/skills/`
- [ ] **F5.2** Refatorar `getActiveSkills()`:
  - Lê skills da pasta do modo ativo + globais
  - Modo específico > global
- [ ] **F5.3** Atualizar `applyMode()`:
  - Carrega skills e injeta no system prompt
- [ ] **F5.4** Atualizar `deactivateMode()`:
  - Remove skills injetadas
- [ ] **F5.5** Criar pasta global `~/.claude-killer/skills/` (skills compartilhadas)

**Entregável:** Modo Roblox ativo → skills rojo-cli, wally-cli, etc. disponíveis pra IA.

---

#### Sprint 6: Modo Normal + Compartilhamento Entre Modos (5h)

**Objetivo:** Modo "normal" também tem pasta. Tools podem ser compartilhadas entre modos (marcar quais modos usam as mesmas).

##### 6.A — Modo Normal com Pasta (1.5h)

**Objetivo:** Mesmo sem modo ativo, usuário tem pasta `~/.claude-killer/modes/normal/` com tools globais.

**Tarefas:**
- [ ] **F6.1** Criar modo "normal" built-in:
  - `defaults/modes/normal/config.json` — config mínimo (sem validators, sem hooks)
  - `defaults/modes/normal/{tools,manifests,skills,hooks,mcps,inbox}/` — estrutura vazia
  - Sempre ativo quando nenhum outro modo está ativo
  - Tools do modo normal são "padrão" — servem pra qualquer projeto
- [ ] **F6.2** Quando nenhum modo ativo → carrega modo normal:
  - `getActiveMode()` retorna modo normal em vez de null
  - Function calls do modo normal ficam disponíveis
  - Validators do modo normal rodam (se houver)
- [ ] **F6.3** Modo normal é "base" pra outros modos:
  - Outros modos HERDAM tools do normal (a menos que sobrescrevam)
  - Ex: modo roblox tem rojo + herda git do normal
  - Modo python tem pytest + herda git do normal
- [ ] **F6.4** Config do modo normal:
  ```json
  {
    "name": "normal",
    "label": "Padrão",
    "description": "Modo padrão com ferramentas básicas",
    "isBase": true,
    "tools": {
      "items": ["git"]
    },
    "skills": {
      "items": ["git-cli"]
    }
  }
  ```

##### 6.B — Compartilhamento de Tools Entre Modos (2h)

**Objetivo:** Usuário marca quais modos usam as mesmas tools. Ex: tool X no modo normal → também quero no modo roblox.

**Tarefas:**
- [ ] **F6.5** Adicionar campo `sharedWith` no manifest:
  ```json
  {
    "name": "darklua",
    "category": "action",
    "sharedWith": ["roblox", "devops"],
    "actions": { ... }
  }
  ```
  - Tool mora em UMA pasta (ex: `modes/normal/tools/darklua.exe`)
  - Mas é visível nos modos listados em `sharedWith`
- [ ] **F6.6** UI pra marcar compartilhamento (no Hub):
  ```
  ┌─────────────────────────────────────────┐
  │ Tool: darklua                           │
  │                                         │
  │ Compartilhar com:                       │
  │ [x] normal (origem)                     │
  │ [x] roblox                              │
  │ [ ] devops                              │
  │ [ ] python                              │
  │                                         │
  │ [Enter] salvar  [Esc] cancelar          │
  └─────────────────────────────────────────┘
  ```
- [ ] **F6.7** `getExternalToolDefinitions()` respeita `sharedWith`:
  - Se modo ativo = roblox → mostra tools de roblox + tools compartilhadas COM roblox
  - Tool compartilhada usa manifest da pasta de origem
  - Tool compartilhada usa binary da pasta de origem (não duplica)
- [ ] **F6.8** Comando `/compartilhar <tool> <modo>`:
  - `/compartilhar darklua roblox` → marca darklua como sharedWith roblox
  - `/compartilhar darklua roblox devops` → marca pra vários
  - `/compartilhar darklua --todos` → compartilha com todos os modos
- [ ] **F6.9** Comando `/descompartilhar <tool> <modo>`:
  - Remove modo de `sharedWith`
- [ ] **F6.10** Tecla 'X' no Hub (não é mais extreme search) → abre painel de compartilhamento da tool selecionada

##### 6.C — Lógica de Herança (1.5h)

**Objetivo:** Modo normal é base. Outros modos herdam + adicionam próprias.

**Tarefas:**
- [ ] **F6.11** Resolução de tools visíveis no modo ativo:
  ```typescript
  function getVisibleTools(modeName: string): Tool[] {
    const modeTools = loadModeTools(modeName);  // tools do próprio modo
    const normalTools = loadModeTools("normal"); // tools do modo normal
    const sharedTools = findSharedWith(modeName); // tools de outros modos marcadas
    
    // Merge: modo específico > compartilhadas > normal
    // Sobrescreve por nome (modo específico ganha)
    return mergeTools(modeTools, sharedTools, normalTools);
  }
  ```
- [ ] **F6.12** Tools padrão (já bundled) NÃO entram no compartilhamento:
  - git, npm, node, etc. são padrão em todos os modos (hardcoded)
  - Não aparecem na UI de compartilhamento
  - Sempre disponíveis
- [ ] **F6.13** Prioridade de resolução:
  1. Tool do modo ativo (específica) → prioridade máxima
  2. Tool compartilhada com o modo ativo → prioridade média
  3. Tool do modo normal (herdada) → prioridade baixa
  4. Tool padrão hardcoded → sempre disponível

##### 6.D — Regras Definitivas de Compartilhamento

> Esta seção resolve os edge cases do `sharedWith` que surgiram durante a revisão do plano. São regras definitivas — implementação deve segui-las à risca.

**Regras do sharedWith:**

1. **Tool mora em UMA pasta (modo de origem).** Binary e manifest ficam lá.
2. **`sharedWith` é opt-in** — usuário marca explicitamente quais modos recebem.
3. **Modo ativo SEMPRE ganha:** se modo roblox tem tool "darklua" própria, usa a própria (ignora compartilhada de outro modo com mesmo nome).
4. **Tool compartilhada usa manifest E binary da ORIGEM** (não copia).
5. **Deletar tool da origem:**
   - ANTES de deletar, verifica `sharedWith`
   - Se há modos compartilhados, AVISA: `"darklua é usada por roblox, devops. Remover vai afetar esses modos. Continuar? (s/n)"`
   - Se confirmar, remove de `sharedWith` de todos os modos + deleta binary
6. **Atualizar tool na origem:**
   - Todos os modos compartilhados veem a mudança (mesmo binary/manifest)
   - Se a atualização quebrar algo, afeta todos os modos (por design)
7. **Prioridade de resolução (ordem decrescente):**
   a. Tool do modo ativo (específica) — prioridade MÁXIMA
   b. Tool compartilhada com o modo ativo (de outro modo)
   c. Tool do modo normal (herdada, `isBase`)
   d. Tool padrão hardcoded (git, npm) — sempre disponível
8. **Conflito de nomes entre compartilhadas:**
   - Se 2 modos compartilham tool de mesmo nome com o modo ativo: ORDEM alfabética do modo de origem (determinístico)
   - Ex: devops compartilha "darklua" E normal compartilha "darklua"
     → devops ganha (vem antes de normal alfabeticamente)
     → MAS modo ativo própria sempre ganha de qualquer compartilhada

**Entregável:** Modo normal tem tools. Outros modos herdam + adicionam. Usuário pode marcar compartilhamento. Edge cases resolvidos.

---

#### Sprint 7: MCPs por Modo (3h)

**Objetivo:** MCP servers moram na pasta do modo, são iniciados com o modo.

**Tarefas:**
- [ ] **F7.1** Mover configs MCP:
  - `~/.claude-killer/mcp-config.json` → `~/.claude-killer/modes/<mode>/mcps/`
- [ ] **F7.2** Refatorar `loadAllExtensions()`:
  - Carrega MCPs da pasta do modo ativo + globais
- [ ] **F7.3** Atualizar `applyMode()`:
  - Inicia MCP servers do modo
- [ ] **F7.4** Atualizar `deactivateMode()`:
  - Para MCP servers do modo
- [ ] **F7.5** Criar pasta global `~/.claude-killer/mcps/` (MCPs compartilhados)

**Entregável:** Modo Roblox ativo → roblox-api MCP disponível.

---

#### Sprint 8: Hooks por Modo com Sandbox Madura (6h)

**Objetivo:** Hooks customizados rodam em eventos do agent loop, isolados em Worker Threads pra não travar/crashar o processo principal.

> **Custo:** Originalmente 4h. Expandido pra 6h (+2h) por causa da sandbox madura com Worker Threads. Ver seção 8.X abaixo.

##### 8.A — Hooks por Modo (4h)

**Tarefas:**
- [ ] **F8.1** Definir interface de hooks (TypeScript)
- [ ] **F8.2** Criar `src/hookRunner.ts`:
  - `loadHooks(modeName)` — carrega hooks da pasta
  - `runHooks(trigger, context)` — roda hooks de um trigger
- [ ] **F8.3** Integrar hooks no `fileEdit.ts`:
  - Antes de salvar: `runHooks("before_write", { filePath, content })`
  - Depois de salvar: `runHooks("on_file", { filePath, content })`
- [ ] **F8.4** Integrar hooks no `agent.ts`:
  - Após task completa: `runHooks("on_task", { toolExecutor })`
  - A cada iteração: `runHooks("always", { toolExecutor })`
- [ ] **F8.5** Criar 2 hooks de exemplo:
  - `defaults/modes/roblox/hooks/auto-build.js` (on_file)
  - `defaults/modes/roblox/hooks/validate-config.js` (on_task)

##### 8.X — Sandbox Madura para Hooks (2h)

**Problema:** Hooks rodam JavaScript arbitrário dentro do processo do claude-killer. Em Node.js, não há sandbox real sem isolamento. Riscos:
- Hook com bug pode travar o agent loop
- Vazamento de memória
- Acesso a fs global (deletar arquivos)
- Chamar `process.exit()`

**Solução:** Worker Threads com API limitada.

**Implementação:**
- Cada hook roda em uma Worker Thread separada
- Worker recebe apenas um objeto `context` com APIs permitidas:
  - `toolExecutor` (proxy que só permite `execute()`)
  - `filePath` (string)
  - `content` (string)
  - `mode` (objeto read-only)
- Worker NÃO tem acesso a:
  - `require()` irrestrito
  - `process.exit()`
  - `fs` global
  - `child_process`
  - `eval`/`Function`
- Timeout de 5s — se hook não terminar, worker é terminado
- Memória limitada (`resourceLimits: { maxOldGenerationSizeMb: 64 }`)
- Comunicação via `postMessage` (serializada, sem shared memory)

**Estrutura:**
```
hooks/
  auto-build.js     ← código do hook (roda na worker)
  auto-build.json   ← config do hook (trigger, timeout, etc.)
```

**`hookRunner.ts`:**
1. Cria Worker Thread para cada hook
2. Envia context via `postMessage`
3. Aguarda resposta (com timeout)
4. Se timeout → `worker.terminate()`, loga warning
5. Se erro → captura, loga, continua
6. Se success → retorna resultado

**API do hook (o que ele recebe):**
```javascript
const { workerData } = require('worker_threads');
// workerData = { filePath, content, mode, toolExecutorProxy }
module.exports = {
  trigger: "on_file",
  async run(context) {
    // context.toolExecutor é um proxy que só permite execute()
    // context.filePath, context.content, context.mode são read-only
    return null; // ou { blocking: true, message: "..." }
  }
};
```

**Tarefas:**
- [ ] **F8.6** Implementar sandbox com Worker Threads (seção 8.X acima):
  - Cada hook roda em Worker Thread isolada
  - `resourceLimits` com `maxOldGenerationSizeMb: 64`
  - Timeout de 5s por hook
  - `worker.terminate()` em caso de timeout
  - Proxy de `toolExecutor` que só permite `execute()`
  - Comunicação via `postMessage` (serializada)

**Entregável:** Editar .luau → auto-build roda automaticamente em sandbox isolada. Hook com bug NÃO trava o agent loop.

---

#### Sprint 9: Busca de Arquivos na Máquina (3h)

**Objetivo:** Usuário pode pedir "tenho darklua.exe em algum lugar, encontre e instale".

> Extraído do antigo Sprint 7 (sub-seção 7.B). Agora é sprint independente pois não depende do mini chat — pode ser usado via CLI ou integração futura.

**Tarefas:**
- [ ] **F9.1** Criar `src/fileFinder.ts`:
  - `searchInDefinedFolders(fileName, modeName)` — busca nas pastas padrão:
    - `~/.claude-killer/modes/<mode>/tools/`
    - `~/.claude-killer/modes/<mode>/inbox/`
    - `~/.rokit/bin/` (legacy fallback)
    - `~/.aftman/bin/` (legacy fallback)
    - `~/.cargo/bin/` (legacy fallback)
    - PATH do sistema
  - `searchEntireMachine(fileName)` — busca em tudo (com permissão):
    - Windows: `where /R C:\ darklua.exe` (por drive)
    - Unix: `find / -name darklua -type f 2>/dev/null`
    - Mostra progresso em tempo real
    - Pode ser cancelado com Esc
  - `searchWithProgress(fileName, onProgress, abortSignal)` — busca com callback
- [ ] **F9.2** Fluxo de busca (pergunta permissão):
  ```
  Usuário: "tenho darklua.exe em algum lugar, instala pra mim"
  ↓
  Configurador: "Vou procurar darklua.exe. Primeiro nas pastas padrão..."
  ↓
  Sistema: searchInDefinedFolders("darklua.exe", "roblox")
  ↓
  Se encontrar: "Achei em ~/.rokit/bin/darklua.exe! Posso copiar pra 
                 modes/roblox/tools/? (s/n)"
  ↓
  Se NÃO encontrar: "Não encontrei nas pastas padrão. Quer que eu procure
                      em toda a máquina? (pode demorar 1-5 min) (s/n)"
  ↓
  Se sim: searchEntireMachine com progresso
  ↓
  Se encontrar: "Achei em D:\Tools\darklua.exe! Copiar? (s/n)"
  Se não: "darklua.exe não encontrado em lugar nenhum. TALVEZ você 
          precise baixar de https://github.com/..."
  ```
- [ ] **F9.3** Permissões de busca:
  - Busca em pastas padrão: automática (sem perguntar)
  - Busca em toda máquina: PRECISA permissão explícita do usuário
  - Busca nunca roda automaticamente (sempre perguntada)
  - Usuário pode cancelar a qualquer momento (Esc)
- [ ] **F9.4** Resultado da busca:
  - Pode encontrar múltiplos arquivos → pergunta qual usar
  - Copia (não move) pra pasta do modo
  - Cria manifest automaticamente após copiar

**Entregável:** Sistema consegue achar binaries em qualquer lugar da máquina (com permissão) e copiar pra pasta do modo.

---

#### Sprint 10: Inbox + Organizadora (4h)

**Objetivo:** Usuário joga arquivos no inbox, IA organiza.

**Tarefas:**
- [ ] **F10.1** Criar `src/inboxOrganizer.ts`:
  - `organizeInbox(modeName)` — entry point
- [ ] **F10.2** Heurística por extensão:
  - `.exe` → tool, `.md` → skill, `.js` → hook/mcp, `.json` → manifest/config/mcp
- [ ] **F10.3** Inspeção de conteúdo:
  - `.js`: procura `module.exports.run` (hook) vs JSON-RPC (mcp)
  - `.json`: schema check (manifest vs config vs mcp)
  - `.exe`: roda `--version`/`--help`
- [ ] **F10.4** IA organizadora (casos ambíguos):
  - Usa IA configuradora pra classificar
- [ ] **F10.5** Move arquivos pros lugares certos
- [ ] **F10.6** Atualiza config.json com novos itens
- [ ] **F10.7** Comando `/organize` no App.tsx
- [ ] **F10.8** Tecla 'O' no Hub
- [ ] **F10.9** Inbox/README.md explicando uso

**Entregável:** Jogar 4 arquivos no inbox → /organize → tudo configurado.

---

#### Sprint 11: Mini Chat + IA Configuradora (10h)

**Objetivo:** Sub-agente limitado com mini chat interativo para configurar tools e criar manifests.

> Originalmente Sprint 7 (sub-seções 7.A + 7.C). A busca de arquivos (antiga 7.B) foi extraída pro Sprint 9. Este sprint foca no mini chat + configuração interativa.
>
> **Pode ser dividido** em 11a (busca+config) e 11b (mini chat) se necessário — decisão fica com quem implementa (avaliar na hora).

##### 11.A — Mini Chat de Configuração (3h)

**Objetivo:** Interface de chat dedicada pra configuração (não é só sim/não).

**Tarefas:**
- [ ] **F11.1** Criar `src/tui/ConfiguratorChat.tsx`:
  - Componente Ink que renderiza um mini chat dentro do Hub
  - Mostra mensagens do configurador + input do usuário
  - Suporta múltiplos turnos de conversa
  - Pode ser aberto via tecla 'C' no Hub OU via comando `/configurar`
- [ ] **F11.2** System prompt do configurador:
  ```
  "Você é uma IA configuradora. Sua tarefa é ajudar o usuário a configurar
  tools, skills, hooks e MCPs para o modo ativo.
  
  Você PODE:
  - Rodar comandos pra entender tools (--help, --version)
  - Pesquisar na web pra achar documentação
  - Criar arquivos .json (manifests, configs)
  - Buscar arquivos na máquina do usuário (com permissão)
  - Mover/copiar arquivos entre pastas do modo
  - Fazer perguntas ao usuário quando incerta
  
  Você NÃO PODE:
  - Editar código fonte do projeto
  - Deletar arquivos do usuário
  - Rodar comandos arbitrários (só --help, --version, where, find)
  - Acessar arquivos fora das pastas do claude-killer
  
  Sempre explique o que está fazendo antes de fazer."
  ```
- [ ] **F11.3** Tools do configurador (limitadas):
  - `executar_comando` (só --help, --version, where, find, ls)
  - `pesquisar` (web search)
  - `criar_arquivo` (só em modes/<mode>/)
  - `buscar_arquivo` (procura arquivo na máquina — vê Sprint 9)
  - `mover_arquivo` (só entre pastas do modo)
  - `perguntar_usuario` (faz pergunta no mini chat — vê Sprint 1)
- [ ] **F11.4** Render do mini chat no Hub:
  - Painel dedicado quando configurador ativo
  - Mostra histórico de mensagens
  - Input field pra usuário responder
  - Botões: [Enter] enviar, [Esc] cancelar configuração

##### 11.B — Configuração Interativa via Chat (4h)

**Objetivo:** Usuário conversa com configurador pra configurar tudo.

**Tarefas:**
- [ ] **F11.5** Criar `src/toolConfigurator.ts`:
  - `startConfigurationSession(modeName)` — inicia mini chat
  - Usa `runAgentLoop` com tools limitadas + system prompt do configurador
  - Session persiste até usuário cancelar (Esc) ou configurador terminar
- [ ] **F11.6** Fluxo de configuração de tool desconhecida:
  ```
  Hub detecta: darklua.exe sem manifest
  ↓
  Hub mostra: "darklua.exe encontrado sem config. [C]onfigurar?"
  ↓
  Usuário pressiona 'C' → abre mini chat
  ↓
  Configurador: "Vou configurar darklua. Primeiro, deixa eu entender 
                 o que ela faz..."
  Configurador: [roda darklua --help]
  Configurador: "Ok, darklua é um minifier/transformer pra Luau. 
                 Tem 3 comandos: process, transform, minify.
                 Quer que eu crie o manifest? (s/n)"
  Usuário: "sim"
  Configurador: [cria manifests/darklua.json]
  Configurador: "Manifest criado! darklua agora aparece como 
                 darklua_process, darklua_transform, darklua_minify 
                 pra IA. Quer testar? (s/n)"
  Usuário: "não"
  Configurador: "Tudo certo! darklua configurada."
  ↓
  Mini chat fecha, Hub atualiza, card mostra [OK]
  ```
- [ ] **F11.7** Fluxo de busca + instalação via chat:
  ```
  Usuário: "tenho uma tool chamada my-linter em algum lugar"
  ↓
  Configurador: "Vou procurar my-linter. Primeiro nas pastas padrão..."
  Configurador: [searchInDefinedFolders]
  Configurador: "Não encontrei nas pastas padrão. Quer que eu procure 
                 em toda a máquina? (s/n)"
  Usuário: "sim"
  ↓
  Configurador: [searchEntireMachine com progresso]
  Configurador: "Achei em C:\Users\kryst\Downloads\my-linter.exe! 
                 Copiar pra modes/roblox/tools/? (s/n)"
  Usuário: "sim"
  ↓
  Configurador: [copia + roda --help + cria manifest]
  Configurador: "my-linter instalada e configurada! 
                 Aparece como my_linter_lint pra IA."
  ```
- [ ] **F11.8** Schema validation do manifest criado:
  - Valida JSON contra schema
  - Se inválido, configurador corrige automaticamente (loop)
- [ ] **F11.9** Múltiplas configurações na mesma session:
  - Usuário pode configurar várias tools na mesma conversa
  - "agora configura selene também"
  - "tem mais uma tool chamada X"
  - Session só termina quando usuário diz "pronto" ou Esc

##### 11.C — Integração com Sprints Anteriores (3h)

**Objetivo:** Integrar mini chat com busca de arquivos (Sprint 9) e AskUser (Sprint 1).

**Tarefas:**
- [ ] **F11.10** Integrar `buscar_arquivo` tool (do Sprint 9) no configurador
- [ ] **F11.11** Integrar `perguntar_usuario` tool (do Sprint 1) no configurador
- [ ] **F11.12** Testar fluxo completo: mini chat → busca → instala → configura → usa

**Entregável:** Abrir mini chat → conversar com IA → tools configuradas automaticamente.

---

### FASE 3 — Robustez

#### Sprint 12: Schema Validation + Tests Completos (11h)

**Objetivo:** Schema rigoroso do config.json + cobertura completa do novo sistema com testes unitários, de integração, property-based e E2E.

> **Filosofia:** Cada sprint anterior produz código novo. Este sprint valida o schema do config E testa TUDO — não só o novo, mas também as integrações entre módulos. Usar a mesma estratégia que funcionou nas sessões anteriores: testes unitários + extended (edge cases) + property-based + integração cross-module + E2E.

##### 12.A — Schema Validation (3h)

**Tarefas:**
- [ ] **F12.1** Definir schema JSON completo do `config.json` (TypeScript + json-schema)
- [ ] **F12.2** Validação na carga:
  - Se config inválido, modo não ativa + mensagem clara
  - Mensagem de erro indica exatamente qual campo está inválido

##### 12.B — Tests Completos (8h)

##### 12.1 — Tests do Sprint 2: Limpeza + toolDetector (1.5h)

**Arquivo:** `src/__tests__/toolDetector-modes.test.ts` (novo)

```
describe("findToolBinary (novo toolDetector)")
  ✓ retorna path quando binary existe em modes/<mode>/tools/
  ✓ retorna null quando binary não existe
  ✓ adiciona .exe no Windows
  ✓ não adiciona extensão no Linux/macOS
  ✓ lida com mode null (retorna null)
  ✓ lida com toolName vazio (retorna null)
  ✓ funciona com paths unicode no nome do modo
  ✓ funciona com tools sem extensão (unix executables)

describe("ToolRegistry com modes")
  ✓ isInstalled() verifica binary na pasta do modo
  ✓ isInstalled() retorna false se modo não ativo
  ✓ isInstalled() sem cache de 5min (sempre verifica)
  ✓ getToolStatus() retorna "missing" | "found" | "working"
  ✓ registry carrega tools do config.json do modo
  ✓ registry não carrega tools de outros modos

describe("Remoção de busca (regression)")
  ✓ ExtensionHub não tem tecla S
  ✓ ExtensionHub não tem tecla A
  ✓ ExtensionHub não tem tecla X
  ✓ ExtensionHub não tem painel de search progress
  ✓ ExtensionHub não tem painel de extreme search
  ✓ ExtensionHub não tem painel de AI search
  ✓ aiSearch.ts foi deletado
  ✓ smartSearch não existe mais em toolDetector
  ✓ extremeFilesystemSearch não existe mais
  ✓ aiOnlySearchAllTools não existe mais
```

**Arquivo:** `src/__tests__/modes-structure.test.ts` (novo)

```
describe("Estrutura de pastas do modo")
  ✓ modo roblox tem pasta tools/
  ✓ modo roblox tem pasta manifests/
  ✓ modo roblox tem pasta skills/
  ✓ modo roblox tem pasta hooks/
  ✓ modo roblox tem pasta mcps/
  ✓ modo roblox tem pasta inbox/
  ✓ modo roblox tem config.json
  ✓ modo devops tem mesma estrutura
  ✓ inbox/ tem README.md explicando uso
```

##### 12.2 — Tests do Sprint 3: Manifests + Function Calls (1.5h)

**Arquivo:** `src/__tests__/manifestLoader.test.ts` (novo)

```
describe("loadToolManifest")
  ✓ carrega manifest custom (modes/<mode>/manifests/<tool>.json)
  ✓ carrega manifest bundled (defaults/modes/<mode>/manifests/<tool>.json)
  ✓ custom tem prioridade sobre bundled
  ✓ retorna null quando manifest não existe
  ✓ lança erro quando manifest é JSON inválido
  ✓ valida schema do manifest (campos obrigatórios)
  ✓ carrega actions do manifest
  ✓ carrega detection config

describe("loadAllManifests")
  ✓ carrega todos manifests do modo
  ✓ ignora manifests inválidos (log warning)
  ✓ retorna array vazio quando pasta não existe
  ✓ não carrega manifests de outro modo

describe("Schema validation do manifest")
  ✓ rejeita manifest sem "name"
  ✓ rejeita manifest sem "category"
  ✓ rejeita category inválida (não é validator/action/background)
  ✓ rejeita action sem "args"
  ✓ rejeita action sem "schema"
  ✓ aceita manifest mínimo válido
  ✓ aceita manifest com múltiplas actions
```

**Arquivo:** `src/__tests__/toolExecutor-manifests.test.ts` (novo)

```
describe("ToolExecutor com manifests")
  ✓ substitui {binary} pelo path do binary
  ✓ substitui {file} pelo arquivo temporário
  ✓ substitui {input} pelo arg da IA
  ✓ substitui {output} pelo arg da IA
  ✓ substitui {projectFile} pelo arg da IA
  ✓ substitui placeholder custom ({qualquerArg})
  ✓ usa defaults do schema quando arg não fornecido
  ✓ retorna output estruturado { ok, exitCode, stdout, stderr, duration }
  ✓ lida com binary não encontrado
  ✓ lida com timeout
  ✓ lida com exit code não-zero

describe("getExternalToolDefinitions (function calls dinâmicas)")
  ✓ gera function call por action (rojo_build, rojo_serve, etc.)
  ✓ não gera function calls para validators
  ✓ não gera function calls para backgrounds
  ✓ function call tem schema correto
  ✓ function call tem description rica
  ✓ retorna vazio quando nenhum modo ativo
  ✓ retorna vazio quando modo não tem tools
```

##### 12.3 — Tests do Sprint 5: Skills por Modo (0.5h)

**Arquivo:** `src/__tests__/skills-modes.test.ts` (novo)

```
describe("Skills por modo")
  ✓ getActiveSkills() retorna skills do modo ativo
  ✓ getActiveSkills() retorna skills globais quando modo não ativo
  ✓ skill do modo sobrescreve skill global de mesmo nome
  ✓ skills são injetadas no system prompt
  ✓ skills removidas do prompt quando modo desativado
  ✓ skills com unicode no conteúdo funcionam
  ✓ skill vazia não quebra system prompt
  ✓ múltiplas skills são concatenadas com separador
```

##### 12.4 — Tests do Sprint 8: Hooks por Modo + Sandbox (1h)

**Arquivo:** `src/__tests__/hookRunner.test.ts` (novo)

```
describe("hookRunner")
  ✓ loadHooks() carrega hooks da pasta do modo
  ✓ loadHooks() ignora hooks inválidos (sem exports.run)
  ✓ loadHooks() ignora hooks sem trigger

describe("runHooks - trigger before_write")
  ✓ roda hooks com trigger "before_write"
  ✓ hook retorna null → não modifica conteúdo
  ✓ hook retorna { modifiedContent } → sobrescreve conteúdo
  ✓ hook retorna { blocking: true } → bloqueia escrita
  ✓ hook retorna { warning } → loga warning mas escreve
  ✓ múltiplos hooks rodam em sequência
  ✓ hook que lança erro não trava o loop (caught + logged)

describe("runHooks - trigger on_file")
  ✓ roda depois de editar arquivo
  ✓ recebe { filePath, content, toolExecutor, mode }
  ✓ hook pode chamar toolExecutor.execute()

describe("runHooks - trigger on_task")
  ✓ roda após task completa (finish_reason=stop)
  ✓ recebe { toolExecutor, mode }
  ✓ hook blocking impede finish

describe("runHooks - trigger always")
  ✓ roda a cada iteração do agent loop
  ✓ não bloqueia (sempre retorna null)

describe("Hook timeout")
  ✓ hook que demora >5s é cancelado
  ✓ timeout loga warning
  ✓ timeout não trava agent loop

describe("Hook sandbox (Worker Threads)")
  ✓ hook tem acesso a toolExecutor (proxy)
  ✓ hook NÃO tem acesso a process.exit
  ✓ hook NÃO tem acesso a fs global (só via toolExecutor)
  ✓ hook NÃO tem acesso a child_process
  ✓ hook NÃO tem acesso a require irrestrito
  ✓ hook NÃO tem acesso a eval/Function
  ✓ hook roda em Worker Thread separada (memória isolada)
  ✓ hook com vazamento de memória não afeta processo principal
  ✓ resourceLimits maxOldGenerationSizeMb: 64 é respeitado
  ✓ worker.terminate() em caso de timeout mata hook imediatamente
  ✓ comunicação via postMessage (serializada, sem shared memory)
  ✓ toolExecutor proxy só permite execute() (não expõe outros métodos)
```

##### 12.5 — Tests do Sprint 7: MCPs por Modo (0.5h)

**Arquivo:** `src/__tests__/mcps-modes.test.ts` (novo)

```
describe("MCPs por modo")
  ✓ loadAllExtensions() carrega MCPs do modo ativo
  ✓ loadAllExtensions() carrega MCPs globais
  ✓ MCP do modo sobrescreve MCP global de mesmo nome
  ✓ applyMode() inicia MCP servers do modo
  ✓ deactivateMode() para MCP servers do modo
  ✓ MCP server crash não derruba o modo
  ✓ MCP tools aparecem como function calls
  ✓ MCP sem "command" é ignorado
```

##### 12.6 — Tests do Sprint 4: Validators do Config (0.5h)

**Arquivo:** `src/__tests__/validators-modes.test.ts` (novo)

```
describe("Validators do config (generalizado)")
  ✓ lê validators do config.json do modo ativo
  ✓ validator roda antes de salvar (gate)
  ✓ validator blocking impede escrita
  ✓ validator non-blocking só loga warning
  ✓ validator com filePattern *.luau só roda em .luau
  ✓ validator com filePattern *.lua só roda em .lua
  ✓ validator com filePattern *.py roda em .py (generalizado)
  ✓ validator com filePattern *.ts roda em .ts (generalizado)
  ✓ múltiplos validators rodam em sequência
  ✓ validator que falha (binary não encontrado) é pulado
  ✓ sem modo ativo → sem validators → escreve sem gate
```

##### 12.7 — Tests do Sprint 11: Mini Chat + IA Configuradora (1h)

**Arquivo:** `src/__tests__/toolConfigurator.test.ts` (novo)

```
describe("IA configuradora")
  ✓ detecta tool sem manifest
  ✓ pergunta "Configurar? (s/n)"
  ✓ se "n" → ignora tool
  ✓ se "s" → inicia sub-agente

describe("Sub-agente limitado")
  ✓ tem access a executar_comando (só --help, --version)
  ✓ tem access a pesquisar (web search)
  ✓ tem access a criar_arquivo (só pra .json)
  ✓ NÃO tem access a editar_arquivo
  ✓ NÃO tem access a aplicar_diff
  ✓ NÃO tem access a ler_arquivo no projeto
  ✓ NÃO pode rodar comandos arbitrários (só --help/--version)

describe("Criação de manifest")
  ✓ roda --help e parseia output
  ✓ roda --version e extrai versão
  ✓ pesquisa documentação se --help não é claro
  ✓ cria manifest JSON válido
  ✓ manifest tem category correto
  ✓ manifest tem actions com schema
  ✓ manifest tem detection config
  ✓ schema validation rejeita manifest inválido
  ✓ se IA erra, pede pra corrigir (loop)

describe("Hook no Hub")
  ✓ detecta tool sem manifest ao abrir Hub
  ✓ mostra "Configurar? (s/n)"
  ✓ tecla 'C' inicia configuradora
  ✓ após configurar, card mostra [OK]
```

##### 12.8 — Tests do Sprint 10: Inbox + Organizadora (1h)

**Arquivo:** `src/__tests__/inboxOrganizer.test.ts` (novo)

```
describe("Heurística por extensão")
  ✓ .exe → classificado como TOOL
  ✓ sem extensão (unix) → classificado como TOOL
  ✓ .md → classificado como SKILL
  ✓ .js → classificado como PLUGIN ou MCP (precisa inspect)
  ✓ .json → classificado como MANIFEST/CONFIG/MCP (precisa inspect)
  ✓ .zip → classificado como ARQUIVO (extrair)
  ✓ .tar.gz → classificado como ARQUIVO (extrair)
  ✓ .txt → classificado como DOCS
  ✓ extensão desconhecida → UNKNOWN

describe("Inspeção de conteúdo")
  ✓ .js com module.exports.run → PLUGIN (hook)
  ✓ .js com JSON-RPC → MCP server
  ✓ .js ambíguo → pergunta IA
  ✓ .json com "command" + "args" → MCP config
  ✓ .json com "category" + "actions" → MANIFEST
  ✓ .json com "name" + "tools" → MODE CONFIG
  ✓ .json ambíguo → pergunta IA

describe("Extração de arquivos")
  ✓ .zip é extraído e re-processado
  ✓ .tar.gz é extraído e re-processado
  ✓ arquivos extraídos são classificados
  ✓ pasta temporária é limpa após processar

describe("Move arquivos")
  ✓ tool → tools/ + cria manifest se necessário
  ✓ skill → skills/
  ✓ hook → hooks/
  ✓ mcp config → mcps/
  ✓ mcp server code → mcps/
  ✓ manifest → manifests/
  ✓ docs → pergunta (ignorar ou mover pra docs/?)
  ✓ unknown → move pra inbox/_unknown/

describe("Atualiza config.json")
  ✓ adiciona tool nova em tools.items
  ✓ adiciona skill nova em skills.items
  ✓ adiciona hook novo em hooks.items
  ✓ adiciona MCP novo em mcps.items
  ✓ não duplica itens já existentes
  ✓ valida config após atualizar

describe("Casos especiais")
  ✓ arquivo duplicado (mesmo nome) → pergunta (sobrescrever/ignorar/renomear)
  ✓ múltiplos arquivos relacionados (.exe + .json) → conecta
  ✓ inbox vazio → mensagem "inbox vazio"
  ✓ inbox não existe → cria pasta + README

describe("Comando /organize")
  ✓ /organize organiza inbox do modo ativo
  ✓ /organize <mode> organiza inbox de modo específico
  ✓ /organize sem modo ativo → erro
  ✓ mostra progresso durante organização
  ✓ mostra resumo no final

describe("Tecla 'O' no Hub")
  ✓ press O → inicia organização
  ✓ mostra progresso no painel
  ✓ após organizar, cards atualizam
```

##### 12.9 — Tests do Sprint 2: Migration (0.5h)

**Arquivo:** `src/__tests__/modeMigration.test.ts` (novo)

```
describe("Migration de config antigo")
  ✓ detecta roblox.json antigo (sem "tools" structure)
  ✓ converte pra novo formato (com tools/manifests/skills/hooks/mcps)
  ✓ preserva enableTools → tools.items
  ✓ preserva enableSkills → skills.items
  ✓ preserva luauValidation → validators
  ✓ preserva effortLevel, strictMode, readBeforeWrite
  ✓ cria backup do config antigo (.bak)
  ✓ não migra se já tá no novo formato

describe("Migration de binaries")
  ✓ detecta tools em ~/.rokit/bin/
  ✓ sugere copiar pra modes/roblox/tools/
  ✓ copia binaries quando usuário confirma
  ✓ não deleta originais (só copia)
  ✓ lida com tools que já existem na pasta do modo

describe("Migration de skills")
  ✓ move skills de defaults/skills/ pra defaults/modes/roblox/skills/
  ✓ skills globais ficam em ~/.claude-killer/skills/
  ✓ não duplica skills

describe("Migration de MCPs")
  ✓ move mcp-config.json pra modes/<mode>/mcps/
  ✓ MCPs globais ficam em ~/.claude-killer/mcps/
```

##### 12.10 — Tests de Integração E2E (1h)

**Arquivo:** `src/__tests__/integration-modes-e2e.test.ts` (novo)

```
describe("E2E: Ativar modo → usar tool → desativar")
  ✓ ativar modo roblox carrega tudo (tools, skills, hooks, mcps)
  ✓ IA vê function calls do modo (rojo_build, etc.)
  ✓ IA não vê function calls de outro modo (pytest_run)
  ✓ validators rodam automaticamente ao editar .luau
  ✓ hooks rodam em eventos (on_file, on_task)
  ✓ MCPs são iniciados com o modo
  ✓ desativar modo remove tudo (function calls, skills, hooks, mcps)
  ✓ trocar de modo descarrega anterior + carrega novo

describe("E2E: Inbox → organize → usar")
  ✓ joga darklua.exe no inbox
  ✓ /organize classifica como tool
  ✓ IA configuradora cria manifest
  ✓ darklua aparece como function call
  ✓ IA consegue chamar darklua_process()
  ✓ darklua roda e retorna output

describe("E2E: Tool sem manifest → configurar → usar")
  ✓ copia tool desconhecida pra tools/
  ✓ Hub detecta "sem manifest"
  ✓ IA configuradora cria manifest
  ✓ tool aparece como function call
  ✓ IA usa tool com args corretos

describe("E2E: Modo custom completo")
  ✓ cria modo do zero (pasta + config.json)
  ✓ adiciona tools via inbox
  ✓ adiciona skills via inbox
  ✓ adiciona hooks via inbox
  ✓ adiciona MCP via inbox
  ✓ ativa modo custom
  ✓ tudo funciona junto
  ✓ desativa modo custom
  ✓ tudo é removido

describe("E2E: Migration completo")
  ✓ usuário com config antigo (hub.json + roblox.json)
  ✓ roda migration
  ✓ tools migradas pra modes/roblox/tools/
  ✓ skills migradas pra modes/roblox/skills/
  ✓ config.json no novo formato
  ✓ backup criado
  ✓ modo roblox ativa sem erro
  ✓ IA consegue usar tools migradas
```

##### 12.11 — Property-Based Tests (1h)

**Arquivo:** `src/__tests__/property-modes.test.ts` (novo)

```
describe("Property: manifest schema")
  ✓ qualquer manifest válido → loadToolManifest não lança erro
  ✓ qualquer manifest → category é um dos 4 valores válidos
  ✓ qualquer action → args é array não-vazio
  ✓ placeholder substitution → resultado nunca tem {x} sobrando

describe("Property: inbox organizer")
  ✓ qualquer arquivo .exe → classificado como TOOL
  ✓ qualquer arquivo .md → classificado como SKILL
  ✓ organizeInbox nunca deleta arquivo original (só move)
  ✓ organizeInbox nunca modifica config.json inválido

describe("Property: hook execution")
  ✓ qualquer hook → runHooks nunca lança erro (sempre caught)
  ✓ hook com timeout → sempre cancelado em <= 6s
  ✓ múltiplos hooks → sempre rodam em ordem (FIFO)

describe("Property: mode lifecycle")
  ✓ ativar modo → sempre carrega todas tools do config
  ✓ desativar modo → sempre remove todas tools carregadas
  ✓ trocar modo → sempre descarrega anterior antes de carregar novo
  ✓ modo com config inválido → nunca ativa (sempre rejeita)
```

##### 12.12 — Snapshot Tests Visuais (0.5h)

**Arquivo:** `src/__tests__/snapshots-hub-modes.test.tsx` (novo)

```
describe("Hub visual - sem S/A/X")
  ✓ snapshot: Hub sem painel de search
  ✓ snapshot: Hub sem teclas S/A/X no help text
  ✓ snapshot: Hub com indicador de inbox (quando há arquivos)
  ✓ snapshot: Hub com "Configurar? (s/n)" (tool sem manifest)

describe("Hub visual - modos completos")
  ✓ snapshot: Hub mostra tools do modo ativo
  ✓ snapshot: Hub mostra skills do modo ativo
  ✓ snapshot: Hub mostra hooks do modo ativo
  ✓ snapshot: Hub mostra MCPs do modo ativo
  ✓ snapshot: Hub com painel de organize (tecla O)
```

##### 12.13 — Tests do Sprint 11: Mini Chat + Sprint 9: Busca de Arquivos (1.5h)

**Arquivo:** `src/__tests__/configurator-chat.test.tsx` (novo)

```
describe("Mini chat de configuração")
  ✓ abre mini chat ao pressionar 'C' no Hub
  ✓ abre mini chat via comando /configurar
  ✓ mostra mensagens do configurador
  ✓ aceita input do usuário
  ✓ múltiplos turnos de conversa
  ✓ Esc fecha mini chat
  ✓ mini chat atualiza Hub ao terminar

describe("System prompt do configurador")
  ✓ NÃO permite editar_arquivo
  ✓ NÃO permite aplicar_diff
  ✓ NÃO permite ler_arquivo no projeto
  ✓ PERMITE executar_comando (só --help, --version, where, find, ls)
  ✓ PERMITE pesquisar (web search)
  ✓ PERMITE criar_arquivo (só em modes/<mode>/)
  ✓ PERMITE buscar_arquivo
  ✓ PERMITE mover_arquivo (só entre pastas do modo)
  ✓ PERMITE perguntar_usuario
  ✓ rejeita comando não whitelistado (ex: rm -rf)

describe("Múltiplas configurações na mesma session")
  ✓ configura tool A → pede pra configurar tool B → configura tool B
  ✓ "agora configura selene também" → configura selene
  ✓ "tem mais uma tool chamada X" → busca e configura X
  ✓ session só termina com "pronto" ou Esc
```

**Arquivo:** `src/__tests__/fileFinder.test.ts` (novo)

```
describe("searchInDefinedFolders")
  ✓ encontra arquivo em modes/<mode>/tools/
  ✓ encontra arquivo em modes/<mode>/inbox/
  ✓ encontra arquivo em ~/.rokit/bin/ (legacy fallback)
  ✓ encontra arquivo em ~/.aftman/bin/ (legacy fallback)
  ✓ encontra arquivo em ~/.cargo/bin/ (legacy fallback)
  ✓ encontra arquivo no PATH do sistema
  ✓ retorna null quando não encontra
  ✓ retorna múltiplos resultados quando há duplicatas
  ✓ adiciona .exe no Windows ao procurar
  ✓ não adiciona extensão no Unix

describe("searchEntireMachine")
  ✓ busca em todas as unidades (Windows: C:\, D:\, etc.)
  ✓ busca em / (Unix)
  ✓ mostra progresso em tempo real
  ✓ pode ser cancelado com Esc (abortSignal)
  ✓ retorna null quando não encontra
  ✓ retorna primeiro resultado encontrado
  ✓ NÃO roda automaticamente (sempre pede permissão)

describe("Fluxo de busca com permissão")
  ✓ busca em pastas padrão: automática (sem perguntar)
  ✓ se não encontra nas padrão → pergunta "buscar em toda máquina?"
  ✓ se usuário diz não → retorna null
  ✓ se usuário diz sim → busca em toda máquina com progresso
  ✓ se encontra → pergunta "copiar? (s/n)"
  ✓ se usuário diz sim → copia pra pasta do modo
  ✓ se usuário diz não → não copia, retorna info
  ✓ múltiplos resultados → pergunta qual usar
  ✓ busca cancelada (Esc) → para graceful, sem erro

describe("Cópia de arquivo encontrado")
  ✓ copia (não move) pra pasta do modo
  ✓ não deleta original
  ✓ cria manifest automaticamente após copiar
  ✓ se arquivo já existe na pasta → pergunta sobrescrever/ignorar
  ✓ lida com erro de permissão gracefully
```

##### 12.14 — Tests do Sprint 6: Modo Normal + Compartilhamento (1.5h)

**Arquivo:** `src/__tests__/mode-normal.test.ts` (novo)

```
describe("Modo normal")
  ✓ modo normal existe em defaults/modes/normal/
  ✓ modo normal tem config.json com isBase: true
  ✓ modo normal tem estrutura de pastas completa
  ✓ getActiveMode() retorna normal quando nenhum modo ativo
  ✓ tools do modo normal ficam disponíveis sem modo ativo
  ✓ skills do modo normal ficam disponíveis sem modo ativo
  ✓ modo normal não tem validators (não bloqueia escrita)
  ✓ modo normal não tem hooks

describe("Herança do modo normal")
  ✓ modo roblox herda tools do normal
  ✓ modo python herda tools do normal
  ✓ modo devops herda tools do normal
  ✓ tool do modo específico sobrescreve tool do normal (mesmo nome)
  ✓ skills do normal são injetadas junto com skills do modo ativo
  ✓ desativar modo específico → volta pra normal (herdadas continuam)

describe("Prioridade de resolução")
  ✓ tool do modo ativo > tool compartilhada > tool do normal > tool padrão
  ✓ tool do modo ativo sempre ganha (mesmo nome)
  ✓ tool padrão (git, npm) sempre disponível
  ✓ tool padrão não aparece na UI de compartilhamento
```

**Arquivo:** `src/__tests__/tool-sharing.test.ts` (novo)

```
describe("sharedWith no manifest")
  ✓ manifest com sharedWith: ["roblox"] → visível no modo roblox
  ✓ manifest sem sharedWith → só visível no modo de origem
  ✓ manifest com sharedWith: ["roblox", "devops"] → visível nos 2
  ✓ manifest com sharedWith: [] → só origem (igual sem campo)
  ✓ tool compartilhada usa binary da pasta de origem (não duplica)
  ✓ tool compartilhada usa manifest da pasta de origem

describe("UI de compartilhamento (tecla X no Hub)")
  ✓ press X → abre painel de compartilhamento da tool selecionada
  ✓ painel mostra todos os modos com checkboxes
  ✓ modo de origem marcado e desabilitado (não pode descompartilhar origem)
  ✓ marcar modo → adiciona em sharedWith
  ✓ desmarcar modo → remove de sharedWith
  ✓ Enter salva mudanças
  ✓ Esc cancela (não salva)

describe("Comando /compartilhar")
  ✓ /compartilhar darklua roblox → adiciona roblox em sharedWith
  ✓ /compartilhar darklua roblox devops → adiciona os 2
  ✓ /compartilhar darklua --todos → compartilha com todos os modos
  ✓ /compartilhar darklua (sem modo) → erro: "especifique modo"
  ✓ /compartilhar darklua modo_inexistente → erro: "modo não existe"
  ✓ /compartilhar tool_inexistente roblox → erro: "tool não existe"

describe("Comando /descompartilhar")
  ✓ /descompartilhar darklua roblox → remove roblox de sharedWith
  ✓ /descompartilhar darklua modo_não_compartilhado → aviso: "já não compartilhava"
  ✓ /descompartilhar darklua (sem modo) → erro: "especifique modo"

describe("Lógica de merge (getVisibleTools)")
  ✓ modo roblox: vê tools próprias + compartilhadas com roblox + herdadas do normal
  ✓ tool com mesmo nome: modo específico ganha sobre compartilhada
  ✓ tool com mesmo nome: compartilhada ganha sobre herdada do normal
  ✓ tool padrão (git) sempre visível (não entra no merge)
  ✓ sem modo ativo: vê tools do normal + compartilhadas com normal
  ✓ mudar de modo → recarrega tools visíveis

describe("Regras definitivas de compartilhamento (edge cases)")
  ✓ tool mora em UMA pasta (binary + manifest na origem)
  ✓ sharedWith é opt-in (default: só origem)
  ✓ modo ativo sempre ganha sobre compartilhada de mesmo nome
  ✓ tool compartilhada usa manifest E binary da origem (não copia)
  ✓ deletar tool da origem com sharedWith → AVISA antes
  ✓ confirmar delete → remove de sharedWith de todos + deleta binary
  ✓ cancelar delete → nada acontece
  ✓ atualizar tool na origem → afeta todos os modos compartilhados
  ✓ prioridade: ativo > compartilhada > normal (isBase) > padrão hardcoded
  ✓ conflito de nomes entre compartilhadas → ordem alfabética da origem
  ✓ modo ativo própria sempre ganha de qualquer compartilhada

describe("Casos edge de compartilhamento")
  ✓ compartilhar com modo que já tem tool de mesmo nome → modo específico ganha
  ✓ tool compartilhada deletada da origem → some de todos os modos compartilhados
  ✓ tool compartilhada atualizada na origem → atualiza em todos os modos
  ✓ compartilhar com modo normal → tool fica disponível globalmente
  ✓ compartilhar com todos os modos → tool aparece em qualquer modo ativo
```

##### 12.15 — Tests do Sprint 1: Sistema de Perguntas (AskUser) (1.5h)

**Arquivo:** `src/__tests__/askUser.test.tsx` (novo)

```
describe("Tool perguntar_usuario")
  ✓ tool está disponível no chat normal
  ✓ tool está disponível no configurador
  ✓ tool NÃO está disponível em sub-agentes (allowUserQuestions: false)
  ✓ tool disponível em sub-agente quando allowUserQuestions: true
  ✓ schema requer "pergunta" (string)
  ✓ schema requer "alternativas" (array min 2, max 6)
  ✓ schema tem "contexto" opcional
  ✓ IA sem permissão recebe erro ao tentar usar

describe("UI de pergunta (QuestionPrompt)")
  ✓ renderiza pergunta + alternativas numeradas
  ✓ mostra contexto quando fornecido
  ✓ setas ↑↓ navegam entre alternativas
  ✓ números 1-6 selecionam alternativa diretamente
  ✓ Enter confirma alternativa selecionada
  ✓ Tab alterna entre "escolher alternativa" e "digitar resposta"
  ✓ modo "digitar resposta" aceita texto livre
  ✓ Esc cancela pergunta → retorna cancelled: true
  ✓ alternativa selecionada destacada visualmente
  ✓ mais de 6 alternativas → erro (maxItems)

describe("Integração com agent loop")
  ✓ agent loop PARA quando perguntar_usuario é chamada
  ✓ agent loop CONTINUA após usuário responder
  ✓ resposta do usuário é retornada como tool result
  ✓ resposta de alternativa → resultStr = "[RESPOSTA] <alternativa>"
  ✓ resposta livre → resultStr = "[RESPOSTA] <texto digitado>"
  ✓ cancelamento → resultStr = "[USUÁRIO CANCELOU]"
  ✓ IA recebe resposta e continua trabalhando
  ✓ múltiplas perguntas na mesma conversa funcionam
  ✓ pergunta aparece no histórico do chat
  ✓ resposta aparece no histórico do chat

describe("Estado de aguardando resposta")
  ✓ App entra em modo "aguardando" quando IA pergunta
  ✓ input normal do chat fica desabilitado
  ✓ status bar mostra "Aguardando resposta..."
  ✓ Hub não abre durante aguardando (Ctrl+E ignorado)
  ✓ após resposta, App volta ao normal

describe("Disponibilidade seletiva")
  ✓ chat principal: allowUserQuestions = true
  ✓ configurador: allowUserQuestions = true
  ✓ sub-agente default: allowUserQuestions = false
  ✓ sub-agente com flag true: pode perguntar
  ✓ sub-agente com flag false: recebe erro
  ✓ tentativa sem permissão não trava agent loop

describe("Casos edge")
  ✓ pergunta com alternativas vazias → erro de schema
  ✓ pergunta com 1 alternativa → erro (minItems 2)
  ✓ pergunta com 7 alternativas → erro (maxItems 6)
  ✓ pergunta muito longa (>500 chars) → truncada ou erro
  ✓ usuário digita número inválido (ex: 9) → ignora, espera válido
  ✓ usuário digita texto em modo "escolher alternativa" → muda pra "digitar"
  ✓ IA pergunta durante streaming → pausa stream, mostra pergunta
  ✓ IA pergunta após tool call → pergunta aparece após resultado do tool
```

**Arquivo:** `src/__tests__/integration-askUser.test.ts` (novo)

```
describe("E2E: IA pergunta quando não entende")
  ✓ usuário: "faz uma interface"
  ✓ IA: pergunta "Qual framework?" com alternativas [React, Vue, Svelte, HTML puro]
  ✓ usuário: "1" (React)
  ✓ IA: continua e cria interface em React

describe("E2E: IA pergunta pra confirmar decisão importante")
  ✓ usuário: "deleta todos os arquivos .log"
  ✓ IA: pergunta "Tem certeza? Vou deletar 47 arquivos .log. Confirmar?" 
        com alternativas [Sim, deletar todos, Não, cancelar, Só os do diretório atual]
  ✓ usuário: "Sim, deletar todos"
  ✓ IA: deleta arquivos

describe("E2E: Usuário digita resposta livre")
  ✓ IA pergunta: "Qual porta pro servidor?" [3000, 8080, 34872]
  ✓ usuário digita: "12345" (não é alternativa)
  ✓ IA: usa porta 12345

describe("E2E: Usuário cancela pergunta")
  ✓ IA pergunta algo
  ✓ usuário pressiona Esc
  ✓ IA: "Ok, vou prosseguir sem essa informação" ou para

describe("E2E: Múltiplas perguntas em sequência")
  ✓ IA pergunta 1 → usuário responde → IA pergunta 2 → usuário responde
  ✓ histórico mostra ambas perguntas + respostas
  ✓ IA usa ambas respostas no trabalho final

describe("E2E: Configurador usa perguntar_usuario")
  ✓ configurador: "darklua.exe encontrado. Configurar?" [Sim, Não, Mais info]
  ✓ usuário: "Mais info"
  ✓ configurador: explica o que darklua faz
  ✓ configurador: pergunta "Agora quer configurar?" [Sim, Não]
  ✓ usuário: "Sim"
  ✓ configurador: cria manifest
```

##### 12.16 — Tests E2E Adicionais: Configurador + Compartilhamento (1h)

**Arquivo:** `src/__tests__/integration-configurator-sharing.test.ts` (novo)

```
describe("E2E: Mini chat → buscar → instalar → configurar → usar")
  ✓ abre mini chat (/configurar)
  ✓ usuário: "tenho darklua em algum lugar"
  ✓ configurador busca nas pastas padrão → não encontra
  ✓ configurador pede permissão pra buscar máquina toda
  ✓ usuário: "sim"
  ✓ configurador busca com progresso → encontra em Downloads
  ✓ configurador pergunta "copiar?"
  ✓ usuário: "sim"
  ✓ configurador copia + roda --help + cria manifest
  ✓ configurador: "darklua configurada!"
  ✓ mini chat fecha
  ✓ darklua aparece como function call no modo ativo
  ✓ IA consegue chamar darklua_process()

describe("E2E: Compartilhar tool entre modos")
  ✓ modo normal tem darklua configurada
  ✓ /compartilhar darklua roblox
  ✓ ativa modo roblox
  ✓ darklua aparece como function call no modo roblox
  ✓ darklua usa binary da pasta do normal (não duplicou)
  ✓ /descompartilhar darklua roblox
  ✓ darklua some do modo roblox
  ✓ darklua continua no modo normal

describe("E2E: Modo normal base")
  ✓ sem modo ativo → modo normal carregado
  ✓ tool git do normal disponível
  ✓ ativa modo roblox → herda git do normal + adiciona rojo
  ✓ desativa roblox → volta pra normal, git continua disponível
  ✓ tool do roblox (rojo) SOME ao desativar
  ✓ tool do normal (git) CONTINUA ao desativar

describe("E2E: Configurar via chat e compartilhar")
  ✓ abre mini chat no modo normal
  ✓ configura darklua no modo normal
  ✓ /compartilhar darklua roblox
  ✓ /compartilhar darklua devops
  ✓ ativa roblox → darklua visível
  ✓ ativa devops → darklua visível
  ✓ ativa python → darklua NÃO visível (não compartilhada)
```

##### Resumo de testes do Sprint 12 (atualizado)

| Categoria | Arquivos | Testes (estimado) |
|---|---|---|
| Unitários (Sprint 2) | 2 | ~30 |
| Manifests + Function calls (Sprint 3) | 2 | ~35 |
| Skills por modo (Sprint 5) | 1 | ~10 |
| Hooks por modo + Sandbox (Sprint 8) | 1 | ~35 |
| MCPs por modo (Sprint 7) | 1 | ~10 |
| Validators do config (Sprint 4) | 1 | ~12 |
| Mini chat + IA configuradora (Sprint 11) | 1 | ~30 |
| Busca de arquivos (Sprint 9) | 1 | ~25 |
| Inbox organizadora (Sprint 10) | 1 | ~30 |
| Modo normal + compartilhamento (Sprint 6) | 2 | ~45 |
| **Sistema de perguntas AskUser (Sprint 1)** | **2** | **~40** |
| Migration (Sprint 2) | 1 | ~15 |
| Integração E2E | 1 | ~25 |
| E2E configurador + compartilhamento | 1 | ~20 |
| Property-based | 1 | ~12 |
| Snapshot visual | 1 | ~8 |
| **Total** | **21 arquivos** | **~382 testes** |

**Meta:** Cobertura >= 80% do novo código. 0 regressões nos testes existentes.

---

## Arquivos a serem criados

```
src/
├── toolConfigurator.ts      ← Sprint 11
├── inboxOrganizer.ts        ← Sprint 10
├── manifestLoader.ts        ← Sprint 3
├── hookRunner.ts            ← Sprint 8
├── modeMigration.ts         ← Sprint 2
├── fileFinder.ts            ← Sprint 9
└── tui/
    ├── QuestionPrompt.tsx   ← Sprint 1
    └── ConfiguratorChat.tsx ← Sprint 11

defaults/modes/roblox/
├── config.json              ← Sprint 2
├── inbox/README.md          ← Sprint 10
├── manifests/
│   ├── rojo.json            ← Sprint 3
│   ├── selene.json
│   ├── stylua.json
│   ├── wally.json
│   ├── lune.json
│   └── rokit.json
├── skills/                  ← Sprint 5 (mover de defaults/skills/)
│   ├── rojo-cli.md
│   ├── wally-cli.md
│   └── ...
├── hooks/                   ← Sprint 8
│   ├── auto-build.js
│   └── validate-config.js
└── mcps/                    ← Sprint 7 (vazio inicialmente)

defaults/modes/normal/       ← Sprint 6
├── config.json
├── tools/
├── manifests/
├── skills/
├── hooks/
├── mcps/
└── inbox/
```

## Arquivos a serem removidos

```
src/
├── aiSearch.ts              ← Sprint 2
└── (funções de busca do toolDetector.ts)

defaults/
├── tools/                   ← Sprint 2 (conteúdo movido pra modes/roblox/manifests/)
└── skills/                  ← Sprint 5 (conteúdo movido pra modes/roblox/skills/)

src/__tests__/
├── aiSearch.test.ts
├── aiSearch-extended.test.ts
├── hub-manual-search.test.tsx
└── (partes de toolDetector-extended.test.ts)
```

## Arquivos a serem modificados

```
src/
├── toolDetector.ts          ← Sprint 2 (remover busca, deixar só detectTool)
├── externalTools.ts         ← Sprint 2 (lê tools da pasta do modo)
├── agent.ts                 ← Sprint 1 (perguntar_usuario) + Sprint 3 (function calls dinâmicas) + Sprint 8 (hooks)
├── luauValidator.ts         ← Sprint 4 (lê validators do config)
├── fileEdit.ts              ← Sprint 4 (validators) + Sprint 8 (hooks)
├── modes.ts                 ← Sprint 2 (applyMode carrega tudo)
├── extensions.ts            ← Sprint 7 (MCPs por modo)
├── tui/ExtensionHub.tsx     ← Sprint 2 (remove S/A/X) + Sprint 11 (configuradora)
└── tui/App.tsx              ← Sprint 10 (/organize command) + Sprint 1 (perguntar_usuario UI)
```

---

## Riscos e mitigações

### Risco 1: Usuários existentes com tools em ~/.rokit/bin/
**Mitigação:** Sprint 2 inclui migration automático que sugere copiar binaries.

### Risco 2: IA configuradora pode errar manifest
**Mitigação:** Schema validation (Sprint 12) + usuário pode editar .json na mão.

### Risco 3: Hooks podem travar agent loop
**Mitigação:** Sandbox madura com Worker Threads (Sprint 8) — timeout de 5s, `worker.terminate()`, memória isolada. Se travar, loga e continua.

### Risco 4: Perde conveniência do auto-detect
**Mitigação:** Inbox + IA organizadora (Sprint 10) compensa — UX melhor que auto-detect.

### Risco 5: Migration quebra config de usuários
**Mitigação:** Backup automático antes de migrar (Sprint 2). Modo só ativa se config válido (Sprint 12).

### Risco 6: Hook com bug/vazamento de memória crasha processo
**Mitigação:** Worker Threads isolam (Sprint 8). `resourceLimits: { maxOldGenerationSizeMb: 64 }`. Worker com problema é terminada sem afetar processo principal.

### Risco 7: Conflito de nomes entre tools compartilhadas
**Mitigação:** Regras definitivas de compartilhamento (Sprint 6) — ordem alfabética da origem é determinística. Modo ativo sempre ganha.

---

## Decisões finais

1. **AskUser primeiro (Sprint 1)** — independente do sistema de modos, alto impacto individual
2. **Limpeza + Migration juntos (Sprint 2)** — não dá pra mudar estrutura sem migrar
3. **Hooks com sandbox madura (Sprint 8)** — Worker Threads essenciais pra segurança
4. **Inbox + organizadora (Sprint 10)** — UX zero-friction
5. **IA configuradora (Sprint 11)** — tools novas sem trabalho manual
6. **Migration automático (Sprint 2)** — usuários existentes não quebram
7. **Globals + específico** — skills/MCPs podem ser globais OU por modo
8. **Regras definitivas de compartilhamento (Sprint 6)** — edge cases resolvidos

---

## Observações e Decisões

### Por que AskUser primeiro?
- É independente do sistema de modos (não precisa de pastas, manifests, etc.)
- Reduz erros desde cedo no chat normal
- É a feature de maior impacto individual
- Pode ser implementada e testada isoladamente

### Por que Migration junto com Limpeza?
- Não dá pra mudar a estrutura de pastas sem migrar o que existe
- Separar deixaria usuários quebrados entre Sprint 1 e Sprint 9
- Migration é parte integral da mudança de estrutura

### Por que Hooks com Sandbox Madura?
- Hooks rodam código arbitrário (JavaScript)
- Sem sandbox, hook com bug pode travar/crashar o claude-killer
- Worker Threads isolam: memória separada, timeout, APIs limitadas
- Custo: +2h de implementação (4h → 6h), mas segurança essencial

### Por que Mini Chat pode ser dividido?
- São 3 features complexas juntas: UI interativa + busca + configuração
- Se a primeira (busca de arquivos) já for útil sozinha, fazer commit
- Mini chat e configuração interativa podem vir depois
- Decisão fica com quem implementa (avaliar na hora)

### Sobre custo de API da IA Configuradora
- Cada configuração faz 5-10 chamadas de API
- Configurar 10 tools = 50-100 chamadas (~$0.50)
- Adicionar warning antes de começar: "Isso pode custar ~$X. Continuar?"
- É a forma mais rápida e eficiente do sistema funcionar

### Sobre pausa do agent loop no AskUser
- `perguntar_usuario` é uma tool call
- O agent loop naturalmente pausa entre tool calls (await resultado)
- Não precisa de mecanismo especial de pausa
- Só fazer `await waitForUserResponse()` no handler da tool

---

## Próximos passos

1. Revisar este plano
2. Confirmar scope (12 sprints em 3 fases, ~64h)
3. Começar Sprint 1 (AskUser — sistema de perguntas interativas)
4. Testar após cada sprint
5. Ajustar plano conforme necessário

---

## Histórico de mudanças

- **2026-06-19:** Versão inicial (8 sprints, 33h)
- **2026-06-19:** Adicionado hooks (Sprint 4) → 10 sprints, 37h
- **2026-06-19:** Adicionado inbox + organizadora (Sprint 8) → mantido 37h com hooks
- **2026-06-19:** Sprint 10 expandido com testes detalhados (3h → 8h, ~232 testes em 14 arquivos) → total 42h
- **2026-06-19:** Sprint 7 expandido com mini chat + busca de arquivos na máquina (6h → 10h)
- **2026-06-19:** Sprint 8.5 novo: modo normal + compartilhamento entre modos (5h)
- **2026-06-19:** Sprint 10 expandido com testes das novidades (+5 arquivos, +65 testes) → total 19 arquivos, ~297 testes
- **2026-06-19:** Sprint 8.6 novo: sistema de perguntas interativas AskUser (7h) — IA pergunta, agent pausa, usuário responde
- **2026-06-19:** Sprint 10 expandido com testes do AskUser (+2 arquivos, +50 testes) → total 21 arquivos, ~347 testes
- **2026-06-20:** Reordenação de sprints (AskUser primeiro, migration com limpeza), sandbox madura para hooks detalhada (worker threads), edge cases do sharedWith resolvidos, dividido em 3 fases. Total mantido em ~64h.
- **Total atual:** ~64h, 12 sprints em 3 fases, ~382 testes
