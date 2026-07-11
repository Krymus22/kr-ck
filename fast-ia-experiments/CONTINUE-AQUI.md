# 🔄 CONTINUE AQUI — Guia para retomar o projeto

> Quando você voltar a trabalhar no fast-ia, comece por este arquivo.

---

## ✅ Onde estamos (Julho 2026)

### O que FUNCIONA (não mexer):

1. **v17 single-file** — gera código Luau de 1 arquivo com 0 bugs
   - Testado: PlayerDataManager (~150 linhas) → 0 bugs em 5 rounds, ~4 min
   - Arquivo: `v17-single-file.mjs`
   - Log de sucesso: `logs/v17-success.log`

2. **v19 multi-file** — gera sistema de 5 módulos com 0 bugs (quase)
   - Testado: Economia + Inventário + Loja (~538 linhas) → 4/5 módulos SUCCESS + integration 0 bugs
   - Arquivo: `v19-multi-file.mjs`
   - Log de sucesso: `logs/v19-success.log`
   - Código gerado: `examples/*.lua`

3. **Rate limiter** — token bucket per key, 40 req/min, 4 keys
   - Bug inicial corrigido (RATE_MAX_PER_KEY = 38, não 2)
   - 375 requests sem waits, sem 429

4. **Surgical patcher** — patch só a função bugada + SEARCH/REPLACE fallback
   - Validado em ~50 patches bem-sucedidos

5. **Contratos inline** — assinaturas das deps no prompt do Code Gen
   - Integration Reviewer achou 0 bugs na primeira rodada

---

## ⚠️ O que PRECISA MELHORAR (próximos passos)

### Prioridade 1: EconomyManager bug (v19)

**Problema:** EconomyManager terminou com 1 bug restante após 6 rounds (max).
- Bug: escopo `self` em método definido com `.` em vez de `:`
- O modelo DiffusionGemma tem dificuldade consistente com OOP Luau (`.` vs `:`)

**Solução proposta (v20):**
- Adicionar um reviewer específico: **"OOP Consistency Checker"**
  - Verifica: se função usa `self`, deve ser definida com `:` (não `.`)
  - Verifica: se função é chamada com `:`, definição deve ter `:`
  - Verifica: `setmetatable` correto, `__index` apontando para a tabela certa
- OU: adicionar um pre-pass que normaliza sintaxe OOP antes dos reviewers
- OU: adicionar exemplo de OOP pattern no prompt (MAS usuário pediu sem hardcoded examples — então melhor fazer o reviewer)

### Prioridade 2: Paralelização de reviewers

**Problema:** v19 roda 7 reviewers SEQUENCIALMENTE por round. Cada um demora ~3-10s.
- 7 reviewers × 5 rounds × 5 módulos = ~175 chamadas só de review
- Tempo total: 18 min para 5 módulos

**Solução proposta (v21):**
- Rodar 7 reviewers em paralelo com `Promise.all()`
- Rate limiter já suporta (token bucket é thread-safe)
- Reduziria tempo de 18 min → ~5 min

### Prioridade 3: Cache de reviewers não-mudados

**Problema:** Se código não mudou entre rounds, reviewers redundantes.
- Round 5: 0 bugs → Self-Validation falha → patch → Round 6 re-roda TODOS reviewers

**Solução proposta (v22):**
- Hash do código antes de cada review
- Se hash igual ao round anterior, reusar verdict
- Economiza ~30% das chamadas

### Prioridade 4: Mais tarefas de teste

**Problema:** Só testamos 2 tarefas (PlayerDataManager e Economia+Inventário+Loja).

**Solução proposta:**
- Testar em outros sistemas para validar generalização:
  - Leaderboard global (DataStore ordenado)
  - Trading system (transação cross-player)
  - Quest system (state machine)
  - Combat system (eventos + cooldowns)

---

## 🚀 Como retomar

### Passo 1: Setup ambiente

