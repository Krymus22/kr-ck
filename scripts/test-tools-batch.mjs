/**
 * test-tools-batch.mjs — Run tests in chunks of N tests.
 * Usage: node test-tools-batch.mjs <start> <count>
 * Where start = test index (1-based), count = how many tests to run.
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
process.chdir("/home/z/my-project/claude-killer");

const C = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m" };
const PASS = `${C.green}PASS${C.reset}`;
const FAIL = `${C.red}FAIL${C.reset}`;
const SKIP = `${C.yellow}SKIP${C.reset}`;

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
const history = await import("/home/z/my-project/claude-killer/dist/history.js");
const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-batch-"));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT(${ms}ms): ${label}`)), ms))
  ]);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===========================================================================
// Test definitions: id, label, prompt, checkFn, mode, opts
// ===========================================================================
const tests = [];

function t(id, label, prompt, checkFn, mode = "normal", opts = {}) {
  tests.push({ id, label, prompt, checkFn, mode, opts });
}

// --- All tests defined here ---
t(1, "ler_arquivo",
  (p) => `Read ${p.f} using ler_arquivo. Tell me the value of ANSWER. Reply with just the number.`,
  (p, r, tc) => [
    [tc.includes("ler_arquivo"), "called ler_arquivo"],
    [String(r).includes("42"), "returned value 42"],
    [tc.length <= 5, `no looping (${tc.length} calls)`]
  ]);

t(2, "editar_arquivo (search/replace)",
  (p) => `Use editar_arquivo to change "X = 1" to "X = 99" in ${p.f}. Reply "done".`,
  (p, r, tc) => [
    [tc.includes("editar_arquivo"), "called editar_arquivo"],
    [fs.readFileSync(p.f, "utf8").includes("99"), "file has new value"],
    [tc.length <= 5, `no looping (${tc.length} calls)`]
  ]);

t(3, "editar_arquivo (createIfMissing)",
  (p) => `Create ${p.f} using editar_arquivo with createIfMissing=true and content "export const CREATED = true;". Reply "done".`,
  (p, r, tc) => [
    [tc.includes("editar_arquivo"), "called editar_arquivo"],
    [fs.existsSync(p.f), "file was created"],
    [fs.readFileSync(p.f, "utf8").includes("CREATED"), "file has content"]
  ]);

t(4, "buscar_arquivos",
  (p) => `Use buscar_arquivos to find all .ts files in ${tmpDir}. Tell me how many .ts files exist. Reply with just the number.`,
  (p, r, tc) => [
    [tc.includes("buscar_arquivos"), "called buscar_arquivos"],
    [/[2-9]/.test(String(r)), "found at least 2 files"]
  ]);

t(5, "buscar_texto",
  (p) => `Use buscar_texto to search for "helloWorld" in ${tmpDir}. Tell me which file contains it. Reply with just the filename.`,
  (p, r, tc) => [
    [tc.includes("buscar_texto"), "called buscar_texto"],
    [String(r).toLowerCase().includes("search-text"), "found the right file"],
    [tc.length <= 5, `no looping (${tc.length} calls)`]
  ]);

t(6, "parse_ast",
  (p) => `Use parse_ast to analyze ${p.f}. Tell me what functions are defined. Reply briefly.`,
  (p, r, tc) => [
    [tc.includes("parse_ast"), "called parse_ast"],
    [/foo|bar/i.test(String(r)), "identified a function"]
  ]);

t(7, "executar_comando",
  () => `Use executar_comando to run "echo e2e-test-marker". Tell me the output. Reply briefly.`,
  (p, r, tc) => [
    [tc.includes("executar_comando"), "called executar_comando"],
    [String(r).includes("e2e-test-marker"), "saw command output"]
  ]);

t(8, "executar_testes",
  () => `Use executar_testes to run "echo simulating-test-runner" as the test command. Tell me the output briefly.`,
  (p, r, tc) => [
    [tc.includes("executar_testes"), "called executar_testes"]
  ]);

t(9, "sugerir_fixes",
  (p) => `Use sugerir_fixes on ${p.f} to get suggestions for fixing issues. Tell me briefly what was suggested.`,
  (p, r, tc) => [
    [tc.includes("sugerir_fixes"), "called sugerir_fixes"]
  ]);

t(10, "desfazer_edicao",
  (p) => `Use editar_arquivo to change "ORIGINAL_CONTENT" to "MODIFIED" in ${p.f}. Then use desfazer_edicao to undo the last edit. Reply "done".`,
  (p, r, tc) => [
    [tc.includes("editar_arquivo"), "called editar_arquivo first"],
    [tc.includes("desfazer_edicao"), "called desfazer_edicao"],
    [fs.readFileSync(p.f, "utf8").includes("ORIGINAL_CONTENT"), "file restored to original"]
  ]);

t(11, "atualizar_estado",
  () => `Use atualizar_estado with key="e2e_test_key" and value="e2e_test_value". Reply "done".`,
  (p, r, tc) => [
    [tc.includes("atualizar_estado"), "called atualizar_estado"]
  ]);

t(12, "ler_estado",
  () => `Use ler_estado to read the value of key="e2e_test_key". Tell me the value. Reply briefly.`,
  (p, r, tc) => [
    [tc.includes("ler_estado"), "called ler_estado"],
    [String(r).includes("e2e_test_value"), "got the stored value back"]
  ]);

t(13, "marcar_feito",
  () => `Use marcar_feito with id="e2e-task-1" and status="done". Reply "done".`,
  (p, r, tc) => [
    [tc.includes("marcar_feito"), "called marcar_feito"]
  ]);

t(14, "pensar",
  () => `Use pensar with pensamento="I should think before coding" and categoria="planning". Reply "done".`,
  (p, r, tc) => [
    [tc.includes("pensar"), "called pensar"]
  ]);

t(15, "perguntar_usuario",
  () => `Use perguntar_usuario to ask me "Which color?" with alternatives ["blue", "red"]. Reply "asked".`,
  (p, r, tc) => [
    [tc.includes("perguntar_usuario"), "called perguntar_usuario"]
  ], "normal", { allowUserQuestions: false });

t(16, "buscar_web",
  () => `Use buscar_web to search for "Node.js 22 LTS". Tell me briefly what you found.`,
  (p, r, tc) => [
    [tc.includes("buscar_web"), "called buscar_web"]
  ]);

t(17, "ler_url",
  () => `Use ler_url to fetch https://example.com. Tell me briefly what the page says.`,
  (p, r, tc) => [
    [tc.includes("ler_url"), "called ler_url"],
    [/example|domain/i.test(String(r)), "got content from URL"]
  ]);

t(18, "editar_multi_arquivos",
  (p) => `Use editar_multi_arquivos to edit both files:
- ${p.f1}: change "A = 1" to "A = 100"
- ${p.f2}: change "B = 2" to "B = 200"
Reply "done".`,
  (p, r, tc) => [
    [tc.includes("editar_multi_arquivos") || tc.filter(t => t === "editar_arquivo").length >= 2, "called multi-edit"],
    [fs.readFileSync(p.f1, "utf8").includes("100"), "file 1 updated"],
    [fs.readFileSync(p.f2, "utf8").includes("200"), "file 2 updated"]
  ]);

t(19, "explorar_subagente",
  () => `Use explorar_subagente to explore ${tmpDir} and find all .ts files. Reply briefly with how many were found.`,
  (p, r, tc) => [
    [tc.includes("explorar_subagente"), "called explorar_subagente"]
  ]);

t(20, "flow: read→edit→verify bug fix",
  (p) => `Fix the bug in ${p.f}. The function "calc" uses "undefinedVar" which doesn't exist. Replace "undefinedVar" with a new parameter "y" and add "y" to the function signature. After editing, read the file to verify. Reply with the fixed function.`,
  (p, r, tc) => [
    [tc.some(t => t === "ler_arquivo"), "read the file"],
    [tc.some(t => t === "editar_arquivo"), "edited the file"],
    [!fs.readFileSync(p.f, "utf8").includes("undefinedVar"), "bug is gone"],
    [tc.length <= 8, `no excessive looping (${tc.length} calls)`]
  ]);

t(21, "flow: search→find→edit",
  (p) => `Use buscar_texto to find which file in ${tmpDir} contains the string "TARGET = 'old'". Then use editar_arquivo to change 'old' to 'new' in that file. Reply "done".`,
  (p, r, tc) => [
    [tc.includes("buscar_texto"), "searched for the string"],
    [tc.includes("editar_arquivo"), "edited the file"],
    [fs.readFileSync(p.f, "utf8").includes("new"), "file was updated"],
    [tc.length <= 8, `no looping (${tc.length} calls)`]
  ]);

t(22, "flow: multi-turn context",
  null, // special handling
  null, "normal", { isMultiTurn: true });

t(23, "flow: create→edit→undo",
  (p) => `First create ${p.f} using editar_arquivo with createIfMissing=true and content "v1". Then change "v1" to "v2" using editar_arquivo. Then call desfazer_edicao to undo. Reply with the final file content.`,
  (p, r, tc) => [
    [tc.filter(t => t === "editar_arquivo").length >= 2, "called editar_arquivo at least twice"],
    [tc.includes("desfazer_edicao"), "called desfazer_edicao"],
    [fs.readFileSync(p.f, "utf8").includes("v1"), "rolled back to v1"]
  ]);

t(24, "flow: tool alias resilience",
  () => `Use the buscar_conteudo tool to search for "function" in ${tmpDir}. (Note: the tool might be called buscar_texto — try it.) Reply "done".`,
  (p, r, tc) => [
    [tc.includes("buscar_texto"), "TOOL_ALIASES mapped buscar_conteudo → buscar_texto"]
  ]);

t(25, "roblox: lua file in mode",
  (p) => `Read ${p.f} using ler_arquivo and tell me what it does. Reply briefly.`,
  (p, r, tc) => [
    [tc.includes("ler_arquivo"), "called ler_arquivo in roblox mode"],
    [/1|print/i.test(String(r)), "understood the lua file"]
  ], "roblox");

t(26, "edge: non-existent file",
  () => `Read /nonexistent/path/file.ts using ler_arquivo. If it fails, just say "not found".`,
  (p, r, tc) => [
    [tc.includes("ler_arquivo"), "attempted to read"],
    [/not found|error|no such/i.test(String(r)), "reported the error"]
  ]);

t(27, "edge: edit with empty search (append)",
  (p) => `Use editar_arquivo on ${p.f} with search="" (empty) and replace="// appended comment". This should append the comment to the file. Reply "done".`,
  (p, r, tc) => [
    [tc.includes("editar_arquivo"), "called editar_arquivo"],
    [fs.readFileSync(p.f, "utf8").includes("appended comment"), "comment was appended (BUG-V regression)"]
  ]);

t(28, "edge: parallel tool calls",
  (p) => `Do these 3 things in parallel (use multiple tool calls in the same response):
1. Use buscar_arquivos to find .ts files in ${tmpDir}
2. Use ler_arquivo to read ${p.f}
3. Use executar_comando to run "echo parallel-ok"
Reply "done".`,
  (p, r, tc) => [
    [tc.includes("buscar_arquivos"), "call 1 ok"],
    [tc.includes("ler_arquivo"), "call 2 ok"],
    [tc.includes("executar_comando"), "call 3 ok"]
  ]);

// --- Setup file fixtures per test ---
function setupFixtures(testId) {
  const fixtures = {};
  switch (testId) {
    case 1:
      fixtures.f = path.join(tmpDir, "read.ts");
      fs.writeFileSync(fixtures.f, "export const ANSWER = 42;\n");
      break;
    case 2:
      fixtures.f = path.join(tmpDir, "edit-sr.ts");
      fs.writeFileSync(fixtures.f, "export const X = 1;\n");
      break;
    case 3:
      fixtures.f = path.join(tmpDir, "new-file.ts");
      break;
    case 4:
      fs.writeFileSync(path.join(tmpDir, "find-a.ts"), "export const a = 1;\n");
      fs.writeFileSync(path.join(tmpDir, "find-b.ts"), "export const b = 2;\n");
      break;
    case 5:
      fixtures.f = path.join(tmpDir, "search-text.ts");
      fs.writeFileSync(fixtures.f, "export function helloWorld() { return 'greeting'; }\n");
      break;
    case 6:
      fixtures.f = path.join(tmpDir, "ast.ts");
      fs.writeFileSync(fixtures.f, "export function foo() { return 1; }\nexport function bar() { return 2; }\n");
      break;
    case 9:
      fixtures.f = path.join(tmpDir, "needs-fix.ts");
      fs.writeFileSync(fixtures.f, "export function broken(x) {\n  return x + undefinedVariable;\n}\n");
      break;
    case 10:
      fixtures.f = path.join(tmpDir, "undo-test.ts");
      fs.writeFileSync(fixtures.f, "ORIGINAL_CONTENT\n");
      break;
    case 18:
      fixtures.f1 = path.join(tmpDir, "multi-1.ts");
      fixtures.f2 = path.join(tmpDir, "multi-2.ts");
      fs.writeFileSync(fixtures.f1, "export const A = 1;\n");
      fs.writeFileSync(fixtures.f2, "export const B = 2;\n");
      break;
    case 20:
      fixtures.f = path.join(tmpDir, "flow-bug.ts");
      fs.writeFileSync(fixtures.f, "export function calc(x) {\n  return x + undefinedVar;\n}\n");
      break;
    case 21:
      fixtures.f = path.join(tmpDir, "flow-x-1.ts");
      fs.writeFileSync(path.join(tmpDir, "flow-x-1.ts"), "export const TARGET = 'old';\n");
      fs.writeFileSync(path.join(tmpDir, "flow-x-2.ts"), "import { TARGET } from './flow-x-1';\nexport function use() { return TARGET; }\n");
      break;
    case 23:
      fixtures.f = path.join(tmpDir, "create-undo.ts");
      break;
    case 25:
      fixtures.f = path.join(tmpDir, "roblox-script.lua");
      fs.writeFileSync(fixtures.f, "local x = 1\nprint(x)\n");
      break;
    case 27:
      fixtures.f = path.join(tmpDir, "edge-empty.ts");
      fs.writeFileSync(fixtures.f, "export const X = 1;\n");
      break;
    case 28:
      fixtures.f = path.join(tmpDir, "edge-empty.ts");
      // re-write if not exists
      if (!fs.existsSync(fixtures.f)) fs.writeFileSync(fixtures.f, "export const X = 1;\n");
      break;
  }
  return fixtures;
}

// --- Main runner ---
const startIdx = parseInt(process.argv[2] || "1");
const count = parseInt(process.argv[3] || "5");
const endIdx = Math.min(startIdx + count - 1, tests.length);

console.log(`${C.cyan}Batch:${C.reset} tests ${startIdx}..${endIdx} (of ${tests.length})`);
console.log(`${C.cyan}Workspace:${C.reset} ${tmpDir}`);
console.log(`${C.cyan}Model:${C.reset} ${process.env.MODEL || "(default)"}\n`);

let pass = 0, fail = 0, skipped = 0;
const fails = [];

function assert(c, m) {
  if (c) { console.log(`  ${PASS}  ${m}`); pass++; return true; }
  else { console.log(`  ${FAIL}  ${m}`); fail++; fails.push(m); return false; }
}

for (let i = startIdx; i <= endIdx; i++) {
  const test = tests[i - 1];
  if (!test) continue;

  console.log(`\n=== [${i}/${tests.length}] ${C.bold}${test.label}${C.reset} (${test.mode}) ===`);
  modes.setActiveMode(test.mode);
  history.resetHistory();

  const fixtures = setupFixtures(test.id);

  // Special handling for multi-turn test
  if (test.opts.isMultiTurn) {
    const tc1 = [];
    try {
      const r1 = await withTimeout(
        agent.runAgentLoop("Remember the secret number 4242. Just reply OK.",
          undefined, undefined, undefined, undefined,
          (n) => tc1.push(n)),
        90_000, "multi-turn-1"
      );
      assert(String(r1).toLowerCase().includes("ok"), "turn 1 acknowledged");
    } catch (e) {
      const msg = e.message.slice(0, 150);
      console.log(`  ${FAIL} turn 1: ${msg}`);
      fail++; fails.push(`[22] turn 1: ${msg.slice(0, 60)}`);
    }
    await sleep(2000);
    const tc2 = [];
    try {
      const r2 = await withTimeout(
        agent.runAgentLoop("What was the secret number I asked you to remember? Just the number.",
          undefined, undefined, undefined, undefined,
          (n) => tc2.push(n)),
        90_000, "multi-turn-2"
      );
      assert(String(r2).includes("4242"), "turn 2 remembered secret");
    } catch (e) {
      const msg = e.message.slice(0, 150);
      console.log(`  ${FAIL} turn 2: ${msg}`);
      fail++; fails.push(`[22] turn 2: ${msg.slice(0, 60)}`);
    }
    await sleep(2000);
    continue;
  }

  const prompt = test.prompt(fixtures);
  const toolCalls = [];

  try {
    const result = await withTimeout(
      agent.runAgentLoop(
        prompt,
        undefined, undefined, undefined, undefined,
        (n, args) => { toolCalls.push(n); console.log(`  ${C.dim}[TOOL]${C.reset} ${n}(${JSON.stringify(args).slice(0, 80)})`); },
        (n, ok, r) => { console.log(`  ${C.dim}[RESULT]${C.reset} ${n}: ${ok ? "OK" : "FAIL"} — ${r.slice(0, 100)}`); },
        undefined,
        test.opts.allowUserQuestions ?? false
      ),
      test.opts.timeout ?? 90_000,
      test.label
    );

    console.log(`  ${C.dim}Final:${C.reset} ${String(result).slice(0, 120)}`);
    console.log(`  ${C.dim}Tools:${C.reset} ${toolCalls.length} calls — ${toolCalls.join(", ")}`);

    const checks = test.checkFn(fixtures, result, toolCalls);
    for (const [cond, msg] of checks) assert(cond, msg);
  } catch (e) {
    const msg = e.message.slice(0, 200);
    console.log(`  ${C.red}Error:${C.reset} ${msg}`);
    if (/429|rate|too many/i.test(msg)) {
      console.log(`  ${SKIP} (rate-limited)`);
      skipped++;
    } else if (msg.includes("TIMEOUT")) {
      console.log(`  ${FAIL} (test timed out)`);
      fail++; fails.push(`[${i}] ${test.label}: TIMEOUT`);
    } else if (msg.includes("maximum depth")) {
      console.log(`  ${FAIL} (loop detected)`);
      fail++; fails.push(`[${i}] ${test.label}: LOOP`);
    } else {
      console.log(`  ${FAIL} (unexpected error)`);
      fail++; fails.push(`[${i}] ${test.label}: ${msg.slice(0, 60)}`);
    }
  }

  await sleep(2000);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`${C.bold}BATCH SUMMARY${C.reset} (tests ${startIdx}..${endIdx}): ${C.green}${pass} passed${C.reset}, ${C.red}${fail} failed${C.reset}, ${C.yellow}${skipped} skipped${C.reset}`);
console.log("═".repeat(60));
if (fails.length > 0) {
  console.log(`\n${C.red}Failures:${C.reset}`);
  for (const f of fails) console.log(`  ${C.red}-${C.reset} ${f}`);
}

// Persist results to /tmp for aggregation across batches
const resultFile = `/tmp/e2e-batch-${startIdx}-${endIdx}.json`;
fs.writeFileSync(resultFile, JSON.stringify({
  startIdx, endIdx, pass, fail, skipped, fails,
  timestamp: new Date().toISOString()
}));
console.log(`\nResults saved to ${resultFile}`);

// Don't clean tmpDir — we want fixtures to persist for multi-batch runs
process.exit(fail === 0 ? 0 : 1);
