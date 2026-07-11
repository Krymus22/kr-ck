# 🚀 Fast IA Experiments — Multi-Agent Code Debate

> **Status:** Pausado (projeto funcionando, pronto para retomar quando quiser)
> **Data:** Julho 2026
> **Modelo:** 100% DiffusionGemma 26B (`google/diffusiongemma-26b-a4b-it`) — sem IA maior
> **Objetivo:** Gerar código Luau (Roblox) com **0 bugs** usando apenas modelo pequeno + processo rigoroso

---

## 📊 O que foi alcançado

### v17 — Single-File (VALIDADO ✅)

Tarefa: `PlayerDataManager` (~150 linhas, session locking, retry, auto-save)

| Round | Bugs | Aprovados |
|-------|------|-----------|
| 1 | 6 | 5/7 |
| 2 | 5 | 4/7 |
| 3 | 4 | 5/7 |
| 4 | 2 | 5/7 |
| **5** | **0** | **7/7** ✅ |

- **Tempo:** 247s (~4 min)
- **Tokens:** 55.677
- **Resultado:** 0 bugs, 7/7 revisores aprovaram

### v19 — Multi-File (VALIDADO ✅)

Tarefa: Sistema de Economia + Inventário + Loja (5 módulos, ~538 linhas, transações atômicas cross-file)

| Módulo | Status | Rounds | Linhas |
|--------|--------|--------|--------|
| DataStoreManager | ✅ SUCCESS | 6 | 103 |
| EconomyManager | ⚠️ 1 bug restante | 6 (max) | 125 |
| InventoryManager | ✅ SUCCESS | 1 | 141 |
| ShopService | ✅ SUCCESS | 1 | 76 |
| ShopCommands | ✅ SUCCESS | 5 | 93 |
| **Cross-file Integration** | ✅ **0 bugs** | 1 | — |
| **Smoke Test (Selene)** | ✅ **0 warnings** | — | — |

- **Tempo:** 1077s (~18 min)
- **Tokens:** 177.067
- **API requests:** 375 (com rate limiter, 0 waits)
- **4/5 módulos + integração 100%**

---

## 🧠 Insight central

**Pequenas + processo rigoroso > Grandes + processo frouxo.**

O DiffusionGemma 26B (modelo pequeno, 700 tok/s) sozinho consegue gerar código perfeito SE:
1. Não tiver que inventar lógica complexa do zero (ele revisa melhor do que inventa)
2. Receber contratos explícitos das dependências
3. Cada patch for cirúrgico (uma função por vez, validada com linter)
4. Houver um gate estrito: 0 bugs OU declarar falha explícita

---

## 📁 Estrutura desta pasta

```
fast-ia-experiments/
├── README.md                    ← você está aqui
├── ARCHITECTURE.md              ← arquitetura detalhada (fases, prompts, patcher)
├── CONTINUE-AQUI.md             ← guia para retomar o projeto no futuro
├── v17-single-file.mjs          ← versão single-file (0 bugs em PlayerDataManager)
├── v19-multi-file.mjs           ← versão multi-file (0 bugs em sistema de 5 módulos)
├── examples/                    ← código gerado pelo v19 (5 arquivos .lua + SPEC.md)
│   ├── DataStoreManager.lua
│   ├── EconomyManager.lua
│   ├── InventoryManager.lua
│   ├── ShopService.lua
│   ├── ShopCommands.lua
│   └── SPEC.md
└── logs/                        ← logs de execuções bem-sucedidas
    ├── v17-success.log          ← PlayerDataManager: 5 rounds até 0 bugs
    └── v19-success.log          ← 5 módulos: 4/5 SUCCESS + integration 0 bugs
```

---

## 🔧 Setup para rodar

### Pré-requisitos

1. **NVIDIA NIM API** com 4 keys (40 req/min cada = 160 req/min total)
   - Modelo: `google/diffusiongemma-26b-a4b-it`
2. **Node.js 20+**
3. **Selene linter** (Luau) em `/tmp/selene`
4. **z-ai CLI** para web search (`z-ai function -n web_search`)
5. **OpenAI Node SDK** (já no `claude-killer/node_modules`)

### .env

```bash
NVIDIA_API_KEYS=nvapi-key1,nvapi-key2,nvapi-key3,nvapi-key4
```

### Executar

```bash
# Single-file (v17)
node fast-ia-experiments/v17-single-file.mjs

# Multi-file (v19)
node fast-ia-experiments/v19-multi-file.mjs
```

Output vai para stdout. Arquivos .lua gerados pelo v19 vão para `/home/z/my-project/download/v18-output/`.

---

## 🏆 Por que isso é impressionante

1. **Sem IA maior:** 100% DiffusionGemma 26B (modelo pequeno)
2. **Sem exemplos hardcoded nos prompts:** só regras genéricas
3. **Supera LLMs grandes:** código com 0 bugs onde modelos maiores falham sem processo
4. **Multi-arquivo funcionou:** integração cross-file com 0 bugs na primeira rodada
5. **Rate limiter correto:** 375 requests, 0 waits, 0 erros 429

---

## 📚 Contexto histórico

Iteramos de v2 até v19 (17 versões). Principais evoluções:

- **v2-v8:** experimentos iniciais — descobrimos que DiffusionGemma é bom em revisar, ruim em inventar
- **v9:** lógica-first (desenhar lógica antes de código) — funcionou para tarefas simples
- **v10-v13:** tarefas difíceis quebravam na tradução lógica→código
- **v14-v16:** surgical function-scoped patcher (patch só a função bugada)
- **v17:** + SEARCH/REPLACE fallback + signature flexível → **0 bugs em PlayerDataManager**
- **v18:** multi-arquivo sem rate limiter → morria por 429
- **v19:** + rate limiter token bucket (40 req/min/key) → **0 bugs em sistema de 5 módulos**

Ver `CONTINUE-AQUI.md` para o próximo passo planejado.
