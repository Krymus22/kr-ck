# Claude-Killer: Roadmap de Melhorias para Nível Mythos

> **Objetivo**: Usar engenharia de harness para fazer um modelo inferior (Kimi K2.6) pensar de forma mais inteligente, mantendo qualidade de código próxima ao Claude Fable 5 / Mythos 5.
>
> **Premissa**: Harness engineering não é "compensar burrice" — é estruturar o trabalho de forma que qualquer modelo competente consiga executar bem. O MiMo Code da Xiaomi provou isso empiricamente: modelo inferior + harness superior > modelo superior + harness inferior, em tarefas longas.

---

## Estado Atual (implementado e validado)

### Features já em produção ✅

| # | Feature | Arquivo | Impacto |
|---|---|---|---|
| 1 | Think Tool (pensar) | `thinkTool.ts` | Raciocínio estruturado antes de cada escrita |
| 2 | Read-before-write gate | `readBeforeWrite.ts` | Previne alucinação de conteúdo de arquivo |
| 3 | Rollback automático | `rollbackStore.ts` | Backup + `desfazer_edicao` |
| 4 | Strict Quality Gate | `strictQualityGate.ts` | `tsc` + `lint` bloqueantes no `finish_reason` |
| 5 | Schema Validation | `toolSchemaValidation.ts` | Valida args contra JSON Schema antes de executar |
| 6 | Poka-Yoke | `pokaYoke.ts` | Paths absolutos, diff structure, descrições expandidas |
| 7 | TASK_STATE.md | `taskState.ts` | Notas estruturadas (feito/falta/decisões/bugs) |
| 8 | Async Command Execution | `tools.ts` | `spawn` com streaming (não bloqueia event loop) |
| 9 | LSP Integration | `lspClient.ts` | tsserver/pylsp reais com fallback tree-sitter |
| 10 | Effort Levels | `effortLevels.ts` | Low/Medium/High/Max via system prompt |
| 11 | Self-validation | `selfValidation.ts` | Força reflexão antes do finish_reason |
| 12 | Model-based compaction | `contextCompaction.ts` | LLM sumariza preservando decisões/bugs/planos |
| 13 | Sub-agentes paralelos | `subAgents.ts` | Em-processo, retry + checkpoint, chaves diferentes |
| 14 | Auto-test generation | `autoTestGenerator.ts` | Sugere teste pós-diff (skip Luau/Roblox) |
| 15 | Context injection | `contextInjector.ts` | Auto-reler TASK_STATE.md antes de decisões |
| 16 | Multi-key pool | `apiKeyPool.ts` | Round-robin, 429 cooldown, métricas |
| 17 | Parallel tool calls | `apiClient.ts` | `parallel_tool_calls: true` + paralelização real |
| 18 | Extension Hub unificado | `extensionCenter.ts` | Skills + Tools + MCPs + Features num só hub |
| 19 | Feature toggles | `extensionCenter.ts` | 14 features toggleable via Hub |
| 20 | Ctrl+E fix | `App.tsx` | TextInput escondido quando Hub aberto |
| 21 | Effort level na StatusBar | `StatusBar.tsx` | Mostra `MEDIUM ⚙` ao lado da barra de contexto |
| 22 | Tokens/segundo | `App.tsx` + `StatusBar.tsx` | Trackeado durante streaming |
| 23 | Slash commands novos | `App.tsx` | `/effort` e `/pool` |
| 24 | Temperature/TopP/MaxTokens | `config.ts` | Configuráveis via env vars (NVIDIA recommended) |

### Qualidade atual

- **1891/1891 testes** passando (0 falhas)
- **71.6% coverage** no SonarQube
- **0 issues** no SonarQube (3 ratings A)
- **7/7 testes E2E** com API real da NVIDIA
- **CI/CD** no GitHub Actions (typecheck + testes)
- **14.106 NCLOC** (linhas de código sem comentário)
- Repo: https://github.com/Krymus22/claude-killer

---

