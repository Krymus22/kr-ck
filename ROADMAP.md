# Claude-Killer: Roadmap de Melhorias para Nível Mythos

> **Objetivo**: Compensar um modelo inferior (Kimi K2.6) com técnicas de harness engineering para atingir qualidade próxima ao Claude Fable 5 / Mythos 5.

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

### Qualidade atual

- **1894/1894 testes** passando (0 falhas)
- **71.9% coverage** no SonarQube
- **0 issues** no SonarQube (3 ratings A)
- **7/7 testes E2E** com API real da NVIDIA
- **CI/CD** no GitHub Actions (typecheck + testes)
- **14.106 NCLOC** (linhas de código sem comentário)

---

## Roadmap: 18 Ideias para Implementar

### 🔥 Crítico (maior impacto em "código que roda de primeira")

#### IDEIA 17: Type-check-before-write (pré-validação)
- **O que é**: Antes de aplicar um diff no disco, aplicar em memória, rodar `tsc --noEmit` no resultado, e só escrever se passar.
- **Por que compensa modelo fraco**: O Fable 5 "vê" erros de tipo mentalmente. O Kimi K2.6 não vê — mas o `tsc` vê. Pré-validar simula a capacidade do Fable 5 de "compilar mentalmente".
- **Impacto estimado**: +20-30% redução em código quebrado
- **Esforço**: ~2h
- **Como implementar**: No `aplicarDiff`, depois de computar `newContent` mas antes de `fs.writeFileSync`, escrever num arquivo temporário, rodar `tsc`, e só escrever no real se passar. Se falhar, injetar o erro de volta no modelo.

#### IDEIA 22: Best-of-N com beam search (múltiplas tentativas)
- **O que é**: Gerar 3 versões independentes do diff (com temperatures diferentes), rodar `tsc` em todas, aplicar a com menos erros.
- **Por que compensa modelo fraco**: O Fable 5 gera certo de primeira porque é inteligente. Modelos fracos precisam de mais tentativas — mas com beam search, 3 tentativas de um modelo fraco podem superar 1 tentativa de um modelo forte. Pesquisa confirma 20-30% de ganho.
- **Impacto estimado**: +20-30% em first-pass accuracy
- **Esforço**: ~3h
- **Como implementar**: Quando `effort=max` e a tarefa é editar código, fazer 3 chamadas `chat()` em paralelo com `temperature=0.3, 0.7, 1.0`. Aplicar cada diff num arquivo temporário. Rodar `tsc` em cada. Escolher o com 0 erros. Se nenhum tiver 0, escolher o com menos erros e entrar no self-healing loop.

#### IDEIA 16: Documentação grounding (llms.txt)
- **O que é**: Antes de gerar código que usa uma biblioteca/API, buscar a documentação atualizada dela. Padrão `llms.txt` (2026) — arquivo que bibliotecas expõem pra agentes de IA.
- **Por que compensa modelo fraco**: O Kimi K2.6 pode não saber a API mais recente do React 19 ou Next.js 16, mas se ler a doc atualizada antes de codar, usa a API certa. Causa #1 de código desatualizado é o modelo não conhecer a API atual.
- **Impacto estimado**: +15-25% em código que "roda de primeira"
- **Esforço**: ~3h
- **Como implementar**: Quando o modelo for usar uma API/biblioteca, o harness busca `https://[lib-domain]/llms.txt` ou o `package.json` da lib no npm, extrai a versão atual e a API correta, e injeta no contexto.

### 🟠 Alto impacto

#### IDEIA 9: Speculative execution (best-of-2, escolher melhor)
- **O que é**: Para tarefas críticas, gerar 2 diffs independentes (com keys diferentes do pool), rodar testes em ambos, entregar só o que passar.
- **Impacto estimado**: +15-20% em qualidade de código
- **Esforço**: ~3h

#### IDEIA 18: TDD automatizado (testes antes do código)
- **O que é**: Forçar o modelo a escrever testes ANTES da implementação. Os testes definem o contrato. Depois o modelo implementa até os testes passarem.
- **Por que compensa modelo fraco**: Os testes viram um "oráculo" — o modelo não precisa adivinhar se o código está certo, só precisa fazer os testes passarem.
- **Impacto estimado**: +15-20% em qualidade
- **Esforço**: ~2h

#### IDEIA 23: Spec-first mode (contrato antes do código)
- **O que é**: Antes de codar uma feature, o modelo escreve uma especificação técnica (inputs, outputs, tipos, edge cases). O usuário aprova. Depois o modelo codifica seguindo a spec.
- **Impacto estimado**: +15% em tarefas complexas
- **Esforço**: ~2h

#### IDEIA 10: Tool reduction dinâmica (menos tools = menos confusão)
- **O que é**: Vercel removeu 80% das tools e got 100% success rate (era 80%). Modelo com menos opções toma decisões melhores.
- **Impacto estimado**: +10-15% em accuracy, -30% tokens
- **Esforço**: ~2h
- **Como implementar**: Detectar tipo de tarefa e enviar só as tools relevantes. Ex: "liste arquivos" → só `ler_arquivo` + `buscar_arquivos`.

#### IDEIA 12: Code review sub-agent (verificador independente)
- **O que é**: Após o agente principal terminar, um sub-agente DIFERENTE (com contexto limpo) revisa o diff e aponta problemas. Como um PR review automatizado.
- **Impacto estimado**: +10-15% redução de bugs
- **Esforço**: ~2h

### 🟡 Médio impacto

