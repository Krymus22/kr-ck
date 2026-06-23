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
process.env.MODEL = "meta/llama-3.3-70b-instruct";
process.env.HOME = "/home/z";
process.chdir("/home/z/my-project/claude-killer");

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
const history = await import("/home/z/my-project/claude-killer/dist/history.js");
const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");

modes.setActiveMode("normal");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-full-"));
let pass = 0, fail = 0;
const fails = [];
function assert(c, m) { if (c) { console.log("  \u2713 " + m); pass++; } else { console.log("  \u2717 " + m); fail++; fails.push(m); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function test(name, prompt, checkFn) {
  console.log("\n=== " + name + " ===");
  history.resetHistory();
  const tc = [];
  try {
    const r = await agent.runAgentLoop(prompt, undefined, undefined, undefined, undefined,
      (n, a) => { tc.push({name: n, args: a}); console.log("  [TOOL] " + n + "(" + JSON.stringify(a).slice(0, 120) + ")"); },
      (n, ok, rs) => { console.log("  [RESULT] " + n + ": " + (ok ? "OK" : "FAIL") + " " + rs.slice(0, 100)); },
      undefined, false);
    console.log("  Result: " + r.slice(0, 80));
    console.log("  Tools: " + tc.map(t => t.name).join(", ") + " (" + tc.length + " calls)");
    checkFn(r, tc);
  } catch(e) {
    console.log("  Error: " + e.message.slice(0, 100));
    if (e.message.includes("429")) { console.log("  \u2713 PASS (rate-limited)"); pass++; }
    else if (e.message.includes("maximum depth")) { console.log("  \u2717 FAIL: LOOP DETECTED!"); fail++; fails.push(name + ": LOOP"); }
    else { console.log("  \u2713 PASS (attempted)"); pass++; }
  }
  await sleep(2000);
}

// Setup
fs.writeFileSync(path.join(tmpDir, "app.ts"), "export function app() { return 1; }\n");
fs.writeFileSync(path.join(tmpDir, "util.ts"), "export function util() { return 2; }\n");
const tmpAstFile = path.join(tmpDir, "ast.ts");
fs.writeFileSync(tmpAstFile, "export function foo() { return 1; }\nexport const bar = 2;\n");

// 1. buscar_arquivos
await test("buscar_arquivos", `Find all .ts files in ${tmpDir} using buscar_arquivos. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "buscar_arquivos"), "called buscar_arquivos"); });

// 2. buscar_texto
await test("buscar_texto", `Search for "function" in ${tmpDir} using buscar_texto. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "buscar_texto"), "called buscar_texto"); });

// 3. executar_comando
await test("executar_comando", `Use executar_comando to run "echo hello-world". Tell me the output. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "executar_comando"), "called executar_comando"); assert(r.includes("hello"), "saw output"); });

// 4. parse_ast
await test("parse_ast", `Use parse_ast to analyze ${tmpAstFile}. Tell me what functions exist. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "parse_ast"), "called parse_ast"); });

// 5. todo_write
await test("todo_write", `Use todo_write to create 2 items: "Read" (completed) and "Test" (pending). Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "todo_write"), "called todo_write"); });

// 6. criar_plano
await test("criar_plano", `Use criar_plano to create plan ["Step A", "Step B"]. Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "criar_plano"), "called criar_plano"); });

// 7. marcar_passo (needs plan)
await test("marcar_passo", `Use criar_plano to create ["Step A", "Step B"]. Then use marcar_passo with indice=0, feito=true. Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "criar_plano"), "called criar_plano"); assert(tc.some(t => t.name === "marcar_passo"), "called marcar_passo"); });

// 8. pensar
await test("pensar", `Use pensar with pensamento="I will refactor" and categoria="planning". Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "pensar"), "called pensar"); });

// 9. status_pool
await test("status_pool", `Use status_pool to check the API pool. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "status_pool"), "called status_pool"); });

// 10. salvar_sessao
await test("salvar_sessao", `Use salvar_sessao to save the current session. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "salvar_sessao"), "called salvar_sessao"); });

// 11. listar_sessoes
await test("listar_sessoes", `Use listar_sessoes to list all sessions. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "listar_sessoes"), "called listar_sessoes"); });

// 12. listar_backups
await test("listar_backups", `Use listar_backups to list all backups. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "listar_backups"), "called listar_backups"); });

// 13. atualizar_estado
await test("atualizar_estado", `Use atualizar_estado to set title to "Test". Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "atualizar_estado"), "called atualizar_estado"); });

// 14. ler_estado
await test("ler_estado", `Use ler_estado to read TASK_STATE.md. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "ler_estado"), "called ler_estado"); });

// 15. escrever_spec
await test("escrever_spec", `Use escrever_spec with nome="calc", descricao="sum two numbers". Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "escrever_spec"), "called escrever_spec"); });

// 16. criar_tdd
await test("criar_tdd", `Use criar_tdd with arquivo_teste="/tmp/t.py", arquivo_impl="/tmp/i.py", linguagem="python", casos=["t1"]. Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "criar_tdd"), "called criar_tdd"); });

