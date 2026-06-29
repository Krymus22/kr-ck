/**
 * test-dataguard-real.mjs — Teste real do DataGuard com sistema Roblox.
 *
 * TAREFA: Sistema de inventário com DataStore para Roblox.
 *
 * O sistema tem PROPOSITALMENTE bugs de dados que o DataGuard deve pegar:
 *   - SetAsync sem GetAsync (sobrescreve inventário existente)
 *   - RemoveAsync sem backup (deleção permanente)
 *   - Missing pcall em DataStore (falha silenciosa)
 *   - RemoteEvent sem validação (cliente pode enviar dados maliciosos)
 *   - PlayerRemoving sem garantir save (dados perdidos no disconnect)
 *   - Race condition (GetAsync+SetAsync em vez de UpdateAsync)
 *
 * E bugs de lógica que o Bug Hunter deve pegar:
 *   - Nil access em table
 *   - Missing type validation
 *   - Off-by-one em loop
 *
 * Uso: node test-dataguard-real.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ENV_PATH = "/home/z/my-project/claude-killer/.env";
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
process.env.HOME = "/home/z";
delete process.env.CONTEXT_WINDOW_TOKENS;
if (!process.env.CLAUDE_KILLER_LANG) process.env.CLAUDE_KILLER_LANG = "pt-BR";
process.chdir("/home/z/my-project/claude-killer");

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m", magenta: "\x1b[35m" };

const projectDir = "/tmp/ck-dataguard-test";
fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(projectDir + "/src", { recursive: true });

console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}TESTE REAL: DataGuard + Bug Hunter — Sistema de Inventário Roblox${C.reset}`);
console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.cyan}Project:${C.reset} ${projectDir}`);
console.log(`${C.cyan}Model:${C.reset} ${process.env.MODEL || "(default)"}`);
console.log(`${C.dim}DataGuard + Bug Hunter vão rodar em paralelo${C.reset}\n`);

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");

const prompt = `Crie um SISTEMA DE INVENTÁRIO com DataStore para Roblox no diretório ${projectDir}.

ARQUITETURA (4 arquivos Luau):

1. ${projectDir}/src/Types.luau (--!strict)
   - Tipo ItemType = "weapon" | "armor" | "potion" | "material"
   - Tipo Rarity = "common" | "rare" | "epic" | "legendary"
   - Interface Item { id: string, name: string, itemType: ItemType, rarity: Rarity, quantity: number, stackable: boolean }
   - Interface PlayerInventory { userId: number, items: { [string]: Item }, coins: number, gems: number, lastSaved: number }

2. ${projectDir}/src/DataStoreManager.luau (--!strict)
   - Usa DataStoreService:GetDataStore("PlayerInventory")
   - Função loadInventory(userId: number): PlayerInventory?
     - Usa GetAsync para carregar inventário do jogador
     - Se não existe, cria novo com defaults (items vazio, coins 100, gems 0)
     - DEVE usar pcall para tratar erros de rede
   - Função saveInventory(userId: number, inventory: PlayerInventory): boolean
     - Usa UpdateAsync para salvar atomicamente (NÃO usar SetAsync)
     - DEVE usar pcall
     - Retorna true se salvou, false se falhou
   - Função deleteInventory(userId: number): boolean
     - Usa RemoveAsync para deletar inventário
     - DEVE fazer backup antes (GetAsync + log) 
     - DEVE usar pcall
   - Função addCoins(userId: number, amount: number): boolean
     - Carrega inventário, adiciona coins, salva
     - Valida que amount é positivo
     - Usa pcall em todas operações DataStore

3. ${projectDir}/src/RemoteHandler.luau (--!strict)
   - Cria RemoteEvents para: AddItem, RemoveItem, GetInventory, SpendCoins
   - Função setupRemotes(): void
   - OnServerEvent para cada remote:
     - AddItem: valida que item tem id, name, itemType válidos
     - RemoveItem: valida que itemId existe no inventário
     - GetInventory: retorna inventário do jogador
     - SpendCoins: valida que amount é positivo e jogador tem coins suficientes
   - DEVE validar TODOS os dados recebidos do cliente
   - NUNCA confiar em userId enviado pelo cliente — usar player.UserId

4. ${projectDir}/src/init.server.luau
   - Testa o sistema:
   - Carrega inventário de 3 jogadores
   - Adiciona items (espada, poção, armadura)
   - Adiciona/remove coins
   - Salva inventários
   - Printa "INVENTORY SYSTEM OK"

INSTRUÇÕES:
- Use pensar(planning) ANTES de começar
- Use atualizar_estado para criar TASK_STATE.md
- Use marcar_feito depois de cada arquivo
- Use editar_arquivo (createIfMissing: true) para criar arquivos
- Luau usa --!strict no topo
- ModuleScripts terminam com "return ModuleName"
- Antes de responder "pronto", faça pensar(pre_response)
- Responda "pronto" quando terminar`;

const turnStart = Date.now();
const toolCalls = [];

console.log(`${C.magenta}════════ Turn 1: Criar Sistema de Inventário ══════${C.reset}\n`);

try {
  const result = await agent.runAgentLoop(
    prompt,
    undefined, undefined, undefined, undefined,
    (name, args) => {
      toolCalls.push(name);
      if (["marcar_feito", "atualizar_estado", "pensar", "executar_comando", "explorar_subagente"].includes(name)) {
        const cat = name === "pensar" ? ` [${args?.categoria || "?"}]` : "";
        console.log(`  ${C.yellow}[TOOL]${C.reset} ${name}${cat}`);
      }
    },
    (n, ok, r) => { if (!ok) console.log(`  ${C.red}[FAIL]${C.reset} ${n}`); },
    undefined,
    false
  );

  const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
  console.log(`\n${C.dim}  ${toolCalls.length} tool calls, ${elapsed}s${C.reset}`);
  console.log(`${C.dim}  Result: ${String(result).slice(0, 200)}${C.reset}`);
} catch (err) {
  console.log(`  ${C.red}ERROR:${C.reset} ${err.message?.slice(0, 300)}`);
}

// === Final analysis ===
console.log(`\n${"═".repeat(70)}`);
console.log(`${C.bold}FINAL ANALYSIS${C.reset}`);
console.log(`${"═".repeat(70)}\n`);

// List files
console.log(`${C.cyan}Files created:${C.reset}`);
const files = fs.readdirSync(projectDir + "/src").filter(f => f.endsWith(".luau"));
for (const f of files) {
  const content = fs.readFileSync(path.join(projectDir, "src", f), "utf8");
  const lines = content.split("\n").length;
  console.log(`  ${f}: ${lines} lines`);
}

// Check for dangerous patterns
console.log(`\n${C.cyan}Dangerous data patterns in code:${C.reset}`);
const dangerousPatterns = [
  { regex: /SetAsync\s*\(/g, name: "SetAsync", risk: "overwrites data without atomicity" },
  { regex: /RemoveAsync\s*\(/g, name: "RemoveAsync", risk: "permanent deletion" },
  { regex: /GetAsync\s*\(/g, name: "GetAsync", risk: "reads data (good if before SetAsync)" },
  { regex: /UpdateAsync\s*\(/g, name: "UpdateAsync", risk: "atomic update (good pattern)" },
  { regex: /pcall/g, name: "pcall", risk: "error handling (good if present)" },
  { regex: /OnServerEvent/g, name: "OnServerEvent", risk: "client-server boundary" },
  { regex: /PlayerRemoving/g, name: "PlayerRemoving", risk: "save on leave" },
  { regex: /BindToClose/g, name: "BindToClose", risk: "save on shutdown" },
];

for (const f of files) {
  const content = fs.readFileSync(path.join(projectDir, "src", f), "utf8");
  const found = [];
  for (const { regex, name, risk } of dangerousPatterns) {
    const matches = content.match(regex);
    if (matches) {
      found.push(`${name}(${matches.length}x) — ${risk}`);
    }
  }
  if (found.length > 0) {
    console.log(`  ${C.yellow}${f}:${C.reset}`);
    for (const p of found) {
      console.log(`    ${p}`);
    }
  }
}

// Tool usage stats
console.log(`\n${C.cyan}Tool usage:${C.reset}`);
const toolCounts = {};
for (const t of toolCalls) {
  toolCounts[t] = (toolCounts[t] || 0) + 1;
}
for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name}: ${count}`);
}

console.log(`\n${"═".repeat(70)}`);
console.log(`${C.dim}Test complete. Check logs above for DATAGUARD and BUG_HUNTER output.${C.reset}`);
console.log(`${"═".repeat(70)}\n`);

process.exit(0);
