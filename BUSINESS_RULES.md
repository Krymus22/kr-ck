# BUSINESS_RULES.md — Regras de Negócio do Claude-Killer

> **DOCUMENTO OBRIGATÓRIO**: Deve ser lido antes de qualquer atualização, correção de bug, ou dispatch de bug hunter. Qualquer mudança que viole estas regras deve ser rejeitada.
>
> **Última atualização**: 2026-07-08
> **Mantenedor**: Krymus22
> **Versão**: 1.0

---

## ÍNDICE

1. [Modelos](#1-modelos)
2. [Configuração Padrão](#2-configuração-padrão)
3. [API Client](#3-api-client)
4. [Heartbeat](#4-heartbeat)
5. [Pool de API Keys](#5-pool-de-api-keys)
6. [Compactação de Contexto](#6-compactação-de-contexto)
7. [Sessões](#7-sessões)
8. [Streaming e TUI](#8-streaming-e-tui)
9. [Níveis de Esforço](#9-níveis-de-esforço)
10. [Agent Loop](#10-agent-loop)
11. [Quality Gate](#11-quality-gate)
12. [MCP e Extensions](#12-mcp-e-extensions)
13. [Read-Before-Write](#13-read-before-write)
14. [Tools](#14-tools)
15. [CI/CD](#15-cicd)
16. [Testes](#16-testes)
17. [Regras Intocáveis](#17-regras-intocáveis)

---

## 1. Modelos

### 1.1 Regras imutáveis

- **Context window** vem do `modelRegistry.ts`, NÃO do config. Sempre usar o valor do registry.
- **Max output tokens** vem do registry. `config.maxTokens` (131072) é apenas um teto alto — o registry é o cap real via `Math.min` no `apiClient.ts`.
- **Todos os modelos do registry têm cost 0/0** (free tier NVIDIA NIM e ZenMux free).
- **GLM 5.2 (pago)** tem `maxOutputTokens: 32_768` — NÃO reduzir. O reasoning consome tokens antes do content; com 16k o content vinha vazio.

### 1.2 Modelos registrados

| Model ID | Provider | Context | Max Output | Tools | Thinking |
|----------|----------|---------|------------|-------|----------|
| `moonshotai/kimi-k2.6` | nvidia | 256k | 8,192 | ✅ | ✅ |
| `minimaxai/minimax-m3` | nvidia | 1M | 16,384 | ✅ | ✅ |
| `qwen/qwen3-235b-a22b-instruct-2507` | nvidia | 256k | 16,384 | ✅ | ✅ |
| `deepseek-ai/deepseek-r1` | nvidia | 128k | 32,768 | ❌ | ✅ |
| `deepseek-ai/deepseek-v3.1` | nvidia | 128k | 8,192 | ✅ | ❌ |
| `deepseek-ai/deepseek-v4-pro` | nvidia | **1M** | **32,768** | ✅ | ✅ |
| `google/diffusiongemma-26b-a4b-it` | nvidia | 256k | 4,096 | ✅ | ✅ |
| `mistralai/mistral-medium-3.5-128b` | nvidia | 128k | 8,192 | ✅ | ❌ |
| `thudm/glm-4.5` | nvidia | 128k | 8,192 | ✅ | ❌ |
| `z-ai/glm-5.2-free` | zenmux | 1M | 16,384 | ✅ | ✅ |
| `z-ai/glm-5.2` | both | 1M | **32,768** | ✅ | ✅ |
| `moonshotai/kimi-k2.7-code-free` | zenmux | 128k | 8,192 | ✅ | ❌ |
| `moonshotai/kimi-k2.7-code` | zenmux | 128k | 8,192 | ✅ | ❌ |

**Modelos sem tools** (`deepseek-r1`, `palmyra-x5`): não podem ser usados com tool calling.

### 1.3 Thinking mode

- **NVIDIA**: enviado via `chat_template_kwargs: { thinking_mode: "enabled" }` — só para modelos com `hasThinking: true`.
- **ZenMux**: thinking é built-in, NUNCA enviar `chat_template_kwargs` (causa erro).
- **Kimi K2.7 Code**: `hasThinking: false` — não tem thinking.

---

## 2. Configuração Padrão

> Arquivo: `src/config.ts`. Todos os valores podem ser override via env var.

| Campo | Env Var | Default | Regra |
|-------|---------|---------|-------|
| `model` | `MODEL` | `moonshotai/kimi-k2.6` | Deve estar no registry |
| `temperature` | `TEMPERATURE` | `1.0` | NVIDIA recommended |
| `topP` | `TOP_P` | `0.95` | NVIDIA recommended |
| `maxTokens` | `MAX_TOKENS` | `131_072` | Teto alto — registry é o cap real |
| `contextWindowTokens` | `CONTEXT_WINDOW_TOKENS` | do registry | NÃO override manual |
| `contextCompactThreshold` | `CONTEXT_COMPACT_THRESHOLD` | **`0.65`** (65%) | Era 0.75, baixado pra evitar OOM |
| `contextWarnThreshold` | `CONTEXT_WARN_THRESHOLD` | `0.60` (60%) | StatusBar fica amarelo |
| `maxHealRetries` | `MAX_HEAL_RETRIES` | `3` | |
| `rateLimitRpm` | `RATE_LIMIT_RPM` | `40` | Free tier NVIDIA |
| `maxConcurrency` | `MAX_CONCURRENCY` | `1` | Hard limit (MVP) |
| `diffPreview` | `DIFF_PREVIEW` | `true` | Pede confirmação antes de editar arquivo |
| `costPerKPrompt` | — | `0` | Todos modelos free |
| `costPerKCompletion` | — | `0` | Todos modelos free |

### Regras imutáveis de config

- **Sempre usar context window do registry**, não do config manual. O config é derivado do model.
- **`contextCompactThreshold = 0.65`** — NÃO aumentar pra 0.75 (causa OOM em sessões longas multi-turn).
- **API key é obrigatória** — sem `NVIDIA_API_KEY`/`NVIDIA_API_KEYS`/`ZENMUX_API_KEY`, o CLI exita com código 1.

---

## 3. API Client

> Arquivo: `src/apiClient.ts`

### 3.1 Timeouts e retries

| Parâmetro | Valor | Regra |
|-----------|-------|-------|
| `HANG_TIMEOUT_MS` | **180,000ms (3min)** | Tempo sem nenhum token = hang |
| `MAX_CHAT_RETRIES` | **2** (3 tentativas total) | Retry automático em hang/empty |
| `MAX_429_RETRIES` | **4** | Rate limit |
| `MAX_NETWORK_RETRIES` | **15** | ECONNRESET, ETIMEDOUT, etc. |
| `MAX_403_RETRIES` | **3** | Glitches transitórios NVIDIA |
| `MAX_RETRY_AFTER_S` | **90** | Se Retry-After > 90s = quota exhausted, throw |
| Empty response retry | espera 2s | Antes de tentar de novo |

### 3.2 Backoff

- **429**: `retryAfterS * 1000 + 500` ms
- **5xx retryable (502, 503)**: exponencial `2^(attempt-1) * 1000`, cap 30s → 1s, 2s, 4s, 8s, 15s, 30s...
- **403**: exponencial `2^attempt * 1000` → 1s, 2s, 4s
- **Network (single key)**: igual 5xx
- **Network (multi-key)**: tenta outra key imediatamente (sem backoff)

### 3.3 Regras imutáveis

- **`stream_options: { include_usage: true }`** SEMPRE enviado. Sem isso a NVIDIA não retorna usage, quebrando context bar e auto-compactação.
- **5xx NÃO retriable**: 500 (bug real), 504 (gateway timeout — provável falha igual).
- **Hang timeout é skipado em testes** (`NODE_ENV === "test"`).
- **`parallel_tool_calls: true`** sempre (quando modelo suporta).
- **`tool_choice: "auto"`** sempre.

### 3.4 Hedging (delayed racing)

- `HEDGE_TIMEOUT_MS = 5000` (5s) — backup request após 5s se primary não streamou.
- **Só NVIDIA** (ZenMux não tem queue, desperdiçaria request).
- **Só se pool tem ≥2 keys** — backup usa `tryAcquireKeyImmediate()` (non-blocking).
- Primeiro a streamar vence; perdedor é abortado via `abortStreamSafe()`.

### 3.5 Repetição detection

- Triggera se content > 300 chars.
- Detecta frases de 25-100 chars repetidas 8+ vezes nos últimos 3000 chars.
- Ignora markdown (`|`, `-`, `#`, `*`, `>`, `` ` ``, `N.`).
- Ação: trunca últimos 500 chars + append `"[GERAÇÃO INTERROMPIDA: repetição detectada]"` + abort stream.

### 3.6 `<think>` tag filtering

- Kimi K2.6 embute reasoning como `<think>...</think>` dentro de `delta.content`.
- **Filtrado em tempo real** durante streaming (state machine).
- Safety net: `buildChatResponse()` stripa tags restantes via regex.

---

## 4. Heartbeat

> Arquivo: `src/heartbeat.ts`

| Parâmetro | Valor | Regra |
|-----------|-------|-------|
| `HEARTBEAT_INTERVAL_MS` | **300,000ms (5min)** | Mínimo 300s (invariant) — menos causa 429 |
| `HEARTBEAT_ENABLED` | `true` default | Desliga via `HEARTBEAT_ENABLED=0` |
| `temperature` | **0.01** | NÃO usar 0.0 (causa 400/hang em mistral-medium-3.5) |
| `max_tokens` | **1** | Só mantém modelo quente |
| Failures até parar | **5 consecutivas** | Auto-stop para não desperdiçar requests |
| Primeiro heartbeat | **imediato** | Não espera 5min pra começar |

### Regras imutáveis

- **`HEARTBEAT_INTERVAL_MS >= 300000`** — invariant enforced. Menos que isso causa 429 no free tier (40 RPM).
- **`temperature: 0.01`** — NÃO mudar pra 0.0. Bug confirmado em mistral.
- **Heartbeat usa LAST key do pool** (reserva) — não compete com keys principais.
- **Só NVIDIA precisa de heartbeat** — ZenMux é instantâneo (sem cold start).
- Timer é `unref()`'d — não mantém processo vivo.

### Model state classification

- `"warm"`: latency < 5,000ms
- `"cold"`: latency > 10,000ms
- `"unknown"`: sem heartbeat ainda

---

## 5. Pool de API Keys

> Arquivo: `src/apiKeyPool.ts`

### 5.1 Configuração

| Parâmetro | Valor |
|-----------|-------|
| `RATE_LIMIT_RPM` | 40 por key |
| `COOLDOWN_AFTER_429_MS` | 60,000ms (60s) |
| `MAX_LATENCY_SAMPLES` | 50 por key |
| Mutex por key | 1 request in-flight (NVIDIA free tier limit) |

### 5.2 Fontes de keys (precedência)

1. `NVIDIA_API_KEYS` (comma-separated) — filtra keys começando com `nvapi-`
2. `NVIDIA_API_KEYS_FILE` (uma por linha) — mesmo filtro
3. `NVIDIA_API_KEY` (single, backwards compat)

Se nenhuma: pool desabilitada → single-key mode.

### 5.3 Seleção de key

- **Round-robin** começando de `nextIndex`.
- Skip se: `cooldownUntil > now`, rate limit cheio, mutex locked.
- **429 = cooldown 60s** — único status que triggera cooldown.
- 5xx/network NÃO triggeram cooldown.

### 5.4 Prewarm

- `prewarmPool()` é **idempotente** (só roda 1x).
- Dispara **todas as keys em paralelo** via `Promise.allSettled`.
- Request: `{ model, messages: [{role:"user",content:"hi"}], max_tokens: 1, stream: false }`.
- **Só NVIDIA** — ZenMux não precisa.

### 5.5 Regras imutáveis

- **Pool é NVIDIA-only** — `BASE_URL` hardcoded.
- **Key #0 NUNCA usada pra heartbeat** — heartbeat usa última key do pool.
- **Nunca logar key completa** — só `apiKey.slice(0,10) + "..."`.
- **1 in-flight por key** — mutex FIFO. NVIDIA free tier não permite mais.

---

## 6. Compactação de Contexto

> Arquivos: `src/history.ts`, `src/contextCompaction.ts`, `src/llmCompactor.ts`, `src/fileRehydration.ts`, `src/skillTracker.ts`

### 6.1 Quando dispara

- **Threshold**: `contextWindowTokens * 0.65` (ex: 256k × 0.65 = 166,400 tokens).
- Roda no **início de cada turno** em `runPreTurnMaintenance()`.
- **ASYNC e BLOCKING** — agent pausa até completar (previne OOM de compactar + chat paralelo).

### 6.2 Estratégias (em ordem)

1. **LLM-based compaction** (se `effortLevel ≠ "low"` E tokens > 1.2× threshold):
   - Resume os 70% mais antigos via IA.
   - **9 seções preservadas** (Gap 8):
     1. User's Original Intent (quote verbatim)
     2. Architectural Decisions Made
     3. Arquivos Modificados
     4. Unresolved Bugs
     5. Problem-Solving Logic Chain (WHY, não só WHAT)
     6. All User Messages Summary (quote verbatim)
     7. Planned Next Steps
     8. Currently Working On
     9. User Preferences/Constraints (quote verbatim)
     10. Critical Technical Context
   - **Anti-drift** (Gap 5): prompt exige "DIRECTLY QUOTE key phrases rather than paraphrasing". Se user disse "never", escreve "never", não "prefers not to".
   - Substitui por 1 system message `"[AI CONTEXT COMPACTED - N old messages summarized...]"`.

2. **Heuristic compaction** (fallback):
   - `remove-consecutive-same-role`: merge mensagens adjacentes mesma role.
   - `compress-long-tool-results`: tool results > 2000 chars → first 500 + `"[COMPACTED]"` + last 500.
   - `merge-adjacent-tool-results`: 3+ tools seguidos → merge.
   - `remove-old-error-messages`: mantém só primeiros 3 `[ERROR]`.

3. **Mechanical compaction** (legacy):
   - `COMPACT_KEEP_RECENT = 6` — mantém últimas 6 mensagens.
   - `PRESERVE_PREFIXES` (ver 6.4).
   - **Estes prefixes NUNCA são removidos** por compaction.

### 6.3 Pós-compactação — re-hidratação (Gaps 1, 2, 9)

Após compactar, 3 system messages são injetadas antes das mensagens recentes:

1. **Mensagem de continuação** (Gap 2):
   - `"[SESSION CONTINUATION] This session was continued from a previous conversation..."`
   - Diz pra IA continuar trabalhando sem perguntar ao usuário.
   - Preservada em `PRESERVE_PREFIXES`.

2. **Re-hidratação de arquivos** (Gap 1) — `fileRehydration.ts`:
   - Relê os **5 arquivos mais recentemente editados** do disco.
   - Budget: **5,000 tokens por arquivo**, **50,000 tokens total**.
   - Arquivos truncados se excederem o limite (com aviso `[TRUNCATED]`).
   - Pula arquivos deletados, diretórios, e arquivos binários.
   - Preservada em `PRESERVE_PREFIXES` como `"## Recently Modified Files"`.
   - `recordSessionFileEdit(path)` chamado em `trackFileAccess()` quando WRITE tools são usadas.
   - `clearSessionFiles()` chamado em `/reset`, `/session new`, `/session load`, auto-load.

3. **Re-injeção de skills** (Gap 9) — `skillTracker.ts`:
   - Re-injeta conteúdo das **skills invocadas nesta sessão**.
   - Budget: **5,000 tokens por skill**, **25,000 tokens total**.
   - Preservada em `PRESERVE_PREFIXES` como `"## Invoked Skills"`.
   - `recordSkillInvocation(path)` chamado quando IA lê arquivo que matchea uma skill ativa.
   - `clearInvokedSkills()` chamado em `/reset`, `/session new`, `/session load`, auto-load.

### 6.4 PRESERVE_PREFIXES (atualizado)

```
"## TASK_STATE"
"## Persistent Memory"
"[CONVERSATION MEMORY"
"[PLAN"                          # Gap 3: preserve plan state
"[SESSION CONTINUATION"          # Gap 2: preserve continuation message
"## Recently Modified Files"     # Gap 1: preserve re-hydrated files
"## Invoked Skills"              # Gap 9: preserve re-injected skills
```

### 6.5 REPLACABLE_PREFIXES (atualizado)

Bug fix (Gap 3): `"[PLAN]"` (com closing bracket) → `"[PLAN"` (sem bracket) para matchear `formatPlan()` que retorna `"[PLAN - N steps]"`.

```
"## TASK_STATE"
"## Persistent Memory"
"## SELF-VALIDATION"
"[SELF-VALIDATION"
"[PLAN"                          # BUG FIX: era "[PLAN]" que não matcheava
"[SESSION CONTINUATION"          # Gap 2
"[GOAL"
"[HONESTY"
"[STRICT_GATE"
"[QUALITY"
"[FALSE_PROMISE"
"[CHECKPOINT"
```

### 6.6 Regras imutáveis

- **`COMPACT_KEEP_RECENT = 6`** — NÃO reduzir (IA perde contexto recente).
- **`PRESERVE_PREFIXES`** — TODOS os prefixes acima devem sobreviver compaction.
- **9 seções no resumo LLM** — NÃO reduzir (cada seção preserva info crítica).
- **Anti-drift**: prompt deve dizer "DIRECTLY QUOTE" — NÃO remover.
- **Re-hidratação de arquivos**: 5 arquivos, 5k tokens/arquivo, 50k total — NÃO remover.
- **Re-injeção de skills**: 5k tokens/skill, 25k total — NÃO remover.
- **Mensagem de continuação**: sempre injetada após compactação.
- **Dangling tool messages** são removidas pós-compaction.
- **Compaction snapshot** é salvo no session file após compactar.
- **`effortLevel = "low"` desabilita LLM compaction** — usa só mechanical.

---

## 7. Sessões

> Arquivo: `src/session.ts`

### 7.1 Storage

- **Location**: `~/.claude-killer/sessions/<sha256(cwd).slice(0,12)>/<id>.jsonl`
- **ID format**: `YYYY-MM-DD_HH-MM-SS_random4` (LOCAL time, não UTC)
- **Format**: JSONL — 1 JSON por linha
  - Linha 1: `{ type: "session-header", id, createdAt, cwd }`
  - Demais: `{ role, content, ts }` ou `{ type: "compaction-snapshot", messages, method, ts }`

### 7.2 Auto-save

- **Cada mensagem é appendada IMMEDIATELY** via `fs.appendFileSync` (crash-safe).
- **Sem `/session save`** — é automático.
- **IA NÃO tem tool de session** — sessions são infraestrutura, não concern da IA.

### 7.3 Auto-load no startup

1. `getLastSession(cwd)` → sessão mais recente do projeto.
2. Se existe E tem mensagens:
   - `setActiveSession(id)` **PRIMEIRO** (previne double-write).
   - `clearReadPaths()` (BS-18 fix).
   - Se tem compaction snapshot: `loadHistoryDirect(snapshot + postSnapshotMessages)`.
   - Se não tem: `loadHistoryDirect(allMessages)`.
   - Visual: `convertSessionToVisualMessages(allMessages)` para display.

### 7.4 Regras imutáveis

- **`setActiveSession` ANTES de `loadHistoryDirect`** — sem isso, `appendMessage` cria nova session (double-write).
- **`loadHistoryDirect` NÃO persiste** — bypassa `tryAppendToSession` inteiro.
- **Orphan tool_calls são reparados** (BS-4 fix): se assistant tem `tool_calls` sem `tool` result, injeta `"[ERROR] Session interrupted — tool did not complete. The terminal was closed mid-tool-call. Please retry or check the current state."`.
- **Snapshot + postSnapshotMessages merge** (BS-3 fix): IA recebe snapshot (estado compactado) + mensagens que vieram depois. NÃO usar só o snapshot.
- **Session com 0 mensagens**: não carrega, não cria nova (lazy init no first message).
- **`clearReadPaths()` em `/reset`, `/session new`, `/session load`, e auto-load** — BS-18 fix.

### 7.5 Slash commands

- `/session` ou `/session list` — lista sessões (máx 20)
- `/session load <id>` — carrega (partial prefix match)
- `/session delete <id>` — deleta
- `/session rename <old> <new>` — renomeia
- `/session new` — sessão nova (reseta history + clearReadPaths)

---

## 8. Streaming e TUI

### 8.1 Throttle de streaming

- **`STREAM_FLUSH_INTERVAL = 80ms`** (~12 updates/sec)
- `streamContent` é `useRef` (mutado a cada token, nunca perdido).
- React state é batched — `setMessages` no máximo 12x/sec.
- **Trailing flush** via `setTimeout` garante que último conteúdo aparece.
- **Flush final síncrono** quando stream termina (clears timer).
- **Timer é cleared** em `onStreamStart` (previne flush stale de stream anterior).

### 8.2 Static/Live split (ChatDisplay)

- **`MIN_LIVE_MESSAGES = 4`** — mínimo na live view.
- Mensagens antigas graduam pra `<Static>` (escritas 1x no stdout, nunca re-rendered).
- Streaming message SEMPRE fica na live view.
- **`maxVisible` default = Infinity** — renderiza TODAS as mensagens (NÃO usar 50).

### 8.3 StatusBar

**Layout**: `[ACTIVITY] [tokens] [bar] [%] [tok/s] [effort] [$cost] [turnCost] [ses:tok] [M:N] [S:N] [PLAN]`

- **Barra de contexto**: **10 segmentos**, escala LINEAR (não log).
  - Cada traço = 10%. `Math.floor(pct * 10)` filled, resto empty.
  - Fill: `#`, Empty: `-`.
  - Cores: verde (<60%), amarelo (≥60%), vermelho (≥65%).
- **Porcentagem**: precisa (1% increments), `Math.round(pct * 100)`.
- **Activity indicator** (leftmost):
  - `▶` (verde) quando idle
  - `■` (violeta) quando thinking/streaming
  - `■` (amarelo) quando compacting
- **Right-aligned**: `justifyContent="flex-end"`, `width="100%"`.

### 8.4 Banner

- **Printado UMA VEZ via `process.stdout.write` ANTES do `render()` do Ink** (em `index.ts`).
- **NÃO está na live view** — fica no scrollback do terminal.
- **Motivo**: se estivesse na live view, cada re-render (12x/sec) moveria cursor pro topo, roubando scroll do usuário.
- Conteúdo: `=` × bannerWidth + `Claude-Killer . Ink TUI` + `Model: <model>` + hints.
- Largura: `Math.max(40, Math.min(cols - 2, 80))`.
- `process.env.CLAUDE_KILLER_BANNER_PRINTED = "1"` após imprimir (App.tsx skipa fallback).

### 8.5 Pensar/think tool — NÃO mostrar resultado

- `toolName === "pensar"` OU `toolName === "think"` com `isResult: true` → `return null` (não renderiza).
- Pensamentos da IA são internos, não vazam pro chat.

### 8.6 Markdown Rendering (MarkdownRenderer.tsx)

> Arquivo: `src/tui/MarkdownRenderer.tsx`

Mensagens de **assistant** são renderizadas com markdown formatting. Mensagens de **user**, **tool**, e **error** continuam como texto puro.

**Features suportadas:**

| Sintaxe | Renderização | Ink |
|---------|-------------|-----|
| `**bold**` | **bold** | `<Text bold>` |
| `*italic*` | *italic* | `<Text italic>` |
| `` `code` `` | código inline (amarelo) | `<Text color="yellow">` |
| ` ```code block``` ` | bloco de código (cinza, indentado) | `<Box>` com `<Text color="muted">` |
| `# Header` | header bold + colorido | `<Text bold color>` |
| `- item` / `* item` | bullet list com • | `<Text> • </Text>` |
| `1. item` | numbered list | `<Text> N. </Text>` |
| `> quote` | blockquote com │ | `<Text> │ </Text>` |
| `\| table \|` | tabela alinhada com flexbox | `<Box flexDirection="row">` |
| `---` | horizontal rule | `<Text>─────</Text>` |
| `[link](url)` | link colorido (azul) | `<Text color="blue">` |
| `~~strike~~` | strikethrough (muted) | `<Text color="muted">` |

**Regras imutáveis:**
- **Apenas mensagens de assistant** usam MarkdownRenderer. User/tool/error = texto puro.
- **Tabelas usam Ink flexbox** (não cli-table3 ou ASCII borders) — mesmo approach do Claude Code.
- **Parser é custom** (sem dependência `marked`) — leve e integrado.
- **Inline code** tem precedência sobre bold/italic (para não parsear `**` dentro de `code`).
- **Streaming messages** usam MarkdownRenderer normalmente (re-rendered a cada throttle flush).
- **Error messages** (`isError: true`) NÃO usam MarkdownRenderer (texto puro vermelho).

---

## 9. Níveis de Esforço

> Arquivo: `src/effortLevels.ts`

| Nível | Label | Auto-test | Sub-agents | LLM Compaction | Think depth |
|-------|-------|-----------|------------|----------------|-------------|
| `low` | `LOW !` | ❌ | ❌ | ❌ (mechanical only) | 1 frase |
| `medium` (default) | `MEDIUM G` | ✅ | ❌ | ✅ | 2-3 frases |
| `high` | `HIGH Q` | ✅ | ✅ (read-only) | ✅ | 4-6 frases |
| `max` | `MAX B` | ✅ | ✅ (read-only + powerful) | ✅ | 6+ frases |

### Regras imutáveis

- **Effort NÃO override `maxOutputTokens` ou `temperature`** — só afeta system prompt snippet, behavior flags, e think tool depth.
- **Default = `medium`**.
- **`low` desabilita LLM compaction** — usa só mechanical (mais rápido).
- **Sub-agents powerful (maxToolCalls=15) só no `max`** — read-only (maxToolCalls=8) no `high`.
- **`/effort` atualiza system prompt imediatamente** (`history[0].content = getSystemPrompt()`).

---

## 9.5 Contexto Injetado na IA

> O que a IA recebe no contexto, além das mensagens do usuário.

### 9.5.1 System Prompt (history[0]) — injetado no início de cada turno

| Componente | Quando | Fonte |
|-----------|--------|-------|
| **Data atual** | Sempre | `## Current Date` — "Today is YYYY-MM-DD" |
| **Base system prompt** | Sempre | `BASE_SYSTEM_PROMPT` (regras, tools, estilo, honesty rules) |
| **Environment info** (Gap 12) | Sempre | `## Environment` — cwd, platform, shell, Node version, model |
| **Tool-routing rules** (Gap 14) | Sempre | `## Tool Routing` — "NEVER use executar_comando for file ops" |
| **Writing style** (Gap 15) | Sempre | `## Response Style` — markdown, ≤25 words entre tools, ≤100 words final |
| **Effort snippet** | Sempre | Depth do pensar por nível (low/medium/high/max) |
| **Caveman mode** | Se ativo | Override de estilo |
| **Project Memory** | Sempre | `## Project Memory` — CLAUDE.md + AGENTS.md + .claude-killer/AGENTS.md |
| **Available Skills** | Se há skills | `## Available Skills` — nome + descrição (NÃO conteúdo completo) |
| **Patterns** | Sempre | `injectPatterns()` — anti-padrões conhecidos do projeto |

### 9.5.2 System Messages — injetadas DURANTE o turno

| Componente | Quando | Prefixo |
|-----------|--------|---------|
| **TASK_STATE** | A cada parada | `## TASK_STATE` |
| **Persistent Memory** | Quando setado | `## Persistent Memory` |
| **CONVERSATION MEMORY** | Após compactação | `[CONVERSATION MEMORY` |
| **SESSION CONTINUATION** (Gap 2) | Após compactação | `[SESSION CONTINUATION` |
| **Recently Modified Files** (Gap 1) | Após compactação | `## Recently Modified Files` |
| **Invoked Skills** (Gap 9) | Após compactação | `## Invoked Skills` |
| **Plan state** | Se plan ativo | `[PLAN` |
| **Goal verification** | Após goal verifier | `[GOAL` |
| **Bug Hunter findings** | Após bug hunter | `[BUG_HUNTER` |
| **Strict gate errors** | Se tsc/lint falha | `[STRICT_GATE` |
| **Checkpoint** | Em 20%/45%/70% | `[CHECKPOINT` |
| **Failure memory** | Antes de write tools | (sem prefixo específico) |
| **Context injection** | Após write tools | (sem prefixo específico) |

### 9.5.3 Regras imutáveis de contexto

- **System prompt é dinâmico** — reconstruído a cada chamada de `getSystemPrompt()`.
- **Environment info** sempre inclui: cwd, platform, shell, Node version, model.
- **Tool-routing rules** proíbem `executar_comando` para operações de arquivo.
- **Writing style** limita 25 palavras entre tools, 100 palavras na resposta final.
- **Skills** só mostram nome + descrição no system prompt — conteúdo completo só se IA ler.
- **PRESERVE_PREFIXES** garantem que system messages críticas sobrevivam compactação.
- **REPLACABLE_PREFIXES** garantem que system messages não acumulem (replace, não append).

### 9.5.4 HONESTY RULES (CRÍTICO)

> As Honest Rules são injetadas no `BASE_SYSTEM_PROMPT` (src/history.ts:205-223) e são a base do comportamento anti-hallucination da IA. Elas NÃO podem ser removidas ou suavizadas.

**Princípio fundamental**: HONESTY OVER AGREEMENT. Always.

A IA NÃO é um yes-man. É uma engenheira confiável, não uma people-pleaser.

**7 regras:**

1. **NEVER agree without VERIFYING** — não concordar com claim só porque o user disse. Verificar primeiro (ler arquivo, rodar comando, checar docs). Se realidade difere, FALAR.
2. **HONEST assessment with evidence** — se perguntado "estamos no nível X?", dar avaliação honesta com evidência. Se NÃO está no nível, dizer e explicar o que falta.
3. **"I don't know" > fabrication** — se não sabe, DIZER "não sei" ou "preciso verificar". Fabricar respostas é a PIOR coisa.
4. **"Let me check" > confident wrong answer** — quando perguntado "X funciona?", não dizer "sim" sem checar. Rodar teste, ler código.
5. **CORRECT YOURSELF** — se disse algo errado antes, CORRIGIR. Não torcer pra esquecerem.
6. **Disagreeing is NOT rude** — é seu trabalho. Médico que concorda com auto-diagnóstico sem checar é mau médico.
7. **If user points out a "bug" that isn't** — explicar por quê. Mas TAMBÉM checar se user pode estar certo.

**Exemplos:**

```
BAD:  "Yes, all tests pass!" (without running them)
GOOD: "Let me verify... [runs tests] Yes, 1695/1695 pass. 2 skipped — investigate?"

BAD:  "You're right, critical bug!" (without checking if it's actually handled)
GOOD: "Let me check... Line 42 already handles X. But there IS an edge case with Y."
```

**Sistema de honesty (src/honestySystem.ts):**
- `isHonestyFeatureEnabled(feature)` — verifica se feature (Devil's Advocate, etc.) está ativa
- Devil's Advocate — roda sub-agente pra revisar trabalho da IA (requer effort high/max)
- False-promise detector — se IA disse que ia investigar mas não chamou tool, bloqueia finish
- Self-validation — se IA editou arquivos, injeta prompt pra auto-validar antes de finishar

**Regra imutável:** As HONESTY RULES devem SEMPRE estar no system prompt. NUNCA remover, suavizar, ou pular. Devil's Advocate deve rodar quando effort=high/max. False-promise detector deve sempre rodar.

---

## 10. Agent Loop

> Arquivo: `src/agent.ts`

### 10.1 Limites por turno

| Parâmetro | Valor | Regra |
|-----------|-------|-------|
| `MAX_STOPS_PER_TURN` | **12** | Após isso, strict gate não bloqueia mais |
| `MAX_GOAL_BLOCKS_PER_TURN` | **2** | Goal verifier bloqueia finish max 2x |
| `MAX_BUG_HUNTER_ROUNDS` | **10** | Critical/high findings bloqueiam max 10 rounds |
| `MAX_MEDIUM_LOW_ROUNDS` | **3** | Medium/low findings bloqueiam max 3 rounds |
| `MAX_AUTO_HEAL_RETRIES` | **2** | Auto-heal loop pra test/lint failures |
| `MAX_CONCURRENT_SUB_AGENTS` | NVIDIA=2, ZenMux=10 | Override via env |
| Duplicate call dedup | 2 = WARN, 3 = STOP | Tool calls idênticos bloqueados |

### 10.2 Pre-turn maintenance

Roda no início de CADA `sendAndProcess` (toda recursão):
1. `smartCompact(compactionThreshold)` — async blocking se > 65%.
2. `maybeWriteCheckpoint()` — em 20%, 45%, 70% do MAX_CONTEXT_TOKENS.
3. `history.optimizeContext()` — stripa `[IMPACT]` hints de tool results antigos.
4. `pushActivity("api_call", model)` — TUI mostra "waiting for LLM".

### 10.3 Tool aliases

```
buscar_conteudo, buscar_texto_no_projeto, grep, search → buscar_texto
find_files, glob, list_files → buscar_arquivos
read_file, read → ler_arquivo
write_file, write, edit → editar_arquivo
run_command, shell → executar_comando
think → pensar
```

### 10.4 Gate chain (toda tool call)

1. `normalizeArgs` — aliases, type coercion, JSON parse, defaults.
2. Force-convert string fields que vieram como objeto (path, comando, pensamento, etc.).
3. `runSchemaGate` — JSON schema validation.
4. `pokaYokeCheck` — poka-yoke (path expansion, etc.).
5. `checkReadBeforeWrite` — read-before-write enforcement.

### 10.5 Stop reason chain (on `finish_reason: "stop"`)

1. False-promise detector — se IA disse que ia investigar mas não chamou tool.
2. Self-validation — se `shouldSelfValidate(turnTouchedFiles.size)`.
3. Strict quality gate — tsc/lint/rojo.
4. Plan completion check — se `hasIncompletePlan()` E touchedFiles > 0.
5. Devil's Advocate + Anonymous Review (parallel, se enabled).
6. Goal verifier — se touchedFiles > 0 E turnStopHits === 1 E `looksLikeTask`.
7. Bug Hunter — critical/high bloqueiam (max 10 rounds), medium/low (max 3).
8. DataGuard — critical/high data loss risks.
9. Failure memory log.
10. TASK_STATE update.

### 10.6 Read-only vs write tools

- **READ_ONLY_TOOLS**: `ler_arquivo, buscar_arquivos, buscar_texto, buscar_web, ler_url, parse_ast, explorar_subagente, usar_scout, ler_estado, listar_memoria` — executam em **paralelo**.
- **WRITE_FILE_TOOLS**: `editar_arquivo, editar_multi_arquivos, desfazer_edicao` — executam **sequencialmente**.

### 10.7 Scout Sub-agent (modelo menor para aceleração)

> Arquivo: `src/scoutAgent.ts`

**PROBLEMA**: O modelo principal (ex: GLM 5.2) é excelente mas lento no servidor NVIDIA. Cada chamada de tool exige um round-trip completo (IA → tool → IA), e o modelo grande é lento para processar cada step.

**SOLUÇÃO**: O agente principal delega leituras/buscas para o scout — um sub-agente com modelo menor e rápido. O scout faz todas as leituras, coleta os resultados, e retorna um summary estruturado. A IA principal recebe o summary e pode pular direto para a edição.

| Parâmetro | Env Var | Default | Regra |
|-----------|---------|---------|-------|
| `SCOUT_ENABLED` | `SCOUT_ENABLED` | `0` (off) | `1` ou `true` para ativar |
| `SCOUT_MODEL` | `SCOUT_MODEL` | `mistralai/mistral-medium-3.5-128b` | Modelo menor (deve suportar tools) |
| `SCOUT_MAX_DURATION_MS` | `SCOUT_MAX_DURATION_MS` | `120000` (2min) | Timeout global do scout |
| Max tool calls | — | `12` (clamp `[1, 50]`) | Limite de rounds de tool calls |
| Max tool result bytes | — | `8192` | Truncamento para evitar context overflow |

**Segurança**:
- **READ-ONLY**: só tem `ler_arquivo, buscar_arquivos, buscar_texto, parse_ast`. NÃO pode editar/escrever/executar.
- **Path traversal blocking**: `resolveAndCheckPath` usa `path.relative()` + `fs.realpathSync()` para bloquear `../`, paths absolutos fora do projeto, e symlinks.
- **Cwd validation**: `args.cwd` é validado contra `process.cwd()` — não pode escapar do projeto.
- **Anti-recursão**: scout não pode ser chamado de dentro de sub-agentes (guard via `CLAUDE_KILLER_AGENT_ID`).
- **Timeout global**: scout retorna erro após `SCOUT_MAX_DURATION_MS` (default 2min).

**Tool**: `usar_scout` (adicionada ao tool set quando `SCOUT_ENABLED=1`).
- Args: `objetivo` (string), `tarefas` (array de `{tipo, descricao}`), `max_tool_calls` (opcional), `cwd` (opcional, validado).
- Retorna: summary estruturado com `## Summary`, `## Files Inspected`, `## Key Findings`.
- `filesInspected` é incluído no resultado para o agente principal saber quais arquivos já foram lidos (read-before-write tracking).

**Fluxo**:
1. Agente principal chama `usar_scout({ objetivo, tarefas })`
2. Scout usa modelo menor (via `chatWithModel` com `modelOverride`) para fazer leituras/buscas
3. Scout retorna summary estruturado
4. Agente principal usa o summary como contexto e pula direto para a edição

**Race condition prevention**: `chatWithModel` usa `modelOverride` (variável module-level) em vez de mutar `config.model` global. O override é limpo no `finally` — nunca corrompe `config.model` permanentemente.

---

## 11. Quality Gate

> Arquivo: `src/strictQualityGate.ts`

### 11.1 Config

| Parâmetro | Default | Regra |
|-----------|---------|-------|
| `STRICT_MODE` | `true` (ON) | |
| `STRICT_GATE_TSC` | `true` | TypeScript check |
| `STRICT_GATE_LINT` | `true` | ESLint check |
| `STRICT_GATE_MAX_BLOCKS` | **8** | Após 8 blocks, desiste e deixa finishar |

### 11.2 O que valida

1. **TypeScript**: `npx tsc --noEmit` — só se `tsconfig.json` existe. 60s timeout.
2. **Lint**: `npm run lint` — só se `package.json` tem `scripts.lint`. 60s timeout.
3. **Rojo build**: `rojo build` — só se `default.project.json` existe E `rojo` no PATH. 60s timeout.

### 11.3 `findProjectRoot`

- **SÓ olha o cwd atual** — NÃO caminha pra cima (achava claude-killer's package.json em vez do projeto do usuário).
- Ordem: `package.json` → `default.project.json` → `tsconfig.json` → `cwd`.

### 11.4 Regras imutáveis

- **Blocking por default** — injeta `[STRICT_GATE BLOCK N/8]` com erros, força recursão.
- **Após 8 blocks**: desiste, deixa finishar com warning.
- **Skip se**: sem arquivos touched, todos match skip patterns, STRICT_MODE off.
- **Self-healing**: parseia erros via `selfHealing.ts`, formata pra IA conseguir corrigir.

---

## 12. MCP e Extensions

> Arquivos: `src/extensions.ts`, `src/robloxMcpGuard.ts`

### 12.1 Fontes de config MCP (3 fontes)

1. **`./.mcp.json`** (project-local, Claude Code format) — mais específico.
2. **`~/.claude-killer/config.json`** → `mcpServers` (native dotfile).
3. **`~/.claude.json`** → `mcpServers` (Claude Code global) — **OPT-IN** via `CLAUDE_KILLER_LOAD_CLAUDE_JSON=1`. Default OFF.

Adicional: `~/.claude-killer/modes/<mode>/mcps/*.json` (mode-specific).

### 12.2 MCP Guard — Roblox Studio

**Política default-allow** (per user request July 2026):

| Categoria | Tools | Comportamento |
|-----------|-------|---------------|
| `read` | `script_read, script_search, script_grep, search_game_tree, inspect_instance, console_output, get_studio_state` | ✅ ALLOWED silent |
| `write` | `multi_edit, insert_from_creator_store, generate_mesh, generate_material, generate_procedural_model` | ❌ **BLOCKED** — usar `aplicar_diff` |
| `execute` | `execute_luau, run_script_in_play_mode` | ✅ ALLOWED com log |
| `playtest` | `start_stop_play, screen_capture, playtest_subagent, character_navigation, keyboard_input, mouse_input` | ✅ ALLOWED silent |
| `unknown` | (não classificada) | ✅ **ALLOWED** (default-allow) |

### 12.3 Regras imutáveis

- **Default-allow**: tools desconhecidas passam, só WRITE tools do Roblox são bloqueadas.
- **WRITE tools bloqueadas** devem usar `aplicar_diff` (passa por Bug Hunter + DataGuard + read-before-write + rollback).
- **Fail-safe**: se o guard erro, a call é **BLOCKED** (proteção).
- **NDJSON framing** (não Content-Length/LSP) — MCP spec. Roblox Studio MCP exige NDJSON.
- **Timeouts**: `initialize` 30s, `tools/list` 15s, `tools/call` 60s, outros 10s. Test env: 100ms.

---

## 13. Read-Before-Write

> Arquivo: `src/readBeforeWrite.ts`

### 13.1 Como funciona

- **READ_TOOLS**: `ler_arquivo, ler_arquivo_avancado, buscar_texto, buscar_arquivos, git_diff, git_blame, git_show, parse_ast`.
- **WRITE_TOOLS**: `aplicar_diff, editar_arquivo, editar_multi_arquivos`.
- `recordRead(tool, path)` adiciona `path.resolve(filePath)` ao set.
- `checkReadBeforeWrite(tool, args)`:
  - Se disabled: allow.
  - Se não é WRITE_TOOL: allow.
  - Se arquivo não existe E `createIfMissing === true`: allow (não pode ler o que não existe).
  - Senão: verifica se path está no set de readPaths.

### 13.2 Quando é cleared

- `clearReadPaths()` chamado em **4 lugares** (BS-18 fix):
  1. `/reset`
  2. `/session new`
  3. `/session load <id>`
  4. Auto-load no startup

### 13.3 Regras imutáveis

- **Default ON** (`READ_BEFORE_WRITE !== "false"`).
- **Mode switching** pode toggle (roblox mode = true, normal = false).
- **Clear em /reset e /session load** — sem isso, gate é bypassado por estado stale (risco de corrupção).
- **Error message** é em PT-BR com exemplo de uso correto.

---

## 14. Tools

### 14.1 Tool result truncation

- **`ler_arquivo`**: NÃO trunca. IA precisa do conteúdo completo. (REMOVIDO per user request — era bug.)
- **`executar_comando`**: combined stdout+stderr capped em **512KB** (`MAX_OUTPUT_BYTES`).
- **`ler_url`**: trunca em `maxLength` (default 10,000 chars).
- **Compaction**: tool messages > 2,000 chars → first 500 + `"[COMPACTED]"` + last 500 (só durante compaction).
- **LLM compactor input**: tool results truncan pra 200 chars (só pra gerar summary).

### 14.2 Regra imutável

> **"n importa o tamanho do arquivo, se a IA precisa ler então ela PRECISA LER"**
>
> — User, July 2026

- **NUNCA truncar ou omitir conteúdo de `ler_arquivo`** no history. A IA chamou porque precisa.
- Otimização de contexto acontece via `/compact` (LLM-based), não removendo conteúdo solicitado.

### 14.3 `pensar` / `think`

- Alias: `think` → `pensar`.
- Categories: `planning, pre_edit, pre_research, pre_response, debugging, architecture, general`.
- `category` (EN) aceito como alias de `categoria` (PT).
- `pensamento` (PT) é o campo — NÃO existe `thought`.
- Planning thoughts > 20 chars viram decision em TASK_STATE.
- **Resultado NÃO aparece no chat** (filtrado em `ChatDisplay`).

### 14.4 `executar_comando`

- Default timeout: **60,000ms (60s)**.
- Shell: `win32 ? powershell.exe : /bin/bash`.
- `MAX_OUTPUT_BYTES = 512KB` por stream (stdout/stderr separados).
- On timeout: SIGKILL + `[TIMEOUT after Xms]`.
- On non-zero exit: `[ERROR] Command failed with code N`.

### 14.5 `aplicar_diff`

1. Lê arquivo atual.
2. Parse diff blocks (`<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`).
3. Aplica diffs in-memory com whitespace-normalized matching.
4. **Diff preview + user approval** (se `config.diffPreview: true`).
5. Salva rollback backup ANTES de escrever.
6. Escreve no disco.
7. Post-write validation (advisory — arquivo é salvo mesmo se validation falha).

---

## 15. CI/CD

> Diretório: `.github/workflows/`

### 15.1 Workflows

| Workflow | Trigger | Blocking? |
|----------|---------|-----------|
| **CI** (`ci.yml`) | push/PR | typecheck ✅, test ✅, lint ❌, smoke ❌ |
| **Code Quality** (`code-quality.yml`) | push/PR | ❌ non-blocking |
| **Semgrep** | push/PR + **daily 01:00 UTC** | Report only |
| **CodeQL** | push/PR + **weekly Monday 01:00 UTC** | Report only |
| **SonarQube** | push/PR | Condicional (SONAR_TOKEN) |
| **gitleaks** | push/PR | Report only |
| **OSV-scan** | push/PR + **daily 01:00 UTC** | ❌ non-blocking |
| **Stryker** (real) | **DESATIVADO** — manual only | Manual |
| **Mutation Caseiro** | **daily 01:00 UTC** (22:00 BRT) + manual | Report only |

### 15.2 Mutation Testing (Caseiro)

- **Cron**: `0 1 * * *` (01:00 UTC = 22:00 BRT).
- **20 jobs paralelos** (matrix `[0..19]`), `max-parallel: 20` (free tier limit).
- **`fail-fast: false`** — um grupo falhar não cancela outros.
- Timeout: 60min por job.
- Script: `scripts/mutation-test.py` + `scripts/list-mutation-groups.py`.
- **Cap**: 30 mutações por arquivo, skip arquivos > 1500 linhas.
- Aggregate job baixa todos os reports e gera `mutation-final-report` artifact.

### 15.3 CI — `npm ci` vs `npm install --legacy-peer-deps`

- **`npm install --legacy-peer-deps`** em todos os workflows (ci, code-quality, mutation-caseiro, sonarqube).
- **Motivo**: conflito de peer deps entre React 19, Ink 7, e dev tooling. Sem `--legacy-peer-deps`, `npm install` falha.
- **`npm ci`** só no Stryker (desativado).
- **Smoke job** usa `npm install` (sem flag) — só precisa do build.

### 15.4 Husky pre-commit

- **NON-BLOCKING** — `|| true` após cada check.
- Roda Prettier check + ESLint (não modifica, só reporta).
- Printa `[pre-commit] Checks complete (non-blocking).`.

### 15.5 Dependabot

- **npm deps**: daily 01:00 America/Sao_Paulo, max 5 PRs, labels `dependencies` + `automated`.
- **GitHub Actions**: weekly Monday, labels `github-actions` + `automated`.

---

## 16. Testes

### 16.1 Configuração

- **Framework**: Vitest 4.x
- **Include**: `src/**/*.test.ts`, `src/**/*.test.tsx`
- **Timeout**: 60,000ms (60s) por teste
- **Environment**: `node`
- **Globals**: `true` (não precisa importar `describe`/`it`/`expect`)
- **Setup**: `./vitest-setup.ts`

### 16.2 Cobertura

- **Provider**: `v8`
- **Reporters**: `lcov`, `text`
- **Include**: `src/**/*.ts`
- **Exclude**: `src/**/*.test.ts`, `src/__tests__/**`, `src/tui/**` (TUI excluído)
- **CI exclude**: `src/__tests__/memory-full.test.ts` (slow/flaky)

### 16.3 Convenções de nome

- `<module>.test.ts` — teste principal
- `<module>-extended.test.ts` — testes estendidos
- `<module>-deep.test.ts` — deep coverage
- `<module>-coverage.test.ts` — coverage gaps
- `unit-<module>-extended.test.ts` — unit tests
- `integration-<flow>.test.ts` — integration
- `fase<N>-<feature>.test.ts` — sprint phases
- `property-<category>.test.ts` — property-based
- `contract-<type>.test.ts` — contract tests
- `regression-<topic>.test.ts` — regression
- `tui-<component>.test.tsx` — TUI components

### 16.4 Regras imutáveis

- **Todo bug fix deve ter teste de regressão**.
- **TUI tests mockam `runAgentLoop`** — não testam wiring end-to-end.
- **`process.chdir()` em testes** quebra Stryker (worker threads não suportam chdir).
- **Testes que usam binários externos** (selene, stylua, rojo) são excluídos do Stryker.

---

## 17. Regras Intocáveis

> Estas regras NÃO PODEM ser mudadas sem aprovação explícita do mantenedor.

### 17.1 Comportamento da IA

1. **IA NÃO tem tool de session** — sessions são infraestrutura.
2. **`ler_arquivo` NÃO trunca** — IA precisa do conteúdo completo.
3. **Tool result `pensar` NÃO aparece no chat** — pensamento é interno.
4. **`think` é alias de `pensar`** — ambos filtrados do display.
5. **HONESTY RULES sempre no system prompt** — NUNCA remover, suavizar, ou pular (ver §9.5.4).
6. **Devil's Advocate roda quando effort=high/max** — NÃO desabilitar.
7. **False-promise detector sempre ativo** — se IA disse que ia investigar mas não chamou tool, bloqueia finish.
8. **`pensar` tool NÃO é removido do tool set** — só filtrado do display (toolReduction deve manter).

### 17.2 Configuração

5. **`contextCompactThreshold = 0.65`** — não aumentar (causa OOM).
6. **`STREAM_FLUSH_INTERVAL = 80ms`** — não reduzir (rouba scroll), não aumentar (streaming choppy).
7. **`MIN_LIVE_MESSAGES = 4`** — não reduzir (input some em conversas longas).
8. **Barra de contexto = 10 segmentos LINEAR** — não voltar pra log scale (enganosa).
9. **Banner fora da live view** — se voltar pra live view, cursor pula durante streaming.

### 17.3 Session

10. **`setActiveSession` ANTES de `loadHistoryDirect`** — sem isso = double-write.
11. **`clearReadPaths` em /reset, /session new, /session load, auto-load** — sem isso = gate bypassado.
12. **Orphan tool_calls são reparados** — sem isso = session permanently quebrada.
13. **Snapshot + postSnapshotMessages merge** — sem isso = IA esquece msgs recentes.
14. **Session ID em LOCAL time** — não UTC.

### 17.4 API

15. **`stream_options: { include_usage: true }`** sempre — sem isso = context bar quebrada.
16. **`temperature: 0.01` no heartbeat** — não 0.0 (bug em mistral).
17. **`HEARTBEAT_INTERVAL_MS >= 300000`** — menos causa 429.
18. **Heartbeat usa LAST key do pool** — não compete com keys principais.
19. **Hedging só NVIDIA** — ZenMux não tem queue.
20. **5xx: só 502/503 retriable** — 500/504 não.
21. **MarkdownRenderer só em assistant messages** — user/tool/error = texto puro.

### 17.5 MCP

21. **Default-allow** — tools desconhecidas passam, só WRITE tools Roblox bloqueadas.
22. **NDJSON framing** — não Content-Length (Roblox Studio MCP exige NDJSON).
23. **`~/.claude.json` é OPT-IN** — `CLAUDE_KILLER_LOAD_CLAUDE_JSON=1` para carregar.

### 17.6 CI/CD

24. **`npm install --legacy-peer-deps`** em todos workflows (não `npm ci`).
25. **Mutation testing = 20 jobs paralelos** — não sequencial (5-7h = timeout).
26. **Husky pre-commit = non-blocking** — não bloquear commits.
27. **Stryker real desativado** — incompatível com `process.chdir()`.

### 17.7 Quality Gate

28. **`findProjectRoot` só olha cwd** — não caminha pra cima.
29. **Max 8 blocks** — após isso, deixa finishar.
30. **Blocking por default** — mas non-blocking após 8.

---

## COMO USAR ESTE DOCUMENTO

### Para bug hunters (sub-agentes)

Antes de corrigir qualquer bug:
1. Leia este documento completo.
2. Verifique se a correção viola alguma regra em §17 (Regras Intocáveis).
3. Se violar, NÃO faça a mudança — reporte ao invés disso.
4. Se não violar, proceda e adicione teste de regressão.

### Para correções de bug

1. Consulte a seção relevante (ex: §6 Compactação para bugs de contexto).
2. Verifique os valores exatos — não aproxime.
3. Após corrigir, rode `npx tsc --noEmit` e `npx vitest run`.
4. Adicione teste de regressão que falha sem o fix e passa com ele.

### Para novas features

1. Verifique se a feature já existe (muitas já estão implementadas).
2. Adicione a feature SEM violar regras intocáveis.
3. Atualize este documento com a nova regra/behavior.
4. Adicione testes.

### Para mudanças de configuração

1. Consulte §2 (Configuração Padrão) e §17 (Regras Intocáveis).
2. Se o parâmetro está em §17, NÃO mude sem aprovação.
3. Se não está, mude com justificativa e teste.

---

**FIM DO DOCUMENTO**