## Evidência: Harness Engineering supera Modelo

O **MiMo Code** da Xiaomi prova empiricamente que harness engineering faz modelo inferior superar modelo superior em tarefas longas:

- **MiMo-V2.5-Pro** (modelo inferior) + MiMo Code harness > Claude Fable 5 + Claude Code em tarefas 200+ passos
- MiMo Code é open-source (MIT), baseado em OpenCode
- 3 pilares: **Computação, Memória, Evolução**

### Técnicas do MiMo Code que validam nossa direção

| Técnica MiMo Code | Nossa equivalente | Status |
|---|---|---|
| Max Mode (N=5 sampling paralelo) | IDEIA 22 (Best-of-N beam search) | ❌ Pendente |
| Goal (verificação de término independente) | IDEIA 12 (Code review sub-agent) | ❌ Pendente |
| Dynamic Workflow (código no lugar de prompt) | NOVA IDEIA 26 | ❌ Pendente |
| Checkpoint-writer subagent independente | Melhoria da IDEIA 14 | ❌ Pendente |
| Extração antecipada (20% não 95%) | Melhoria do nosso compaction | ❌ Pendente |
| 4 camadas de memória com promoção | memory.ts tem 4 camadas, mas sem promoção automática | ⚠️ Parcial |
| Rebuild injection estruturado | Nosso compaction é um sumário simples | ❌ Pendente |
| notes.md scratchpad | TASK_STATE.md | ✅ Temos |

---

## Roadmap Atualizado: 19 Ideias para Implementar

### 🔥 Fase 1: "Código que roda de primeira" (maior ganho comprovado)

#### IDEIA 22: Max Mode — Best-of-N beam search (MÚLTIPLAS TENTATIVAS)
- **O que é**: Gerar N candidatos (default 5) em paralelo por turno. Cada candidato raciocina e planeja tool calls independentemente. O próprio modelo julga qual é o melhor ANTES de executar.
- **Evidência**: MiMo Code reporta +10-20% no SWE-Bench Pro com N=5. Custo: ~4-5x tokens.
- **Como implementar**: Quando `effort=max`, fazer N chamadas `chat()` em paralelo (usando chaves diferentes do pool) com `temperature=1.0`. Cada uma retorna um plano de ação. Uma chamada adicional (judge, `temperature=0`) compara os N planos e seleciona o melhor. Só o plano selecionado é executado.
- **Impacto estimado**: +10-20% first-pass accuracy (comprovado pelo MiMo Code)
- **Esforço**: ~3h
- **Dependência**: Multi-key pool (✅ já temos)

#### IDEIA 17: Type-check-before-write (PRÉ-VALIDAÇÃO)
- **O que é**: Antes de aplicar um diff no disco, aplicar em memória, rodar `tsc --noEmit` no resultado, e só escrever se passar. Se falhar, injetar o erro de volta no modelo ANTES de commitar.
- **Como implementar**: No `aplicarDiff`, depois de computar `newContent` mas antes de `fs.writeFileSync`, escrever num arquivo temporário, rodar `tsc`, e só escrever no real se passar.
- **Impacto estimado**: +20-30% redução em código quebrado
- **Esforço**: ~2h

#### IDEIA 16: Documentação grounding (llms.txt)
- **O que é**: Antes de gerar código que usa uma biblioteca/API, buscar a documentação atualizada. Padrão `llms.txt` (2026) — arquivo que bibliotecas expõem pra agentes de IA.
- **Como implementar**: Quando o modelo for usar uma API/biblioteca, o harness busca `https://[lib-domain]/llms.txt` ou o `package.json` da lib no npm, extrai a versão atual e a API correta, e injeta no contexto.
- **Impacto estimado**: +15-25% em código que "roda de primeira"
- **Esforço**: ~3h

### 🟠 Fase 2: Verificação e Memória (prevenção de erros em tarefas longas)

