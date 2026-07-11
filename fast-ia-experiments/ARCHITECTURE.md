# 🏗️ Architecture — Multi-Agent Code Debate

> Documentação técnica completa do sistema v17 (single-file) e v19 (multi-file).

---

## 🎯 Princípio fundamental

```
NÃO peça para o modelo INVENTAR código.
Peça para ele:
  1. Desenhar a LÓGICA (pseudocódigo)
  2. Verificar a lógica com traces
  3. TRADUZIR lógica → código (sem inventar nada novo)
  4. Revisar o código com múltiplos agentes especializados
  5. Patch cirúrgico: só a função bugada, validada com linter
```

---

## 📐 v17 — Single-File (4 fases)

### Phase 1: Logic Design + Verification

```
┌─────────────────────────────────────────────┐
│  Logic Designer (gen, temp=0.4)             │
│  "Design logic in pseudocode. NO Lua code." │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│  Logic Verifier (review, temp=0.15)         │
│  "Trace EACH test input. APROVADO/REJEITADO"│
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│  API Design Reviewer (review, temp=0.15)    │
│  "Checklist: UpdateAsync, pcall, no SetAsync│
│   Cross-module call signature match"        │
└──────────────────┬──────────────────────────┘
                   ↓
        (loop until both approve, max 5 rounds)
```

### Phase 2: Code Generation + Review Loop

```
┌─────────────────────────────────────────────┐
│  Code Gen from Logic (gen, temp=0.4)        │
│  "Translate EXACTLY. Do NOT add flags,      │
│   variables, or logic NOT in the flow."     │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│  7 Reviewers (em paralelo conceitual):      │
│  1. Selene (linter estático)                │
│  2. Logic Diff (code vs verified logic)     │
│  3. Syntax Checker                          │
│  4. Correctness Reviewer (trace + edge)     │
│  5. API Verifier (Roblox APIs)              │
│  6. Edge Case Hunter                        │
│  7. Devil's Advocate (com FIX obrigatório)  │
└──────────────────┬──────────────────────────┘
                   ↓
        (se 0 bugs E 7/7 aprovam → Self-Validation)
                   ↓
┌─────────────────────────────────────────────┐
│  Self-Validation (honesty check)            │
│  "Return reference? ALL local? Crashes?     │
│   GetAsync→SetAsync?"                       │
└──────────────────┬──────────────────────────┘
                   ↓
        (se 0 bugs → SUCCESS. Senão → patch loop)
```

### Surgical Patch Loop

