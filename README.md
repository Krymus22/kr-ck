# Claude-Killer 🤖

> **MVP CLI** — Agente de código local alimentado pelo **Kimi K2.6** via **NVIDIA NIM API**

Uma ferramenta de linha de comando que conecta o modelo Kimi K2.6 ao seu repositório local, permitindo que ele leia, analise, crie e edite arquivos de código diretamente — com um sistema anti-alucinação integrado que valida a sintaxe **antes** de salvar qualquer alteração.

---

## ✨ Funcionalidades

| Módulo | Descrição |
|---|---|
| **Cliente NVIDIA NIM** | Usa a biblioteca OpenAI apontada para `integrate.api.nvidia.com/v1` |
| **Mutex de Concorrência** | Máximo de 1 requisição em andamento — a segunda espera na fila |
| **Rate Limiter** | Janela deslizante de 60 s — nunca ultrapassa N rpm (padrão: 40) |
| **Histórico Stateless** | Array em memória enviado completo a cada requisição |
| **Tool Calling** | `ler_arquivo` e `aplicar_diff` com suporte a function calling nativo |
| **Loop do Agente** | Ciclo ReAct automático: chama tools → recebe resultado → continua |
| **Guardrail Anti-Alucinação** | Valida sintaxe antes de salvar; auto-cura em até 3 tentativas |

---

## 🗂 Estrutura de Arquivos

```
claude-killer/
├── src/
│   ├── index.ts       ← Entry point: REPL, banner, slash commands
│   ├── agent.ts       ← Loop do agente ReAct (orquestra tool calls)
│   ├── apiClient.ts   ← Cliente NVIDIA NIM com Mutex + Rate Limiter
│   ├── history.ts     ← Gerenciador de histórico em memória
│   ├── tools.ts       ← ler_arquivo / aplicar_diff com guardrail
│   ├── guardrail.ts   ← Validação de sintaxe por extensão de arquivo
│   ├── config.ts      ← Configuração centralizada via env vars
│   └── logger.ts      ← Output estilizado com chalk
├── .env.example       ← Template de variáveis de ambiente
├── package.json
└── tsconfig.json
```

---

## 🚀 Setup & Execução

### 1. Instalar dependências

```bash
cd c:\Users\kryst\Downloads\Claude-Killer
npm install
```

### 2. Configurar a API Key

```bash
# Copie o template
copy .env.example .env

# Edite o arquivo .env e coloque sua chave da NVIDIA NIM
# NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxx
```

> 🔑 Obtenha sua chave em: https://build.nvidia.com/ → Kimi K2.6 → Get API Key

### 3. Build e execução

```bash
# Build TypeScript
npm run build

# Executar a CLI
npm start

# Ou em modo dev (sem build)
npm run dev
```

---

## 💬 Uso Interativo

```
╰─ ❯ Leia o arquivo src/index.ts e me explique o que ele faz
╰─ ❯ Crie um arquivo chamado utils/math.ts com funções de soma e multiplicação
╰─ ❯ Refatore o arquivo src/tools.ts para usar async/await em vez de callbacks
```

### Slash Commands

| Comando | Ação |
|---|---|
| `/help` | Lista de comandos disponíveis |
| `/reset` | Limpa o histórico da conversa |
| `/history` | Mostra estatísticas do histórico atual |
| `/exit` | Sai da CLI |

---

## 🛡 Sistema Anti-Alucinação

Quando o Claude-Killer tenta editar um arquivo:

```
1. Claude-Killer chama aplicar_diff(caminho, bloco_diff)
         │
         ▼
2. Modificação é aplicada em memória e o Guardrail analisa a extensão do arquivo
         │
   ┌─────┴─────┐
   │           │
 VÁLIDO     INVÁLIDO
   │           │
   ▼           ▼
3a. Salva   3b. Injeta erro no histórico
  no disco      → Reenvia ao Claude-Killer
                → Claude-Killer corrige e retenta
                │ Até 3 tentativas
                └ Se falhar: alteração NÃO é salva
```

### Extensões suportadas pelo guardrail

| Extensão | Validador |
|---|---|
| `.js` `.mjs` `.cjs` | `node --check` (built-in) |
| `.ts` `.tsx` | `tsc --noEmit` via npx |
| `.json` | `JSON.parse()` nativo |
| `.py` | `python3 -m py_compile` |
| `.java` | `javac` (requer JDK) |
| `.html` `.htm` | Heurística de tags |
| `.css` `.scss` | Heurística de chaves |
| outros | Passthrough (sem checagem) |

---

## ⚙️ Variáveis de Ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `NVIDIA_API_KEY` | **obrigatório** | Chave da API NVIDIA NIM |
| `RATE_LIMIT_RPM` | `40` | Máximo de requisições por minuto |
| `MAX_CONCURRENCY` | `1` | Máximo de chamadas simultâneas (fixo em 1) |
| `MAX_HEAL_RETRIES` | `3` | Tentativas de auto-cura do guardrail |
| `DEBUG` | `false` | Ativa logs internos detalhados |

---

## 🏗 Arquitetura Técnica

```
┌─────────────────────────────────────────────────────┐
│                   index.ts (REPL)                   │
│  readline → slash cmds → ora spinner → agent loop   │
└─────────────────────┬───────────────────────────────┘
                      │ userInput
                      ▼
┌─────────────────────────────────────────────────────┐
│                  agent.ts (Loop)                    │
│  addUserMessage → chat() → tool_calls? → dispatch   │
│  [recursivo até finish_reason = "stop"]             │
└──────┬──────────────────────────────┬───────────────┘
       │                              │
       ▼                              ▼
┌─────────────────┐    ┌──────────────────────────────┐
│  apiClient.ts   │    │          tools.ts            │
│  Mutex          │    │  ler_arquivo()               │
│  RateLimiter    │    │  aplicarDiff()               │
│  OpenAI client  │    │      └── guardrail.ts        │
└─────────────────┘    └──────────────────────────────┘
       │
       ▼
┌─────────────────┐
│  history.ts     │
│  Message[]      │
│  System Prompt  │
└─────────────────┘
```

---

## 📋 Requisitos

- **Node.js** ≥ 18.0.0
- **NVIDIA NIM API Key** (modelo: `moonshotai/kimi-k2.6`)
- Opcional: `python3`, `javac` para validação das respectivas extensões