#### IDEIA 26: Goal — Verificador de término independente (NOVA)
- **O que é**: Verificador independente checa se a tarefa realmente acabou. Recebe o mesmo contexto que o agente, mas NÃO participou do trabalho — então não tem viés de "eu fiz isso, deve estar certo".
- **Evidência**: MiMo Code reporta que falsos "terminei" são a causa #1 de falha em tarefas longas autônomas. Probabilidade de loop infinito < 0.5%.
- **Como implementar**: Quando o agente tenta terminar (finish_reason=stop) em `effort=high/max`, disparar uma chamada `chat()` independente com o prompt: "Analise o histórico completo. A tarefa do usuário foi realmente completada? Liste especificamente o que falta. Responda DONE ou NOT_DONE com razões." Se NOT_DONE, injetar o feedback e continuar.
- **Impacto estimado**: -80% término prematuro em tarefas longas
- **Esforço**: ~2h
- **Diferença da nossa self-validation**: Self-validation faz o MESMO modelo refletir. Goal é um verificador INDEPENDENTE com contexto limpo — sem viés.

#### IDEIA 27: Checkpoint-writer subagent independente (NOVA)
- **O que é**: Um sub-agente separado extrai estado estruturado em checkpoints (20%, 45%, 70% do contexto), não quando está quase cheio (75% como hoje).
- **Evidência**: MiMo Code prova que extrair cedo (20%) é melhor que tarde (95%) porque o modelo extrai melhor com contexto leve. "Lost in the middle" — em 95% o modelo não consegue sumarizar bem.
- **Como implementar**: Em vez de compaction reativa (roda quando contexto > 75%), ter 3 checkpoints proativos (20%, 45%, 70%). Cada um dispara um sub-agente writer que atualiza um arquivo de estado estruturado com 11 campos: intenção atual, próxima ação, constraints, árvore de tarefas, trabalho atual, arquivos envolvidos, descobertas cross-task, erros e correções, estado de runtime, decisões de design, notas miscelâneas.
- **Impacto estimado**: +30% em continuidade de tarefas longas
- **Esforço**: ~3h
- **Diferença do nosso model-compaction**: Nosso compaction é reativo e sumariza. Checkpoint-writer é proativo e extrai estruturado.

#### IDEIA 28: Extração antecipada (20% não 75%) (NOVA)
- **O que é**: Mudar os gatilhos de compaction de 75% para checkpoints em 20%, 45%, 70%.
- **Evidência**: MiMo Code: "Asking the model to perform the most critical compression at the very moment when its compression ability is degrading is a bad trade-off."
- **Como implementar**: Modificar `smartCompact()` em `contextCompaction.ts` para disparar em 3 pontos em vez de 1. Cada checkpoint é incremental (não one-shot).
- **Impacto estimado**: +15% em qualidade de compaction
- **Esforço**: ~1h
- **Dependência**: IDEIA 27

#### IDEIA 12: Code review sub-agent (verificador independente)
- **O que é**: Após o agente principal terminar, um sub-agente DIFERENTE (com contexto limpo) revisa o diff e aponta problemas. Como um PR review automatizado.
- **Como implementar**: Após `finish_reason=stop` com arquivos modificados, disparar `explorar_subagente` com a pergunta "revise este diff e liste problemas: [diff]". Se encontrar problemas, injetar de volta.
- **Impacto estimado**: +10-15% redução de bugs
- **Esforço**: ~2h

#### IDEIA 14: Failure memory (aprender com erros anteriores) — MELHORADA
- **O que é**: Quando um `aplicar_diff` falha, salvar o erro em `.claude-killer/failure_log.md` com contexto. Antes da próxima edição, injetar os erros recentes. Writer independente roteia notas livres do agente pra campos estruturados.
- **Impacto estimado**: -20% erros repetidos
- **Esforço**: ~1h

### 🟡 Fase 3: Orquestração determinística

