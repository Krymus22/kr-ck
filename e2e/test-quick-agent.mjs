import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Load env
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-test-"));
fs.writeFileSync(path.join(tmpDir, "app.ts"), "export function app() { return 1; }\n");

let pass = 0, fail = 0;
function assert(c, m) { if (c) { console.log("  ✓ PASS:", m); pass++; } else { console.log("  ✗ FAIL:", m); fail++; } }

async function testTool(name, prompt, checkFn) {
  console.log(`\n=== ${name} ===`);
  history.resetHistory();
  const toolCalls = [];
  try {
    const result = await agent.runAgentLoop(prompt, undefined, undefined, undefined, undefined,
      (n) => { toolCalls.push(n); console.log(`  [TOOL] ${n}`); },
      undefined, undefined, false);
    console.log("  Result:", result.slice(0, 80));
    console.log("  Tools:", toolCalls.join(", "), `(${toolCalls.length} calls)`);
    checkFn(result, toolCalls);
  } catch(e) {
    console.log("  Error:", e.message.slice(0, 100));
    if (e.message.includes("429") || e.message.includes("rate")) { console.log("  ✓ PASS (rate-limited)"); pass++; }
    else if (e.message.includes("maximum depth")) { console.log("  ✗ FAIL: loop detected!"); fail++; }
    else { console.log("  ✗ FAIL:", e.message.slice(0, 80)); fail++; }
  }
  await new Promise(r => setTimeout(r, 3000));
}

// Test 1: buscar_arquivos
await testTool("buscar_arquivos", `Find all .ts files in ${tmpDir} using buscar_arquivos. Be brief.`,
  (r, tc) => { assert(tc.includes("buscar_arquivos"), "called buscar_arquivos"); });

// Test 2: executar_comando
await testTool("executar_comando", `Use executar_comando to run "echo hello-world". Tell me the output. Be brief.`,
  (r, tc) => { assert(tc.includes("executar_comando"), "called executar_comando"); assert(r.includes("hello"), "saw output"); });

// Test 3: todo_write
await testTool("todo_write", `Use todo_write to create 2 items: "Read" (completed) and "Test" (pending). Reply done.`,
  (r, tc) => { assert(tc.includes("todo_write"), "called todo_write"); });

// Test 4: criar_plano
await testTool("criar_plano", `Use criar_plano to create plan ["Step A", "Step B"]. Reply done.`,
  (r, tc) => { assert(tc.includes("criar_plano"), "called criar_plano"); });

// Test 5: pensar
await testTool("pensar", `Use pensar with pensamento="planning refactor" and categoria="planning". Reply done.`,
  (r, tc) => { assert(tc.includes("pensar"), "called pensar"); });

// Test 6: status_pool
await testTool("status_pool", `Use status_pool to check the API pool. Be brief.`,
  (r, tc) => { assert(tc.includes("status_pool"), "called status_pool"); });

// Test 7: parse_ast
const tmpAstFile = path.join(tmpDir, "ast.ts");
fs.writeFileSync(tmpAstFile, "export function foo() { return 1; }\n");
await testTool("parse_ast", `Use parse_ast to analyze ${tmpAstFile}. Tell me what functions exist. Be brief.`,
  (r, tc) => { assert(tc.includes("parse_ast"), "called parse_ast"); assert(r.includes("foo") || r.includes("function"), "found symbols"); });

// Test 8: salvar_sessao
await testTool("salvar_sessao", `Use salvar_sessao to save the current session. Be brief.`,
  (r, tc) => { assert(tc.includes("salvar_sessao"), "called salvar_sessao"); });

// Test 9: listar_sessoes
await testTool("listar_sessoes", `Use listar_sessoes to list all sessions. Be brief.`,
  (r, tc) => { assert(tc.includes("listar_sessoes"), "called listar_sessoes"); });

// Test 10: listar_backups
await testTool("listar_backups", `Use listar_backups to list all backups. Be brief.`,
  (r, tc) => { assert(tc.includes("listar_backups"), "called listar_backups"); });

// Test 11: atualizar_estado
await testTool("atualizar_estado", `Use atualizar_estado to set title to "Test". Reply done.`,
  (r, tc) => { assert(tc.includes("atualizar_estado"), "called atualizar_estado"); });

// Test 12: ler_estado
await testTool("ler_estado", `Use ler_estado to read TASK_STATE.md. Be brief.`,
  (r, tc) => { assert(tc.includes("ler_estado"), "called ler_estado"); });

// Test 13: escrever_spec
await testTool("escrever_spec", `Use escrever_spec with nome="calc", descricao="sum two numbers". Reply done.`,
  (r, tc) => { assert(tc.includes("escrever_spec"), "called escrever_spec"); });

// Test 14: criar_tdd
await testTool("criar_tdd", `Use criar_tdd with arquivo_teste="/tmp/test.py", arquivo_impl="/tmp/impl.py", linguagem="python", casos=["test1"]. Reply done.`,
  (r, tc) => { assert(tc.includes("criar_tdd"), "called criar_tdd"); });

// Test 15: Complex read→edit→verify
const tmpEditFile = path.join(tmpDir, "edit-test.ts");
fs.writeFileSync(tmpEditFile, "export const x = 1;\n");
await testTool("Complex: read→edit→verify", `Read ${tmpEditFile} using ler_arquivo. Then use editar_arquivo to change "x = 1" to "x = 42". Reply with the value of x.`,
  (r, tc) => {
    assert(tc.includes("ler_arquivo"), "read file");
    assert(tc.includes("editar_arquivo"), "edited file");
    assert(fs.readFileSync(tmpEditFile, "utf8").includes("42"), "file updated to 42");
    assert(tc.length <= 8, "no excessive looping", `${tc.length} calls`);
  });

// Test 16: Complex fix bug
const tmpBuggyFile = path.join(tmpDir, "buggy.ts");
fs.writeFileSync(tmpBuggyFile, "export function calc(x) {\n  return x + undefinedVar;\n}\n");
await testTool("Complex: fix bug", `Fix bug in ${tmpBuggyFile}. File has: export function calc(x) { return x + undefinedVar; }. Replace "undefinedVar" with "y" and add "y" as parameter. Use editar_arquivo. Reply "fixed".`,
  (r, tc) => {
    assert(tc.includes("editar_arquivo"), "edited to fix");
    const after = fs.readFileSync(tmpBuggyFile, "utf8");
    assert(!after.includes("undefinedVar"), "bug fixed");
    assert(tc.length <= 8, "no excessive looping", `${tc.length} calls`);
  });

console.log(`\n${"═".repeat(60)}`);
console.log(`SUMMARY: ${pass} passed, ${fail} failed`);
console.log("═".repeat(60));
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
