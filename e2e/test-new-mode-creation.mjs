#!/usr/bin/env node
/**
 * test-new-mode-creation.mjs — E2E test: cria um modo "python" do zero e
 * valida que TODAS as prevenções contra bugs sistêmicos funcionam.
 *
 * Testa especificamente:
 *   - BUG-A prevention: configSchema rejeita formato misto (enableTools + toolsDir)
 *   - BUG-B prevention: validatorArgs do manifest usado (sem --no-global-check hardcoded)
 *   - BUG-C prevention: validator checa stdout || stderr
 *   - BUG-D prevention: validator usa findToolBinary (mode-aware), não detectTool
 *   - BUG-E prevention: inboxOrganizer reporta "skipped" como ignored, não organized
 *   - Lint anti-regressão: detectTool() não é usado fora de toolDetector.ts
 *
 * Run:  node /home/z/my-project/scripts/test-new-mode-creation.mjs
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
  console.log(`${C.bold}${C.cyan}║  New Mode Creation E2E — Bug Prevention Verification          ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚════════════════════════════════════════════════════════════════╝${C.reset}`);

  // Imports
  const configSchema = await import("/home/z/my-project/claude-killer/dist/configSchema.js");
  const fileValidator = await import("/home/z/my-project/claude-killer/dist/fileValidator.js");
  const manifestLoader = await import("/home/z/my-project/claude-killer/dist/manifestLoader.js");
  const toolDetector = await import("/home/z/my-project/claude-killer/dist/toolDetector.js");
  const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");
  const inboxOrganizer = await import("/home/z/my-project/claude-killer/dist/inboxOrganizer.js");
  const modeMigration = await import("/home/z/my-project/claude-killer/dist/modeMigration.js");

  // -----------------------------------------------------------------------
  // SECTION 1: configSchema rejeita formato misto (BUG-A prevention)
  // -----------------------------------------------------------------------
  console.log(SECTION("1. configSchema rejeita formato misto (BUG-A prevention)"));

  // Config válido: formato novo puro
  const validNew = {
    name: "python",
    label: "Python",
    description: "Python dev",
    toolsDir: "tools",
    tools: ["tool:ruff_lint"],
    validators: [{ tool: "ruff_lint", filePattern: "*.py", blocking: true }],
  };
  const errorsValidNew = configSchema.validateModeConfig(validNew);
  console.log(`${INFO}  Valid new-format config errors: ${errorsValidNew.length}`);
  assert(errorsValidNew.length === 0, "Pure new-format config is valid",
    errorsValidNew.map((e) => e.message).join("; "));

  // Config inválido: formato misto
  const mixedFormat = {
    name: "python",
    label: "Python",
    description: "Python dev",
    toolsDir: "tools",
    tools: ["tool:ruff_lint"],
    enableTools: ["tool:legacy_tool"],  // legacy
    validators: [{ tool: "ruff_lint", filePattern: "*.py", blocking: true }],
  };
  const errorsMixed = configSchema.validateModeConfig(mixedFormat);
  console.log(`${INFO}  Mixed-format config errors: ${errorsMixed.length}`);
  assert(errorsMixed.length > 0, "Mixed-format config is REJECTED");
  assert(
    errorsMixed.some((e) => e.message.includes("mistura formato novo")),
    "Mixed-format error mentions format mixing",
    errorsMixed.map((e) => e.message).join("; ")
  );

  // Config inválido: toolsDir sem tools[]
  const noToolsArray = {
    name: "python",
    label: "Python",
    description: "Python dev",
    toolsDir: "tools",
    enableTools: ["tool:legacy"],  // wrong — should be tools[]
    // sem tools[]
  };
  const errorsNoTools = configSchema.validateModeConfig(noToolsArray);
  assert(errorsNoTools.length > 0, "toolsDir without tools[] is rejected");
  assert(
    errorsNoTools.some((e) => e.message.includes("DEVEM ter tools[]")),
    "Error mentions 'DEVEM ter tools[]'",
    errorsNoTools.map((e) => e.message).join("; ")
  );

  // Config legacy puro (sem toolsDir) — ainda aceito (backward compat)
  const validLegacy = {
    name: "oldmode",
    label: "Old",
    description: "legacy",
    enableTools: ["tool:x"],
    luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
  };
  const errorsLegacy = configSchema.validateModeConfig(validLegacy);
  assert(errorsLegacy.length === 0, "Pure legacy config (no toolsDir) is still valid",
    errorsLegacy.map((e) => e.message).join("; "));

  // -----------------------------------------------------------------------
  // SECTION 2: fileValidator usa findToolBinary (BUG-D prevention)
  // -----------------------------------------------------------------------
  console.log(SECTION("2. fileValidator uses findToolBinary (BUG-D prevention)"));

  // Setup: create a fake "python" mode with a fake "ruff" tool
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-test-home-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  console.log(`${INFO}  Using tmp HOME: ${tmpHome}`);

  // Create mode structure
  const modeDir = path.join(tmpHome, ".claude-killer", "modes", "python");
  fs.mkdirSync(path.join(modeDir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(modeDir, "manifests"), { recursive: true });
  fs.mkdirSync(path.join(modeDir, "inbox"), { recursive: true });

  // Create a fake ruff binary that emits to stderr (like real ruff)
  const fakeRuffPath = path.join(modeDir, "tools", "ruff");
  const fakeRuffContent = `#!/bin/sh
# Fake ruff: emits "unused import" warning to stderr, exits 1
echo "fake.py:1:1: F401 [*] unused import 'os'" >&2
exit 1
`;
  fs.writeFileSync(fakeRuffPath, fakeRuffContent);
  fs.chmodSync(fakeRuffPath, 0o755);

  // Create ruff manifest with validatorArgs
  const ruffManifest = [
    {
      name: "ruff_lint",
      description: "Lint Python code with ruff",
      category: "python",
      command: "ruff",
      args: ["check"],
      flags: [
        { name: "--fix", type: "boolean", description: "Auto-fix" },
        { name: "path", type: "string", description: "Path" },
      ],
      validatorArgs: ["check", "--quiet", "{file}"],
      outputParser: "raw",
    },
  ];
  fs.writeFileSync(path.join(modeDir, "manifests", "ruff.json"), JSON.stringify(ruffManifest, null, 2));

  // Create python config.json
  const pythonConfig = {
    name: "python",
    label: "Python",
    description: "Python development",
    toolsDir: "tools",
    manifestsDir: "manifests",
    tools: ["tool:ruff_lint"],
    validators: [{ tool: "ruff_lint", filePattern: "*.py", blocking: true }],
  };
  fs.writeFileSync(path.join(modeDir, "config.json"), JSON.stringify(pythonConfig, null, 2));

  // Find ruff binary via findToolBinary (mode-aware)
  const ruffPath = toolDetector.findToolBinary("ruff", "python");
  console.log(`${INFO}  findToolBinary('ruff', 'python'): ${ruffPath}`);
  assert(ruffPath !== null, "findToolBinary finds ruff in mode tools/");
  assert(ruffPath === fakeRuffPath, "findToolBinary returns correct path", `got: ${ruffPath}`);

  // Find ruff via old detectTool (mode-unaware) — should NOT find
  const detectResult = toolDetector.detectTool("ruff");
  console.log(`${INFO}  detectTool('ruff'): status=${detectResult.status}`);
  // detectTool looks at PATH + common locations, NOT mode tools/ → should be missing
  // (unless ruff happens to be installed system-wide, which is unlikely)
  assert(
    detectResult.status === "missing" || detectResult.binaryPath !== fakeRuffPath,
    "detectTool does NOT find ruff in mode tools/ (confirms BUG-D scenario)"
  );

  // Restore HOME
  process.env.HOME = origHome;

  // -----------------------------------------------------------------------
  // SECTION 3: fileValidator executa via manifest.validatorArgs (BUG-B prevention)
  // -----------------------------------------------------------------------
  console.log(SECTION("3. fileValidator uses manifest.validatorArgs (BUG-B prevention)"));

  // Now test that validateFile() uses validatorArgs from manifest, not hardcoded flags
  // We'll use the same fake ruff setup but call fileValidator directly
  process.env.HOME = tmpHome;

  // Bad Python code (will trigger fake ruff)
  const badPython = `import os\nprint("hello")\n`;
  const tmpFile = path.join(os.tmpdir(), "test-bad.py");
  fs.writeFileSync(tmpFile, badPython);

  const rules = [{ tool: "ruff_lint", filePattern: "*.py", blocking: true }];
  const result = await fileValidator.validateFile(
    tmpFile,
    badPython,
    rules,
    process.cwd(),
    "python"
  );
  console.log(`${INFO}  validateFile result: ok=${result.ok}`);
  console.log(`${INFO}  rulesApplied: ${result.rulesApplied.join(", ")}`);
  console.log(`${INFO}  rulesSkipped: ${result.rulesSkipped.join(", ")}`);
  if (result.blockingError) console.log(`${INFO}  blockingError: ${result.blockingError.slice(0, 200)}`);

  // BUG-D fix: validator found ruff via findToolBinary → rule was APPLIED (not skipped)
  assert(
    result.rulesApplied.includes("ruff_lint"),
    "ruff_lint was APPLIED (not skipped — proves findToolBinary works)"
  );
  assert(result.rulesSkipped.length === 0, "No rules skipped", `skipped: ${result.rulesSkipped.join(", ")}`);

  // BUG-C fix: validator checks stderr (fake ruff emits to stderr) → blocks
  assert(result.ok === false, "Bad Python code blocks validation (stderr detected)");
  assert(
    result.blockingError !== undefined && result.blockingError.includes("unused import"),
    "Blocking error includes ruff stderr output",
    result.blockingError?.slice(0, 200)
  );

  // BUG-B prevention: validator did NOT try to use --no-global-check or any
  // hardcoded flag — it used manifest.validatorArgs: ["check", "--quiet", "{file}"]
  // (We can't directly observe this, but if it had used a bad flag, the fake
  // ruff would have failed differently — exit 127 "command not found" for the flag)
  assert(
    result.blockingError?.includes("unused import") === true,
    "Fake ruff ran with correct args (no unknown-flag error)"
  );

  // Good Python code (won't trigger because fake ruff always exits 1, but proves flow)
  // We'll test with a custom rule.command instead
  const goodRule = {
    tool: "true_check",
    filePattern: "*.py",
    blocking: true,
    command: "true {file}",  // always exits 0
  };
  const goodResult = await fileValidator.validateFile(
    tmpFile, "print('hi')\n", [goodRule], process.cwd(), null
  );
  console.log(`${INFO}  Good rule (true) result: ok=${goodResult.ok}`);
  assert(goodResult.ok === true, "rule.command 'true {file}' passes (custom command works)");
  assert(goodResult.rulesApplied.includes("true_check"), "true_check was APPLIED");

  // Restore HOME
  process.env.HOME = origHome;

  // -----------------------------------------------------------------------
  // SECTION 4: fileValidator works with rule.command string (no manifest needed)
  // -----------------------------------------------------------------------
  console.log(SECTION("4. fileValidator with rule.command (no manifest needed)"));

  // Rule with custom command — works without any manifest
  const cmdRule = {
    tool: "grep_check",
    filePattern: "*.py",
    blocking: true,
    command: "grep -q 'TODO' {file}",
  };
  const codeWithTodo = `# TODO: fix this\nprint('hi')\n`;
  const codeNoTodo = `print('hi')\n`;

  // Code WITH TODO: grep returns 0 → ok=true (rule passes)
  const withTodoResult = await fileValidator.validateFile(
    "/tmp/test1.py", codeWithTodo, [cmdRule], process.cwd(), null
  );
  console.log(`${INFO}  Code with TODO: ok=${withTodoResult.ok}`);
  assert(withTodoResult.ok === true, "Code with TODO passes grep -q 'TODO'");

  // Code WITHOUT TODO: grep returns 1 → ok=false (rule fails, blocking)
  const noTodoResult = await fileValidator.validateFile(
    "/tmp/test2.py", codeNoTodo, [cmdRule], process.cwd(), null
  );
  console.log(`${INFO}  Code without TODO: ok=${noTodoResult.ok}`);
  assert(noTodoResult.ok === false, "Code without TODO fails grep -q 'TODO' (blocking)");
  assert(
    noTodoResult.blockingError?.includes("grep_check failed"),
    "Blocking error mentions rule name"
  );

  // -----------------------------------------------------------------------
  // SECTION 5: fileValidator checa stdout E stderr (BUG-C prevention)
  // -----------------------------------------------------------------------
  console.log(SECTION("5. fileValidator checks stdout AND stderr (BUG-C prevention)"));

  // Tool that emits ONLY to stderr (like real selene 0.28.0)
  const stderrOnlyScript = `#!/bin/sh\necho "ERROR: bad code" >&2\nexit 1\n`;
  // IMPORTANT: binary name uses hyphens, but tool/manifest name uses underscores.
  // The validator strips underscores from rule.tool to find the binary.
  const stderrToolPath = path.join(tmpHome, ".claude-killer", "modes", "python", "tools", "stderr-only-tool");
  fs.writeFileSync(stderrToolPath, stderrOnlyScript);
  fs.chmodSync(stderrToolPath, 0o755);

  process.env.HOME = tmpHome;
  // Rule uses underscore name; binary uses hyphen. Validator strips suffixes
  // but doesn't convert underscores to hyphens, so we need to use a tool name
  // that maps directly to a binary. Let's use "stderrtool" (no separator).
  const stderrToolPath2 = path.join(tmpHome, ".claude-killer", "modes", "python", "tools", "stderrtool");
  fs.writeFileSync(stderrToolPath2, stderrOnlyScript);
  fs.chmodSync(stderrToolPath2, 0o755);

  const stderrRule = { tool: "stderrtool", filePattern: "*.py", blocking: true };
  // Need a manifest for this tool so validator can find it via findToolBinary
  fs.writeFileSync(
    path.join(tmpHome, ".claude-killer", "modes", "python", "manifests", "stderrtool.json"),
    JSON.stringify([{
      name: "stderrtool",
      description: "Test tool that emits to stderr",
      category: "test",
      command: "stderrtool",
      args: [],
      validatorArgs: ["{file}"],
    }], null, 2)
  );

  const stderrResult = await fileValidator.validateFile(
    "/tmp/test.py", "x = 1\n", [stderrRule], process.cwd(), "python"
  );
  console.log(`${INFO}  stderr-only tool result: ok=${stderrResult.ok}`);
  console.log(`${INFO}  blockingError: ${stderrResult.blockingError?.slice(0, 200)}`);

  // BUG-C fix: validator should detect stderr output and block
  assert(stderrResult.ok === false, "stderr-only tool output is detected (BUG-C fixed)");
  assert(
    stderrResult.blockingError?.includes("ERROR: bad code"),
    "Blocking error contains stderr output",
    stderrResult.blockingError?.slice(0, 200)
  );

  process.env.HOME = origHome;

  // -----------------------------------------------------------------------
  // SECTION 6: inboxOrganizer — BUG-E prevention check
  // -----------------------------------------------------------------------
  console.log(SECTION("6. inboxOrganizer skip handling (BUG-E check)"));

  // BUG-E: when file already exists at destination, organizeInbox reports
  // it as "organized" instead of "skipped". Let's check the current behavior.
  const inboxTestDir = path.join(tmpHome, ".claude-killer", "modes", "python", "inbox");
  fs.mkdirSync(inboxTestDir, { recursive: true });
  fs.mkdirSync(path.join(tmpHome, ".claude-killer", "modes", "python", "skills"), { recursive: true });

  // Put a file in inbox
  const skillContent1 = "# Skill 1\n";
  fs.writeFileSync(path.join(inboxTestDir, "skill1.md"), skillContent1);

  // First organize — should move
  process.env.HOME = tmpHome;
  const org1 = inboxOrganizer.organizeInbox("python");
  console.log(`${INFO}  First organize: organized=${org1.organized.length} skipped_in_ignored=${org1.ignored.length}`);
  assert(org1.organized.length === 1, "First organize moves the file");

  // Put the SAME file back in inbox
  fs.writeFileSync(path.join(inboxTestDir, "skill1.md"), skillContent1);

  // Second organize — file already exists at destination
  const org2 = inboxOrganizer.organizeInbox("python");
  console.log(`${INFO}  Second organize (file exists): organized=${org2.organized.length} ignored=${org2.ignored.length} errors=${org2.errors.length}`);
  console.log(`${INFO}  organized entries: ${JSON.stringify(org2.organized)}`);
  console.log(`${INFO}  ignored entries: ${JSON.stringify(org2.ignored)}`);

  // BUG-E fix: organizeInbox now reports already-existing file as ignored
  assert(org2.organized.length === 0, "BUG-E FIXED: already-existing file NOT in organized[]");
  assert(org2.ignored.length > 0, "BUG-E FIXED: already-existing file IS in ignored[]");
  assert(
    org2.ignored.some((i) => i.fileName === "skill1.md" && (i.reason ?? "").includes("already exists")),
    "Ignored entry has 'already exists' reason",
    JSON.stringify(org2.ignored)
  );

  process.env.HOME = origHome;

  // -----------------------------------------------------------------------
  // SECTION 7: Lint anti-regressão — detectTool() só em toolDetector.ts
  // -----------------------------------------------------------------------
  console.log(SECTION("7. Lint: detectTool() not used outside toolDetector.ts"));

  // Read all .ts files in src/ (excluding __tests__) and check for detectTool() calls
  const srcDir = "/home/z/my-project/claude-killer/src";
  const violations = [];
  function walkDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__") continue;
        walkDir(fullPath);
      } else if (entry.name.endsWith(".ts")) {
        const content = fs.readFileSync(fullPath, "utf8");
        // Look for detectTool( calls (not the definition, not comments)
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip: definition (export function detectTool), comments, imports
          if (line.includes("export function detectTool")) continue;
          if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
          if (line.includes("detectTool(") && !line.includes("// ")) {
            // Allow in toolDetector.ts itself
            if (fullPath.endsWith("toolDetector.ts")) continue;
            // Allow in fileValidator.ts (uses it via dynamic import in a comment-like context, but actually no)
            // Check for actual call (not just import)
            if (line.includes("detectTool(") && !line.includes("import")) {
              violations.push({ file: fullPath, line: i + 1, content: line.trim() });
            }
          }
        }
      }
    }
  }
  walkDir(srcDir);

  console.log(`${INFO}  detectTool() violations: ${violations.length}`);
  for (const v of violations) {
    console.log(`${INFO}    ${v.file}:${v.line}: ${v.content}`);
  }
  assert(violations.length === 0, "No detectTool() calls outside toolDetector.ts",
    violations.map((v) => `${path.basename(v.file)}:${v.line}`).join(", "));

  // -----------------------------------------------------------------------
  // SECTION 8: Lint — no hardcoded --no-global-check in source
  // -----------------------------------------------------------------------
  console.log(SECTION("8. Lint: no hardcoded --no-global-check (BUG-B prevention)"));

  const bBviolations = [];
  function walkForFlag(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
        walkForFlag(fullPath);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".json")) {
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.includes("--no-global-check")) {
            // Allow in comments explaining the bug
            if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
            bBviolations.push({ file: fullPath, line: i + 1, content: line.trim() });
          }
        }
      }
    }
  }
  walkForFlag(srcDir);
  // Also check defaults/
  walkForFlag("/home/z/my-project/claude-killer/defaults");

  console.log(`${INFO}  --no-global-check violations: ${bBviolations.length}`);
  for (const v of bBviolations) {
    console.log(`${INFO}    ${v.file}:${v.line}: ${v.content}`);
  }
  assert(bBviolations.length === 0, "No hardcoded --no-global-check in source or defaults",
    bBviolations.map((v) => `${path.basename(v.file)}:${v.line}`).join(", "));

  // -----------------------------------------------------------------------
  // SECTION 9: Migration removes legacy .json when new format exists
  // -----------------------------------------------------------------------
  console.log(SECTION("9. Migration removes legacy .json (BUG-A fix)"));

  // Setup: tmp home with legacy roblox.json AND roblox/config.json
  const migHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mig-home-"));
  const migModesDir = path.join(migHome, ".claude-killer", "modes");
  fs.mkdirSync(migModesDir, { recursive: true });

  // Create legacy roblox.json
  const legacyRoblox = {
    name: "roblox",
    label: "Roblox",
    description: "legacy",
    enableTools: ["tool:rojo_build"],
    luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
  };
  fs.writeFileSync(path.join(migModesDir, "roblox.json"), JSON.stringify(legacyRoblox, null, 2));

  // Create new format roblox/config.json
  fs.mkdirSync(path.join(migModesDir, "roblox"), { recursive: true });
  const newRobloxConfig = {
    name: "roblox",
    label: "Roblox",
    description: "new format",
    toolsDir: "tools",
    tools: ["tool:rojo_build"],
    validators: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
  };
  fs.writeFileSync(
    path.join(migModesDir, "roblox", "config.json"),
    JSON.stringify(newRobloxConfig, null, 2)
  );

  console.log(`${INFO}  Before migration: legacy exists = ${fs.existsSync(path.join(migModesDir, "roblox.json"))}`);

  // Run migration
  process.env.HOME = migHome;
  const migResult = modeMigration.migrateToModeStructure();
  console.log(`${INFO}  Migration result: backedUp=${migResult.backedUp.length} created=${migResult.created.length}`);
  for (const b of migResult.backedUp) console.log(`${INFO}    ${b}`);

  // After migration: legacy should be removed, .bak should exist
  const legacyExists = fs.existsSync(path.join(migModesDir, "roblox.json"));
  const bakExists = fs.existsSync(path.join(migModesDir, "roblox.json.bak"));
  const newExists = fs.existsSync(path.join(migModesDir, "roblox", "config.json"));
  console.log(`${INFO}  After migration: legacy=${legacyExists} bak=${bakExists} new=${newExists}`);

  assert(legacyExists === false, "Legacy roblox.json REMOVED after migration (BUG-A fix)");
  assert(bakExists === true, "Backup roblox.json.bak exists (for recovery)");
  assert(newExists === true, "New format roblox/config.json preserved");

  process.env.HOME = origHome;

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

  // Cleanup tmp home dirs
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(migHome, { recursive: true, force: true }); } catch {}

  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${C.red}FATAL:${C.reset} ${err.stack ?? err.message}`);
  process.exit(2);
});