#### IDEIA 19: Codebase pattern extraction (aprender convenções do projeto)
- **O que é**: Antes de codar, analisar 3-5 arquivos do projeto pra extrair padrões: naming convention, error handling style, import style, etc.
- **Impacto estimado**: +10-15% em consistência de código
- **Esforço**: ~2h

#### IDEIA 20: Self-healing com compiler feedback estruturado
- **O que é**: Quando `tsc`/`lint` falha, pegar a mensagem de erro, estruturá-la (file, line, error code, expected vs got), e injetar de volta com instrução específica.
- **Impacto estimado**: +10-15% em fix-rate
- **Esforço**: ~1h

#### IDEIA 24: Import resolver automático
- **O que é**: Após `aplicar_diff`, fazer um quick scan dos imports no arquivo editado. Verificar se o arquivo alvo existe e se exporta o símbolo.
- **Impacto estimado**: +10-15% em first-pass accuracy
- **Esforço**: ~1h

#### IDEIA 21: Dependency graph awareness (regression prevention)
- **O que é**: Antes de editar um arquivo, saber quais outros arquivos dependem dele. Se a edição mudar uma interface, alertar.
- **Impacto estimado**: +10% redução em regressões
- **Esforço**: ~2h

#### IDEIA 11: Plan-then-execute (modo plano explícito)
- **O que é**: Forçar o modelo a escrever um plano em `TASK_STATE.md` com passos numerados antes de qualquer edição. Depois executar um passo por turno.
- **Impacto estimado**: +10% em tarefas multi-step
- **Esforço**: ~1h

#### IDEIA 14: Failure memory (aprender com erros anteriores)
- **O que é**: Quando um `aplicar_diff` falha, salvar o erro em `.claude-killer/failure_log.md` com contexto. Antes da próxima edição, injetar os erros recentes.
- **Impacto estimado**: -20% erros repetidos
- **Esforço**: ~1h

#### IDEIA 25: Snapshot testing automático
- **O que é**: Antes de editar uma função, capturar o output atual dela. Depois da edição, comparar. Se mudou algo inesperado, alertar.
- **Impacto estimado**: +10% detecção de regressões silenciosas
- **Esforço**: ~3h

### 🟢 Custo / UX

#### IDEIA 8: Dual-model routing (modelo barato + modelo caro)
- **O que é**: Claude Code usa Haiku (barato) pra triagem e Opus (caro) só pra código complexo.
- **Impacto estimado**: -40% custo
- **Esforço**: ~2h

#### IDEIA 13: Progressive context loading (carregar só o necessário)
- **O que é**: Em vez de ler o arquivo inteiro, carregar só a função/classe relevante via `parse_ast` + `ler_arquivo_avancado` com offset/limit.
- **Impacto estimado**: -30% tokens em codebases grandes
- **Esforço**: ~2h

#### IDEIA 15: Graceful shutdown com state persistence
- **O que é**: Handler de SIGINT/SIGTERM que salva TASK_STATE.md, faz checkpoint do histórico, e limpa `.rollback/` temporários.
- **Impacto estimado**: UX (não perde trabalho)
- **Esforço**: ~1h

---

## Priorização Sugerida

### Fase 1: "Código que roda de primeira" (maior ganho)
1. IDEIA 17 — Type-check-before-write (+20-30%)
2. IDEIA 22 — Best-of-N beam search (+20-30%)
3. IDEIA 16 — Documentação grounding (+15-25%)

### Fase 2: Qualidade e consistência
4. IDEIA 18 — TDD automatizado (+15-20%)
5. IDEIA 9 — Speculative execution (+15-20%)
6. IDEIA 12 — Code review sub-agent (+10-15%)
7. IDEIA 10 — Tool reduction dinâmica (+10-15%)
8. IDEIA 23 — Spec-first mode (+15%)

### Fase 3: Prevenção de regressões
9. IDEIA 20 — Self-healing feedback estruturado (+10-15%)
10. IDEIA 24 — Import resolver automático (+10-15%)
11. IDEIA 19 — Codebase pattern extraction (+10-15%)
12. IDEIA 21 — Dependency graph awareness (+10%)
13. IDEIA 14 — Failure memory (-20% erros repetidos)
14. IDEIA 25 — Snapshot testing (+10%)

### Fase 4: Custo e UX
15. IDEIA 11 — Plan-then-execute (+10%)
16. IDEIA 8 — Dual-model routing (-40% custo)
17. IDEIA 13 — Progressive context loading (-30% tokens)
18. IDEIA 15 — Graceful shutdown (UX)

---

## Referências de Pesquisa

- Anthropic Official: "Claude Fable 5 and Claude Mythos 5" (Jun 9, 2026)
- Anthropic System Card: Fable 5 & Mythos 5 (26MB PDF, 11.758 linhas)
- Anthropic Engineering: "Effective Context Engineering for AI Agents"
- Vals AI: SWE-bench Verified leaderboard
- Vellum: Fable 5 benchmarks explained
- Vercel: "We removed 80% of our agent's tools" (100% success rate)
- Cognition: FrontierCode benchmark
- arXiv: "Reducing Code Regressions in AI Coding Agents via Graph-Based"
- arXiv: "Beam Search for Code Agents: Why Greedy Generation Is a Cap"
- llms.txt standard: documentação otimizada para agentes de IA
- Addy Osmani: "How to write a good spec for AI agents"
- Martin Fowler: "Maintainability sensors for coding agents"

---

*Documento gerado em Junho 2026. Atualizar conforme implementação avança.*
