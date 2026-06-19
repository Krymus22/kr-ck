# Plano de Refatoração: Modos Completos + Tools Declarativas + Inbox

> **Criado em:** 2026-06-19
> **Status:** Aprovado (com hooks incluídos)
> **Estimativa total:** ~37h (8 sprints)

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

### Sprint 1: Limpeza + Estrutura + Tools (10h)

**Objetivo:** Remover sistema antigo de busca, criar estrutura de pastas, toolDetector simples.

**Tarefas:**
- [ ] **F1.1** Remover `src/aiSearch.ts` (~250 linhas)
- [ ] **F1.2** Remover funções de busca do `src/toolDetector.ts`:
  - `smartSearch()`, `findToolchainConfig()`, `getRegistryPathDirs()`
  - `queryPackageManagers()`, `extremeFilesystemSearch()`
  - `deepFilesystemSearch()`, `extremeSearchAllTools()`, `aiOnlySearchAllTools()`
  - `searchAllTools()` (versão antiga)
  - Manter só `detectTool()` (sem busca profunda) e `getModeToolNames()`
- [ ] **F1.3** Remover do `ExtensionHub.tsx`:
  - Estados: `searching`, `extremeSearching`, `aiSearching` + progress
  - Funções: `triggerToolSearch()`, `triggerExtremeSearch()`, `triggerAiSearch()`
  - Keybinds: S, A, X
  - Painéis de busca
- [ ] **F1.4** Criar estrutura de pastas:
  - `defaults/modes/roblox/{tools,manifests,skills,hooks,mcps,inbox}/`
  - `defaults/modes/devops/{tools,manifests,skills,hooks,mcps,inbox}/`
- [ ] **F1.5** Refatorar `toolDetector.ts`:
  - Nova função `findToolBinary(toolName, modeName)` — olha só em `modes/<mode>/tools/`
  - 5 linhas em vez de 1500
- [ ] **F1.6** Atualizar `externalTools.ts`:
  - `ToolRegistry` lê tools da pasta do modo ativo
  - `isInstalled()` verifica se binary existe (sem cache de 5min)
- [ ] **F1.7** Migrar binaries existentes (opcional, migration tool):
  - Script que copia `~/.rokit/bin/*.exe` → `~/.claude-killer/modes/roblox/tools/`
- [ ] **F1.8** Deletar testes antigos de busca:
  - `hub-manual-search.test.tsx`
  - `hub-e2e.test.tsx` ( partes de search)
  - `toolDetector-extended.test.ts` (partes de search)
  - `aiSearch.test.ts`, `aiSearch-extended.test.ts`
  - `tool-detection-hub.test.tsx`

**Entregável:** Hub sem S/A/X, tools sendo detectadas só na pasta do modo.

---

### Sprint 2: Manifests + Function Calls Dinâmicas (6h)

**Objetivo:** Tools viram function calls específicas baseadas em manifests.

**Tarefas:**
- [ ] **F2.1** Definir schema do manifest (TypeScript interface)
- [ ] **F2.2** Criar manifests pré-feitos:
  - `defaults/modes/roblox/manifests/rojo.json`
  - `defaults/modes/roblox/manifests/selene.json`
  - `defaults/modes/roblox/manifests/stylua.json`
  - `defaults/modes/roblox/manifests/wally.json`
  - `defaults/modes/roblox/manifests/lune.json`
  - `defaults/modes/roblox/manifests/rokit.json`
- [ ] **F2.3** Criar `src/manifestLoader.ts`:
  - `loadToolManifest(toolName, modeName)` — lê custom ou bundled
  - `loadAllManifests(modeName)` — carrega todos do modo
- [ ] **F2.4** Refatorar `getExternalToolDefinitions()` em `agent.ts`:
  - Em vez de `executar_tool` genérico, gera function calls dos manifests
  - Cada action vira 1 function call (ex: `rojo_build`, `rojo_serve`)
- [ ] **F2.5** Refatorar handler de tool calls em `agent.ts`:
  - Despachar `${toolName}_${actionName}` → `toolExecutor.execute(toolName, actionName, args)`