#### IDEIA 29: Dynamic Workflow — código no lugar de prompt (NOVA)
- **O que é**: Orquestração de tarefas complexas vira código JavaScript determinístico executado num sandbox, não prompt em linguagem natural.
- **Evidência**: MiMo Code: "Natural language is ambiguous, forgettable, and unverifiable. An if statement will not forget a branch, a for loop will not exit prematurely."
- **Como implementar**: Permitir que o agente gere um script JS que orquestra sub-agentes via `agent()` e controla concorrência via `parallel()`/`pipeline()`. O script é executado deterministicamente no Node.js em vez de o modelo tentar seguir passos em prompt.
- **Impacto estimado**: +20% em tarefas multi-step complexas
- **Esforço**: ~4h

#### IDEIA 23: Spec-first mode (contrato antes do código)
- **O que é**: Antes de codar uma feature, o modelo escreve uma especificação técnica (inputs, outputs, tipos, edge cases). Depois codifica seguindo a spec.
- **Impacto estimado**: +15% em tarefas complexas
- **Esforço**: ~2h

#### IDEIA 18: TDD automatizado (testes antes do código)
- **O que é**: Forçar o modelo a escrever testes ANTES da implementação. Os testes viram oráculo.
- **Impacto estimado**: +15-20% em qualidade
- **Esforço**: ~2h

#### IDEIA 11: Plan-then-execute (modo plano explícito)
- **O que é**: Forçar o modelo a escrever um plano com passos numerados antes de qualquer edição. Depois executar um passo por turno.
- **Impacto estimado**: +10% em tarefas multi-step
- **Esforço**: ~1h

### 🟢 Fase 4: Eficiência e UX

#### IDEIA 10: Tool reduction dinâmica (menos tools = menos confusão)
- **O que é**: Detectar tipo de tarefa e enviar só as tools relevantes. Vercel removeu 80% das tools e got 100% success rate.
- **Impacto estimado**: +10-15% accuracy, -30% tokens
- **Esforço**: ~2h

#### IDEIA 19: Codebase pattern extraction (aprender convenções)
- **O que é**: Analisar 3-5 arquivos do projeto pra extrair padrões (naming, error handling, import style).
- **Impacto estimado**: +10-15% consistência
- **Esforço**: ~2h

#### IDEIA 20: Self-healing com compiler feedback estruturado
- **O que é**: Quando `tsc`/`lint` falha, estruturar o erro (file, line, code, expected vs got) antes de injetar.
- **Impacto estimado**: +10-15% fix-rate
- **Esforço**: ~1h

#### IDEIA 24: Import resolver automático
- **O que é**: Após `aplicar_diff`, verificar se imports existem e exportam os símbolos usados.
- **Impacto estimado**: +10-15% first-pass accuracy
- **Esforço**: ~1h

#### IDEIA 21: Dependency graph awareness (regression prevention)
- **O que é**: Antes de editar um arquivo, saber quais outros dependem dele.
- **Impacto estimado**: +10% redução em regressões
- **Esforço**: ~2h

#### IDEIA 25: Snapshot testing automático
- **O que é**: Capturar output de função antes/depois da edição e comparar.
- **Impacto estimado**: +10% detecção de regressões silenciosas
- **Esforço**: ~3h

#### IDEIA 8: Dual-model routing (modelo barato + caro)
- **O que é**: Tarefas simples usam modelo menor; complexas usam Kimi K2.6.
- **Impacto estimado**: -40% custo
- **Esforço**: ~2h

#### IDEIA 13: Progressive context loading (carregar só o necessário)
- **O que é**: Ler só a função relevante via AST + offset/limit.
- **Impacto estimado**: -30% tokens
- **Esforço**: ~2h

#### IDEIA 15: Graceful shutdown com state persistence
- **O que é**: SIGINT/SIGTERM salva TASK_STATE.md + checkpoint.
- **Impacto estimado**: UX (não perde trabalho)
- **Esforço**: ~1h

---

## Priorização Atualizada (baseada em evidência do MiMo Code)

### Fase 1: Comprovado pelo MiMo Code (+10-30% each)
1. **IDEIA 22** — Max Mode best-of-N (+10-20%, comprovado)
2. **IDEIA 17** — Type-check-before-write (+20-30%)
3. **IDEIA 16** — Documentação grounding (+15-25%)

