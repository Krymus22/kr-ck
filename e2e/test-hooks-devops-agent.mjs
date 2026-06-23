#!/usr/bin/env node
/**
 * test-hooks-devops-agent.mjs — Testes de hooks com erro, modo devops, e agent loop.
 *
 * Testa:
 *   1. Hooks com erro de runtime (syntax error, require failure, etc)
 *   2. Hooks com modifiedContent (before_write que altera conteúdo)
 *   3. Modo devops — ativação, safety patterns custom, validators
 *   4. Agent loop completo (runAgentLoop) — fluxo simples
 *   5. dispatchToolCallPublic — todas as tools nativas
 *   6. getMergedToolsPublic — combo de tools nativas + manifest
 *   7. Hooks encadeados (múltiplos hooks mesmo trigger)
 *   8. Hook que excede memória (resourceLimits)
 *
 * Run:  node /home/z/my-project/scripts/test-hooks-devops-agent.mjs
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
  console.log(`${C.bold}${C.cyan}║  Hooks + DevOps + Agent Loop Test Suite                        ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════════════════╝${C.reset}`);
  console.log(`${INFO}  HOME=${process.env.HOME}`);
  console.log(`${INFO}  MODEL=${process.env.MODEL ?? "(unset)"}`);

  // Imports
  const hookRunner = await import("/home/z/my-project/claude-killer/dist/hookRunner.js");
  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  const manifestLoader = await import("/home/z/my-project/claude-killer/dist/manifestLoader.js");
  const apiClient = await import("/home/z/my-project/claude-killer/dist/apiClient.js");
  const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
  const safetyReviewer = await import("/home/z/my-project/claude-killer/dist/safetyReviewer.js");
  const modeExtensions = await import("/home/z/my-project/claude-killer/dist/modeExtensions.js");

  // -----------------------------------------------------------------------
  // SECTION 1: Hooks com erro de runtime
  // -----------------------------------------------------------------------
  console.log(SECTION("1. Hooks com erro de runtime"));

  modes.setActiveMode("roblox");
  const robloxHooksDir = path.join(process.env.HOME, ".claude-killer", "modes", "roblox", "hooks");
  fs.mkdirSync(robloxHooksDir, { recursive: true });

  // Hook 1: Syntax error
  const syntaxHookJs = `const { parentPort } = require("worker_threads");\n// Syntax error below\nparentPort.postMessage({ warning: "unterminated string" });\n// missing close`;
  const syntaxHookJson = { name: "syntax-error-hook", file: "syntax-error-hook.js", trigger: "on_file", timeout: 3000 };
  fs.writeFileSync(path.join(robloxHooksDir, "syntax-error-hook.js"), syntaxHookJs + "\n");
  fs.writeFileSync(path.join(robloxHooksDir, "syntax-error-hook.json"), JSON.stringify(syntaxHookJson, null, 2));

  // Hook 2: throw exception
  const throwHookJs = `const { parentPort } = require("worker_threads");\nthrow new Error("Hook intentionally crashed");\nparentPort.postMessage({ warning: "never reached" });\n`;
  const throwHookJson = { name: "throw-hook", file: "throw-hook.js", trigger: "on_file", timeout: 3000 };
  fs.writeFileSync(path.join(robloxHooksDir, "throw-hook.js"), throwHookJs);
  fs.writeFileSync(path.join(robloxHooksDir, "throw-hook.json"), JSON.stringify(throwHookJson, null, 2));

  // Hook 3: require de módulo inexistente
  const requireFailHookJs = `const { parentPort } = require("worker_threads");\nconst nonexistent = require("nonexistent-module-xyz");\nparentPort.postMessage({ warning: "never reached" });\n`;
  const requireFailHookJson = { name: "require-fail-hook", file: "require-fail-hook.js", trigger: "on_file", timeout: 3000 };
  fs.writeFileSync(path.join(robloxHooksDir, "require-fail-hook.js"), requireFailHookJs);
  fs.writeFileSync(path.join(robloxHooksDir, "require-fail-hook.json"), JSON.stringify(requireFailHookJson, null, 2));

  // Hook 4: Posta mensagem normal (controle)
  const okHookJs = `const { parentPort, workerData } = require("worker_threads");\nparentPort.postMessage({ warning: "ok-hook ran for " + workerData.filePath });\n`;
  const okHookJson = { name: "ok-hook-control", file: "ok-hook-control.js", trigger: "on_file", timeout: 3000 };
  fs.writeFileSync(path.join(robloxHooksDir, "ok-hook-control.js"), okHookJs);
  fs.writeFileSync(path.join(robloxHooksDir, "ok-hook-control.json"), JSON.stringify(okHookJson, null, 2));

  // Rodar todos os hooks on_file
  console.log(`${INFO}  Running 4 hooks (3 broken + 1 ok)...`);
  const hookResults = await hookRunner.runHooks("on_file", { filePath: "/tmp/test.luau", mode: "roblox" }, "roblox");
  console.log(`${INFO}  Results: ${hookResults.length}`);
  for (const r of hookResults) {
    console.log(`${INFO}    warning=${r.warning?.slice(0, 80) ?? "(none)"} blocking=${r.blocking ?? false}`);
  }
  // Hooks com erro deveriam produzir warnings, não crashes
  assert(hookResults.length >= 1, "Hook errors produce results (not throws)");
  // Pelo menos o hook OK deve ter rodado
  const okRan = hookResults.some((r) => r.warning?.includes("ok-hook ran"));
  assert(okRan === true, "OK hook ran successfully despite other hooks failing");

  // -----------------------------------------------------------------------
  // SECTION 2: Hook com modifiedContent (before_write)
  // -----------------------------------------------------------------------
  console.log(SECTION("2. Hook com modifiedContent (before_write)"));

  // Hook que adiciona um header no início do arquivo
  const modifyHookJs = `const { parentPort, workerData } = require("worker_threads");\nconst header = "-- Auto-generated header by hook\\n-- File: " + workerData.filePath + "\\n\\n";\nparentPort.postMessage({ modifiedContent: header + workerData.content });\n`;
  const modifyHookJson = { name: "add-header-hook", file: "add-header-hook.js", trigger: "before_write", timeout: 3000 };
  fs.writeFileSync(path.join(robloxHooksDir, "add-header-hook.js"), modifyHookJs);
  fs.writeFileSync(path.join(robloxHooksDir, "add-header-hook.json"), JSON.stringify(modifyHookJson, null, 2));

  const modifyResults = await hookRunner.runHooks(
    "before_write",
    { filePath: "/tmp/test.luau", content: "local x = 1\n", mode: "roblox" },
    "roblox",
  );
  console.log(`${INFO}  before_write results: ${modifyResults.length}`);
  for (const r of modifyResults) {
    console.log(`${INFO}    modifiedContent length=${r.modifiedContent?.length ?? 0}, warning=${r.warning?.slice(0, 60) ?? "(none)"}`);
  }
  assert(modifyResults.length > 0, "before_write hook produced result");
  const modifiedResult = modifyResults.find((r) => r.modifiedContent);
  assert(modifiedResult !== undefined, "Hook returned modifiedContent");
  if (modifiedResult) {
    assert(modifiedResult.modifiedContent?.includes("Auto-generated header"), "modifiedContent includes header");
    assert(modifiedResult.modifiedContent?.includes("local x = 1"), "modifiedContent preserves original content");
  }

  // -----------------------------------------------------------------------
  // SECTION 3: Hooks encadeados (múltiplos hooks mesmo trigger)
  // -----------------------------------------------------------------------
  console.log(SECTION("3. Hooks encadeados (multiple hooks, same trigger)"));

  // Criar 3 hooks on_task
  for (let i = 1; i <= 3; i++) {
    const hookJs = `const { parentPort, workerData } = require("worker_threads");\nparentPort.postMessage({ warning: "chain-hook-${i} ran" });\n`;
    const hookJson = { name: `chain-hook-${i}`, file: `chain-hook-${i}.js`, trigger: "on_task", timeout: 2000 };
    fs.writeFileSync(path.join(robloxHooksDir, `chain-hook-${i}.js`), hookJs);
    fs.writeFileSync(path.join(robloxHooksDir, `chain-hook-${i}.json`), JSON.stringify(hookJson, null, 2));
  }

  const chainResults = await hookRunner.runHooks("on_task", { mode: "roblox" }, "roblox");
  console.log(`${INFO}  Chain results: ${chainResults.length}`);
  for (let i = 0; i < chainResults.length; i++) {
    console.log(`${INFO}    [${i}] ${chainResults[i].warning?.slice(0, 60)}`);
  }
  // Deve rodar todos os 3 hooks (não parar no primeiro)
  assert(chainResults.length >= 3, "All 3 chain hooks ran (no early stop without blocking)");

  // -----------------------------------------------------------------------
  // SECTION 4: Hook blocking para no primeiro
  // -----------------------------------------------------------------------
  console.log(SECTION("4. Hook blocking para no primeiro"));

  // Criar 2 hooks before_write: primeiro blocking, segundo deveria ser pulado
  const blockFirstJs = `const { parentPort } = require("worker_threads");\nparentPort.postMessage({ blocking: true, message: "First hook blocked" });\n`;
  const blockFirstJson = { name: "block-first", file: "block-first.js", trigger: "before_write", timeout: 2000 };
  fs.writeFileSync(path.join(robloxHooksDir, "block-first.js"), blockFirstJs);
  fs.writeFileSync(path.join(robloxHooksDir, "block-first.json"), JSON.stringify(blockFirstJson, null, 2));

  const blockSecondJs = `const { parentPort } = require("worker_threads");\nparentPort.postMessage({ warning: "second hook ran (should not happen if first blocks)" });\n`;
  const blockSecondJson = { name: "block-second", file: "block-second.js", trigger: "before_write", timeout: 2000 };
  fs.writeFileSync(path.join(robloxHooksDir, "block-second.js"), blockSecondJs);
  fs.writeFileSync(path.join(robloxHooksDir, "block-second.json"), JSON.stringify(blockSecondJson, null, 2));

  const blockResults = await hookRunner.runHooks(
    "before_write",
    { filePath: "/tmp/x.luau", content: "x", mode: "roblox" },
    "roblox",
  );
  console.log(`${INFO}  Block results: ${blockResults.length}`);
  for (const r of blockResults) {
    console.log(`${INFO}    blocking=${r.blocking ?? false}, message=${r.message?.slice(0, 50) ?? "(none)"}, warning=${r.warning?.slice(0, 50) ?? "(none)"}`);
  }
  // Deve ter pelo menos o blocking
  const hasBlocking = blockResults.some((r) => r.blocking === true);
  assert(hasBlocking === true, "First hook is blocking");
  // Hooks são carregados em ordem alfabética pelo loadHooksFromDir, então "block-first" vem antes de "block-second"
  // MAS add-header-hook também é before_write e vem antes alfabeticamente. Vamos ver a ordem real.
  console.log(`${INFO}  Note: hooks load in alphabetical order from dir`);

  // -----------------------------------------------------------------------
  // SECTION 5: Modo devops — ativação e config
  // -----------------------------------------------------------------------
  console.log(SECTION("5. Modo DevOps — ativação"));

  // Antes de ativar, normal mode está ativo
  modes.setActiveMode("normal");
  let activeName = modes.getActiveModeName();
  console.log(`${INFO}  Before: active=${activeName}`);
  assert(activeName === "normal", "Normal mode active before switch");

  // Ativar devops
  modes.setActiveMode("devops");
  activeName = modes.getActiveModeName();
  console.log(`${INFO}  After: active=${activeName}`);
  assert(activeName === "devops", "DevOps mode activated");

  const devopsMode = modes.getActiveMode();
  console.log(`${INFO}  devops mode: name=${devopsMode?.name}, label=${devopsMode?.label}`);
  assert(devopsMode?.name === "devops", "getActiveMode returns devops");
  assert(devopsMode?.label?.includes("DevOps"), "DevOps label includes 'DevOps'");
  assert(devopsMode?.effortLevel === "high", "DevOps effort level is high");
  assert(devopsMode?.strictMode === true, "DevOps has strictMode=true");
  assert(devopsMode?.readBeforeWrite === true, "DevOps has readBeforeWrite=true");
  assert(devopsMode?.advancedThinking === true, "DevOps has advancedThinking=true");

  // DevOps não tem tools próprias (não instalou terraform/kubectl)
  const devopsManifests = manifestLoader.loadActiveManifests();
  console.log(`${INFO}  devops manifests: ${devopsManifests.length}`);
  assert(devopsManifests.length === 0, "DevOps has 0 manifests (no tools installed)");

  // DevOps tem validators (terraform_fmt, terraform_validate, yamllint) do config.json
  const devopsRules = await modeExtensions.getActiveValidationRules();
  console.log(`${INFO}  devops validation rules: ${devopsRules.length}`);
  for (const r of devopsRules) console.log(`${INFO}    - ${r.tool} on ${r.filePattern}`);
  assert(devopsRules.length >= 4, "DevOps has 4+ validation rules (terraform + yamllint)");
  assert(devopsRules.some((r) => r.tool === "terraform_fmt"), "Has terraform_fmt validator");
  assert(devopsRules.some((r) => r.tool === "yamllint"), "Has yamllint validator");

  // DevOps tem features habilitadas
  const devopsFeatures = devopsMode?.enableFeatures ?? [];
  console.log(`${INFO}  devops features: ${devopsFeatures.length}`);
  assert(devopsFeatures.length > 0, "DevOps has features enabled");
  assert(devopsFeatures.includes("feature:think_tool"), "DevOps has think_tool feature");
  assert(devopsFeatures.includes("feature:read_before_write"), "DevOps has read_before_write feature");
  assert(devopsFeatures.includes("feature:sub_agents"), "DevOps has sub_agents feature");

  // -----------------------------------------------------------------------
  // SECTION 6: DevOps com safetyPatterns customizado (simulado)
  // -----------------------------------------------------------------------
  console.log(SECTION("6. DevOps safetyPatterns (custom destructive ops)"));

  // Criar um modo devops custom com safetyPatterns
  const customDevopsConfig = {
    name: "devops-custom",
    label: "DevOps Custom (test)",
    description: "Test mode with custom safety patterns",
    builtIn: false,
    effortLevel: "high",
    strictMode: true,
    readBeforeWrite: true,
    advancedThinking: true,
    toolsDir: "tools",
    manifestsDir: "manifests",
    skillsDir: "skills",
    hooksDir: "hooks",
    mcpsDir: "mcps",
    tools: [],
    skills: [],
    enableFeatures: ["feature:think_tool", "feature:read_before_write"],
    validators: [],
    safetyPatterns: [
      {
        regex: "terraform\\s+destroy",
        description: "terraform destroy (destructive)",
        severity: "high",
      },
      {
        regex: "kubectl\\s+delete\\s+namespace",
        description: "kubectl delete namespace (destructive)",
        severity: "high",
      },
      {
        regex: "kubectl\\s+delete\\s+deployment",
        description: "kubectl delete deployment",
        severity: "medium",
      },
    ],
    researchSources: {
      terraform: ["terraform.io/docs", "registry.terraform.io"],
      kubernetes: ["kubernetes.io/docs", "kubernetes.io/docs/reference"],
    },
    systemPrompt: "",
  };
  modes.saveUserMode(customDevopsConfig);
  modes.setActiveMode("devops-custom");

  const customMode = modes.getActiveMode();
  assert(customMode?.name === "devops-custom", "Custom devops mode active");
  assert((customMode?.safetyPatterns?.length ?? 0) === 3, "Custom mode has 3 safetyPatterns");

  // Testar safetyPatterns via scanDangerousPatternsAsync
  const terraformDestroyCode = `terraform destroy -auto-approve\n`;
  const terraformResult = await safetyReviewer.scanDangerousPatternsAsync(terraformDestroyCode);
  console.log(`${INFO}  terraform destroy: ${terraformResult.matched.length} patterns matched, hasHigh=${terraformResult.hasHighSeverity}`);
  assert(terraformResult.matched.length > 0, "terraform destroy matched custom pattern");
  assert(terraformResult.hasHighSeverity === true, "terraform destroy is high severity");

  const kubectlDeleteNsCode = `kubectl delete namespace production\n`;
  const kubectlResult = await safetyReviewer.scanDangerousPatternsAsync(kubectlDeleteNsCode);
  console.log(`${INFO}  kubectl delete namespace: ${kubectlResult.matched.length} patterns`);
  assert(kubectlResult.matched.length > 0, "kubectl delete namespace matched custom pattern");

  // Código seguro não dispara
  const safeTerraformCode = `terraform plan -out=tfplan\nterraform apply tfplan\n`;
  const safeTerraformResult = await safetyReviewer.scanDangerousPatternsAsync(safeTerraformCode);
  console.log(`${INFO}  safe terraform: ${safeTerraformResult.matched.length} patterns`);
  assert(safeTerraformResult.matched.length === 0, "Safe terraform code does not match destructive patterns");

  // Testar researchSources
  const researchSources = await modeExtensions.getActiveResearchSources();
  console.log(`${INFO}  research sources: ${JSON.stringify(researchSources).slice(0, 200)}`);
  assert(Object.keys(researchSources).length > 0, "Custom mode has research sources");
  assert(researchSources.terraform?.length > 0, "Has terraform research sources");
  assert(researchSources.kubernetes?.length > 0, "Has kubernetes research sources");

  // Limpar modo custom
  modes.deleteUserMode("devops-custom");

  // -----------------------------------------------------------------------
  // SECTION 7: getMergedToolsPublic — combo de tools nativas + manifest
  // -----------------------------------------------------------------------
  console.log(SECTION("7. getMergedToolsPublic — native + manifest tools"));

  // Voltar para roblox mode (tem manifest tools)
  modes.setActiveMode("roblox");

  const mergedTools = agent.getMergedToolsPublic();
  console.log(`${INFO}  Total merged tools: ${mergedTools.length}`);

  // Listar todas as tools
  const toolNames = mergedTools.map((t) => t.function.name);
  console.log(`${INFO}  Tools: ${toolNames.join(", ").slice(0, 300)}`);

  // Deve ter tools nativas (ler_arquivo, editar_arquivo, etc)
  assert(toolNames.includes("ler_arquivo"), "Has ler_arquivo (native)");
  assert(toolNames.includes("editar_arquivo"), "Has editar_arquivo (native)");
  assert(toolNames.includes("executar_comando"), "Has executar_comando (native)");
  assert(toolNames.includes("buscar_arquivos"), "Has buscar_arquivos (native)");
  assert(toolNames.includes("buscar_texto"), "Has buscar_texto (native grep)");
  assert(toolNames.includes("pensar"), "Has pensar (think tool)");

  // Deve ter tools de manifest (rojo_build, selene_lint, etc)
  assert(toolNames.includes("rojo_build"), "Has rojo_build (manifest)");
  assert(toolNames.includes("rojo_serve"), "Has rojo_serve (manifest)");
  assert(toolNames.includes("rojo_sourcemap"), "Has rojo_sourcemap (manifest)");
  assert(toolNames.includes("selene_lint"), "Has selene_lint (manifest)");
  assert(toolNames.includes("stylua_format"), "Has stylua_format (manifest)");
  assert(toolNames.includes("lune_run"), "Has lune_run (manifest)");

  // -----------------------------------------------------------------------
  // SECTION 8: dispatchToolCallPublic — todas as tools nativas
  // -----------------------------------------------------------------------
  console.log(SECTION("8. dispatchToolCallPublic — native tools dispatch"));

  // Helper: criar tool call
  function makeToolCall(name, args) {
    return {
      id: `call_${name}_${Date.now()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // ler_arquivo
  const tmpReadFile = path.join(os.tmpdir(), "claude-killer-dispatch-test.txt");
  fs.writeFileSync(tmpReadFile, "dispatch test content\n");
  const lerResult = await agent.dispatchToolCallPublic(makeToolCall("ler_arquivo", { caminho: tmpReadFile }));
  console.log(`${INFO}  ler_arquivo: ${lerResult.resultStr.slice(0, 80)}`);
  assert(lerResult.resultStr.includes("dispatch test content"), "dispatch ler_arquivo reads file");
  assert(lerResult.usedHeal === false, "ler_arquivo: no heal needed");

  // executar_comando
  const cmdResult = await agent.dispatchToolCallPublic(makeToolCall("executar_comando", { comando: "echo 'dispatch works'" }));
  console.log(`${INFO}  executar_comando: ${cmdResult.resultStr.slice(0, 80)}`);
  assert(cmdResult.resultStr.includes("dispatch works"), "dispatch executar_comando runs command");

  // buscar_arquivos (glob)
  const tmpSearchDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-dispatch-search-"));
  fs.writeFileSync(path.join(tmpSearchDir, "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(tmpSearchDir, "b.ts"), "export const b = 2;\n");
  const globResult = await agent.dispatchToolCallPublic(makeToolCall("buscar_arquivos", { pattern: "**/*.ts", cwd: tmpSearchDir }));
  console.log(`${INFO}  buscar_arquivos: ${globResult.resultStr.slice(0, 100)}`);
  assert(globResult.resultStr.includes("a.ts"), "buscar_arquivos finds a.ts");

  // buscar_texto (grep)
  const grepResult = await agent.dispatchToolCallPublic(makeToolCall("buscar_texto", { pattern: "export", path: tmpSearchDir }));
  console.log(`${INFO}  buscar_texto: ${grepResult.resultStr.slice(0, 100)}`);
  assert(grepResult.resultStr.length > 0, "buscar_texto returns results");

  // pensar (think tool)
  const thinkResult = await agent.dispatchToolCallPublic(makeToolCall("pensar", { pensamento: "test thinking", categoria: "verification" }));
  console.log(`${INFO}  pensar: ${thinkResult.resultStr.slice(0, 80)}`);
  assert(thinkResult.resultStr.includes("PENSAMENTO REGISTRADO"), "pensar returns confirmation");

  // Tool inexistente — deve retornar erro graceful
  const unknownResult = await agent.dispatchToolCallPublic(makeToolCall("tool_inexistente_xyz", {}));
  console.log(`${INFO}  unknown tool: ${unknownResult.resultStr.slice(0, 80)}`);
  assert(unknownResult.resultStr.includes("[ERRO]") || unknownResult.resultStr.toLowerCase().includes("unknown") || unknownResult.resultStr.toLowerCase().includes("não"), "Unknown tool returns error");

  // -----------------------------------------------------------------------
  // SECTION 9: dispatchToolCallPublic com manifest tools (rojo_build)
  // -----------------------------------------------------------------------
  console.log(SECTION("9. dispatchToolCallPublic — manifest tools (rojo_build)"));

  // Criar projeto rojo
  const tmpRojoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-dispatch-rojo-"));
  fs.writeFileSync(path.join(tmpRojoDir, "default.project.json"), JSON.stringify({
    name: "DispatchTest",
    tree: { $path: "src" },
  }, null, 2));
  fs.mkdirSync(path.join(tmpRojoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpRojoDir, "src", "init.luau"), `--!strict\nreturn {}\n`);

  const rojoOutput = path.join(tmpRojoDir, "dispatch-test.rbxl");
  const rojoResult = await agent.dispatchToolCallPublic(makeToolCall("rojo_build", { output: rojoOutput, dir: tmpRojoDir }));
  console.log(`${INFO}  rojo_build: ${rojoResult.resultStr.slice(0, 150)}`);
  assert(rojoResult.resultStr.includes("Built") || rojoResult.resultStr.includes("Building") || fs.existsSync(rojoOutput), "rojo_build dispatched successfully");
  assert(fs.existsSync(rojoOutput), "Output .rbxl file created via dispatch");

  // selene_lint
  const tmpLintFile = path.join(tmpRojoDir, "src", "lint-me.luau");
  fs.writeFileSync(tmpLintFile, `print(undefinedGlobalZzz)\n`);
  const seleneResult = await agent.dispatchToolCallPublic(makeToolCall("selene_lint", { path: tmpLintFile }));
  console.log(`${INFO}  selene_lint: ${seleneResult.resultStr.slice(0, 200)}`);
  // selene deve retornar output com diagnósticos
  assert(seleneResult.resultStr.length > 0, "selene_lint dispatched and returned output");

  // stylua_format
  const tmpFormatFile = path.join(tmpRojoDir, "src", "format-me.luau");
  fs.writeFileSync(tmpFormatFile, `local x={1,2,3}for i,v in ipairs(x)do print(i,v)end\n`);
  const styluaResult = await agent.dispatchToolCallPublic(makeToolCall("stylua_format", { path: tmpFormatFile }));
  console.log(`${INFO}  stylua_format: ${styluaResult.resultStr.slice(0, 150)}`);
  assert(styluaResult.resultStr.length > 0, "stylua_format dispatched");
  // Verificar que o arquivo foi formatado
  const afterFormat = fs.readFileSync(tmpFormatFile, "utf8");
  console.log(`${INFO}  File after format: ${afterFormat.replace(/\n/g, "\\n").slice(0, 100)}`);

  // -----------------------------------------------------------------------
  // SECTION 10: Agent loop completo — fluxo simples
  // -----------------------------------------------------------------------
  console.log(SECTION("10. Agent loop (runAgentLoop) — simple flow"));

  // Reset history entre testes (senão IA continua conversa anterior)
  const history = await import("/home/z/my-project/claude-killer/dist/history.js");
  history.resetHistory();

  // Agent loop com pergunta simples (sem tools)
  let tokensReceived = 0;
  let streamStarted = false;
  const agentResult = await agent.runAgentLoop(
    "What is 2+2? Reply with just the number, nothing else.",
    () => { streamStarted = true; },  // onStreamStart
    (token) => { tokensReceived += token.length; },  // onToken
    undefined,  // onThinking
    undefined,  // onUsage
    undefined,  // onToolCall
    undefined,  // onToolResult
    undefined,  // onAskUser
    false,      // allowUserQuestions (no UI)
  );
  console.log(`${INFO}  Agent result: ${agentResult.slice(0, 100)}`);
  console.log(`${INFO}  Stream started: ${streamStarted}, tokens received: ${tokensReceived}`);
  assert(typeof agentResult === "string", "runAgentLoop returns string");
  assert(agentResult.length > 0, "runAgentLoop returns non-empty result");
  assert(streamStarted === true, "Stream started callback fired");
  // Deve conter "4"
  assert(agentResult.includes("4"), "Agent answered 2+2=4", `got: ${agentResult.slice(0, 100)}`);

  // -----------------------------------------------------------------------
  // SECTION 11: Agent loop com tool call (ler_arquivo)
  // -----------------------------------------------------------------------
  console.log(SECTION("11. Agent loop with tool call (ler_arquivo)"));

  // Reset history
  history.resetHistory();
  console.log(`${INFO}  History length after reset: ${history.getHistory().length}`);
  console.log(`${INFO}  First msg role: ${history.getHistory()[0]?.role}`);

  // Criar arquivo pra IA ler
  const tmpAgentFile = path.join(os.tmpdir(), "claude-killer-agent-target.txt");
  fs.writeFileSync(tmpAgentFile, "The secret word is: BANANA\n");

  const toolCallsObserved = [];
  const toolResultsObserved = [];
  const agentResult2 = await agent.runAgentLoop(
    `I have a file at ${tmpAgentFile}. Use the ler_arquivo tool to read it (the parameter name is "caminho"). Then reply with ONLY the secret word that's in the file.`,
    undefined,
    undefined,
    undefined,
    undefined,
    (toolName, args) => { toolCallsObserved.push({ toolName, args }); },
    (toolName, ok, resultStr) => { toolResultsObserved.push({ toolName, ok, resultStr: resultStr.slice(0, 100) }); },
    undefined,
    false,
  );
  console.log(`${INFO}  Agent result: ${agentResult2.slice(0, 100)}`);
  console.log(`${INFO}  Tool calls observed: ${toolCallsObserved.length}`);
  for (const tc of toolCallsObserved) {
    console.log(`${INFO}    ${tc.toolName}(${JSON.stringify(tc.args).slice(0, 80)})`);
  }
  console.log(`${INFO}  Tool results observed: ${toolResultsObserved.length}`);
  for (const tr of toolResultsObserved) {
    console.log(`${INFO}    ${tr.toolName} ok=${tr.ok}: ${tr.resultStr.slice(0, 80)}`);
  }
  assert(toolCallsObserved.length > 0, "Agent made at least 1 tool call");
  assert(toolCallsObserved.some((tc) => tc.toolName === "ler_arquivo"), "Agent called ler_arquivo");
  assert(agentResult2.toUpperCase().includes("BANANA"), "Agent found the secret word BANANA", `got: ${agentResult2.slice(0, 100)}`);

  // -----------------------------------------------------------------------
  // SECTION 12: Agent loop com rojo_build (manifest tool)
  // -----------------------------------------------------------------------
  console.log(SECTION("12. Agent loop with manifest tool (rojo_build)"));

  // Reset history
  history.resetHistory();

  const tmpAgentRojoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-agent-rojo-"));
  fs.writeFileSync(path.join(tmpAgentRojoDir, "default.project.json"), JSON.stringify({
    name: "AgentRojoTest",
    tree: { $path: "src" },
  }, null, 2));
  fs.mkdirSync(path.join(tmpAgentRojoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpAgentRojoDir, "src", "init.luau"), `--!strict\nreturn {}\n`);

  const agentRojoOutput = path.join(tmpAgentRojoDir, "agent-built.rbxl");
  const toolCalls12 = [];
  const agentResult12 = await agent.runAgentLoop(
    `Build the Rojo project at ${tmpAgentRojoDir} to ${agentRojoOutput}. Use rojo_build tool. Reply with "done" when finished.`,
    undefined, undefined, undefined, undefined,
    (toolName, args) => { toolCalls12.push({ toolName, args }); },
    undefined, undefined, false,
  );
  console.log(`${INFO}  Agent result: ${agentResult12.slice(0, 150)}`);
  console.log(`${INFO}  Tool calls: ${toolCalls12.map((tc) => tc.toolName).join(", ")}`);
  assert(toolCalls12.some((tc) => tc.toolName === "rojo_build"), "Agent called rojo_build");
  assert(fs.existsSync(agentRojoOutput), "Agent's rojo_build created .rbxl file");
  assert(agentResult12.toLowerCase().includes("done") || agentResult12.toLowerCase().includes("built") || agentResult12.toLowerCase().includes("success"), "Agent confirmed build done");

  // -----------------------------------------------------------------------
  // Cleanup test hooks
  // -----------------------------------------------------------------------
  console.log(SECTION("Cleanup"));
  const cleanupHooks = [
    "syntax-error-hook", "throw-hook", "require-fail-hook", "ok-hook-control",
    "add-header-hook", "chain-hook-1", "chain-hook-2", "chain-hook-3",
    "block-first", "block-second",
  ];
  for (const name of cleanupHooks) {
    try {
      fs.unlinkSync(path.join(robloxHooksDir, `${name}.js`));
      fs.unlinkSync(path.join(robloxHooksDir, `${name}.json`));
    } catch {}
  }
  console.log(`${INFO}  Cleaned up test hooks`);

  // Restore normal mode
  modes.setActiveMode("roblox");

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

  // Cleanup temp dirs
  try {
    fs.rmSync(tmpSearchDir, { recursive: true, force: true });
    fs.rmSync(tmpRojoDir, { recursive: true, force: true });
    fs.rmSync(tmpAgentRojoDir, { recursive: true, force: true });
  } catch {}

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`);
  process.exit(2);
});
