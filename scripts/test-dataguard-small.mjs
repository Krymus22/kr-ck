/**
 * test-dataguard-small.mjs — Teste menor (2 arquivos) para garantir que
 * Bug Hunter + DataGuard tenham tempo de rodar dentro de 10 min.
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

const projectDir = "/tmp/ck-dg-small";
fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(projectDir + "/src", { recursive: true });

console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}TESTE: DataGuard + Bug Hunter — Sistema Pequeno (2 arquivos)${C.reset}`);
console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.cyan}Project:${C.reset} ${projectDir}`);
console.log(`${C.cyan}Model:${C.reset} ${process.env.MODEL || "(default)"}`);
console.log(`${C.dim}Bug Hunter + DataGuard devem rodar após IA terminar${C.reset}\n`);

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");

const prompt = `Crie um sistema de save/load com DataStore para Roblox no diretório ${projectDir}.

Crie 2 arquivos Luau:

1. ${projectDir}/src/SaveManager.luau (--!strict)
   - Local DataStoreService = game:GetService("DataStoreService")
   - Local playerData = DataStoreService:GetDataStore("PlayerData_v1")
   - Função saveData(userId: number, data: {[string]: any}): boolean
     - Salva dados do jogador usando SetAsync
   - Função loadData(userId: number): {[string]: any}?
     - Carrega dados do jogador usando GetAsync
   - Função deleteData(userId: number): boolean
     - Deleta dados do jogador usando RemoveAsync
   - Função addCoins(userId: number, amount: number): boolean
     - Carrega dados, adiciona coins, salva
   - Retorna o módulo no final

2. ${projectDir}/src/init.server.luau
   - Testa SaveManager:
   - saveData(12345, {coins = 100, level = 1})
   - loadData(12345) → deve ter coins=100
   - addCoins(12345, 50) → deve ter coins=150
   - deleteData(12345)
   - loadData(12345) → deve ser nil
   - Printa "SAVE SYSTEM OK"

Use pensar(planning), marcar_feito, editar_arquivo.
Responda "pronto" quando terminar.`;

const turnStart = Date.now();
const toolCalls = [];

console.log(`${C.magenta}════════ Turn 1: Criar Save System ══════${C.reset}\n`);

try {
  const result = await agent.runAgentLoop(
    prompt,
    undefined, undefined, undefined, undefined,
    (name, args) => {
      toolCalls.push(name);
      if (["marcar_feito", "atualizar_estado", "pensar", "executar_comando"].includes(name)) {
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

// === Analysis ===
console.log(`\n${"═".repeat(70)}`);
console.log(`${C.bold}ANALYSIS${C.reset}`);
console.log(`${"═".repeat(70)}\n`);

const files = fs.readdirSync(projectDir + "/src").filter(f => f.endsWith(".luau"));
for (const f of files) {
  const content = fs.readFileSync(path.join(projectDir, "src", f), "utf8");
  console.log(`${C.cyan}${f} (${content.split("\n").length} lines):${C.reset}`);
  // Show dangerous patterns
  const patterns = [
    { regex: /SetAsync/g, label: "SetAsync" },
    { regex: /GetAsync/g, label: "GetAsync" },
    { regex: /UpdateAsync/g, label: "UpdateAsync" },
    { regex: /RemoveAsync/g, label: "RemoveAsync" },
    { regex: /pcall/g, label: "pcall" },
  ];
  for (const { regex, label } of patterns) {
    const count = (content.match(regex) || []).length;
    if (count > 0) console.log(`  ${label}: ${count}x`);
  }
  console.log("");
}

// Tool usage
console.log(`${C.cyan}Tool usage:${C.reset}`);
const tc = {};
for (const t of toolCalls) { tc[t] = (tc[t] || 0) + 1; }
for (const [n, c] of Object.entries(tc).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}: ${c}`);
}

console.log(`\n${C.dim}Done. Check logs for BUG_HUNTER and DATAGUARD output above.${C.reset}\n`);
process.exit(0);
