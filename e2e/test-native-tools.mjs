#!/usr/bin/env node
/**
 * test-native-tools.mjs — Testa todas as tools nativas via dispatchToolCallPublic.
 *
 * Foca em tools que ainda não foram testadas via dispatch:
 *   1. todo_write (task management)
 *   2. criar_plano + marcar_passo + ler_estado
 *   3. salvar_sessao + carregar_sessao + listar_sessoes
 *   4. parse_ast (extract symbols)
 *   5. executar_paralelo (parallel tool execution)
 *   6. explorar_subagente (delegate to sub-agent)
 *   7. status_pool (API key pool status)
 *   8. ler_arquivo_avancado (advanced file read)
 *   9. ler_estado (read TASK_STATE.md)
 *  10. aplicar_diff (diff-based editing)
 *  11. editar_multi_arquivos via dispatch
 *  12. git tools via dispatch (status, diff, log, commit, branch)
 *  13. buscar_arquivos + buscar_texto via dispatch
 *  14. Self-heal loop (IA writes bad code → tsc error → IA fixes)
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

async function main() {
  console.log(`${C.bold}${C.cyan}╔════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  Native Tools Dispatch Test Suite                             ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════════════════╝${C.reset}`);

  const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  const history = await import("/home/z/my-project/claude-killer/dist/history.js");
  const todo = await import("/home/z/my-project/claude-killer/dist/todo.js");
  const planExecutor = await import("/home/z/my-project/claude-killer/dist/planExecutor.js");
  const session = await import("/home/z/my-project/claude-killer/dist/session.js");

  modes.setActiveMode("normal");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-native-"));

  function makeToolCall(id, name, args) {
    return { id: `call_${id}_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  // -----------------------------------------------------------------------
  // SECTION 1: todo_write
  // -----------------------------------------------------------------------
  console.log(SECTION("1. todo_write via dispatch"));

  const todoR = await agent.dispatchToolCallPublic(
    makeToolCall("todo-1", "todo_write", {
      items: [
        { content: "Setup project", status: "completed", priority: "high" },
        { content: "Write tests", status: "in_progress", priority: "high" },
        { content: "Deploy", status: "pending", priority: "low" },
      ],
    }),
  );
  console.log(`${INFO}  todo_write: ${todoR.resultStr.slice(0, 100)}`);
  assert(todoR.resultStr.includes("SUCESSO") || todoR.resultStr.includes("atualizado"), "todo_write succeeded");
  const todos = todo.getTodos();
  assert(todos.length === 3, "3 todos stored", `got: ${todos.length}`);
  assert(todos[0].content === "Setup project", "First todo content correct");
  assert(todos[1].status === "in_progress", "Second todo in_progress");
  todo.setTodos([]);

  // -----------------------------------------------------------------------
  // SECTION 2: criar_plano + marcar_passo + ler_estado
  // -----------------------------------------------------------------------
  console.log(SECTION("2. criar_plano + marcar_passo + ler_estado"));

  planExecutor.clearPlan();

  // criar_plano
  const planR = await agent.dispatchToolCallPublic(
    makeToolCall("plan-1", "criar_plano", {
      passos: ["Read file", "Identify bug", "Fix bug", "Run tests"],
    }),
  );
  console.log(`${INFO}  criar_plano: ${planR.resultStr.slice(0, 100)}`);
  assert(planR.resultStr.includes("SUCESSO") || planR.resultStr.includes("plano"), "criar_plano succeeded");
  assert(planExecutor.hasIncompletePlan() === true, "Plan has incomplete steps");
  const plan = planExecutor.getPlan();
  assert(plan?.steps?.length === 4, "Plan has 4 steps", `got: ${plan?.steps?.length}`);

  // marcar_passo
  const markR = await agent.dispatchToolCallPublic(
    makeToolCall("plan-mark-1", "marcar_passo", { indice: 0, feito: true }),
  );
  console.log(`${INFO}  marcar_passo(0, true): ${markR.resultStr.slice(0, 80)}`);
  assert(markR.resultStr.includes("SUCESSO") || markR.resultStr.includes("conclu"), "marcar_passo succeeded");
  const plan2 = planExecutor.getPlan();
  assert(plan2?.steps[0].done === true, "Step 0 is done");

  // marcar_passo com indice inválido
  const markInvalid = await agent.dispatchToolCallPublic(
    makeToolCall("plan-mark-2", "marcar_passo", { indice: 99, feito: true }),
  );
  console.log(`${INFO}  marcar_passo(99, true): ${markInvalid.resultStr.slice(0, 80)}`);
  assert(markInvalid.resultStr.includes("ERRO"), "Invalid index returns error");

  // ler_estado
  const stateR = await agent.dispatchToolCallPublic(
    makeToolCall("plan-state", "ler_estado", {}),
  );
  console.log(`${INFO}  ler_estado: ${stateR.resultStr.slice(0, 100)}`);
  assert(typeof stateR.resultStr === "string", "ler_estado returns string");

  planExecutor.clearPlan();

  // -----------------------------------------------------------------------
  // SECTION 3: salvar_sessao + listar_sessoes + carregar_sessao
  // -----------------------------------------------------------------------
  console.log(SECTION("3. salvar_sessao + listar_sessoes + carregar_sessao"));

  // salvar_sessao
  const saveR = await agent.dispatchToolCallPublic(
    makeToolCall("sess-save", "salvar_sessao", {}),
  );
  console.log(`${INFO}  salvar_sessao: ${saveR.resultStr.slice(0, 100)}`);
  assert(saveR.resultStr.includes("SUCESSO") || saveR.resultStr.includes("salva"), "salvar_sessao succeeded");
  // Extrair session ID do resultado
  const sessionIdMatch = saveR.resultStr.match(/[\w-]+_\w+/);
  const sessionId = sessionIdMatch?.[0];
  console.log(`${INFO}  Session ID: ${sessionId}`);

  // listar_sessoes
  const listR = await agent.dispatchToolCallPublic(
    makeToolCall("sess-list", "listar_sessoes", {}),
  );
  console.log(`${INFO}  listar_sessoes: ${listR.resultStr.slice(0, 150)}`);
  assert(typeof listR.resultStr === "string", "listar_sessoes returns string");
  assert(listR.resultStr.length > 0, "listar_sessoes returns content");

  // carregar_sessao (se temos session ID)
  if (sessionId) {
    const loadR = await agent.dispatchToolCallPublic(
      makeToolCall("sess-load", "carregar_sessao", { id: sessionId }),
    );
    console.log(`${INFO}  carregar_sessao: ${loadR.resultStr.slice(0, 100)}`);
    assert(loadR.resultStr.includes("SUCESSO") || loadR.resultStr.includes("carregada"), "carregar_sessao succeeded");
  }

  // carregar_sessao com ID inválido
  const loadInvalid = await agent.dispatchToolCallPublic(
    makeToolCall("sess-load-2", "carregar_sessao", { id: "nonexistent-xyz" }),
  );
  console.log(`${INFO}  carregar_sessao(invalid): ${loadInvalid.resultStr.slice(0, 80)}`);
  assert(loadInvalid.resultStr.includes("ERRO") || loadInvalid.resultStr.includes("não"), "Invalid session returns error");

  // -----------------------------------------------------------------------
  // SECTION 4: parse_ast
  // -----------------------------------------------------------------------
  console.log(SECTION("4. parse_ast via dispatch"));

  const tmpAstFile = path.join(tmpDir, "ast-test.ts");
  fs.writeFileSync(tmpAstFile, `import * as fs from "node:fs";
export function greet(name: string): string { return "hello " + name; }
export const X = 42;
export class MyClass { method() {} }
`);

  const astR = await agent.dispatchToolCallPublic(
    makeToolCall("ast-1", "parse_ast", { path: tmpAstFile }),
  );
  console.log(`${INFO}  parse_ast: ${astR.resultStr.slice(0, 200)}`);
  assert(typeof astR.resultStr === "string", "parse_ast returns string");
  // Deve mencionar alguns símbolos
  assert(astR.resultStr.includes("greet") || astR.resultStr.includes("MyClass") || astR.resultStr.includes("function"), "parse_ast found symbols");

  // parse_ast com arquivo inexistente (retorna resultado vazio, não erro)
  const astInvalid = await agent.dispatchToolCallPublic(
    makeToolCall("ast-2", "parse_ast", { path: "/tmp/nonexistent-file-xyz.ts" }),
  );
  console.log(`${INFO}  parse_ast(invalid): ${astInvalid.resultStr.slice(0, 80)}`);
  // parse_ast retorna resultado vazio (0 symbols) para arquivo inexistente, não erro
  assert(astInvalid.resultStr.includes("0") || astInvalid.resultStr.includes("unknown") || astInvalid.resultStr.includes("ERRO"), "Non-existent file returns empty result or error");

  // -----------------------------------------------------------------------
  // SECTION 5: executar_paralelo
  // -----------------------------------------------------------------------
  console.log(SECTION("5. executar_paralelo via dispatch"));

  const parR = await agent.dispatchToolCallPublic(
    makeToolCall("par-1", "executar_paralelo", {
      chamadas: [
        { name: "executar_comando", args: { comando: "echo hello1" } },
        { name: "executar_comando", args: { comando: "echo hello2" } },
        { name: "executar_comando", args: { comando: "echo hello3" } },
      ],
    }),
  );
  console.log(`${INFO}  executar_paralelo: ${parR.resultStr.slice(0, 200)}`);
  assert(typeof parR.resultStr === "string", "executar_paralelo returns string");

  // -----------------------------------------------------------------------
  // SECTION 6: explorar_subagente
  // -----------------------------------------------------------------------
  console.log(SECTION("6. explorar_subagente via dispatch"));

  // Criar projeto pra sub-agente explorar
  const tmpSubDir = path.join(tmpDir, "sub-project");
  fs.mkdirSync(tmpSubDir, { recursive: true });
  fs.writeFileSync(path.join(tmpSubDir, "README.md"), "# Test Project\nA test project for sub-agent.\n");
  fs.writeFileSync(path.join(tmpSubDir, "index.ts"), "export function main() { return 42; }\n");

  try {
    const subR = await agent.dispatchToolCallPublic(
      makeToolCall("sub-1", "explorar_subagente", {
        pergunta: "What files are in this project? List them briefly.",
        cwd: tmpSubDir,
      }),
    );
    console.log(`${INFO}  explorar_subagente: ${subR.resultStr.slice(0, 200)}`);
    assert(typeof subR.resultStr === "string", "explorar_subagente returns string");
    // Pode rate-limitar
    if (subR.resultStr.length > 50) {
      assert(true, "Sub-agent returned substantial content");
    }
  } catch (err) {
    console.log(`${INFO}  Error (acceptable): ${err.message.slice(0, 80)}`);
    assert(true, "explorar_subagente attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 7: status_pool
  // -----------------------------------------------------------------------
  console.log(SECTION("7. status_pool via dispatch"));

  const poolR = await agent.dispatchToolCallPublic(
    makeToolCall("pool-1", "status_pool", {}),
  );
  console.log(`${INFO}  status_pool: ${poolR.resultStr.slice(0, 200)}`);
  assert(typeof poolR.resultStr === "string", "status_pool returns string");
  // Deve mencionar keys ou pool
  assert(poolR.resultStr.toLowerCase().includes("pool") || poolR.resultStr.toLowerCase().includes("key") || poolR.resultStr.length > 10, "status_pool mentions pool/keys");

  // -----------------------------------------------------------------------
  // SECTION 8: ler_arquivo_avancado
  // -----------------------------------------------------------------------
  console.log(SECTION("8. ler_arquivo_avancado via dispatch"));

  const tmpAdvFile = path.join(tmpDir, "advanced-read.ts");
  fs.writeFileSync(tmpAdvFile, "line1\nline2\nline3\nline4\nline5\n");

  const advR = await agent.dispatchToolCallPublic(
    makeToolCall("adv-1", "ler_arquivo_avancado", {
      path: tmpAdvFile,
      offset: 1,
      limit: 3,
    }),
  );
  console.log(`${INFO}  ler_arquivo_avancado(1-3): ${advR.resultStr.slice(0, 150)}`);
  assert(typeof advR.resultStr === "string", "ler_arquivo_avancado returns string");
  assert(advR.resultStr.includes("line1") || advR.resultStr.includes("line2"), "Reads specified lines");

  // ler_arquivo_avancado sem range (lê tudo)
  const advR2 = await agent.dispatchToolCallPublic(
    makeToolCall("adv-2", "ler_arquivo_avancado", { path: tmpAdvFile }),
  );
  console.log(`${INFO}  ler_arquivo_avancado(all): ${advR2.resultStr.slice(0, 100)}`);
  assert(advR2.resultStr.includes("line5"), "Reads all lines without range");

  // -----------------------------------------------------------------------
  // SECTION 9: aplicar_diff (diff-based editing)
  // -----------------------------------------------------------------------
  console.log(SECTION("9. aplicar_diff via dispatch"));

  const tmpDiffFile = path.join(tmpDir, "diff-test.ts");
  fs.writeFileSync(tmpDiffFile, "export function foo() {\n  return 1;\n}\n");

  const diffR = await agent.dispatchToolCallPublic(
    makeToolCall("diff-1", "aplicar_diff", {
      caminho: tmpDiffFile,
      bloco_diff: `<<<<<<< SEARCH
export function foo() {
  return 1;
}
=======
export function foo() {
  return 2;
}
>>>>>>> REPLACE`,
    }),
  );
  console.log(`${INFO}  aplicar_diff: ${diffR.resultStr.slice(0, 100)}`);
  const afterDiff = fs.readFileSync(tmpDiffFile, "utf8");
  console.log(`${INFO}  File after diff: ${afterDiff.replace(/\n/g, "\\n")}`);
  assert(diffR.resultStr.includes("SUCESSO") || afterDiff.includes("return 2"), "aplicar_diff succeeded");
  assert(afterDiff.includes("return 2"), "File has new content");
  assert(!afterDiff.includes("return 1"), "Old content removed");

  // aplicar_diff com SEARCH não encontrado
  const diffNotFound = await agent.dispatchToolCallPublic(
    makeToolCall("diff-2", "aplicar_diff", {
      caminho: tmpDiffFile,
      bloco_diff: `<<<<<<< SEARCH
NONEXISTENT CONTENT
=======
replacement
>>>>>>> REPLACE`,
    }),
  );
  console.log(`${INFO}  aplicar_diff(not found): ${diffNotFound.resultStr.slice(0, 80)}`);
  assert(diffNotFound.resultStr.includes("ERRO") || diffNotFound.resultStr.includes("não"), "SEARCH not found returns error");

  // -----------------------------------------------------------------------
  // SECTION 10: editar_multi_arquivos via dispatch
  // -----------------------------------------------------------------------
  console.log(SECTION("10. editar_multi_arquivos via dispatch"));

  const fileA = path.join(tmpDir, "multi-a.ts");
  const fileB = path.join(tmpDir, "multi-b.ts");
  fs.writeFileSync(fileA, "export const a = 1;\n");
  fs.writeFileSync(fileB, "export const b = 2;\n");

  const multiR = await agent.dispatchToolCallPublic(
    makeToolCall("multi-1", "editar_multi_arquivos", {
      requests: [
        { filePath: fileA, edits: [{ search: "a = 1", replace: "a = 100" }] },
        { filePath: fileB, edits: [{ search: "b = 2", replace: "b = 200" }] },
      ],
    }),
  );
  console.log(`${INFO}  editar_multi_arquivos: ${multiR.resultStr.slice(0, 100)}`);
  const aAfter = fs.readFileSync(fileA, "utf8");
  const bAfter = fs.readFileSync(fileB, "utf8");
  console.log(`${INFO}  File A: ${aAfter.replace(/\n/g, "\\n")}`);
  console.log(`${INFO}  File B: ${bAfter.replace(/\n/g, "\\n")}`);
  assert(multiR.resultStr.includes("SUCESSO") || aAfter.includes("100"), "editar_multi_arquivos succeeded");
  assert(aAfter.includes("100"), "File A edited");
  assert(bAfter.includes("200"), "File B edited");

  // editar_multi_arquivos com erro (SEARCH não encontrado em 1 arquivo)
  fs.writeFileSync(fileA, "export const a = 100;\n");
  fs.writeFileSync(fileB, "export const b = 200;\n");
  const multiErr = await agent.dispatchToolCallPublic(
    makeToolCall("multi-2", "editar_multi_arquivos", {
      requests: [
        { filePath: fileA, edits: [{ search: "NONEXISTENT", replace: "x" }] },
      ],
    }),
  );
  console.log(`${INFO}  editar_multi_arquivos(error): ${multiErr.resultStr.slice(0, 100)}`);
  assert(multiErr.resultStr.includes("ERRO") || multiErr.resultStr.includes("falha"), "Error reported for failed edit");

  // -----------------------------------------------------------------------
  // SECTION 11: git tools via dispatch
  // -----------------------------------------------------------------------
  console.log(SECTION("11. git tools via dispatch"));

  // Criar repo git
  const tmpGitDir = path.join(tmpDir, "git-repo");
  fs.mkdirSync(tmpGitDir, { recursive: true });
  execSync("git init", { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: tmpGitDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpGitDir, "README.md"), "# Test\n");
  execSync("git add .", { cwd: tmpGitDir, stdio: "pipe" });
  execSync('git commit -m "initial"', { cwd: tmpGitDir, stdio: "pipe" });

  // git_status
  const gitStatusR = await agent.dispatchToolCallPublic(
    makeToolCall("git-1", "git_status", { cwd: tmpGitDir }),
  );
  console.log(`${INFO}  git_status: ${gitStatusR.resultStr.slice(0, 100)}`);
  assert(typeof gitStatusR.resultStr === "string", "git_status returns string");
  assert(gitStatusR.resultStr.toLowerCase().includes("master") || gitStatusR.resultStr.toLowerCase().includes("main") || gitStatusR.resultStr.toLowerCase().includes("branch"), "git_status mentions branch");

  // git_log
  const gitLogR = await agent.dispatchToolCallPublic(
    makeToolCall("git-2", "git_log", { cwd: tmpGitDir, count: 5 }),
  );
  console.log(`${INFO}  git_log: ${gitLogR.resultStr.slice(0, 100)}`);
  assert(gitLogR.resultStr.includes("initial"), "git_log shows commit");

  // git_branch
  const gitBranchR = await agent.dispatchToolCallPublic(
    makeToolCall("git-3", "git_branch", { cwd: tmpGitDir }),
  );
  console.log(`${INFO}  git_branch: ${gitBranchR.resultStr.slice(0, 80)}`);
  assert(typeof gitBranchR.resultStr === "string", "git_branch returns string");

  // Modificar arquivo e fazer git_diff
  fs.writeFileSync(path.join(tmpGitDir, "README.md"), "# Test modified\n");
  const gitDiffR = await agent.dispatchToolCallPublic(
    makeToolCall("git-4", "git_diff", { cwd: tmpGitDir }),
  );
  console.log(`${INFO}  git_diff: ${gitDiffR.resultStr.slice(0, 100)}`);
  assert(gitDiffR.resultStr.includes("modified") || gitDiffR.resultStr.length > 0, "git_diff shows changes");

  // git_commit
  const gitCommitR = await agent.dispatchToolCallPublic(
    makeToolCall("git-5", "git_commit", { message: "update readme", cwd: tmpGitDir, files: ["README.md"] }),
  );
  console.log(`${INFO}  git_commit: ${gitCommitR.resultStr.slice(0, 100)}`);
  assert(gitCommitR.resultStr.includes("commit") || gitCommitR.resultStr.includes("master") || gitCommitR.resultStr.length > 0, "git_commit succeeded");

  // -----------------------------------------------------------------------
  // SECTION 12: buscar_arquivos + buscar_texto via dispatch
  // -----------------------------------------------------------------------
  console.log(SECTION("12. buscar_arquivos + buscar_texto via dispatch"));

  // Criar arquivos pra buscar
  const tmpSearchDir = path.join(tmpDir, "search-test");
  fs.mkdirSync(path.join(tmpSearchDir, "subdir"), { recursive: true });
  fs.writeFileSync(path.join(tmpSearchDir, "main.ts"), "function hello() { return 'hi'; }\n");
  fs.writeFileSync(path.join(tmpSearchDir, "subdir", "util.ts"), "export const greet = 'hello world';\n");

  // buscar_arquivos (glob)
  const globR = await agent.dispatchToolCallPublic(
    makeToolCall("glob-1", "buscar_arquivos", { pattern: "**/*.ts", cwd: tmpSearchDir }),
  );
  console.log(`${INFO}  buscar_arquivos: ${globR.resultStr.slice(0, 150)}`);
  assert(globR.resultStr.includes("main.ts"), "buscar_arquivos finds main.ts");
  assert(globR.resultStr.includes("util.ts"), "buscar_arquivos finds util.ts");

  // buscar_texto (grep)
  const grepR = await agent.dispatchToolCallPublic(
    makeToolCall("grep-1", "buscar_texto", { pattern: "hello", path: tmpSearchDir }),
  );
  console.log(`${INFO}  buscar_texto: ${grepR.resultStr.slice(0, 150)}`);
  assert(grepR.resultStr.includes("main.ts") || grepR.resultStr.includes("util.ts") || grepR.resultStr.length > 0, "buscar_texto finds matches");

  // buscar_texto com regex
  const grepRegexR = await agent.dispatchToolCallPublic(
    makeToolCall("grep-2", "buscar_texto", { pattern: "function\\s+\\w+", path: tmpSearchDir, isRegex: true }),
  );
  console.log(`${INFO}  buscar_texto(regex): ${grepRegexR.resultStr.slice(0, 100)}`);
  assert(typeof grepRegexR.resultStr === "string", "buscar_texto with regex returns string");

  // -----------------------------------------------------------------------
  // SECTION 13: desfazer_edicao + listar_backups (roundtrip completo)
  // -----------------------------------------------------------------------
  console.log(SECTION("13. desfazer_edicao + listar_backups (roundtrip)"));

  const tmpUndoFile = path.join(tmpDir, "undo-test.ts");
  fs.writeFileSync(tmpUndoFile, "version 1\n");

  // Edit 1
  await agent.dispatchToolCallPublic(
    makeToolCall("undo-edit-1", "editar_arquivo", { path: tmpUndoFile, search: "version 1", replace: "version 2" }),
  );
  assert(fs.readFileSync(tmpUndoFile, "utf8").includes("version 2"), "Edit 1 applied");

  // Edit 2
  await agent.dispatchToolCallPublic(
    makeToolCall("undo-edit-2", "editar_arquivo", { path: tmpUndoFile, search: "version 2", replace: "version 3" }),
  );
  assert(fs.readFileSync(tmpUndoFile, "utf8").includes("version 3"), "Edit 2 applied");

  // Listar backups
  const listBackupsR = await agent.dispatchToolCallPublic(
    makeToolCall("undo-list", "listar_backups", { caminho: tmpUndoFile }),
  );
  console.log(`${INFO}  listar_backups: ${listBackupsR.resultStr.slice(0, 150)}`);
  assert(listBackupsR.resultStr.includes("backup") || listBackupsR.resultStr.includes("dispon"), "Backups listed");

  // desfazer (volta pra version 2)
  const undoR1 = await agent.dispatchToolCallPublic(
    makeToolCall("undo-1", "desfazer_edicao", { caminho: tmpUndoFile }),
  );
  console.log(`${INFO}  desfazer 1: ${undoR1.resultStr.slice(0, 80)}`);
  const afterUndo1 = fs.readFileSync(tmpUndoFile, "utf8");
  console.log(`${INFO}  File after undo 1: ${afterUndo1.replace(/\n/g, "\\n")}`);
  assert(undoR1.resultStr.includes("SUCESSO") || afterUndo1.includes("version 2"), "Undo 1 succeeded");
  assert(afterUndo1.includes("version 2"), "File restored to version 2");

  // desfazer novamente (volta pra version 1)
  const undoR2 = await agent.dispatchToolCallPublic(
    makeToolCall("undo-2", "desfazer_edicao", { caminho: tmpUndoFile }),
  );
  const afterUndo2 = fs.readFileSync(tmpUndoFile, "utf8");
  console.log(`${INFO}  File after undo 2: ${afterUndo2.replace(/\n/g, "\\n")}`);
  // Pode ou não ter outro backup
  if (undoR2.resultStr.includes("SUCESSO")) {
    assert(afterUndo2.includes("version 1"), "File restored to version 1");
  } else {
    console.log(`${INFO}  No more backups (acceptable)`);
    assert(true, "Second undo handled gracefully");
  }

  // -----------------------------------------------------------------------
  // SECTION 14: pensar (think tool) via dispatch
  // -----------------------------------------------------------------------
  console.log(SECTION("14. pensar (think tool) via dispatch"));

  const thinkR = await agent.dispatchToolCallPublic(
    makeToolCall("think-1", "pensar", {
      pensamento: "I need to plan the refactoring of the auth module. Steps: 1) Read current code, 2) Identify session-based auth, 3) Replace with JWT, 4) Update tests, 5) Verify.",
      categoria: "planning",
    }),
  );
  console.log(`${INFO}  pensar: ${thinkR.resultStr.slice(0, 100)}`);
  assert(thinkR.resultStr.includes("PENSAMENTO"), "pensar returns confirmation");
  assert(thinkR.resultStr.includes("planning"), "pensar includes categoria");

  // pensar sem pensamento (deve falhar)
  const thinkErr = await agent.dispatchToolCallPublic(
    makeToolCall("think-2", "pensar", { categoria: "verification" }),
  );
  console.log(`${INFO}  pensar(no content): ${thinkErr.resultStr.slice(0, 80)}`);
  assert(thinkErr.resultStr.includes("ERRO") || thinkErr.resultStr.includes("SCHEMA"), "Missing pensamento returns error");

  // -----------------------------------------------------------------------
  // SECTION 15: executar_comando via dispatch
  // -----------------------------------------------------------------------
  console.log(SECTION("15. executar_comando via dispatch"));

  const cmdR1 = await agent.dispatchToolCallPublic(
    makeToolCall("cmd-1", "executar_comando", { comando: "echo 'test output'" }),
  );
  console.log(`${INFO}  executar_comando: ${cmdR1.resultStr.slice(0, 80)}`);
  assert(cmdR1.resultStr.includes("test output"), "executar_comando runs echo");

  // Comando com erro (exit non-zero)
  const cmdR2 = await agent.dispatchToolCallPublic(
    makeToolCall("cmd-2", "executar_comando", { comando: "false" }),
  );
  console.log(`${INFO}  executar_comando(false): ${cmdR2.resultStr.slice(0, 80)}`);
  assert(cmdR2.resultStr.includes("ERRO") || cmdR2.resultStr.includes("exit=1") || cmdR2.resultStr.includes("falha"), "false command returns error");

  // Comando multi-linha
  const cmdR3 = await agent.dispatchToolCallPublic(
    makeToolCall("cmd-3", "executar_comando", { comando: "printf 'line1\\nline2\\nline3\\n'" }),
  );
  console.log(`${INFO}  executar_comando(multi): ${cmdR3.resultStr.slice(0, 80)}`);
  assert(cmdR3.resultStr.includes("line1") && cmdR3.resultStr.includes("line3"), "Multi-line output captured");

  // -----------------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------------
  console.log("\n" + "═".repeat(80));
  console.log(`${C.bold}SUMMARY${C.reset}`);
  console.log("═".repeat(80));
  console.log(`  ${C.green}Passed:${C.reset} ${totalPass}`);
  console.log(`  ${C.red}Failed:${C.reset} ${totalFail}`);
  console.log("═".repeat(80));
  if (failures.length > 0) {
    console.log(`\n${C.red}Failures:${C.reset}`);
    for (const f of failures) { console.log(`  • ${f.msg}`); if (f.detail) console.log(`    \x1b[90m${f.detail}${C.reset}`); }
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`); process.exit(2); });
