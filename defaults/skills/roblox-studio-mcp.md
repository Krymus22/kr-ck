---
name: Roblox Studio MCP
version: "1.0.0"
source: official
url: https://create.roblox.com/docs/studio/mcp
category: roblox
tags: [mcp, studio, runtime, inspect, playtest]
---

# Roblox Studio MCP — Visão de Runtime do Jogo

> **Importante:** O Roblox Studio agora tem um MCP Server **nativo embutido** (sem plugin separado).
> O antigo `studio-rust-mcp-server` foi arquivado em abril de 2026 — use apenas o nativo.

## Como ativar (uma vez, no Studio)

1. Abra o **Assistant** no Roblox Studio
2. Clique em **… ⟩ Manage MCP Servers**
3. Ligue **"Enable Studio as MCP server"**
4. Pronto! O Claude-Killer detecta automaticamente.

## ⚠️ Regras de Segurança (MCP GUARD)

O Claude-Killer intercepta TODAS as chamadas MCP ao Studio. As ferramentas são classificadas:

### ✅ PERMITIDAS (Read-Only)

| Tool | O que faz |
|------|-----------|
| `script_read` | Lê script por path dot-notation (`game.ServerScriptService.MyScript`) |
| `script_search` | Busca scripts por nome (fuzzy matching, 10 resultados) |
| `script_grep` | Busca string pattern em todos os scripts (50 matches) |
| `search_game_tree` | Explora hierarquia de instâncias como JSON flat |
| `inspect_instance` | Detalhes de instância: propriedades, atributos, children |
| `explore_subagent` | Investiga o place em paralelo, retorna summary compacto |
| `list_roblox_studios` | Lista instâncias do Studio abertas (nome, ID, status) |
| `console_output` | Output logs enquanto o jogo roda |

### ✅ PERMITIDAS (Execute — com monitoramento)

| Tool | O que faz |
|------|-----------|
| `execute_luau` | Roda código Luau no Studio (retorna resultado ou erro) |
| `run_script_in_play_mode` | Roda script em play mode e para automaticamente |

> **Nota:** DataGuard já validou o código ANTES de ele chegar ao Studio (via `aplicar_diff`).
> O `execute_luau` é para **testar** código já escrito, não para introduzir código novo sem validação.

### ✅ PERMITIDAS (Playtest)

| Tool | O que faz |
|------|-----------|
| `start_stop_play` | Inicia/para playtest |
| `screen_capture` | Captura viewport em Play mode |
| `playtest_subagent` | Spawna personagem de teste que roda cenários |
| `character_navigation` | Move personagem para posição/instância |
| `keyboard_input` | Simula teclas (press, hold, text) |
| `mouse_input` | Simula mouse (click, move, scroll) |

### ✅ PERMITIDAS (Session)

| Tool | O que faz |
|------|-----------|
| `set_active_studio` | Define qual instância do Studio é a ativa |

### 🚫 BLOQUEADAS (Write — usar `aplicar_diff` em vez)

| Tool | Por que bloqueada |
|------|-------------------|
| `multi_edit` | Edita script direto no Studio, burlando Bug Hunter + DataGuard |
| `insert_from_creator_store` | Insere asset sem versionamento (não vai pro Rojo project) |
| `generate_mesh` | Gera mesh sem backup/versionamento |
| `generate_material` | Gera material sem backup |
| `generate_procedural_model` | Gera modelo procedural sem backup |

> **Se você tentar usar uma dessas, receberá um erro explicando como usar `aplicar_diff` em vez.**

## Fluxo correto de edição

```
IA quer editar script no Studio
  ↓
IA chama aplicar_diff (não multi_edit!)
  ↓
Pipeline de segurança:
  1. Read-before-write (força ler antes)
  2. Bug Hunter (detecta logic bugs)
  3. DataGuard (detecta SetAsync sem GetAsync, RemoveAsync sem backup, etc.)
  4. Rollback backup criado
  5. Diff aplicado ao arquivo no disco
  6. Rojo sync: arquivo → Studio (automático)
  ↓
IA verifica com script_read (read-only, permitido)
  ↓
IA testa com execute_luau ou start_stop_play (permitido)
```

## Exemplos de uso

### Ver toda a estrutura do jogo
```
search_game_tree({ path: "game.Workspace", instanceType: "Part" })
→ retorna JSON com todas as Parts na Workspace
```

### Inspecionar uma UI
```
inspect_instance({ path: "game.StarterGui.ScreenGui.TextLabel" })
→ retorna propriedades, atributos, children do TextLabel
```

### Procurar um padrão em todos os scripts
```
script_grep({ pattern: "SetAsync", searchType: "string" })
→ retorna até 50 matches com path e linha
```

### Rodar playtest e ver output
```
start_stop_play({ action: "start" })
→ ... espera ...
console_output({})
→ retorna logs do jogo rodando
start_stop_play({ action: "stop" })
```

### Mover personagem durante playtest
```
character_navigation({ target: "game.Workspace.SpawnLocation" })
→ personagem se move até o SpawnLocation
```

## Limitações

- O Studio precisa estar **aberto** com o place carregado
- O MCP server precisa estar **ativado** nas configurações do Assistant
- Apenas **uma** instância do Studio pode ser ativa por vez (use `set_active_studio`)
- `screen_capture` só funciona em **Play mode** (não em Edit mode)