- [ ] **F2.6** Refatorar `ToolExecutor.execute()`:
  - Lê manifest, substitui placeholders nos args
  - Spawn com args corretos
  - Retorna output estruturado

**Entregável:** IA vê `rojo_build({projectFile, outputPath})` em vez de `executar_tool({tool: "rojo_build"})`.

---

### Sprint 3: Skills por Modo (3h)

**Objetivo:** Skills moram na pasta do modo, são injetadas no system prompt.

**Tarefas:**
- [ ] **F3.1** Mover skills existentes:
  - `defaults/skills/*-cli.md` → `defaults/modes/roblox/skills/`
- [ ] **F3.2** Refatorar `getActiveSkills()`:
  - Lê skills da pasta do modo ativo + globais
  - Modo específico > global
- [ ] **F3.3** Atualizar `applyMode()`:
  - Carrega skills e injeta no system prompt
- [ ] **F3.4** Atualizar `deactivateMode()`:
  - Remove skills injetadas
- [ ] **F3.5** Criar pasta global `~/.claude-killer/skills/` (skills compartilhadas)

**Entregável:** Modo Roblox ativo → skills rojo-cli, wally-cli, etc. disponíveis pra IA.

---

### Sprint 4: Hooks por Modo (4h)

**Objetivo:** Hooks customizados rodam em eventos do agent loop.

**Tarefas:**
- [ ] **F4.1** Definir interface de hooks (TypeScript)
- [ ] **F4.2** Criar `src/hookRunner.ts`:
  - `loadHooks(modeName)` — carrega hooks da pasta
  - `runHooks(trigger, context)` — roda hooks de um trigger
- [ ] **F4.3** Integrar hooks no `fileEdit.ts`:
  - Antes de salvar: `runHooks("before_write", { filePath, content })`
  - Depois de salvar: `runHooks("on_file", { filePath, content })`
- [ ] **F4.4** Integrar hooks no `agent.ts`:
  - Após task completa: `runHooks("on_task", { toolExecutor })`
  - A cada iteração: `runHooks("always", { toolExecutor })`
- [ ] **F4.5** Criar 2 hooks de exemplo:
  - `defaults/modes/roblox/hooks/auto-build.js` (on_file)
  - `defaults/modes/roblox/hooks/validate-config.js` (on_task)
- [ ] **F4.6** Sandbox de segurança (limitar APIs disponíveis pros hooks)

**Entregável:** Editar .luau → auto-build roda automaticamente.

---

### Sprint 5: MCPs por Modo (3h)

**Objetivo:** MCP servers moram na pasta do modo, são iniciados com o modo.

**Tarefas:**
- [ ] **F5.1** Mover configs MCP:
  - `~/.claude-killer/mcp-config.json` → `~/.claude-killer/modes/<mode>/mcps/`
- [ ] **F5.2** Refatorar `loadAllExtensions()`:
  - Carrega MCPs da pasta do modo ativo + globais
- [ ] **F5.3** Atualizar `applyMode()`:
  - Inicia MCP servers do modo
- [ ] **F5.4** Atualizar `deactivateMode()`:
  - Para MCP servers do modo
- [ ] **F5.5** Criar pasta global `~/.claude-killer/mcps/` (MCPs compartilhados)

**Entregável:** Modo Roblox ativo → roblox-api MCP disponível.

---

### Sprint 6: Validators por Modo (3h)

**Objetivo:** Validators (selene, stylua) rodam automáticos baseados em config.

**Tarefas:**
- [ ] **F6.1** Refatorar `luauValidator.ts`:
  - Lê validators do config.json do modo ativo (em vez de hardcoded)
  - Cada validator tem: tool, filePattern, blocking
- [ ] **F6.2** Atualizar `fileEdit.ts`:
  - `validateLuauBeforeWrite()` lê validators do config
  - Suporte a qualquer validator (não só selene/stylua)
- [ ] **F6.3** Generalizar pra outras linguagens:
  - `validateBeforeWrite()` (não só Luau)
  - Python mode → validators com black, mypy, ruff
  - TS mode → validators com tsc, eslint

