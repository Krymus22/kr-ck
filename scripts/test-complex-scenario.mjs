/**
 * test-complex-scenario.mjs — Complex scenario that REQUIRES codebase exploration.
 *
 * The IA must:
 *   1. Explore an existing codebase (multiple files with dependencies)
 *   2. Understand how modules connect before making changes
 *   3. Add a new feature that touches multiple files
 *   4. Fix a bug that requires understanding data flow
 *   5. Refactor with awareness of all callers
 *
 * This is the kind of task where explorar_subagente should shine —
 * the IA needs to understand relationships before editing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
const PASS = `${C.green}PASS${C.reset}`;
const FAIL = `${C.red}FAIL${C.reset}`;
let pass = 0, fail = 0;
const fails = [];

function assert(c, m, d) {
  if (c) { console.log(`  ${PASS}  ${m}`); pass++; }
  else { console.log(`  ${FAIL}  ${m}`); if (d) console.log(`         ${C.dim}${d}${C.reset}`); fail++; fails.push(m); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms))
  ]);
}

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
const history = await import("/home/z/my-project/claude-killer/dist/history.js");
const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");

// Create a PRE-EXISTING codebase that the IA must understand before editing
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-complex-"));

console.log(`${C.cyan}Project workspace:${C.reset} ${projectDir}`);
console.log(`${C.cyan}Model:${C.reset} ${process.env.MODEL || "(default)"}`);
console.log(`${C.dim}Pre-existing codebase with 4 interdependent modules.${C.reset}\n`);

// --- Create the existing codebase ---
fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

// 1. User type
fs.writeFileSync(path.join(projectDir, "src/types.ts"), `
export interface User {
  id: number;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
}
`);

// 2. User repository (CRUD)
fs.writeFileSync(path.join(projectDir, "src/userRepository.ts"), `
import { User } from "./types";

const users: User[] = [];
let nextId = 1;

export function createUser(name: string, email: string, role: User["role"] = "user"): User {
  const user: User = { id: nextId++, name, email, role };
  users.push(user);
  return user;
}

export function getUserById(id: number): User | undefined {
  return users.find(u => u.id === id);
}

export function getAllUsers(): User[] {
  return [...users];
}

export function updateUser(id: number, updates: Partial<User>): User | undefined {
  const user = getUserById(id);
  if (!user) return undefined;
  Object.assign(user, updates);
  return user;
}

export function deleteUser(id: number): boolean {
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) return false;
  users.splice(idx, 1);
  return true;
}
`);

// 3. User service (business logic)
fs.writeFileSync(path.join(projectDir, "src/userService.ts"), `
import { User } from "./types";
import { createUser, getUserById, getAllUsers, updateUser, deleteUser } from "./userRepository";

export function registerUser(name: string, email: string): User {
  // BUG: não valida email duplicado
  return createUser(name, email, "user");
}

export function findUser(id: number): User | undefined {
  return getUserById(id);
}

export function listUsers(): User[] {
  return getAllUsers();
}

export function changeUserRole(id: number, role: User["role"]): User | undefined {
  return updateUser(id, { role });
}

export function removeUser(id: number): boolean {
  return deleteUser(id);
}
`);

// 4. Main entry point
fs.writeFileSync(path.join(projectDir, "src/index.ts"), `
import { registerUser, findUser, listUsers, changeUserRole, removeUser } from "./userService";

// Demo
const alice = registerUser("Alice", "alice@example.com");
const bob = registerUser("Bob", "bob@example.com");

console.log("All users:", listUsers());
console.log("Find Alice:", findUser(alice.id));

changeUserRole(bob.id, "admin");
console.log("Bob after role change:", findUser(bob.id));

removeUser(alice.id);
console.log("After removing Alice:", listUsers());
`);

// 5. Package.json
fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({
  name: "user-management",
  version: "1.0.0",
  type: "module",
  scripts: { start: "npx tsx src/index.ts" }
}, null, 2));

console.log(`${C.cyan}Pre-existing files:${C.reset}`);
for (const f of ["src/types.ts", "src/userRepository.ts", "src/userService.ts", "src/index.ts", "package.json"]) {
  console.log(`  ${f} (${fs.statSync(path.join(projectDir, f)).size} bytes)`);
}
console.log("");

modes.setActiveMode("normal");

async function turn(label, prompt, checkFn, timeout = 180_000) {
  console.log(`\n${C.bold}─── ${label} ───${C.reset}`);
  const toolCalls = [];

  try {
    const result = await withTimeout(
      agent.runAgentLoop(
        prompt,
        undefined, undefined, undefined, undefined,
        (n, args) => { toolCalls.push(n); process.stdout.write(`  ${C.dim}[TOOL]${C.reset} ${n}\n`); },
        (n, ok, r) => { if (!ok) process.stdout.write(`  ${C.red}[FAIL]${C.reset} ${n}: ${r.slice(0, 80)}\n`); },
        undefined,
        false
      ),
      timeout,
      label
    );

    console.log(`  ${C.dim}Final:${C.reset} ${String(result).slice(0, 150)}`);
    console.log(`  ${C.dim}Tools:${C.reset} ${toolCalls.length} calls — ${toolCalls.join(", ")}`);
    checkFn(String(result), toolCalls);
  } catch (e) {
    const msg = e.message.slice(0, 200);
    console.log(`  ${C.red}Error:${C.reset} ${msg}`);
    if (/429|rate|too many/i.test(msg)) {
      console.log(`  ${C.yellow}SKIP (rate-limited)${C.reset}`);
      await sleep(30_000);
    } else if (msg.includes("TIMEOUT")) {
      console.log(`  ${C.red}FAIL (timed out)${C.reset}`);
      fail++; fails.push(`${label}: TIMEOUT`);
    } else if (msg.includes("LOOP")) {
      console.log(`  ${C.red}FAIL (loop)${C.reset}`);
      fail++; fails.push(`${label}: LOOP`);
    } else {
      console.log(`  ${C.red}FAIL (error)${C.reset}`);
      fail++; fails.push(`${label}: ${msg.slice(0, 60)}`);
    }
  }

  await sleep(3000);
}

// ===========================================================================
// TURN 1: Explore the codebase before doing anything
// This is where explorar_subagente should be used!
// ===========================================================================
await turn("Turn 1: Explore codebase structure", `
Você recebeu um projeto de gerenciamento de usuários em ${projectDir}. 
ANTES de fazer qualquer alteração, explore a codebase para entender:
1. Quais arquivos existem e qual a responsabilidade de cada um
2. Como os módulos se conectam (imports/exports)
3. Qual é o fluxo de dados quando um usuário é registrado

Use explorar_subagente para fazer essa investigação (NÃO leia os arquivos você mesmo — delegue para o sub-agente).
Depois, me explique brevemente a arquitetura.
`, (r, tc) => {
  // CHECK: did the IA use explorar_subagente?
  assert(tc.includes("explorar_subagente"), "usou explorar_subagente para explorar a codebase");
  assert(/types|userRepository|userService|index/i.test(r), "mencionou os módulos da codebase");
  assert(/import|export|connect|depend/i.test(r), "explicou como os módulos se conectam");
  assert(tc.length <= 5, `não fez loop excessivo (${tc.length} calls)`);
});

// ===========================================================================
// TURN 2: Fix the duplicate email bug (requires understanding data flow)
// ===========================================================================
await turn("Turn 2: Fix duplicate email bug", `
Tem um bug em ${projectDir}/src/userService.ts: a função registerUser não valida emails duplicados. Dois usuários podem ser registrados com o mesmo email.

Investigue como o fluxo funciona (use explorar_subagente se precisar entender as dependências), depois corrija o bug:
- registerUser deve lançar Error("Email already registered") se o email já existe
- Adicione uma função findByEmail no userRepository.ts
- Use essa função no userService.ts para validar

Responda "corrigido" quando acabar.
`, (r, tc) => {
  const repoContent = fs.readFileSync(path.join(projectDir, "src/userRepository.ts"), "utf8");
  const serviceContent = fs.readFileSync(path.join(projectDir, "src/userService.ts"), "utf8");

  assert(/findByEmail/i.test(repoContent), "adicionou findByEmail no userRepository.ts");
  assert(/findByEmail/i.test(serviceContent), "usou findByEmail no userService.ts");
  assert(/Email already registered|email.*exist|duplicat/i.test(serviceContent), "valida email duplicado");
  assert(tc.length <= 12, `não fez loop excessivo (${tc.length} calls)`);
});

// ===========================================================================
// TURN 3: Add a new feature — user search by name
// Requires understanding where to add the function and how to expose it
// ===========================================================================
await turn("Turn 3: Add user search by name", `
Adicione uma nova feature ao projeto em ${projectDir}: busca de usuários por nome (parcial, case-insensitive).

Implemente:
1. searchByName(query: string) no userRepository.ts que retorna User[]
2. searchUsers(query: string) no userService.ts que chama o repository
3. Exporte searchUsers do index.ts

Leia os arquivos necessários, faça as alterações, depois leia novamente para confirmar.
Responda "pronto".
`, (r, tc) => {
  const repoContent = fs.readFileSync(path.join(projectDir, "src/userRepository.ts"), "utf8");
  const serviceContent = fs.readFileSync(path.join(projectDir, "src/userService.ts"), "utf8");
  const indexContent = fs.readFileSync(path.join(projectDir, "src/index.ts"), "utf8");

  assert(/searchByName/i.test(repoContent), "adicionou searchByName no userRepository.ts");
  assert(/searchUsers/i.test(serviceContent), "adicionou searchUsers no userService.ts");
  assert(/searchUsers/i.test(indexContent), "exportou searchUsers do index.ts");
  assert(/toLowerCase|case.insensitive/i.test(repoContent), "busca é case-insensitive");
});

// ===========================================================================
// TURN 4: Run the project to verify everything works
// ===========================================================================
await turn("Turn 4: Run and verify", `
Rode o projeto em ${projectDir} usando executar_comando com "npx tsx src/index.ts".
Me diga se rodou sem erros. Se houve erro, mostre e corrija.
`, (r, tc) => {
  assert(tc.includes("executar_comando"), "chamou executar_comando");
  assert(/passou|funcionou|sem erro|sucesso|ok/i.test(r) || !/error|fail/i.test(r), "projeto rodou sem erros");
});

// ===========================================================================
// TURN 5: Add role-based access control
// Complex feature that touches multiple files
// ===========================================================================
await turn("Turn 5: Add admin-only delete protection", `
Adicione proteção no ${projectDir}/src/userService.ts: a função removeUser só deve permitir deletar usuários com role "user" ou "guest". Tentar deletar um "admin" deve lançar Error("Cannot delete admin user").

Leia o arquivo, faça a alteração, depois leia para confirmar.
Responda "pronto".
`, (r, tc) => {
  const serviceContent = fs.readFileSync(path.join(projectDir, "src/userService.ts"), "utf8");
  assert(/admin|Cannot delete/i.test(serviceContent), "adicionou verificação de role admin");
  assert(/throw.*Error|Cannot delete admin/i.test(serviceContent), "lança erro ao tentar deletar admin");
  assert(tc.length <= 10, `não fez loop excessivo (${tc.length} calls)`);
});

// ===========================================================================
// TURN 6: Context retention — does the IA remember the architecture?
// ===========================================================================
await turn("Turn 6: Architecture memory test", `
Sem ler arquivos, me responda: 
1. Quantos arquivos .ts existem no projeto?
2. Quais funções o userService.ts exporta?
3. O que o userRepository.ts faz?

Responda de memória, sem usar tools.
`, (r, tc) => {
  assert(tc.length === 0, "não precisou de tools (respondeu de memória)");
  assert(/4|quatro/i.test(r), "sabia que são 4 arquivos .ts");
  assert(/registerUser|findUser|listUsers|changeUserRole|removeUser|searchUsers/i.test(r), "lembrou as funções do userService");
  assert(/CRUD|create|read|update|delete|repository/i.test(r), "explicou o que userRepository faz");
});

// ===========================================================================
// TURN 7: Refactor — extract validation to a separate module
// ===========================================================================
await turn("Turn 7: Extract validation module", `
Refatore o ${projectDir}: extraia a validação de email duplicado e a verificação de role admin para um novo arquivo ${projectDir}/src/validators.ts.

1. Crie src/validators.ts com:
   - validateEmailNotDuplicate(email: string): void
   - validateCanDeleteUser(role: User["role"]): void
2. Atualize userService.ts para usar essas funções do validators.ts
3. Não quebre a funcionalidade existente

Leia os arquivos necessários, faça as alterações, depois leia para confirmar.
Responda "pronto".
`, (r, tc) => {
  const validatorsPath = path.join(projectDir, "src/validators.ts");
  assert(fs.existsSync(validatorsPath), "criou src/validators.ts");
  if (fs.existsSync(validatorsPath)) {
    const validatorsContent = fs.readFileSync(validatorsPath, "utf8");
    assert(/validateEmailNotDuplicate/i.test(validatorsContent), "tem validateEmailNotDuplicate");
    assert(/validateCanDeleteUser/i.test(validatorsContent), "tem validateCanDeleteUser");
  }
  const serviceContent = fs.readFileSync(path.join(projectDir, "src/userService.ts"), "utf8");
  assert(/validators/i.test(serviceContent), "userService importa de validators");
  assert(!/Email already registered.*userRepository|findByEmail.*throw/i.test(serviceContent), "removeu validação inline do userService");
});

// ===========================================================================
// TURN 8: Final verification — run again
// ===========================================================================
await turn("Turn 8: Final run and verify", `
Rode o projeto em ${projectDir} novamente com "npx tsx src/index.ts".
Confirme que tudo ainda funciona após o refactor.
Responda brevemente.
`, (r, tc) => {
  assert(tc.includes("executar_comando"), "chamou executar_comando");
  assert(/passou|funcionou|sem erro|sucesso|ok/i.test(r) || !/error|fail/i.test(r), "projeto rodou sem erros após refactor");
});

// ===========================================================================
// FINAL VERIFICATION
// ===========================================================================
console.log(`\n${"═".repeat(70)}`);
console.log(`${C.bold}FINAL PROJECT STATE${C.reset}`);
console.log("═".repeat(70));

const walk = (dir) => {
  const items = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") items.push(...walk(full));
    else if (!entry.isDirectory()) items.push(full);
  }
  return items;
};

const files = walk(projectDir).filter(f => !f.includes("node_modules"));
console.log(`\n${C.cyan}Files in project:${C.reset}`);
for (const f of files) {
  const rel = path.relative(projectDir, f);
  const size = fs.statSync(f).size;
  console.log(`  ${rel} (${size} bytes)`);
}

// Check if validators.ts was created
const validatorsExists = fs.existsSync(path.join(projectDir, "src/validators.ts"));
console.log(`\n${C.cyan}Refactor result:${C.reset} ${validatorsExists ? "✓ validators.ts created" : "✗ validators.ts NOT created"}`);

console.log(`\n${"═".repeat(70)}`);
console.log(`${C.bold}SUMMARY${C.reset}: ${C.green}${pass} passed${C.reset}, ${C.red}${fail} failed${C.reset}`);
console.log("═".repeat(70));

if (fails.length > 0) {
  console.log(`\n${C.red}Failures:${C.reset}`);
  for (const f of fails) console.log(`  ${C.red}-${C.reset} ${f}`);
}

try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}

process.exit(fail === 0 ? 0 : 1);