```bash
# Verificar que tudo ainda funciona
cd /home/z/my-project/claude-killer
cat .env | grep NVIDIA_API_KEYS  # 4 keys presentes

# Selene linter
ls /tmp/selene  # deve existir

# z-ai CLI
which z-ai  # deve estar no PATH
```

### Passo 2: Rodar v19 para confirmar que funciona

```bash
cd /home/z/my-project
node scripts/test-debate-v19.mjs 2>&1 | tee /tmp/v19-test.log
# Deve terminar em ~18 min com 4/5 SUCCESS + integration 0 bugs
```

### Passo 3: Criar v20 (próxima versão)

```bash
cp fast-ia-experiments/v19-multi-file.mjs /home/z/my-project/scripts/test-debate-v20.mjs
# Editar v20 adicionando OOP Consistency Checker
# (ver "Prioridade 1" acima)
```

### Passo 4: Iterar até 5/5 SUCCESS

- Rodar v20
- Se EconomyManager ainda falhar → v21 com mais um reviewer OOP
- Repetir até 5/5 módulos SUCCESS

---

## 📋 Checklist para v20

- [ ] Copiar v19 → v20
- [ ] Adicionar `OOP_CONSISTENCY_CHECKER` prompt
- [ ] Adicionar aos reviewers loop (ficam 8 revisores)
- [ ] Atualizar banner `v20 — OOP Consistency Checker`
- [ ] Rodar v20
- [ ] Se EconomyManager passar → documentar sucesso
- [ ] Se não passar → identificar padrão do bug e planejar v21

---

## 💡 Insights para não esquecer

### Sobre o DiffusionGemma 26B

- **Bom em:** revisar código, traduzir lógica→código, seguir regras estritas
- **Ruim em:** inventar lógica complexa do zero, OOP Luau (`.` vs `:`), sintaxes não-lineares
- **Velocidade:** ~700 tok/s (muito rápido)
- **Custo:** gratuito via NVIDIA NIM

### Sobre o processo

- **Lógica-first é essencial** — sem isso, modelo inventa bug
- **Contratos inline** — modelo não adivinha API dos imports
- **Surgical patches** — patcher que reescreve código inteiro introduz bugs novos
- **Selene como gatekeeper** — patch sem validação é perigoso
- **Devil's Advocate com FIX obrigatório** — separa bug de sugestão
- **Strict gate** — aceitar "best" com bugs é derrota

### Sobre rate limiting

- **40 req/min/key, 4 keys = 160 req/min total**
- **Margem de 2** (use 38 como limite) — evita edge cases
- **Sliding window** (não fixed window) — mais preciso
- **Reservar slot ANTES de chamar** — evita race condition entre callers concorrentes

### Sobre multi-arquivo

- **DAG topológica é obrigatória** — sem ordem, módulos não veem deps prontas
- **Contratos no prompt** — Integration Reviewer funciona de primeira
- **Cross-file bugs têm FILE= prefix** — sem isso, não sabe onde patchear

---

## 📞 Contexto do projeto maior

Este projeto é parte do **Claude-Killer** — um CLI tool (Ink/React TUI) que encapsula LLM APIs.

- Repo: `https://github.com/Krymus22/kr-ck.git`
- Branch: `master`
- O fast-ia-experiments é uma **sub-pasta** do claude-killer, não um repo separado
- O claude-killer tem 3 modos: Agent, Orchestrator (com planner+coder+scout), e este fast-ia-experiments (experimental)

A ideia era: se conseguirmos 0 bugs com modelo pequeno, podemos usar isso no modo Orchestrator para gerar código mais rápido e barato que GLM 5.2.

---

## 🎯 Meta final (quando retomar)

**Sistema multi-arquivo de 10+ módulos com 0 bugs em <30 min, 100% DiffusionGemma 26B.**

Estamos em 5 módulos, 4/5 SUCCESS, 18 min. Falta pouco.