**Entregável:** Adicionar validator novo = só editar config.json, sem código.

---

### Sprint 7: IA Configuradora (6h)

**Objetivo:** Sub-agente limitado que cria manifests de tools desconhecidas.

**Tarefas:**
- [ ] **F7.1** Criar `src/toolConfigurator.ts`:
  - `configureUnknownTool(toolName, modeName)` — entry point
- [ ] **F7.2** System prompt do configurador:
  - "Você é uma IA configuradora. Descubra como usar a tool X..."
  - Restrições claras: não edita código, só cria .json
- [ ] **F7.3** Tools limitadas do configurador:
  - `executar_comando` (só pra --help, --version)
  - `pesquisar` (web search)
  - `criar_arquivo` (só pra criar o manifest)
  - Sem acesso a editar_arquivo, aplicar_diff, etc.
- [ ] **F7.4** Schema validation do manifest criado:
  - Valida JSON contra schema
  - Se inválido, pede pra IA corrigir
- [ ] **F7.5** Hook no Hub: detectar tool sem manifest
  - "darklua.exe encontrado sem config. Configurar? (s/n)"
- [ ] **F7.6** Testar com tools reais (darklua, etc.)

**Entregável:** Copiar darklua.exe → IA cria manifest automaticamente.

---

### Sprint 8: Inbox + Organizadora (4h)

**Objetivo:** Usuário joga arquivos no inbox, IA organiza.

**Tarefas:**
- [ ] **F8.1** Criar `src/inboxOrganizer.ts`:
  - `organizeInbox(modeName)` — entry point
- [ ] **F8.2** Heurística por extensão:
  - `.exe` → tool, `.md` → skill, `.js` → hook/mcp, `.json` → manifest/config/mcp
- [ ] **F8.3** Inspeção de conteúdo:
  - `.js`: procura `module.exports.run` (hook) vs JSON-RPC (mcp)
  - `.json`: schema check (manifest vs config vs mcp)
  - `.exe`: roda `--version`/`--help`
- [ ] **F8.4** IA organizadora (casos ambíguos):
  - Usa IA configuradora pra classificar
- [ ] **F8.5** Move arquivos pros lugares certos
- [ ] **F8.6** Atualiza config.json com novos itens
- [ ] **F8.7** Comando `/organize` no App.tsx
- [ ] **F8.8** Tecla 'O' no Hub
- [ ] **F8.9** Inbox/README.md explicando uso

**Entregável:** Jogar 4 arquivos no inbox → /organize → tudo configurado.

---

### Sprint 9: config.json Schema + Migration (4h)

**Objetivo:** Schema rigoroso + migration de usuários existentes.

**Tarefas:**
- [ ] **F9.1** Definir schema JSON completo (TypeScript + json-schema)
- [ ] **F9.2** Validação na carga:
  - Se config inválido, modo não ativa + mensagem clara
- [ ] **F9.3** Migration automático:
  - Detecta `roblox.json` antigo → converte pra novo formato
  - Detecta tools em `~/.rokit/bin/` → sugere copiar pra `modes/roblox/tools/`
- [ ] **F9.4** Backup do config antigo antes de migrar
- [ ] **F9.5** Testar migration com configs reais

**Entregável:** Usuário existente atualiza claude-killer → migration automático.

---

### Sprint 10: Tests (3h)

**Objetivo:** Cobertura completa do novo sistema.

**Tarefas:**
- [ ] **F10.1** Tests `findToolBinary()` (vários cenários)
- [ ] **F10.2** Tests `manifestLoader` (custom + bundled + inválido)
- [ ] **F10.3** Tests `getExternalToolDefinitions()` (function calls dinâmicas)
- [ ] **F10.4** Tests `ToolExecutor` com manifests (placeholders, args)
- [ ] **F10.5** Tests hooks (4 triggers, retornos)
- [ ] **F10.6** Tests IA configuradora (mock LLM)
- [ ] **F10.7** Tests inbox organizer (todos os tipos de arquivo)
- [ ] **F10.8** Tests migration (configs antigos)
- [ ] **F10.9** Tests end-to-end: ativar modo → usar tool → desativar

