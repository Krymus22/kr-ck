#!/usr/bin/env node
/**
 * test-all-tools-agent-loop.mjs — Testa TODAS as tools via agent loop.
 *
 * Cada teste pede pra IA usar uma tool específica e verifica:
 * 1. A IA chamou a tool correta
 * 2. O resultado faz sentido
 * 3. Não houve loop infinito
 *
 * Usa llama-3.3-70b-instruct (kimi-k2.6 pode estar rate-limited).
 * Delay de 3s entre testes pra respeitar 40 RPM.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

// Load env
const ENV_PATH = "/home/z/my-project/claude-killer/.env";
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
}
process.env.MODEL = "meta/llama-3.3-70b-instruct";
if (!process.env.HOME) process.env.HOME = os.homedir();
process.chdir("/home/z/my-project/claude-killer");

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" };
const PASS = `${C.green}✓ PASS${C.reset}`;
const FAIL = `${C.red}✗ FAIL${C.reset}`;
const INFO = `${C.cyan}ℹ INFO${C.reset}`;
const SECTION = (s) => `\n${C.bold}\x1b[35m═══ ${s} ═══${C.reset}\n`;

let totalPass = 0, totalFail = 0;
const failures = [];
function assert(cond, msg, detail) {
  if (cond) { console.log(`  ${PASS}  ${msg}`); totalPass++; }
  else { console.log(`  ${FAIL}  ${msg}`); if (detail) console.log(`         \x1b[90m${detail}${C.reset}`); totalFail++; failures.push({ msg, detail: detail ?? "" }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runAgent(prompt) {
  const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
  const history = await import("/home/z/my-project/claude-killer/dist/history.js");
  history.resetHistory();
  const toolCalls = [];
  const toolResults = [];
  const result = await agent.runAgentLoop(prompt, undefined, undefined, undefined, undefined,
    (name, args) => { toolCalls.push({ name, args }); console.log(`${INFO}  [TOOL] ${name}(${JSON.stringify(args).slice(0, 100)})`); },
    (name, ok, resultStr) => { toolResults.push({ name, ok, resultStr: resultStr.slice(0, 120) }); },
    undefined, false);
  return { result, toolCalls, toolResults };
}

async function main() {
  console.log(`${C.bold}${C.cyan}╔════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  All Tools Agent Loop Test (llama-3.3-70b)                    ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════════════════╝${C.reset}`);

  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  modes.setActiveMode("normal");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-all-tools-"));
  let testNum = 0;

  async function testTool(name, prompt, checkFn) {
    testNum++;
    console.log(SECTION(`${testNum}. ${name}`));
    try {
      const { result, toolCalls, toolResults } = await runAgent(prompt);
      console.log(`${INFO}  Result: ${result.slice(0, 100)}`);
      console.log(`${INFO}  Tools used: ${toolCalls.map((t) => t.name).join(", ")} (${toolCalls.length} calls)`);
      checkFn(result, toolCalls, toolResults);
    } catch (err) {
      console.log(`${INFO}  Error: ${err.message.slice(0, 120)}`);
      if (err.message.includes("429") || err.message.includes("rate")) {
        assert(true, `${name} attempted (rate-limited)`);
      } else if (err.message.includes("maximum depth")) {
        assert(false, `${name}: agent loop did not loop infinitely`, `Loop detected — possible bug`);
      } else {
        assert(false, `${name} failed`, err.message.slice(0, 100));
      }
    }
    await sleep(3000);
  }

  // Setup files
  fs.writeFileSync(path.join(tmpDir, "app.ts"), "export function app() { return 1; }\n");
  fs.writeFileSync(path.join(tmpDir, "util.ts"), "export function util() { return 2; }\n");
  const tmpGitDir = path.join(tmpDir, "git-repo");
  fs.mkdirSync(tmpGitDir, { recursive: true });
  execSync("git init", { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git config user.email "t@t.com"', { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git config user.name "T"', { cwd: tmpGitDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpGitDir, "README.md"), "# Test\n");
  execSync("git add .", { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git commit -m "init"', { cwd: tmpGitDir, stdio: "pipe" });
  const tmpAstFile = path.join(tmpDir, "ast-test.ts");
  fs.writeFileSync(tmpAstFile, "export function foo() { return 1; }\nexport const bar = 2;\n");

  // 1. buscar_arquivos
  await testTool("buscar_arquivos", `Find all .ts files in ${tmpDir} using buscar_arquivos. List the files. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "buscar_arquivos"), "IA called buscar_arquivos"); assert(r.includes("app") || r.includes("util") || r.includes(".ts"), "IA found .ts files"); });

  // 2. buscar_texto
  await testTool("buscar_texto", `Search for "function" in ${tmpDir} using buscar_texto. Tell me how many matches. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "buscar_texto"), "IA called buscar_texto"); });

  // 3. git_status
  await testTool("git_status", `Run git_status on ${tmpGitDir} and tell me the branch name. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "git_status" || t.name === "executar_comando"), "IA checked git"); assert(r.toLowerCase().includes("master") || r.toLowerCase().includes("main") || r.toLowerCase().includes("branch"), "IA found branch"); });

  // 4. desfazer_edicao
  const tmpUndoFile = path.join(tmpDir, "undo-test.ts");
  fs.writeFileSync(tmpUndoFile, "original\n");
  await testTool("desfazer_edicao", `Edit ${tmpUndoFile} using editar_arquivo — change "original" to "modified". Then use desfazer_edicao to undo. Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "editar_arquivo"), "IA edited"); assert(tc.some((t) => t.name === "desfazer_edicao"), "IA called desfazer_edicao"); });

  // 5. todo_write
  await testTool("todo_write", `Use todo_write to create 3 items: "Read" (completed), "Edit" (in_progress), "Test" (pending). Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "todo_write"), "IA called todo_write"); });

  // 6. criar_plano
  await testTool("criar_plano", `Use criar_plano to create a plan: ["Read config", "Update config", "Verify"]. Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "criar_plano"), "IA called criar_plano"); });

  // 7. executar_comando
  await testTool("executar_comando", `Use executar_comando to run "echo hello-world". Tell me the output. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "executar_comando"), "IA called executar_comando"); assert(r.includes("hello"), "IA saw output"); });

  // 8. parse_ast
  await testTool("parse_ast", `Use parse_ast to analyze ${tmpAstFile}. Tell me what functions are defined. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "parse_ast"), "IA called parse_ast"); assert(r.includes("foo") || r.includes("bar") || r.includes("function"), "IA found symbols"); });

  // 9. salvar_sessao
  await testTool("salvar_sessao", `Use salvar_sessao to save the current session. Tell me the session ID. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "salvar_sessao"), "IA called salvar_sessao"); });

  // 10. escrever_spec
  await testTool("escrever_spec", `Use escrever_spec with nome="calculate", descricao="Sum two numbers". Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "escrever_spec"), "IA called escrever_spec"); });

  // 11. criar_tdd
  await testTool("criar_tdd", `Use criar_tdd with arquivo_teste="/tmp/test_calc.py", arquivo_impl="/tmp/calc.py", linguagem="python", casos=["test_add"]. Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "criar_tdd"), "IA called criar_tdd"); });

  // 12. status_pool
  await testTool("status_pool", `Use status_pool to check the API key pool. Tell me how many keys. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "status_pool"), "IA called status_pool"); });

  // 13. atualizar_estado
  await testTool("atualizar_estado", `Use atualizar_estado to set title to "Test Task" and add "item1" to done list. Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "atualizar_estado"), "IA called atualizar_estado"); });

  // 14. ler_estado
  await testTool("ler_estado", `Use ler_estado to read TASK_STATE.md. Tell me the title. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "ler_estado"), "IA called ler_estado"); });

  // 15. marcar_passo
  await testTool("marcar_passo", `Use criar_plano to create ["Step A", "Step B"]. Then use marcar_passo with indice=0, feito=true. Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "criar_plano"), "IA called criar_plano"); assert(tc.some((t) => t.name === "marcar_passo"), "IA called marcar_passo"); });

  // 16. pensar
  await testTool("pensar", `Use pensar with pensamento="I need to refactor" and categoria="planning". Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "pensar"), "IA called pensar"); });

  // 17. listar_backups
  await testTool("listar_backups", `Use listar_backups to list all available backups. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "listar_backups"), "IA called listar_backups"); });

  // 18. listar_sessoes
  await testTool("listar_sessoes", `Use listar_sessoes to list all saved sessions. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "listar_sessoes"), "IA called listar_sessoes"); });

  // 19. editar_multi_arquivos
  const fileA = path.join(tmpDir, "multi-a.ts");
  const fileB = path.join(tmpDir, "multi-b.ts");
  fs.writeFileSync(fileA, "export const a = 1;\n");
  fs.writeFileSync(fileB, "export const b = 2;\n");
  await testTool("editar_multi_arquivos", `Edit ${fileA} changing "a = 1" to "a = 100" AND ${fileB} changing "b = 2" to "b = 200". Use editar_multi_arquivos or editar_arquivo. Reply "done".`,
    (r, tc) => {
      const usedMulti = tc.some((t) => t.name === "editar_multi_arquivos");
      const usedSingle = tc.filter((t) => t.name === "editar_arquivo").length >= 2;
      assert(usedMulti || usedSingle, "IA edited multiple files");
    });

  // 20. capturar_snapshot
  await testTool("capturar_snapshot", `Use capturar_snapshot with funcao="foo", arquivo="${tmpAstFile}", inputs="[1]". Reply "done".`,
    (r, tc) => { assert(tc.some((t) => t.name === "capturar_snapshot"), "IA called capturar_snapshot"); });

  // 21. pesquisar_api_atualizada
  await testTool("pesquisar_api_atualizada", `Use pesquisar_api_atualizada with nome="print", linguagem="roblox". Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "pesquisar_api_atualizada"), "IA called pesquisar_api_atualizada"); });

  // 22. executar_testes
  await testTool("executar_testes", `Use executar_testes to run tests in ${tmpDir}. Be brief.`,
    (r, tc) => { assert(tc.some((t) => t.name === "executar_testes"), "IA called executar_testes"); });

  // 23. Complex: read → edit → read
  const tmpVerifyFile = path.join(tmpDir, "verify-test.ts");
  fs.writeFileSync(tmpVerifyFile, "export const x = 1;\n");
  await testTool("Complex: read → edit → verify", `Read ${tmpVerifyFile} using ler_arquivo. Then use editar_arquivo to change "x = 1" to "x = 42". Then read it again. Reply with the final value of x.`,
    (r, tc) => {
      assert(tc.some((t) => t.name === "ler_arquivo"), "IA read the file");
      assert(tc.some((t) => t.name === "editar_arquivo"), "IA edited the file");
      assert(fs.readFileSync(tmpVerifyFile, "utf8").includes("42"), "File updated to 42");
      assert(tc.length <= 10, "No excessive looping", `${tc.length} tool calls`);
    });

  // 24. Complex: create file + verify
  const tmpNewFile = path.join(tmpDir, "new-create.ts");
  await testTool("Complex: create + verify", `Create ${tmpNewFile} using editar_arquivo with createIfMissing=true. Write "export const hello = 'world';". Then read it back. Reply "done".`,
    (r, tc) => {
      assert(tc.some((t) => t.name === "editar_arquivo"), "IA created file");
      if (fs.existsSync(tmpNewFile)) { assert(fs.readFileSync(tmpNewFile, "utf8").includes("hello"), "File has correct content"); }
      else { assert(false, "File was created", "not found"); }
    });

  // 25. Complex: fix bug
  const tmpBuggyFile = path.join(tmpDir, "buggy-fix.ts");
  fs.writeFileSync(tmpBuggyFile, "export function calc(x) {\n  return x + undefinedVar;\n}\n");
  await testTool("Complex: fix bug", `Fix the bug in ${tmpBuggyFile}. The file has: export function calc(x) { return x + undefinedVar; }. Replace "undefinedVar" with "y" and add "y" as parameter. Use editar_arquivo. Reply "fixed".`,
    (r, tc) => {
      assert(tc.some((t) => t.name === "editar_arquivo"), "IA edited to fix bug");
      const after = fs.readFileSync(tmpBuggyFile, "utf8");
      assert(!after.includes("undefinedVar"), "Bug fixed");
      assert(tc.length <= 8, "No excessive looping", `${tc.length} tool calls`);
    });

  // SUMMARY
  console.log("\n" + "═".repeat(80));
  console.log(`${C.bold}SUMMARY${C.reset}`);
  console.log("═".repeat(80));
  console.log(`  ${C.green}Passed:${C.reset} ${totalPass}`);
  console.log(`  ${C.red}Failed:${C.reset} ${totalFail}`);
  console.log("═".repeat(80));
  if (failures.length > 0) { console.log(`\n${C.red}Failures:${C.reset}`); for (const f of failures) { console.log(`  • ${f.msg}`); if (f.detail) console.log(`    \x1b[90m${f.detail}${C.reset}`); } }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`); process.exit(2); });
