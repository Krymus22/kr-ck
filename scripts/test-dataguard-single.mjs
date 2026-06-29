/**
 * test-dataguard-single.mjs — Teste com 1 arquivo só.
 * Bug Hunter aprova rápido → DataGuard tem tempo de rodar.
 */
import * as fs from "node:fs";

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

const projectDir = "/tmp/ck-dg-single";
fs.rmSync(projectDir, { recursive: true, force: true });
fs.mkdirSync(projectDir + "/src", { recursive: true });

console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}TESTE: DataGuard — 1 arquivo (Bug Hunter aprova rápido)${C.reset}`);
console.log(`${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}\n`);

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");

const prompt = `Crie 1 arquivo Luau no diretório ${projectDir}:

${projectDir}/src/SaveManager.luau (--!strict)

Um módulo de save/load com DataStore para Roblox com:
- local DataStoreService = game:GetService("DataStoreService")
- local playerData = DataStoreService:GetDataStore("PlayerData_v1")
- Função saveData(userId: number, data: table): boolean — usa SetAsync com pcall
- Função loadData(userId: number): table? — usa GetAsync com pcall, retorna nil se não existe
- Função deleteData(userId: number): boolean — usa RemoveAsync com pcall
- return SaveManager no final

Use pensar(planning), editar_arquivo.
Responda "pronto" quando terminar.`;

const turnStart = Date.now();
const toolCalls = [];

try {
  const result = await agent.runAgentLoop(
    prompt,
    undefined, undefined, undefined, undefined,
    (name, args) => {
      toolCalls.push(name);
      if (["marcar_feito", "pensar", "executar_comando"].includes(name)) {
        const cat = name === "pensar" ? ` [${args?.categoria || "?"}]` : "";
        console.log(`  ${C.yellow}[TOOL]${C.reset} ${name}${cat}`);
      }
    },
    (n, ok) => { if (!ok) console.log(`  ${C.red}[FAIL]${C.reset} ${n}`); },
    undefined, false
  );
  const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
  console.log(`\n${C.dim}  ${toolCalls.length} tool calls, ${elapsed}s${C.reset}`);
  console.log(`${C.dim}  Result: ${String(result).slice(0, 200)}${C.reset}`);
} catch (err) {
  console.log(`  ${C.red}ERROR:${C.reset} ${err.message?.slice(0, 300)}`);
}

console.log(`\n${"═".repeat(70)}`);
console.log(`${C.bold}SUMMARY${C.reset}`);
console.log(`${"═".repeat(70)}\n`);

const files = fs.readdirSync(projectDir + "/src").filter(f => f.endsWith(".luau"));
for (const f of files) {
  const content = fs.readFileSync(`${projectDir}/src/${f}`, "utf8");
  console.log(`${C.cyan}${f} (${content.split("\n").length} lines):${C.reset}`);
  for (const [label, regex] of [["SetAsync", /SetAsync/g], ["GetAsync", /GetAsync/g], ["RemoveAsync", /RemoveAsync/g], ["pcall", /pcall/g]]) {
    const c = (content.match(regex) || []).length;
    if (c > 0) console.log(`  ${label}: ${c}x`);
  }
}

console.log(`\n${C.cyan}Tool usage:${C.reset}`);
const tc = {};
for (const t of toolCalls) tc[t] = (tc[t] || 0) + 1;
for (const [n, c] of Object.entries(tc).sort((a, b) => b[1] - a[1])) console.log(`  ${n}: ${c}`);

console.log(`\n${C.dim}Done. Check logs for BUG_HUNTER and DATAGUARD above.${C.reset}\n`);
process.exit(0);
