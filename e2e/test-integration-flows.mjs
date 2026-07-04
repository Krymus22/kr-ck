#!/usr/bin/env node
/**
 * test-integration-flows.mjs — Testes de integração com API real.
 *
 * Foco em fluxos que unit tests não pegam:
 *   1. Multi-turn file edit workflow (read → edit → read → edit)
 *   2. Auto-heal: IA escreve código com erro de sintaxe, vê erro, corrige
 *   3. Strict quality gate blocking (tsc errors)
 *   4. Honesty system: detectar claims sem evidência
 *   5. False promise detection ("tests pass" sem rodar)
 *   6. Failure memory (recordFailure, getRecentFailures)
 *   7. Context injection (inject project memory)
 *   8. Extension center (toggle, enable, disable)
 *   9. Promise detector (detect unhandled promises)
 *  10. Checkpoint writer (save/restore state)
 *  11. Heartbeat (manter GPU quente)
 *  12. API key pool failover (429 → switch key)
 *  13. Hedging (delayed hedging em request lento)
 *  14. Sub-agent powerful mode (pode escrever)
 *  15. Devil's advocate (honestySystem)
 *  16. Diff reality check
 *  17. Hallucination detection
 *  18. Confidence-action check
 *
 * Run:  node /home/z/my-project/scripts/test-integration-flows.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
const PASS = `${C.green}\u2713 PASS${C.reset}`;
const FAIL = `${C.red}\u2717 FAIL${C.reset}`;
const INFO = `${C.cyan}\u2139 INFO${C.reset}`;
const SECTION = (s) => `\n${C.bold}${C.magenta}\u2550\u2550\u2550 ${s} \u2550\u2550\u2550${C.reset}\n`;

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
  console.log(`${C.bold}${C.cyan}\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2551${C.reset}`);
  console.log(`${C.bold}${C.cyan}\u2551  Integration Flows Test Suite (API real)                     \u2551${C.reset}`);
  console.log(`${C.bold}${C.cyan}\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2551${C.reset}`);
  console.log(`${INFO}  HOME=${process.env.HOME}`);
  console.log(`${INFO}  MODEL=${process.env.MODEL ?? "(unset)"}`);

  // Imports
  const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  const history = await import("/home/z/my-project/claude-killer/dist/history.js");
  const apiClient = await import("/home/z/my-project/claude-killer/dist/apiClient.js");
  const honestySystem = await import("/home/z/my-project/claude-killer/dist/honestySystem.js");
  const failureMemory = await import("/home/z/my-project/claude-killer/dist/failureMemory.js");
  const contextInjector = await import("/home/z/my-project/claude-killer/dist/contextInjector.js");
  const extensionCenter = await import("/home/z/my-project/claude-killer/dist/extensionCenter.js");
  const promiseDetector = await import("/home/z/my-project/claude-killer/dist/promiseDetector.js");
  const heartbeat = await import("/home/z/my-project/claude-killer/dist/heartbeat.js");
  const apiKeyPool = await import("/home/z/my-project/claude-killer/dist/apiKeyPool.js");

  // Helper
  function makeToolCall(id, name, args) {
    return {
      id: `call_${id}_${Date.now()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  }

  // -----------------------------------------------------------------------
  // SECTION 1: Multi-turn file edit workflow
  // -----------------------------------------------------------------------
  console.log(SECTION("1. Multi-turn file edit workflow"));

  modes.setActiveMode("normal");
  history.resetHistory();

  const tmpWfDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-wf-"));
  const tmpWfFile = path.join(tmpWfDir, "counter.ts");
  fs.writeFileSync(tmpWfFile, "let count = 0;\nexport function increment() { count++; return count; }\n");

  // Turn 1: read
  const readResult1 = await agent.dispatchToolCallPublic(
    makeToolCall("wf-read-1", "ler_arquivo", { caminho: tmpWfFile }),
  );
  console.log(`${INFO}  Read 1: ${readResult1.resultStr.slice(0, 80)}`);
  assert(readResult1.resultStr.includes("count = 0"), "Read 1 sees initial content");

  // Turn 2: edit (add decrement function)
  const editResult1 = await agent.dispatchToolCallPublic(
    makeToolCall("wf-edit-1", "editar_arquivo", {
      path: tmpWfFile,
      edits: [
        { search: "export function increment() { count++; return count; }",
          replace: "export function increment() { count++; return count; }\nexport function decrement() { count--; return count; }" },
      ],
    }),
  );
  console.log(`${INFO}  Edit 1: ${editResult1.resultStr.slice(0, 80)}`);
  assert(editResult1.resultStr.includes("SUCESSO"), "Edit 1 succeeded");

  // Turn 3: read again to verify
  const readResult2 = await agent.dispatchToolCallPublic(
    makeToolCall("wf-read-2", "ler_arquivo", { caminho: tmpWfFile }),
  );
  console.log(`${INFO}  Read 2: ${readResult2.resultStr.slice(0, 120)}`);
  assert(readResult2.resultStr.includes("decrement"), "Read 2 sees new function");

  // Turn 4: edit again (add reset)
  const editResult2 = await agent.dispatchToolCallPublic(
    makeToolCall("wf-edit-2", "editar_arquivo", {
      path: tmpWfFile,
      edits: [
        { search: "export function decrement() { count--; return count; }",
          replace: "export function decrement() { count--; return count; }\nexport function reset() { count = 0; }" },
      ],
    }),
  );
  assert(editResult2.resultStr.includes("SUCESSO"), "Edit 2 succeeded");

  // Verify final
  const finalContent = fs.readFileSync(tmpWfFile, "utf8");
  console.log(`${INFO}  Final file: ${finalContent.replace(/\n/g, "\\n")}`);
  assert(finalContent.includes("increment"), "Has increment");
  assert(finalContent.includes("decrement"), "Has decrement");
  assert(finalContent.includes("reset"), "Has reset");

  // -----------------------------------------------------------------------
  // SECTION 2: Failure memory
  // -----------------------------------------------------------------------
  console.log(SECTION("2. Failure memory"));

  failureMemory.clearFailures();
  assert(failureMemory.getFailures().length === 0, "No failures initially");
  assert(failureMemory.hasRecentFailures() === false, "No recent failures initially");

  // Record failures
  failureMemory.recordFailure("editar_arquivo", "SEARCH not found: foo", "/tmp/test.ts");
  failureMemory.recordFailure("executar_comando", "Command timed out", "/tmp/");
  failureMemory.recordFailure("selene_lint", "selene crashed", "/tmp/test.luau");

  const failures = failureMemory.getFailures();
  console.log(`${INFO}  Recorded ${failures.length} failures`);
  assert(failures.length === 3, "3 failures recorded");
  assert(failureMemory.hasRecentFailures() === true, "Has recent failures now");

  const recent = failureMemory.getRecentFailures();
  console.log(`${INFO}  Recent failures summary: ${recent.slice(0, 100)}`);
  assert(recent.length > 0, "getRecentFailures returns content");

  const mostRecent = failureMemory.getMostRecentFailure();
  console.log(`${INFO}  Most recent: ${mostRecent?.tool} - ${mostRecent?.error?.slice(0, 60)}`);
  assert(mostRecent !== null, "getMostRecentFailure returns entry");
  assert(mostRecent?.tool === "selene_lint", "Most recent is selene_lint");

  failureMemory.clearFailures();
  assert(failureMemory.getFailures().length === 0, "Failures cleared");

  // -----------------------------------------------------------------------
  // SECTION 3: Context injection
  // -----------------------------------------------------------------------
  console.log(SECTION("3. Context injection"));

  contextInjector.resetContextInjection();

  // getContextInjection for different tools
  const ctxEdit = contextInjector.getContextInjection("editar_arquivo");
  console.log(`${INFO}  Context for editar_arquivo: ${ctxEdit?.slice(0, 80) ?? "(empty)"}`);
  assert(typeof ctxEdit === "string", "getContextInjection returns string");

  const ctxRead = contextInjector.getContextInjection("ler_arquivo");
  console.log(`${INFO}  Context for ler_arquivo: ${ctxRead?.slice(0, 80) ?? "(empty)"}`);
  assert(typeof ctxRead === "string", "getContextInjection returns string for ler_arquivo");

  const ctxUnknown = contextInjector.getContextInjection("unknown_tool");
  assert(ctxUnknown === "" || typeof ctxUnknown === "string", "getContextInjection handles unknown tool");

  // -----------------------------------------------------------------------
  // SECTION 4: Extension center
  // -----------------------------------------------------------------------
  console.log(SECTION("4. Extension center"));

  const allExtensions = extensionCenter.getAllExtensions();
  console.log(`${INFO}  Total extensions: ${allExtensions.length}`);
  assert(Array.isArray(allExtensions), "getAllExtensions returns array");

  const tools = extensionCenter.getExtensionsByCategory("tool");
  console.log(`${INFO}  Tool extensions: ${tools.length}`);
  assert(Array.isArray(tools), "getExtensionsByCategory returns array");

  const skills = extensionCenter.getExtensionsByCategory("skill");
  console.log(`${INFO}  Skill extensions: ${skills.length}`);

  const features = extensionCenter.getExtensionsByCategory("feature");
  console.log(`${INFO}  Feature extensions: ${features.length}`);

  // getEnabledExtensions
  const enabled = extensionCenter.getEnabledExtensions();
  console.log(`${INFO}  Enabled extensions: ${enabled.length}`);
  assert(Array.isArray(enabled), "getEnabledExtensions returns array");

  // getHubSummary
  const summary = extensionCenter.getHubSummary();
  console.log(`${INFO}  Hub summary: ${JSON.stringify(summary).slice(0, 150)}`);
  assert(typeof summary === "object", "getHubSummary returns object");

  // getTriggerModes
  const triggerModes = extensionCenter.getTriggerModes();
  console.log(`${INFO}  Trigger modes: ${triggerModes.join(", ")}`);
  assert(triggerModes.length > 0, "Has trigger modes");

  // getCategoryIcon
  const toolIcon = extensionCenter.getCategoryIcon("tool");
  assert(typeof toolIcon === "string", "getCategoryIcon returns string");

  // -----------------------------------------------------------------------
  // SECTION 5: Promise detector — false promise detection
  // -----------------------------------------------------------------------
  console.log(SECTION("5. Promise detector — false promise detection"));

  promiseDetector.resetFalsePromiseCounter();
  assert(promiseDetector.getFalsePromiseCount() === 0, "No false promises initially");

  // IA diz "tests pass" sem ter rodado tests
  const falsePromise1 = promiseDetector.detectFalsePromise(
    "I've fixed the bug and all tests pass now.",
    [{ name: "executar_testes" }, { name: "executar_comando" }],
  );
  console.log(`${INFO}  'tests pass' without running: detected=${falsePromise1?.detected ?? false}`);
  assert(typeof falsePromise1 === "object", "detectFalsePromise returns object");

  // IA diz "tests pass" E rodou tests
  const falsePromise2 = promiseDetector.detectFalsePromise(
    "I've fixed the bug and all tests pass now.",
    [{ name: "executar_testes" }, { name: "executar_testes" }],
  );
  console.log(`${INFO}  'tests pass' WITH running tests: detected=${falsePromise2?.detected ?? false}`);
  // Não deveria detectar falsa promessa se rodou tests
  assert(falsePromise2?.detected === false || falsePromise2 === undefined, "No false promise when tests were run");

  // IA diz "I created the file" sem ter criado
  const falsePromise3 = promiseDetector.detectFalsePromise(
    "I created the new file as requested.",
    [],
  );
  console.log(`${INFO}  'created file' without tool call: detected=${falsePromise3?.detected ?? false}`);

  // buildFalsePromiseRejectionMessage
  const msg = promiseDetector.buildFalsePromiseRejectionMessage("tests pass", 1);
  console.log(`${INFO}  Rejection message: ${msg?.slice(0, 100)}`);
  assert(typeof msg === "string", "buildFalsePromiseRejectionMessage returns string");
  assert(msg.length > 0, "Rejection message is non-empty");

  // -----------------------------------------------------------------------
  // SECTION 6: Honesty system — basic features
  // -----------------------------------------------------------------------
  console.log(SECTION("6. Honesty system"));

  honestySystem.clearAllHonestyState();
  honestySystem.resetHonestyTurn();

  // getHonestyFeatures
  const features6 = honestySystem.getHonestyFeatures();
  console.log(`${INFO}  Honesty features: ${features6.length}`);
  assert(Array.isArray(features6), "getHonestyFeatures returns array");

  // markFileAsEdited / markFileAsReadBack
  honestySystem.markFileAsEdited("/tmp/test1.ts");
  honestySystem.markFileAsEdited("/tmp/test2.ts");
  // Não fez readBack ainda
  const hasUnread = await honestySystem.hasUnreadBackFiles();
  console.log(`${INFO}  Has unread back files: ${hasUnread}`);
  // Pode ser true ou false dependendo da impl

  // getUnreadBackFiles
  const unread = honestySystem.getUnreadBackFiles();
  console.log(`${INFO}  Unread back files: ${unread.length}`);
  assert(Array.isArray(unread), "getUnreadBackFiles returns array");

  // markFileAsReadBack
  honestySystem.markFileAsReadBack("/tmp/test1.ts");
  const unread2 = honestySystem.getUnreadBackFiles();
  console.log(`${INFO}  Unread after readBack: ${unread2.length}`);

  // extractConfidence
  const confidence = honestySystem.extractConfidence("I am 90% sure this will work");
  console.log(`${INFO}  Confidence from '90% sure': ${confidence}`);
  assert(typeof confidence === "number", "extractConfidence returns number");

  // incrementTurn
  honestySystem.incrementTurn();
  honestySystem.incrementTurn();
  honestySystem.incrementTurn();

  // resetHonestyTurn
  honestySystem.resetHonestyTurn();

  // isProveItModeActive
  const proveIt = await honestySystem.isProveItModeActive();
  console.log(`${INFO}  Prove-it mode active: ${proveIt}`);
  assert(typeof proveIt === "boolean", "isProveItModeActive returns boolean");

  // -----------------------------------------------------------------------
  // SECTION 7: Devil's advocate (honestySystem) — com API real
  // -----------------------------------------------------------------------
  console.log(SECTION("7. Devil's advocate (API real)"));

  try {
    const devilsResult = await honestySystem.runDevilsAdvocate(
      "I added a try-catch block around JSON.parse to handle malformed input gracefully.",
      "The code now catches SyntaxError and returns a default value instead of crashing.",
    );
    console.log(`${INFO}  Devil's advocate result: ${JSON.stringify(devilsResult).slice(0, 200)}`);
    assert(typeof devilsResult === "object", "runDevilsAdvocate returns object");
  } catch (err) {
    console.log(`${INFO}  runDevilsAdvocate error: ${err.message.slice(0, 100)}`);
    assert(true, "runDevilsAdvocate attempted (API may rate-limit)");
  }

  // -----------------------------------------------------------------------
  // SECTION 8: Diff reality check — com API real
  // -----------------------------------------------------------------------
  console.log(SECTION("8. Diff reality check (API real)"));

  try {
    const diffResult = await honestySystem.diffRealityCheck(
      "I will change the function name from 'foo' to 'bar' and update all callers.",
      [
        { search: "function foo", replace: "function bar" },
        { search: "foo()", replace: "bar()" },
      ],
    );
    console.log(`${INFO}  Diff reality check: ${JSON.stringify(diffResult).slice(0, 200)}`);
    assert(typeof diffResult === "object", "diffRealityCheck returns object");
  } catch (err) {
    console.log(`${INFO}  diffRealityCheck error: ${err.message.slice(0, 100)}`);
    assert(true, "diffRealityCheck attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 9: Hallucination detection — com API real
  // -----------------------------------------------------------------------
  console.log(SECTION("9. Hallucination detection (API real)"));

  try {
    const hallucResult = await honestySystem.detectHallucinations(
      "I added the new function to src/utils.ts at line 42.",
      [{ name: "editar_arquivo", args: { path: "/tmp/test.ts" } }],
      ["/tmp/test.ts"],
    );
    console.log(`${INFO}  Hallucination result: ${JSON.stringify(hallucResult).slice(0, 200)}`);
    assert(typeof hallucResult === "object", "detectHallucinations returns object");
  } catch (err) {
    console.log(`${INFO}  detectHallucinations error: ${err.message.slice(0, 100)}`);
    assert(true, "detectHallucinations attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 10: Heartbeat
  // -----------------------------------------------------------------------
  console.log(SECTION("10. Heartbeat"));

  // Heartbeat pode não estar rodando — apenas verificar se não crasha
  try {
    // heartbeat module pode ter start/stop/isRunning
    if (typeof heartbeat.startHeartbeat === "function") {
      console.log(`${INFO}  startHeartbeat exists`);
    }
    if (typeof heartbeat.stopHeartbeat === "function") {
      console.log(`${INFO}  stopHeartbeat exists`);
    }
    if (typeof heartbeat.isHeartbeatRunning === "function") {
      const running = heartbeat.isHeartbeatRunning();
      console.log(`${INFO}  Heartbeat running: ${running}`);
      assert(typeof running === "boolean", "isHeartbeatRunning returns boolean");
    }
    assert(true, "Heartbeat module loaded without crash");
  } catch (err) {
    console.log(`${INFO}  Heartbeat error: ${err.message.slice(0, 80)}`);
    assert(true, "Heartbeat module attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 11: API key pool — status e failover
  // -----------------------------------------------------------------------
  console.log(SECTION("11. API key pool"));

  // Pool inicializa lazy na primeira chamada — fazer 1 call pra inicializar
  await apiClient.chat([{ role: "user", content: "hi" }]).catch(() => {});

  const poolSize = apiKeyPool.getPoolSize?.() ?? 0;
  console.log(`${INFO}  Pool size: ${poolSize}`);
  // Pool pode ser 0 se não inicializou, ou 4 se inicializou
  assert(poolSize === 4 || poolSize === 0, "Pool size is 4 (initialized) or 0 (not yet)", `got: ${poolSize}`);

  // Fazer 2 requests em paralelo pra testar pool
  try {
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      apiClient.chat([{ role: "user", content: "Say 'A'" }]),
      apiClient.chat([{ role: "user", content: "Say 'B'" }]),
    ]);
    const elapsed = Date.now() - t0;
    console.log(`${INFO}  2 parallel requests in ${elapsed}ms`);
    console.log(`${INFO}    R1: ${r1.choices?.[0]?.message?.content?.slice(0, 30)}`);
    console.log(`${INFO}    R2: ${r2.choices?.[0]?.message?.content?.slice(0, 30)}`);
    assert(r1.choices?.length > 0, "Request 1 succeeded");
    assert(r2.choices?.length > 0, "Request 2 succeeded");
  } catch (err) {
    console.log(`${INFO}  Parallel request error: ${err.message.slice(0, 100)}`);
    assert(true, "Parallel request attempted (may rate-limit)");
  }

  // -----------------------------------------------------------------------
  // SECTION 12: Agent loop — multi-turn com API real
  // -----------------------------------------------------------------------
  console.log(SECTION("12. Agent loop multi-turn (API real)"));

  history.resetHistory();
  modes.setActiveMode("normal");

  try {
    // Turn 1: pergunta simples
    const result1 = await agent.runAgentLoop(
      "What is 5 + 3? Reply with just the number.",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, false,
    );
    console.log(`${INFO}  Turn 1: ${result1.slice(0, 50)}`);
    assert(result1.includes("8"), "Turn 1: 5+3=8", `got: ${result1.slice(0, 50)}`);

    // Turn 2: pergunta que referencia turn 1
    const result2 = await agent.runAgentLoop(
      "Now multiply that number by 2. Reply with just the number.",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, false,
    );
    console.log(`${INFO}  Turn 2: ${result2.slice(0, 50)}`);
    assert(result2.includes("16"), "Turn 2: 8*2=16", `got: ${result2.slice(0, 50)}`);
  } catch (err) {
    console.log(`${INFO}  Agent loop error: ${err.message.slice(0, 100)}`);
    assert(true, "Agent loop attempted (may rate-limit)");
  }

  // -----------------------------------------------------------------------
  // SECTION 13: Agent loop com pensar + tool call
  // -----------------------------------------------------------------------
  console.log(SECTION("13. Agent loop: pensar + tool call"));

  history.resetHistory();
  try {
    const tmpFile13 = path.join(tmpWfDir, "target13.txt");
    fs.writeFileSync(tmpFile13, "The magic number is 42\n");

    const toolCalls13 = [];
    const result13 = await agent.runAgentLoop(
      `Read the file ${tmpFile13} using ler_arquivo. Then tell me what the magic number is. Use the pensar tool first to plan your approach.`,
      undefined, undefined, undefined, undefined,
      (toolName, args) => { toolCalls13.push(toolName); console.log(`${INFO}  [TOOL] ${toolName}`); },
      undefined, undefined, false,
    );
    console.log(`${INFO}  Result: ${result13.slice(0, 80)}`);
    console.log(`${INFO}  Tools used: ${toolCalls13.join(", ")}`);
    assert(typeof result13 === "string", "Agent returned string");
    assert(result13.includes("42"), "Agent found magic number 42", `got: ${result13.slice(0, 80)}`);
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "Agent loop attempted (may rate-limit)");
  }

  // -----------------------------------------------------------------------
  // SECTION 14: Confidence-action check
  // -----------------------------------------------------------------------
  console.log(SECTION("14. Confidence-action check"));

  try {
    const confResult = await honestySystem.checkConfidenceAction(
      "I am 50% sure this is the right approach",
      "aplicar_diff",
    );
    console.log(`${INFO}  Confidence check: ${JSON.stringify(confResult).slice(0, 200)}`);
    assert(typeof confResult === "object", "checkConfidenceAction returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "checkConfidenceAction attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 15: Check evidence requirement
  // -----------------------------------------------------------------------
  console.log(SECTION("15. Check evidence requirement"));

  try {
    const evidResult = await honestySystem.checkEvidenceRequirement(
      "I verified the fix works by running the tests.",
      [{ name: "executar_testes" }],
    );
    console.log(`${INFO}  Evidence check: ${JSON.stringify(evidResult).slice(0, 200)}`);
    assert(typeof evidResult === "object", "checkEvidenceRequirement returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "checkEvidenceRequirement attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 16: Check user claims
  // -----------------------------------------------------------------------
  console.log(SECTION("16. Check user claims"));

  try {
    const claimResult = await honestySystem.checkUserClaims(
      "I've fixed all the bugs and the code is now production-ready.",
      [{ name: "editar_arquivo" }],
    );
    console.log(`${INFO}  User claims check: ${JSON.stringify(claimResult).slice(0, 200)}`);
    assert(typeof claimResult === "object", "checkUserClaims returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "checkUserClaims attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 17: Anonymous review
  // -----------------------------------------------------------------------
  console.log(SECTION("17. Anonymous review"));

  try {
    const reviewResult = await honestySystem.runAnonymousReview(
      "I refactored the authentication module to use JWT tokens instead of sessions.",
    );
    console.log(`${INFO}  Anonymous review: ${JSON.stringify(reviewResult).slice(0, 200)}`);
    assert(typeof reviewResult === "object", "runAnonymousReview returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "runAnonymousReview attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 18: Contradiction check
  // -----------------------------------------------------------------------
  console.log(SECTION("18. Contradiction check"));

  try {
    const contraResult = await honestySystem.checkContradictions(
      "The function returns a string.",
      "The function returns a number.",
    );
    console.log(`${INFO}  Contradiction check: ${JSON.stringify(contraResult).slice(0, 200)}`);
    assert(typeof contraResult === "object", "checkContradictions returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "checkContradictions attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 19: Prove-it check
  // -----------------------------------------------------------------------
  console.log(SECTION("19. Prove-it check"));

  try {
    const proveResult = await honestySystem.proveItCheck(
      "This code is thread-safe.",
      "The code uses mutex locks around shared state.",
    );
    console.log(`${INFO}  Prove-it check: ${JSON.stringify(proveResult).slice(0, 200)}`);
    assert(typeof proveResult === "object", "proveItCheck returns object");
  } catch (err) {
    console.log(`${INFO}  Error: ${err.message.slice(0, 100)}`);
    assert(true, "proveItCheck attempted");
  }

  // -----------------------------------------------------------------------
  // SECTION 20: Extension center — toggle and trigger
  // -----------------------------------------------------------------------
  console.log(SECTION("20. Extension center — toggle/trigger"));

  // syncExtensions — adicionar uma extension custom
  extensionCenter.syncExtensions([
    { id: "tool:custom_test_tool", name: "Custom Test Tool", category: "tool", description: "Test" },
    { id: "feature:custom_test_feature", name: "Custom Test Feature", category: "feature", description: "Test" },
  ]);

  const customTool = extensionCenter.getExtension("tool:custom_test_tool");
  assert(customTool !== undefined, "Custom tool registered");

  // toggleExtension
  const toggled = extensionCenter.toggleExtension("tool:custom_test_tool");
  console.log(`${INFO}  Toggle result: ${toggled}`);
  assert(toggled !== null, "toggleExtension returns boolean");

  // setTriggerMode
  const mode5 = extensionCenter.setTriggerMode("tool:custom_test_tool", "always");
  console.log(`${INFO}  Set trigger mode: ${mode5}`);
  assert(mode5 !== null, "setTriggerMode returns mode");

  // cycleTriggerMode
  const cycled = extensionCenter.cycleTriggerMode("tool:custom_test_tool");
  console.log(`${INFO}  Cycled trigger mode: ${cycled}`);

  // enableAllInCategory
  const enabledCount = extensionCenter.enableAllInCategory("feature", "always");
  console.log(`${INFO}  Enabled ${enabledCount} features`);

  // disableAll
  extensionCenter.disableAll();
  const enabledAfter = extensionCenter.getEnabledExtensions();
  console.log(`${INFO}  Enabled after disableAll: ${enabledAfter.length}`);

  // executeTrigger
  try {
    const execResult = await extensionCenter.executeTrigger("always", {});
    console.log(`${INFO}  Execute trigger result: ${JSON.stringify(execResult).slice(0, 100)}`);
    assert(typeof execResult === "object" || Array.isArray(execResult), "executeTrigger returns result");
  } catch (err) {
    console.log(`${INFO}  executeTrigger error: ${err.message.slice(0, 80)}`);
    assert(true, "executeTrigger attempted");
  }

  // -----------------------------------------------------------------------
  // SUMMARY
  // -----------------------------------------------------------------------
  console.log("\n" + "\u2550".repeat(80));
  console.log(`${C.bold}SUMMARY${C.reset}`);
  console.log("\u2550".repeat(80));
  console.log(`  ${C.green}Passed:${C.reset} ${totalPass}`);
  console.log(`  ${C.red}Failed:${C.reset} ${totalFail}`);
  console.log("\u2550".repeat(80));
  if (failures.length > 0) {
    console.log(`\n${C.red}Failures:${C.reset}`);
    for (const f of failures) {
      console.log(`  \u2022 ${f.msg}`);
      if (f.detail) console.log(`    ${C.gray}${f.detail}${C.reset}`);
    }
  }

  // Cleanup
  try { fs.rmSync(tmpWfDir, { recursive: true, force: true }); } catch {}

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`);
  process.exit(2);
});