**Entregável:** Cobertura >= 80% do novo código.

---

## Arquivos a serem criados

```
src/
├── toolConfigurator.ts      ← Sprint 7
├── inboxOrganizer.ts        ← Sprint 8
├── manifestLoader.ts        ← Sprint 2
├── hookRunner.ts            ← Sprint 4
└── modeMigration.ts         ← Sprint 9

defaults/modes/roblox/
├── config.json              ← Sprint 1
├── inbox/README.md          ← Sprint 8
├── manifests/
│   ├── rojo.json            ← Sprint 2
│   ├── selene.json
│   ├── stylua.json
│   ├── wally.json
│   ├── lune.json
│   └── rokit.json
├── skills/                  ← Sprint 3 (mover de defaults/skills/)
│   ├── rojo-cli.md
│   ├── wally-cli.md
│   └── ...
├── hooks/                   ← Sprint 4
│   ├── auto-build.js
│   └── validate-config.js
└── mcps/                    ← Sprint 5 (vazio inicialmente)
```

## Arquivos a serem removidos

```
src/
├── aiSearch.ts              ← Sprint 1
└── (funções de busca do toolDetector.ts)

defaults/
├── tools/                   ← Sprint 1 (conteúdo movido pra modes/roblox/manifests/)
└── skills/                  ← Sprint 3 (conteúdo movido pra modes/roblox/skills/)

src/__tests__/
├── aiSearch.test.ts
├── aiSearch-extended.test.ts
├── hub-manual-search.test.tsx
└── (partes de toolDetector-extended.test.ts)
```

## Arquivos a serem modificados

```
src/
├── toolDetector.ts          ← Sprint 1 (remover busca, deixar só detectTool)
├── externalTools.ts         ← Sprint 1 (lê tools da pasta do modo)
├── agent.ts                 ← Sprint 2 (function calls dinâmicas)
├── luauValidator.ts         ← Sprint 6 (lê validators do config)
├── fileEdit.ts              ← Sprint 4 (hooks) + Sprint 6 (validators)
├── modes.ts                 ← Sprint 1 (applyMode carrega tudo)
├── extensions.ts            ← Sprint 5 (MCPs por modo)
├── tui/ExtensionHub.tsx     ← Sprint 1 (remove S/A/X) + Sprint 7 (configuradora)
└── tui/App.tsx              ← Sprint 8 (/organize command)
```

---

## Riscos e mitigações

### Risco 1: Usuários existentes com tools em ~/.rokit/bin/
**Mitigação:** Sprint 9 inclui migration automático que sugere copiar binaries.

### Risco 2: IA configuradora pode errar manifest
**Mitigação:** Schema validation + usuário pode editar .json na mão.

### Risco 3: Hooks podem travar agent loop
**Mitigação:** Timeout em cada hook (5s default). Se travar, loga e continua.

### Risco 4: Perde conveniência do auto-detect
**Mitigação:** Inbox + IA organizadora compensa — UX melhor que auto-detect.

### Risco 5: Migration quebra config de usuários
**Mitigação:** Backup automático antes de migrar. Modo só ativa se config válido.

---

## Decisões finais

1. **Hooks incluídos desde o início** (Sprint 4) — usuário pediu pra adiantar
2. **Inbox + organizadora** (Sprint 8) — UX zero-friction
3. **IA configuradora** (Sprint 7) — tools novas sem trabalho manual
4. **Migration automático** (Sprint 9) — usuários existentes não quebram
5. **Globals + específico** — skills/MCPs podem ser globais OU por modo

---

## Próximos passos

1. Revisar este plano
2. Confirmar scope (10 sprints, ~37h)
3. Começar Sprint 1 (limpeza + estrutura + tools)
4. Testar após cada sprint
5. Ajustar plano conforme necessário

---

## Histórico de mudanças

- **2026-06-19:** Versão inicial (8 sprints, 33h)
- **2026-06-19:** Adicionado hooks (Sprint 4) → 10 sprints, 37h
- **2026-06-19:** Adicionado inbox + organizadora (Sprint 8) → mantido 37h com hooks