### Fase 2: Verificação e Memória (prevenção de falhas em tarefas longas)
4. **IDEIA 26** — Goal verifier independente (-80% término prematuro)
5. **IDEIA 27** — Checkpoint-writer subagent (+30% continuidade)
6. **IDEIA 28** — Extração antecipada 20/45/70% (+15% compaction)
7. **IDEIA 12** — Code review sub-agent (+10-15% redução bugs)
8. **IDEIA 14** — Failure memory (-20% erros repetidos)

### Fase 3: Orquestração determinística
9. **IDEIA 29** — Dynamic Workflow (+20% multi-step)
10. **IDEIA 23** — Spec-first mode (+15%)
11. **IDEIA 18** — TDD automatizado (+15-20%)
12. **IDEIA 11** — Plan-then-execute (+10%)

### Fase 4: Eficiência e UX
13. **IDEIA 10** — Tool reduction (+10-15%, -30% tokens)
14. **IDEIA 20** — Self-healing estruturado (+10-15% fix-rate)
15. **IDEIA 24** — Import resolver (+10-15%)
16. **IDEIA 19** — Pattern extraction (+10-15%)
17. **IDEIA 21** — Dependency graph (+10%)
18. **IDEIA 25** — Snapshot testing (+10%)
19. **IDEIA 8** — Dual-model routing (-40% custo)
20. **IDEIA 13** — Progressive context (-30% tokens)
21. **IDEIA 15** — Graceful shutdown (UX)

---

## Referências de Pesquisa

### Evidência primária
- **Xiaomi MiMo Code**: "Scaling Coding Agents to Long-Horizon Tasks" (Jun 10, 2026)
  - MiMo-V2.5-Pro (modelo inferior) + harness superior > Claude Code em 200+ steps
  - 3 pilares: Computação (Max Mode, Goal), Memória (checkpoint-writer, 4 camadas), Evolução
  - Max Mode: +10-20% no SWE-Bench Pro com N=5
  - Open-source MIT: https://github.com/XiaomiMiMo/MiMoCode

- **Anthropic Fable 5/Mythos 5 System Card** (Jun 9, 2026)
  - SWE-bench Verified: 95.0% (Fable 5) vs 88.6% (Opus 4.8)
  - Memory em tarefas longas: 3x ganho vs Opus 4.8
  - Persistent file-based memory é central

- **Anthropic "Effective Context Engineering"** (Sep 2025)
  - Compaction, note-taking, sub-agent architectures
  - Claude Code implementa checkpoint-writer

### Harness Engineering
- **Vercel**: "We removed 80% of our agent's tools" (100% success rate, era 80%)
- **arXiv**: "Beam Search for Code Agents: Why Greedy Generation Is a Cap" (+20-30%)
- **arXiv**: "Reducing Code Regressions via Graph-Based Detection"
- **llms.txt** standard: documentação otimizada para agentes de IA
- **Addy Osmani**: "How to write a good spec for AI agents"
- **Martin Fowler**: "Maintainability sensors for coding agents"
- **Cognition**: FrontierCode benchmark (Fable 5: 29.3%, Opus 4.8: 13.4%)

### Claude Code architecture
- **VILA-Lab/Dive-into-Claude-Code**: arquitetura dissecada
  - Sub-agent delegation via sidechain transcripts
  - Dual model: heavyweight (Opus) + lightweight (Haiku)
  - 6 built-in agent definitions + custom
  - SkillTool vs AgentTool: inject vs spawn
  - Plan mode: ~7× tokens, mas previne drift
  - Memory: AGENTS.md, SOUL.md, TOOLS.md, MEMORY.md, daily notes

---

*Documento atualizado em Junho 2026 com evidência do MiMo Code.*
*Premissa revisada: harness engineering faz modelo pensar de forma mais inteligente, não apenas "compensa" modelo fraco.*