```
Para cada bug (ordenado por linha DESC):
  1. extractFunction(code, bug.line)
     → acha função contendo a linha (style: function Foo:bar() OU Foo.bar = function())
     → balanceia function/do/for/while/if-then vs end
  2. Se achou função:
     → SURGICAL_PATCHER recebe SÓ a função + bug
     → retorna função corrigida
     → signature check (nome após . ou :)
     → replaceFunction() substitui no código
     → validatePatch(): Selene antes vs depois
       (se NOVAS warnings → REVERT este patch)
     → PATCH_REVIEWER: "patch realmente corrige? introduz bug?"
       (se REJEITADO → REVERT)
  3. Se NÃO achou função (bug em nível de módulo):
     → SEARCH/REPLACE fallback
     → LLM retorna blocos ```search e ```replace
     → parser tolerante (``` ou ''' ou ~~~, com/sem header)
     → match exato primeiro, depois fuzzy (whitespace-normalized)
     → validatePatch() com Selene
```

### Strict Gate

```javascript
// SÓ declara SUCCESS se:
if (unique.length === 0 && approvals >= verdicts.length) {
  // Self-validation também deve passar
  if (selfValidation.bugs.length === 0) {
    return SUCCESS;
  }
}
// Senão, continua até MAX_CODE_ROUNDS
// Se acabou com bugs → declara FAILURE explícito (não aceita "best")
```

---

## 📐 v19 — Multi-File (5 fases)

### Phase 0: Architecture Design

```
┌─────────────────────────────────────────────┐
│  Architect (gen, temp=0.4)                  │
│  "Design MULTI-FILE system. Output:         │
│   === MODULE: <name> ===                    │
│   FILE: <name>.lua                          │
│   DEPENDS_ON: <modules>                     │
│   DESCRIPTION: <purpose>                    │
│   PUBLIC API:                               │
│   - <signature 1>                           │
│   - <signature 2>                           │
│   === DAG ORDER ===                         │
│   A -> B -> C"                              │
└──────────────────┬──────────────────────────┘
                   ↓
┌─────────────────────────────────────────────┐
│  Arch Verifier (review, temp=0.15)          │
│  "DAG acíclica? API cobre propósito?        │
│   Assinaturas completas (params+types)?     │
│   Ordem topológica correta?"                │
└──────────────────┬──────────────────────────┘
                   ↓
        (loop until approved, max 4 rounds)
```

**Parser:** regex extrai módulos + DAG. Fallback: Kahn's algorithm se DAG order não vier explícita.

### Phase 1: Per-Module Logic (topological order)

Para CADA módulo M na ordem topológica:
```
Logic Designer recebe:
  - Spec do módulo M
  - CONTRATOS das deps de M (assinaturas inline!)
  - Task + test inputs

Logic Verifier + API Design Reviewer (mesmo do v17)
```

**Chave:** contratos das deps são inline no prompt, então o modelo não precisa adivinhar a API dos imports.

### Phase 2: Per-Module Code (topological order)

Para CADA módulo M:
```
Code Gen recebe:
  - Logic flow verificado de M
  - Spec de M
  - CONTRATOS das deps (assinaturas EXATAS)

7 Reviewers (mesmo do v17, mas com cross-module awareness)

Surgical Patches (mesmo do v17)

Strict Gate: 0 bugs OU FAILURE explícito
```

### Phase 3: Cross-File Integration

```
┌─────────────────────────────────────────────┐
│  Integration Reviewer vê TODOS arquivos      │
│  + contratos de TODOS módulos               │
│                                              │
│  Para cada cross-module call (A chama B.foo):│
│  1. B.foo existe no PUBLIC API de B?         │
│  2. Arg count + types batem com signature?  │
│  3. Return value tratado corretamente?       │
│  4. require() path correto?                 │
│                                              │
│  Para cada shared data flow:                │
│  5. Data shape consistente entre A e B?     │
│                                              │
│  Para cada cross-module STATE:              │
│  6. Ordem de chamadas correta (init→use)?  │
│  7. Lifecycle match (load→save)?            │
│                                              │
│  Bug format: BUG [FILE=<name> L<line>]      │
└──────────────────┬──────────────────────────┘
                   ↓
  Agrupa bugs por arquivo, patcha cada um
  (surgical patches do v17, por arquivo)
```

### Phase 4: Smoke Test

```
Para cada módulo:
  runSelene(code)
  se warnings > 0 → smoke falha
```

---

## 🎛️ Rate Limiter (v19)

### Problema
NVIDIA NIM: 40 req/min por key. Com 4 keys = 160 req/min total.
Sem rate limiter → 429 → processo morre.

### Solução: Token bucket per key, sliding window

```javascript
const RATE_LIMIT_PER_KEY = 40;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_KEY = RATE_LIMIT_PER_KEY - 2; // 38, margem de segurança

// Per-key: array de timestamps das últimas requests
const keyRequestLog = allKeys.map(() => []);

async function waitForSlot() {
  while (true) {
    purgeOldRequests(Date.now()); // remove timestamps > 60s
    // Acha key com MENOS requests recentes (mais capacidade)
    const { idx, count } = findBestKey();
    if (count < RATE_MAX_PER_KEY) {
      keyRequestLog[idx].push(Date.now()); // RESERVA slot
      return idx;
    }
    // Todas as keys cheias — espera a mais velha expirar
    const minWaitMs = computeMinWait();
    await sleep(minWaitMs);
  }
}
```

### Bug que tivemos (e corrigimos)

```javascript
// ❌ ERRADO (v19 inicial):
const RATE_SAFETY_MARGIN = 2;
if (count < RATE_SAFETY_MARGIN) { ... }  // só 2 req/key/min!

// ✅ CORRETO (v19 final):
const RATE_MAX_PER_KEY = RATE_LIMIT_PER_KEY - 2; // 38
if (count < RATE_MAX_PER_KEY) { ... }  // 38 req/key/min
```

Resultado: 375 requests, **0 waits**, 0 erros 429.

---

## 🤖 Prompts-chave (sem exemplos hardcoded)

### Logic Designer
```
You are a SYSTEM ARCHITECT. Design the LOGIC for a Roblox Luau module.
DO NOT write Lua code. Write the LOGIC FLOW in structured pseudocode.
FORMAT: FUNCTION <name>(<params>): STEP 1: ... RETURN: ...
Be SPECIFIC about DataStore methods, UpdateAsync callback, pcall, nil handling.
CRITICAL: NEVER GetAsync→SetAsync (race). ALWAYS UpdateAsync for read-modify-write.
```

### Code Gen from Logic
```
You receive a VERIFIED LOGIC FLOW. Translate it into Lua/Luau code.
- Translate the logic EXACTLY as specified
- Do NOT add flags, variables, or logic that is NOT in the flow
- Do NOT omit anything from the flow
- Do NOT "improve" or "optimize" — just translate
- ALL variables must be "local"
- Use UpdateAsync, NEVER SetAsync
```

### Devil's Advocate (com FIX obrigatório)
```
IMPORTANT: Only report a bug if you can provide a SPECIFIC FIX (corrected code).
If you CANNOT provide a fix, it's a SUGGESTION, not a bug → APROVADO COM RESSALVAS.

1. What input would CRASH this code? (provide the fix)
2. What if caller MODIFIES return value? (provide the fix)
3. What if DataStore returns CORRUPTED data? (provide the fix)
...
```

### Surgical Patcher
```
You receive:
- ONE buggy function
- ONE bug description

Your job:
- Return the FIXED function — the ENTIRE function
- Do NOT touch any code OUTSIDE this function
- Do NOT add new variables, flags, or branches not needed for the fix
- Keep the SAME function signature
```

### Integration Reviewer (v19)
```
You are the CROSS-FILE INTEGRATION REVIEWER. You see ALL files.

For EACH cross-module call (A calls B.foo(args)):
1. Does B.foo exist in B's PUBLIC API?
2. Do the arg COUNT and TYPES match B.foo's signature?
3. Does A handle B.foo's return value correctly?
...

Bug format: BUG [FILE=<filename> L<line>]
```

---

## 📊 Stats finais

| Métrica | v17 | v19 |
|---------|-----|-----|
| Arquivos | 1 | 5 |
| Linhas | ~150 | ~538 |
| Tempo | 247s | 1077s |
| Tokens | 55K | 177K |
| API reqs | ~120 | 375 |
| Bugs finais | 0 | 0 (4/5 modules + integration) |
| Rounds | 5 | 5-6 por módulo |

---

## 🔍 Por que funciona

1. **Lógica antes de código:** modelo não precisa inventar; só traduzir
2. **Contratos inline:** modelo não adivinha API dos imports
3. **Surgical patches:** modelo não reescreve código inteiro (introduziria bugs novos)
4. **Selene como gatekeeper:** patch que introduz warning é revertido
5. **Devil's Advocate com FIX obrigatório:** separa bug real de sugestão
6. **Strict gate:** não aceita "best" com bugs; declara FAILURE explícito
7. **Rate limiter:** 160 req/min sem morrer
8. **Multi-agente especializado:** cada reviewer foca em 1 coisa, não tenta fazer tudo
