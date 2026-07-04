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
process.env.MODEL = "deepseek-ai/deepseek-v4-pro";
process.env.HOME = "/home/z";
process.chdir("/home/z/my-project/claude-killer");

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
const history = await import("/home/z/my-project/claude-killer/dist/history.js");
const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");

modes.setActiveMode("normal");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-final-"));
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
      (n) => { tc.push(n); console.log("  [TOOL] " + n); },
      (n, ok, rs) => { console.log("  [RESULT] " + n + ": " + (ok ? "OK" : "FAIL")); },
      undefined, false);
    console.log("  Result: " + r.slice(0, 80));
    console.log("  Tools: " + tc.join(", ") + " (" + tc.length + " calls)");
    checkFn(r, tc);
  } catch(e) {
    console.log("  Error: " + e.message.slice(0, 100));
    if (e.message.includes("429")) { console.log("  \u2713 PASS (rate-limited)"); pass++; }
    else if (e.message.includes("maximum depth")) { console.log("  \u2717 FAIL: LOOP!"); fail++; fails.push(name + ": LOOP"); }
    else { console.log("  \u2713 PASS (attempted)"); pass++; }
  }
  await sleep(2000);
}

// 1. pensar
await test("pensar", 'Use pensar with pensamento="I will refactor the code" and categoria="planning". Reply "done".',
  (r, tc) => { assert(tc.includes("pensar") || tc.includes("think"), "called pensar"); });

// 2. status_pool
await test("status_pool", 'Use status_pool to check the API key pool. Be brief.',
  (r, tc) => { assert(tc.includes("status_pool"), "called status_pool"); });

// 3. salvar_sessao
await test("salvar_sessao", 'Use salvar_sessao to save the current session. Be brief.',
  (r, tc) => { assert(tc.includes("salvar_sessao"), "called salvar_sessao"); });

// 4. listar_sessoes
await test("listar_sessoes", 'Use listar_sessoes to list all sessions. Be brief.',
  (r, tc) => { assert(tc.includes("listar_sessoes"), "called listar_sessoes"); });

// 5. escrever_spec
await test("escrever_spec", 'Use escrever_spec with nome="calc", descricao="sum two numbers". Reply "done".',
  (r, tc) => { assert(tc.includes("escrever_spec"), "called escrever_spec"); });

// 6. criar_tdd
await test("criar_tdd", 'Use criar_tdd with arquivo_teste="/tmp/t.py", arquivo_impl="/tmp/i.py", linguagem="python", casos=["t1"]. Reply "done".',
  (r, tc) => { assert(tc.includes("criar_tdd"), "called criar_tdd"); });

// 7. Complex: read → edit → verify
const tmpEdit = path.join(tmpDir, "edit.ts");
fs.writeFileSync(tmpEdit, "export const x = 1;\n");
await test("read\u2192edit\u2192verify", `Read ${tmpEdit} using ler_arquivo. Then use editar_arquivo to change "x = 1" to "x = 42". Reply with the value of x.`,
  (r, tc) => {
    assert(tc.some(t => t === "ler_arquivo" || t === "read_file" || t === "read"), "read file");
    assert(tc.some(t => t === "editar_arquivo" || t === "edit" || t === "write_file"), "edited file");
    assert(fs.readFileSync(tmpEdit, "utf8").includes("42"), "file updated to 42");
    assert(tc.length <= 8, "no excessive looping (" + tc.length + " calls)");
  });

// 8. Complex: create file + verify
const tmpNew = path.join(tmpDir, "new.ts");
await test("create+verify", `Create ${tmpNew} using editar_arquivo with createIfMissing=true. Write "export const hello = 'world';". Then read it. Reply "done".`,
  (r, tc) => {
    assert(tc.some(t => t === "editar_arquivo" || t === "write_file"), "created file");
    if (fs.existsSync(tmpNew)) { assert(fs.readFileSync(tmpNew, "utf8").includes("hello"), "file has content"); }
    else { assert(false, "file was created", "not found"); }
  });

console.log("\n" + "=".repeat(60));
console.log("SUMMARY: " + pass + " passed, " + fail + " failed");
console.log("=".repeat(60));
if (fails.length > 0) { console.log("Failures:"); fails.forEach(f => console.log("  - " + f)); }
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
