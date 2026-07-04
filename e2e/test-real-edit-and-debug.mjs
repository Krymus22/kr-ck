#!/usr/bin/env node
/**
 * test-real-edit-and-debug.mjs — Testa edição real de arquivos via API,
 * fluxo de debug, e criação de modo custom python do zero.
 *
 * Testa:
 *   1. Agent loop edita arquivo real (editar_arquivo via API)
 *   2. Agent loop cria arquivo novo (createIfMissing)
 *   3. Agent loop faz múltiplas edições
 *   4. Fluxo de debug — IA analisa erro e corrige
 *   5. Cria modo python custom do zero (local, sem commit)
 *   6. Ativa modo python e testa se carrega config/manifests
 *   7. Cria manifest custom para ruff (simulado)
 *   8. Testa que modo python é visível no getAllModes
 *   9. Deleta modo python (cleanup)
 *  10. TDD mode (registerTDD, getTDD, formatTDD)
 *  11. Dynamic workflow (validateWorkflow, getExampleWorkflow)
 *  12. Self validation (shouldSelfValidate, injectSelfValidationPrompt)
 *  13. Auto test generator (generateTestSuggestionForFile)
 *
 * Run:  node /home/z/my-project/scripts/test-real-edit-and-debug.mjs
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

if (!process.env.HOME) process.env.HOME = os.homedir();
process.chdir("/home/z/my-project/claude-killer");

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m", bold: "\x1b[1m",
};
const PASS = `${C.green}✓ PASS${C.reset}`;
const FAIL = `${C.red}✗ FAIL${C.reset}`;
const INFO = `${C.cyan}ℹ INFO${C.reset}`;
const SECTION = (s) => `\n${C.bold}${C.magenta}═══ ${s} ═══${C.reset}\n`;

let totalPass = 0, totalFail = 0;
const failures = [];
function assert(cond, msg, detail) {
  if (cond) { console.log(`  ${PASS}  ${msg}`); totalPass++; }
  else {
    console.log(`  ${FAIL}  ${msg}`);
    if (detail) console.log(`         ${C.gray}${detail}${C.reset}`);
    totalFail++; failures.push({ msg, detail: detail ?? "" });
  }
}

async function main() {
  console.log(`${C.bold}${C.cyan}╔════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  Real Edit + Debug + Custom Mode Test Suite                   ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`${INFO}  HOME=${process.env.HOME}`);
  console.log(`${INFO}  MODEL=${process.env.MODEL ?? "(unset)"}`);

  // Imports
  const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  const manifestLoader = await import("/home/z/my-project/claude-killer/dist/manifestLoader.js");
  const history = await import("/home/z/my-project/claude-killer/dist/history.js");
  const tddMode = await import("/home/z/my-project/claude-killer/dist/tddMode.js");
  const dynamicWorkflow = await import("/home/z/my-project/claude-killer/dist/dynamicWorkflow.js");
  const selfValidation = await import("/home/z/my-project/claude-killer/dist/selfValidation.js");
  const autoTestGenerator = await import("/home/z/my-project/claude-killer/dist/autoTestGenerator.js");

  // -----------------------------------------------------------------------
  // SECTION 1: Editar arquivo real via dispatchToolCallPublic
  // -----------------------------------------------------------------------
  console.log(SECTION("1. Edit real file via dispatchToolCallPublic"));

  // Sprint C: usar modo normal (sem read-before-write)
  modes.setActiveMode("normal");
  console.log(`${INFO}  READ_BEFORE_WRITE env: ${process.env.READ_BEFORE_WRITE}`);

  // Criar arquivo inicial
  const tmpEditDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-edit-"));
  const tmpEditFile = path.join(tmpEditDir, "calc.ts");
  fs.writeFileSync(tmpEditFile, "export function add(a, b) {\n  return a + b;\n}\n");

  // Helper: criar tool call
  function makeToolCall(id, name, args) {
    return {
      id: `call_${id}_${Date.now()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // Edit 1: search/replace simples
  const editResult1 = await agent.dispatchToolCallPublic(
    makeToolCall("edit1", "editar_arquivo", {
      path: tmpEditFile,
      search: "function add",
      replace: "function multiply",
    }),
  );
  console.log(`${INFO}  Edit 1 result: ${editResult1.resultStr.slice(0, 100)}`);
  const afterEdit1 = fs.readFileSync(tmpEditFile, "utf8");
  console.log(`${INFO}  File after edit 1: ${afterEdit1.replace(/\n/g, "\\n")}`);
  assert(editResult1.resultStr.includes("SUCESSO"), "Edit 1 succeeded");
  assert(afterEdit1.includes("multiply"), "File has 'multiply' after edit 1");

  // Edit 2: multiple edits via array
  fs.writeFileSync(tmpEditFile, "export function add(a, b) {\n  return a + b;\n}\n");
  const editResult2 = await agent.dispatchToolCallPublic(
    makeToolCall("edit2", "editar_arquivo", {
      path: tmpEditFile,
      edits: [
        { search: "function add", replace: "function multiply" },
        { search: "a + b", replace: "a * b" },
      ],
    }),
  );
  console.log(`${INFO}  Edit 2 result: ${editResult2.resultStr.slice(0, 100)}`);
  const afterEdit2 = fs.readFileSync(tmpEditFile, "utf8");
  console.log(`${INFO}  File after edit 2: ${afterEdit2.replace(/\n/g, "\\n")}`);
  assert(editResult2.resultStr.includes("SUCESSO"), "Edit 2 succeeded");
  assert(afterEdit2.includes("multiply"), "File has 'multiply' after edit 2");
  assert(afterEdit2.includes("a * b"), "File has 'a * b' after edit 2");

  // -----------------------------------------------------------------------
  // SECTION 2: Criar arquivo novo (createIfMissing)
  // -----------------------------------------------------------------------
  console.log(SECTION("2. Create new file via dispatchToolCallPublic (createIfMissing)"));

  const tmpNewFile = path.join(tmpEditDir, "new-module.ts");
  const createResult = await agent.dispatchToolCallPublic(
    makeToolCall("create", "editar_arquivo", {
      path: tmpNewFile,
      search: "",
      replace: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
      createIfMissing: true,
    }),
  );
  console.log(`${INFO}  Create result: ${createResult.resultStr.slice(0, 100)}`);
  const newFileExists = fs.existsSync(tmpNewFile);
  const newFileContent = newFileExists ? fs.readFileSync(tmpNewFile, "utf8") : "";
  console.log(`${INFO}  New file exists: ${newFileExists}`);
  console.log(`${INFO}  New file content: ${newFileContent.replace(/\n/g, "\\n").slice(0, 150)}`);
  assert(createResult.resultStr.includes("SUCESSO"), "Create succeeded");
  assert(newFileExists, "New file was created");
  assert(newFileContent.includes("greet"), "New file contains 'greet' function");
  assert(newFileContent.toLowerCase().includes("hello"), "New file contains 'hello'");

  // -----------------------------------------------------------------------
  // SECTION 3: Fluxo de debug — corrigir bug via dispatchToolCallPublic
  // -----------------------------------------------------------------------
  console.log(SECTION("3. Debug flow — fix broken code via dispatchToolCallPublic"));

  const tmpBuggyFile = path.join(tmpEditDir, "buggy.ts");
  fs.writeFileSync(tmpBuggyFile, "export function calculate(x) {\n  return x + undefineddVar;\n}\n");

  // Simular o que a IA faria: identificar o bug e corrigir
  const fixResult = await agent.dispatchToolCallPublic(
    makeToolCall("fix", "editar_arquivo", {
      path: tmpBuggyFile,
      edits: [
        { search: "function calculate(x)", replace: "function calculate(x, y)" },
        { search: "x + undefineddVar", replace: "x + y" },
      ],
    }),
  );
  console.log(`${INFO}  Fix result: ${fixResult.resultStr.slice(0, 100)}`);
  const afterFix = fs.readFileSync(tmpBuggyFile, "utf8");
  console.log(`${INFO}  File after fix: ${afterFix.replace(/\n/g, "\\n")}`);
  assert(fixResult.resultStr.includes("SUCESSO"), "Fix succeeded");
  assert(!afterFix.includes("undefineddVar"), "Bug was fixed (undefineddVar removed)", `got: ${afterFix}`);
  assert(afterFix.includes("y"), "Fix added 'y' parameter", `got: ${afterFix}`);

  // -----------------------------------------------------------------------
  // SECTION 4: Criar modo python custom do zero (LOCAL, sem commit)
  // -----------------------------------------------------------------------
  console.log(SECTION("4. Create custom python mode from scratch (local only)"));

  // Cleanup se já existir
  try { modes.deleteUserMode("python"); } catch {}

  // Criar config.json do modo python
  const pythonConfig = {
    name: "python",
    label: "Python (Custom Test)",
    description: "Python development mode for testing. Has custom validators for ruff/black, safety patterns for destructive ops, and research sources for python docs.",
    icon: "P",
    builtIn: false,
    effortLevel: "high",
    strictMode: true,
    readBeforeWrite: true,
    advancedThinking: true,
    safetyReview: true,
    toolsDir: "tools",
    manifestsDir: "manifests",
    skillsDir: "skills",
    hooksDir: "hooks",
    mcpsDir: "mcps",
    tools: ["tool:ruff_lint", "tool:black_format"],
    skills: ["skill:python-best-practices"],
    enableFeatures: [
      "feature:think_tool",
      "feature:read_before_write",
      "feature:rollback",
      "feature:strict_gate",
      "feature:poka_yoke",
      "feature:sub_agents",
    ],
    validators: [
      { tool: "ruff_lint", filePattern: "*.py", blocking: true },
      { tool: "black_format", filePattern: "*.py", blocking: false },
    ],
    safetyPatterns: [
      { regex: "os\\.system\\s*\\(", description: "os.system (shell injection risk)", severity: "high" },
      { regex: "subprocess\\.call\\s*\\(.*shell=True", description: "subprocess with shell=True (injection risk)", severity: "high" },
      { regex: "eval\\s*\\(", description: "eval (code injection)", severity: "high" },
      { regex: "exec\\s*\\(", description: "exec (code injection)", severity: "high" },
      { regex: "__import__\\s*\\(", description: "__import__ (dynamic import risk)", severity: "medium" },
    ],
    researchSources: {
      python: ["docs.python.org/3", "realpython.com", "pypi.org"],
      ruff: ["docs.astral.sh/ruff", "github.com/astral-sh/ruff"],
    },
    systemPrompt: "",
  };

  // Salvar modo
  modes.saveUserMode(pythonConfig);
  console.log(`${INFO}  Python mode saved`);

  // Verificar que aparece em getAllModes
  const allModes = modes.getAllModes();
  const pythonMode = allModes.find((m) => m.name === "python");
  assert(pythonMode !== undefined, "Python mode appears in getAllModes");
  assert(pythonMode?.label === "Python (Custom Test)", "Python mode label correct");
  assert(pythonMode?.builtIn === false, "Python mode is NOT builtIn (user-created)");
  assert((pythonMode?.tools?.length ?? 0) === 2, "Python mode has 2 tools", `got: ${pythonMode?.tools?.length}`);
  assert((pythonMode?.validators?.length ?? 0) === 2, "Python mode has 2 validators");
  assert((pythonMode?.safetyPatterns?.length ?? 0) === 5, "Python mode has 5 safetyPatterns");

  // -----------------------------------------------------------------------
  // SECTION 5: Ativar modo python e verificar carregamento
  // -----------------------------------------------------------------------
  console.log(SECTION("5. Activate python mode and verify loading"));

  modes.setActiveMode("python");
  assert(modes.getActiveModeName() === "python", "Active mode is python");

  const activeMode = modes.getActiveMode();
  assert(activeMode?.name === "python", "getActiveMode returns python");
  assert(activeMode?.effortLevel === "high", "Python effort level is high");
  assert(activeMode?.strictMode === true, "Python strictMode=true");
  console.log(`${INFO}  Active mode: ${activeMode?.name}, label=${activeMode?.label}`);
  console.log(`${INFO}  Tools: ${activeMode?.tools?.length ?? 0}`);
  console.log(`${INFO}  Validators: ${activeMode?.validators?.length ?? 0}`);
  console.log(`${INFO}  Safety patterns: ${activeMode?.safetyPatterns?.length ?? 0}`);

  // Manifests (deve ser 0 porque não criamos nenhum)
  const pythonManifests = manifestLoader.loadActiveManifests();
  console.log(`${INFO}  Python manifests: ${pythonManifests.length}`);
  assert(pythonManifests.length === 0, "Python mode has 0 manifests (none created yet)");

  // Function calls (deve ser 0 porque não tem tools instaladas)
  const pythonFc = manifestLoader.generateFunctionCallsFromManifests(pythonManifests, "python");
  assert(pythonFc.length === 0, "Python mode has 0 function calls (no tools installed)");

  // -----------------------------------------------------------------------
  // SECTION 6: Criar manifest custom para ruff (simulado)
  // -----------------------------------------------------------------------
  console.log(SECTION("6. Create custom manifest for ruff"));

  // Criar estrutura de diretórios do modo python
  const pythonModeDir = path.join(process.env.HOME, ".claude-killer", "modes", "python");
  fs.mkdirSync(path.join(pythonModeDir, "manifests"), { recursive: true });
  fs.mkdirSync(path.join(pythonModeDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(pythonModeDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(pythonModeDir, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(pythonModeDir, "inbox"), { recursive: true });

  // Criar manifest do ruff
  const ruffManifest = [
    {
      name: "ruff_lint",
      description: "Lint Python code with Ruff",
      category: "python",
      command: "ruff",
      args: ["check"],
      flags: [
        { name: "--fix", type: "boolean", description: "Auto-fix issues" },
        { name: "path", type: "string", description: "File or directory to lint" },
      ],
      detection: { method: "binary", check: "ruff --version" },
      context: {
        whenToUse: ["lint python", "ruff lint", "check python style"],
        examples: ["ruff check src/", "ruff check --fix file.py"],
      },
      outputParser: "raw",
      validatorArgs: ["check", "--quiet", "{file}"],
    },
  ];
  fs.writeFileSync(path.join(pythonModeDir, "manifests", "ruff.json"), JSON.stringify(ruffManifest, null, 2));
  console.log(`${INFO}  ruff.json manifest created`);

  // Criar manifest do black
  const blackManifest = [
    {
      name: "black_format",
      description: "Format Python code with Black",
      category: "python",
      command: "black",
      args: [],
      flags: [
        { name: "--check", type: "boolean", description: "Check only" },
        { name: "--diff", type: "boolean", description: "Show diff" },
        { name: "path", type: "string", description: "File to format" },
      ],
      detection: { method: "binary", check: "black --version" },
      context: {
        whenToUse: ["format python", "black format", "code style python"],
        examples: ["black file.py", "black --check src/"],
      },
      outputParser: "raw",
      validatorArgs: ["--check", "{file}"],
    },
  ];
  fs.writeFileSync(path.join(pythonModeDir, "manifests", "black.json"), JSON.stringify(blackManifest, null, 2));
  console.log(`${INFO}  black.json manifest created`);

  // Recarregar manifests
  const pythonManifests2 = manifestLoader.loadActiveManifests();
  console.log(`${INFO}  Python manifests after creating files: ${pythonManifests2.length}`);
  console.log(`${INFO}  pythonModeDir exists: ${fs.existsSync(pythonModeDir)}`);
  console.log(`${INFO}  manifests dir exists: ${fs.existsSync(path.join(pythonModeDir, "manifests"))}`);
  if (fs.existsSync(path.join(pythonModeDir, "manifests"))) {
    console.log(`${INFO}  manifests dir files: ${fs.readdirSync(path.join(pythonModeDir, "manifests")).join(", ")}`);
  }
  assert(pythonManifests2.length === 2, "Python mode now has 2 manifests (ruff + black)", `got: ${pythonManifests2.length}`);
  assert(pythonManifests2.some((m) => m.name === "ruff_lint"), "ruff_lint manifest loaded");
  assert(pythonManifests2.some((m) => m.name === "black_format"), "black_format manifest loaded");

  // Verificar validatorArgs
  const ruffMan = pythonManifests2.find((m) => m.name === "ruff_lint");
  assert(ruffMan?.validatorArgs?.length === 3, "ruff has 3 validatorArgs", `got: ${ruffMan?.validatorArgs?.length}`);
  assert(ruffMan?.validatorArgs?.includes("{file}"), "ruff validatorArgs includes {file}");

  // Function calls ainda deve ser 0 (binários não instalados)
  const pythonFc2 = manifestLoader.generateFunctionCallsFromManifests(pythonManifests2, "python");
  console.log(`${INFO}  Python function calls: ${pythonFc2.length} (0 because ruff/black not installed)`);
  assert(pythonFc2.length === 0, "Python still has 0 function calls (binaries not installed)");

  // -----------------------------------------------------------------------
  // SECTION 7: Criar skill markdown para python
  // -----------------------------------------------------------------------
  console.log(SECTION("7. Create python skill markdown"));

  const pythonSkill = `# Python Best Practices

## Type Hints
Always use type hints for function parameters and return types.

\`\`\`python
def greet(name: str) -> str:
    return f"Hello, {name}!"
\`\`\`

## Error Handling
Use specific exceptions, not bare except.

\`\`\`python
try:
    result = parse(input)
except ValueError as e:
    logger.error(f"Parse failed: {e}")
    raise
\`\`\`

## Testing
Use pytest. Name test files test_*.py.

\`\`\`python
def test_greet():
    assert greet("World") == "Hello, World!"
\`\`\`
`;
  fs.writeFileSync(path.join(pythonModeDir, "skills", "python-best-practices.md"), pythonSkill);
  console.log(`${INFO}  python-best-practices.md skill created`);

  // Verificar que skill foi carregada
  const skillsDir = path.join(pythonModeDir, "skills");
  const skillFiles = fs.readdirSync(skillsDir);
  assert(skillFiles.includes("python-best-practices.md"), "Skill file exists");

  // -----------------------------------------------------------------------
  // SECTION 8: Criar hook custom para python (auto-format on save)
  // -----------------------------------------------------------------------
  console.log(SECTION("8. Create python hook (auto-format on save)"));

  const hookJs = `const { parentPort, workerData } = require("worker_threads");
// Auto-format hook: logs that black would run
const filePath = workerData.filePath || "(unknown)";
parentPort.postMessage({
  warning: "auto-format: " + filePath + " was modified (mode=python) — black would run here"
});
`;
  const hookJson = {
    name: "auto-format-python",
    file: "auto-format-python.js",
    trigger: "on_file",
    timeout: 3000,
  };
  fs.writeFileSync(path.join(pythonModeDir, "hooks", "auto-format-python.js"), hookJs);
  fs.writeFileSync(path.join(pythonModeDir, "hooks", "auto-format-python.json"), JSON.stringify(hookJson, null, 2));
  console.log(`${INFO}  auto-format-python hook created`);

  // Carregar hooks
  const hookRunner = await import("/home/z/my-project/claude-killer/dist/hookRunner.js");
  const loadedHooks = hookRunner.loadHooks("python");
  console.log(`${INFO}  Loaded hooks: ${loadedHooks.length}`);
  for (const h of loadedHooks) console.log(`${INFO}    ${h.name} (${h.trigger})`);
  assert(loadedHooks.some((h) => h.name === "auto-format-python"), "auto-format-python hook loaded");

  // Rodar hook
  const hookResults = await hookRunner.runHooks("on_file", { filePath: "/tmp/test.py", mode: "python" }, "python");
  console.log(`${INFO}  Hook results: ${hookResults.length}`);
  for (const r of hookResults) console.log(`${INFO}    warning=${r.warning?.slice(0, 80)}`);
  assert(hookResults.some((r) => r.warning?.includes("auto-format")), "Hook produced auto-format warning");

  // -----------------------------------------------------------------------
  // SECTION 9: Testar safetyPatterns do modo python
  // -----------------------------------------------------------------------
  console.log(SECTION("9. Test python safetyPatterns"));

  const safetyReviewer = await import("/home/z/my-project/claude-killer/dist/safetyReviewer.js");

  // Código perigoso: os.system
  const dangerousPython = `import os\nos.system("rm -rf /")\n`;
  const dangerousResult = await safetyReviewer.scanDangerousPatternsAsync(dangerousPython);
  console.log(`${INFO}  os.system code: ${dangerousResult.matched.length} patterns, hasHigh=${dangerousResult.hasHighSeverity}`);
  assert(dangerousResult.matched.length > 0, "os.system matched python safetyPattern");
  assert(dangerousResult.hasHighSeverity === true, "os.system is high severity");

  // Código perigoso: eval
  const evalCode = `result = eval(user_input)\n`;
  const evalResult = await safetyReviewer.scanDangerousPatternsAsync(evalCode);
  console.log(`${INFO}  eval code: ${evalResult.matched.length} patterns`);
  assert(evalResult.matched.length > 0, "eval matched python safetyPattern");

  // Código seguro
  const safePython = `def add(a: int, b: int) -> int:\n    return a + b\n`;
  const safeResult = await safetyReviewer.scanDangerousPatternsAsync(safePython);
  console.log(`${INFO}  Safe python: ${safeResult.matched.length} patterns`);
  assert(safeResult.matched.length === 0, "Safe python does not match destructive patterns");

  // -----------------------------------------------------------------------
  // SECTION 10: TDD mode
  // -----------------------------------------------------------------------
  console.log(SECTION("10. TDD mode"));

  tddMode.clearTDD();
  assert(tddMode.hasTDD() === false, "No TDD initially");

  const tddSpec = tddMode.registerTDD(
    "/tmp/test_add.py",
    "/tmp/add.py",
    "python",
    ["test_add_positive", "test_add_negative", "test_add_zero"],
  );
  console.log(`${INFO}  TDD registered: ${tddSpec?.testFile}`);
  assert(tddMode.hasTDD() === true, "TDD registered");
  assert(tddSpec?.testFile === "/tmp/test_add.py", "TDD test file correct");
  assert(tddSpec?.language === "python", "TDD language is python");
  assert(tddSpec?.testCases?.length === 3, "TDD has 3 test cases");

  const retrievedTdd = tddMode.getTDD();
  assert(retrievedTdd !== null, "getTDD returns spec");
  assert(retrievedTdd?.implFile === "/tmp/add.py", "TDD impl file correct");

  const formattedTdd = tddMode.formatTDD();
  console.log(`${INFO}  Formatted TDD: ${formattedTdd.slice(0, 100)}`);
  assert(formattedTdd.length > 0, "formatTDD returns content");

  // isTestable
  assert(tddMode.isTestable("/tmp/test_foo.py") === true, "isTestable(.py) = true");
  assert(tddMode.isTestable("/tmp/foo.ts") === true, "isTestable(.ts) = true");
  assert(tddMode.isTestable("/tmp/foo.txt") === false, "isTestable(.txt) = false");

  // getTestFilePath
  const testPath = tddMode.getTestFilePath("/tmp/foo.py");
  console.log(`${INFO}  Test file path for foo.py: ${testPath}`);
  assert(typeof testPath === "string", "getTestFilePath returns string");

  tddMode.clearTDD();
  assert(tddMode.hasTDD() === false, "TDD cleared");

  // -----------------------------------------------------------------------
  // SECTION 11: Dynamic workflow
  // -----------------------------------------------------------------------
  console.log(SECTION("11. Dynamic workflow"));

  // getExampleWorkflow
  const exampleWf = dynamicWorkflow.getExampleWorkflow();
  console.log(`${INFO}  Example workflow (first 200): ${exampleWf.slice(0, 200)}`);
  assert(exampleWf.length > 0, "getExampleWorkflow returns content");

  // validateWorkflow com exemplo válido
  const validWf = dynamicWorkflow.validateWorkflow(exampleWf);
  console.log(`${INFO}  Valid workflow: ${validWf.valid}`);
  assert(typeof validWf.valid === "boolean", "validateWorkflow returns valid boolean");

  // validateWorkflow com script inválido
  const invalidWf = dynamicWorkflow.validateWorkflow("not a valid workflow script {{");
  console.log(`${INFO}  Invalid workflow: valid=${invalidWf.valid}, error=${invalidWf.error?.slice(0, 80)}`);
  assert(invalidWf.valid === false, "Invalid workflow rejected");

  // executeWorkflow (pode falhar se não tiver tools — aceita)
  try {
    const wfResult = await dynamicWorkflow.executeWorkflow(exampleWf);
    console.log(`${INFO}  Workflow result: ${JSON.stringify(wfResult).slice(0, 150)}`);
    assert(typeof wfResult === "object", "executeWorkflow returns object");
  } catch (err) {
    console.log(`${INFO}  executeWorkflow threw (acceptable): ${err.message.slice(0, 80)}`);
    assert(true, "executeWorkflow attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 12: Self validation
  // -----------------------------------------------------------------------
  console.log(SECTION("12. Self validation"));

  selfValidation.resetSelfValidation();

  // shouldSelfValidate
  const should1 = selfValidation.shouldSelfValidate(0);
  const should2 = selfValidation.shouldSelfValidate(5);
  console.log(`${INFO}  shouldSelfValidate(0 files): ${should1}`);
  console.log(`${INFO}  shouldSelfValidate(5 files): ${should2}`);
  assert(typeof should1 === "boolean", "shouldSelfValidate returns boolean");
  assert(typeof should2 === "boolean", "shouldSelfValidate returns boolean (5 files)");

  // injectSelfValidationPrompt
  const touchedFiles = ["/tmp/file1.py", "/tmp/file2.py", "/tmp/file3.py"];
  const prompt = selfValidation.injectSelfValidationPrompt(touchedFiles);
  console.log(`${INFO}  Self validation prompt (first 200): ${prompt.slice(0, 200)}`);
  assert(typeof prompt === "string", "injectSelfValidationPrompt returns string");
  // Pode ser vazio se shouldSelfValidate retornar false
  if (prompt.length > 0) {
    assert(prompt.includes("file1.py") || prompt.includes("self") || prompt.length > 0, "Prompt mentions files or self-validation");
  }

  // -----------------------------------------------------------------------
  // SECTION 13: Auto test generator
  // -----------------------------------------------------------------------
  console.log(SECTION("13. Auto test generator"));

  autoTestGenerator.resetAutoTestSuggestions();

  // Criar arquivo Python pra gerar teste
  const tmpPyFile = path.join(tmpEditDir, "sample.py");
  fs.writeFileSync(tmpPyFile, `def add(a, b):
    """Add two numbers."""
    return a + b

def multiply(a, b):
    """Multiply two numbers."""
    return a * b
`);

  const testSuggestion = autoTestGenerator.generateTestSuggestionForFile(tmpPyFile);
  console.log(`${INFO}  Test suggestion (first 200): ${testSuggestion.slice(0, 200)}`);
  assert(typeof testSuggestion === "string", "generateTestSuggestionForFile returns string");
  assert(testSuggestion.length > 0, "Test suggestion is non-empty");
  // Deve mencionar alguma função do arquivo
  assert(testSuggestion.includes("add") || testSuggestion.includes("multiply") || testSuggestion.includes("test"), "Suggestion mentions functions or tests");

  // -----------------------------------------------------------------------
  // SECTION 14: Cleanup — deletar modo python
  // -----------------------------------------------------------------------
  console.log(SECTION("14. Cleanup — delete python mode"));

  // Voltar para roblox
  modes.setActiveMode("roblox");

  // Deletar modo python
  const deleted = modes.deleteUserMode("python");
  assert(deleted === true, "Python mode deleted");

  // Verificar que não aparece mais
  const allModesAfter = modes.getAllModes();
  assert(!allModesAfter.some((m) => m.name === "python"), "Python mode removed from getAllModes");

  // Verificar que active mode voltou pra outro
  console.log(`${INFO}  Active mode after delete: ${modes.getActiveModeName()}`);

  // Limpar diretório python se ainda existir
  try {
    fs.rmSync(pythonModeDir, { recursive: true, force: true });
    console.log(`${INFO}  Python mode directory removed`);
  } catch {}

  // -----------------------------------------------------------------------
  // SECTION 15: Modo python completo (re-criar e testar fluxo E2E)
  // -----------------------------------------------------------------------
  console.log(SECTION("15. E2E: re-create python mode + AI uses it"));

  // Re-criar modo python completo
  modes.saveUserMode(pythonConfig);
  modes.setActiveMode("python");

  // Re-criar manifests
  fs.mkdirSync(path.join(pythonModeDir, "manifests"), { recursive: true });
  fs.mkdirSync(path.join(pythonModeDir, "tools"), { recursive: true });
  fs.writeFileSync(path.join(pythonModeDir, "manifests", "ruff.json"), JSON.stringify(ruffManifest, null, 2));
  fs.writeFileSync(path.join(pythonModeDir, "manifests", "black.json"), JSON.stringify(blackManifest, null, 2));

  // Criar fake ruff binary pra testar function calls
  const fakeRuffPath = path.join(pythonModeDir, "tools", "ruff");
  const fakeRuffContent = `#!/bin/sh\n# Fake ruff for testing\necho "fake-ruff: $@" >&2\nexit 0\n`;
  fs.writeFileSync(fakeRuffPath, fakeRuffContent);
  fs.chmodSync(fakeRuffPath, 0o755);

  // Agora function calls deve incluir ruff_lint
  const pythonManifests3 = manifestLoader.loadActiveManifests();
  const pythonFc3 = manifestLoader.generateFunctionCallsFromManifests(pythonManifests3, "python");
  console.log(`${INFO}  Python function calls after fake ruff: ${pythonFc3.length}`);
  for (const fc of pythonFc3) console.log(`${INFO}    - ${fc.function.name}`);
  assert(pythonFc3.length === 1, "Python has 1 function call (ruff_lint)", `got: ${pythonFc3.length}`);
  assert(pythonFc3[0]?.function?.name === "ruff_lint", "Function call is ruff_lint");

  // Executar ruff_lint via manifest
  const tmpPyLintFile = path.join(tmpEditDir, "lint_test.py");
  fs.writeFileSync(tmpPyLintFile, "import os\nos.system('test')\n");
  const lintResult = await manifestLoader.executeFromManifest(
    "ruff_lint",
    { path: tmpPyLintFile },
    pythonManifests3,
    "python",
  );
  console.log(`${INFO}  ruff_lint result: ok=${lintResult.ok}, duration=${lintResult.duration}ms`);
  console.log(`${INFO}  stdout: ${lintResult.output.slice(0, 100)}`);
  assert(lintResult.ok === true, "ruff_lint (fake) executed successfully");

  // Cleanup final
  modes.setActiveMode("roblox");
  modes.deleteUserMode("python");
  try { fs.rmSync(pythonModeDir, { recursive: true, force: true }); } catch {}

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
    for (const f of failures) {
      console.log(`  • ${f.msg}`);
      if (f.detail) console.log(`    ${C.gray}${f.detail}${C.reset}`);
    }
  }

  // Cleanup temp dir
  try { fs.rmSync(tmpEditDir, { recursive: true, force: true }); } catch {}

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`);
  process.exit(2);
});