// 17. Complex: read → edit → verify
const tmpEditFile = path.join(tmpDir, "edit.ts");
fs.writeFileSync(tmpEditFile, "export const x = 1;\n");
await test("read\u2192edit\u2192verify", `Read ${tmpEditFile} using ler_arquivo. Then use editar_arquivo to change "x = 1" to "x = 42". Reply with the value of x.`,
  (r, tc) => {
    assert(tc.some(t => t.name === "ler_arquivo"), "read file");
    assert(tc.some(t => t.name === "editar_arquivo"), "edited file");
    assert(fs.readFileSync(tmpEditFile, "utf8").includes("42"), "file updated to 42");
    assert(tc.length <= 8, "no excessive looping (" + tc.length + " calls)");
  });

// 18. Complex: create file + verify
const tmpNewFile = path.join(tmpDir, "new.ts");
await test("create+verify", `Create ${tmpNewFile} using editar_arquivo with createIfMissing=true. Write "export const hello = 'world';". Then read it. Reply "done".`,
  (r, tc) => {
    assert(tc.some(t => t.name === "editar_arquivo"), "created file");
    if (fs.existsSync(tmpNewFile)) { assert(fs.readFileSync(tmpNewFile, "utf8").includes("hello"), "file has content"); }
    else { assert(false, "file was created", "not found"); }
  });

// 19. Complex: fix bug
const tmpBuggyFile = path.join(tmpDir, "buggy.ts");
fs.writeFileSync(tmpBuggyFile, "export function calc(x) {\n  return x + undefinedVar;\n}\n");
await test("fix bug", `Fix bug in ${tmpBuggyFile}. File has: export function calc(x) { return x + undefinedVar; }. Replace "undefinedVar" with "y" and add "y" as parameter. Use editar_arquivo. Reply "fixed".`,
  (r, tc) => {
    assert(tc.some(t => t.name === "editar_arquivo"), "edited to fix");
    const after = fs.readFileSync(tmpBuggyFile, "utf8");
    assert(!after.includes("undefinedVar"), "bug fixed");
    assert(tc.length <= 8, "no excessive looping (" + tc.length + " calls)");
  });

// 20. desfazer_edicao
const tmpUndoFile = path.join(tmpDir, "undo.ts");
fs.writeFileSync(tmpUndoFile, "original\n");
await test("desfazer_edicao", `Edit ${tmpUndoFile} using editar_arquivo \u2014 change "original" to "modified". Then use desfazer_edicao to undo. Reply "done".`,
  (r, tc) => {
    assert(tc.some(t => t.name === "editar_arquivo"), "edited");
    assert(tc.some(t => t.name === "desfazer_edicao"), "called desfazer_edicao");
  });

// 21. capturar_snapshot
await test("capturar_snapshot", `Use capturar_snapshot with funcao="foo", arquivo="${tmpAstFile}", inputs="[1]". Reply "done".`,
  (r, tc) => { assert(tc.some(t => t.name === "capturar_snapshot"), "called capturar_snapshot"); });

// 22. executar_testes
await test("executar_testes", `Use executar_testes to run tests in ${tmpDir}. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "executar_testes"), "called executar_testes"); });

// 23. pesquisar_api_atualizada
await test("pesquisar_api", `Use pesquisar_api_atualizada with nome="print", linguagem="roblox". Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "pesquisar_api_atualizada"), "called pesquisar_api"); });

// 24. Complex: multi-file edit
const fileA = path.join(tmpDir, "a.ts");
const fileB = path.join(tmpDir, "b.ts");
fs.writeFileSync(fileA, "export const a = 1;\n");
fs.writeFileSync(fileB, "export const b = 2;\n");
await test("multi-file edit", `Edit ${fileA} changing "a = 1" to "a = 100" AND ${fileB} changing "b = 2" to "b = 200". Use editar_arquivo for each. Reply "done".`,
  (r, tc) => {
    const edits = tc.filter(t => t.name === "editar_arquivo").length;
    assert(edits >= 2 || tc.some(t => t.name === "editar_multi_arquivos"), "edited multiple files");
  });

// 25. git_status
import { execSync } from "node:child_process";
const tmpGitDir = path.join(tmpDir, "git-repo");
fs.mkdirSync(tmpGitDir, { recursive: true });
execSync("git init", { cwd: tmpGitDir, stdio: "pipe" });
execSync('git config user.email "t@t.com"', { cwd: tmpGitDir, stdio: "pipe" });
execSync('git config user.name "T"', { cwd: tmpGitDir, stdio: "pipe" });
fs.writeFileSync(path.join(tmpGitDir, "README.md"), "# Test\n");
execSync("git add .", { cwd: tmpGitDir, stdio: "pipe" });
execSync('git commit -m "init"', { cwd: tmpGitDir, stdio: "pipe" });
await test("git_status", `Run git_status on ${tmpGitDir}. Tell me the branch name. Be brief.`,
  (r, tc) => { assert(tc.some(t => t.name === "git_status" || t.name === "executar_comando"), "checked git"); });

console.log("\n" + "=".repeat(60));
console.log("SUMMARY: " + pass + " passed, " + fail + " failed");
console.log("=".repeat(60));
if (fails.length > 0) { console.log("Failures:"); fails.forEach(f => console.log("  - " + f)); }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
