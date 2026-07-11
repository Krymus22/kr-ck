#!/usr/bin/env node
/**
 * v17: SURGICAL PATCHER v2 — Flexible signature + SEARCH/REPLACE fallback
 *
 * FIXES over v16:
 *   1. Flexible signature check: compare only the function NAME (last segment
 *      after `.` or `:`), not the full prefix. So `PlayerDataManager:loadPlayer`
 *      matches `local function loadPlayer` — both have name `loadPlayer`.
 *   2. SEARCH/REPLACE fallback: if function extraction fails (module-level bug),
 *      ask LLM for a SEARCH block (exact buggy code) + REPLACE block. Find &
 *      replace in code. Validate with Selene.
 *   3. Better function detection: also match `Foo.bar = function(` and
 *      `Foo:method = function(` assignment style.
 *   4. Fewer rounds (MAX_CODE_ROUNDS=6) to fit timeout.
 *   5. Token-accurate tracking.
 */
/**
 * v16: SURGICAL FUNCTION-SCOPED PATCHER + STRICT GATE
 *
 * PROBLEM in v14/v15:
 *   - callLLMPatcher rewrites the WHOLE code → introduces NEW bugs
 *   - applyPatches uses line numbers that drift after splice
 *   - validateSyntax is weak (just if/end count)
 *   - Final gate accepts "best" code even with bugs
 *
 * SOLUTION in v16:
 *   1. Function-scoped patching: for each bug, extract ONLY the containing
 *      function, send to LLM with the bug, get back JUST the fixed function.
 *      Replace the function in the original code (find by name + signature).
 *      → LLM only sees one function, can't mess up the rest.
 *   2. Per-patch Selene validation: after each patch, run Selene.
 *      If NEW warnings (not in original) → REVERT that single patch.
 *   3. Patch reviewer: a separate agent verifies each patch actually fixes
 *      the bug and introduces no new bugs. Bad patches → REVERT.
 *   4. SEARCH/REPLACE fallback: if function extraction fails, ask LLM for
 *      a SEARCH block (exact buggy code) + REPLACE block. Find & replace.
 *   5. Strict gate: don't accept code with bugs. If MAX_CODE_ROUNDS
 *      exhausted with bugs > 0 → declare FAILURE explicitly.
 *   6. Selene strict comparison: count warnings BEFORE and AFTER patch.
 *      Patch must NOT increase warning count.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OpenAI = require("/home/z/my-project/claude-killer/node_modules/openai").default;
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const envContent = readFileSync("/home/z/my-project/claude-killer/.env", "utf8");
const keysMatch = envContent.match(/^NVIDIA_API_KEYS=(.+)$/m);
const allKeys = keysMatch[1].split(",").filter(k => k.startsWith("nvapi-"));
let keyIndex = 0;
function getClient() { const k = allKeys[keyIndex++ % allKeys.length]; return new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey: k }); }

const MODEL = "google/diffusiongemma-26b-a4b-it";
const MAX_LOGIC_ROUNDS = 5;
const MAX_CODE_ROUNDS = 6;
const GEN_TEMP = 0.4;
const REVIEW_TEMP = 0.15;
const PATCH_TEMP = 0.1;
const SELENE_PATH = "/tmp/selene";

const REVIEW_TOOLS = [
  { type: "function", function: { name: "pensar", description: "MANDATORY before verdict. categoria='debugging'.", parameters: { type: "object", properties: { categoria: { type: "string", enum: ["debugging","architecture","general","pre_response"] }, pensamento: { type: "string" } }, required: ["categoria","pensamento"] } }},
  { type: "function", function: { name: "buscar_web", description: "Verify Roblox APIs.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }},
];
const GEN_TOOLS = [
  { type: "function", function: { name: "pensar", description: "Call BEFORE writing.", parameters: { type: "object", properties: { categoria: { type: "string", enum: ["planning","pre_edit","pre_research","debugging","architecture"] }, pensamento: { type: "string" } }, required: ["categoria","pensamento"] } }},
  { type: "function", function: { name: "buscar_web", description: "Verify APIs.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }},
];

// ═══ PHASE 1 ═════════════════════════════════════════════════════════════
const LOGIC_DESIGNER = `You are a SYSTEM ARCHITECT. Design the LOGIC for a Roblox Luau module.
DO NOT write Lua code. Write the LOGIC FLOW in structured pseudocode.
Use pensar (categoria="architecture") to plan, then pensar (categoria="debugging") to trace.
FORMAT: FUNCTION <name>(<params>): STEP 1: ... RETURN: ...
Be SPECIFIC about DataStore methods, UpdateAsync callback, pcall, nil handling.
CRITICAL: NEVER GetAsync→SetAsync (race). ALWAYS UpdateAsync for read-modify-write. NEVER SetAsync. Check conditions INSIDE UpdateAsync callback.`;

const LOGIC_VERIFIER = `## HONESTY RULES
1. NEVER approve without TRACING with EACH test input.
2. If wrong, explain WHY and what CORRECT flow should be.
Verify: does logic produce CORRECT results for EACH test input?
Trace EACH input step by step. Use pensar (categoria="debugging").
If ALL correct: VERDICT: APROVADO. If any wrong: VERDICT: REJEITADO + ISSUES.`;

const API_DESIGN_REVIEWER = `## HONESTY RULES
1. NEVER approve without verifying API patterns.
Verify: does the logic use CORRECT Roblox APIs for each operation?
CHECKLIST:
1. GetAsync→SetAsync = RACE. Use UpdateAsync(key, function(oldData) return newData end).
2. SetAsync = WRONG. Always UpdateAsync.
3. Conditional write = UpdateAsync callback: if condition then return new else return old end.
4. Every DataStore call in pcall.
5. Validate loaded data structure.
6. Lock/claim = UpdateAsync atomically. Never GetAsync→check→SetAsync.
Use pensar (categoria="debugging"). Use buscar_web to verify.
If ALL correct: VERDICT: APROVADO. If any wrong: VERDICT: REJEITADO + ISSUES.`;

// ═══ PHASE 2 ═════════════════════════════════════════════════════════════
const HONESTY = `## HONESTY RULES
1. NEVER approve without verifying. Use buscar_web.
2. "I don't know" > fabrication.
3. If bug, provide corrected code in FIX.
## OUTPUT FORMAT
Call pensar FIRST (categoria="debugging"). Then:
TRACE: <trace with test input>
VERDICT: APROVADO | APROVADO COM RESSALVAS | REJEITADO
If REJEITADO: BUG [L<line>] or BUG [L<start>-L<end>]
PROBLEM: <1 sentence>
FIX: <VALID LUA CODE. NO instructions. JUST CODE.>
If APROVADO: no bugs. RESSALVAS: minor style only.`;

const LOGIC_DIFF_REVIEWER = `${HONESTY}
You are the LOGIC-TO-CODE DIFF REVIEWER. Compare the CODE against the VERIFIED LOGIC FLOW.

Check:
1. Does the code implement EVERY step from the logic flow?
2. Does the code ADD anything not in the logic flow? (extra flags, variables, branches)
3. Does the code OMIT anything from the logic flow?
4. Does each UpdateAsync callback match the logic's callback description?
5. Does the retry/loop logic match?

For EACH function, write:
FUNCTION <name>: MATCH | MISMATCH: <what's different>

If ALL match: VERDICT: APROVADO
If any mismatch: VERDICT: REJEITADO + BUG blocks for each mismatch

Call pensar (categoria="debugging").`;

const CODE_GEN_FROM_LOGIC = `You are a Lua/Luau programmer for Roblox.
You receive a VERIFIED LOGIC FLOW. Translate it into Lua/Luau code.

CRITICAL RULES:
- Call pensar (categoria="pre_edit") BEFORE writing code
- Translate the logic EXACTLY as specified
- Do NOT add flags, variables, or logic that is NOT in the flow
- Do NOT omit anything from the flow
- Do NOT "improve" or "optimize" — just translate
- ALL variables and helper functions must be "local"
- Function parameters CANNOT have default values in the signature
- If a function returns a table, return a COPY (not internal reference)
- Use UpdateAsync, NEVER SetAsync
- Use task.cancel(thread) NOT task:cancel(thread)
- Use Players:GetPlayerByUserId(id) NOT GetPlayerById(id)
- When logic says "UpdateAsync callback checks oldData", implement EXACTLY:
  dataStore:UpdateAsync(key, function(oldData)
    if <condition from logic> then return <newData> else return oldData end
  end)
- Output in a \`\`\`lua block (first line is code, NOT "lua")`;

const SYNTAX_CHECKER = `${HONESTY}
You are the SYNTAX CHECKER. Check ONLY syntax:
1. Function params CANNOT have default values.
2. String concat is "..".
3. Every if/for/while/function/do needs matching "end".
4. Variables AND functions must be "local". EXCEPTION: methods (function Table:method()) OK.
5. Luau supports "+=", "-=", "*=", "/=", "^" — all OK.
Call pensar (categoria="debugging").`;

const CORRECTNESS_REVIEWER = `${HONESTY}
You are the CORRECTNESS REVIEWER. Check:
1. Correct result — trace with test input
2. Edge cases: 0, nil, negative, empty, max
3. Off-by-one, undefined variables, logic errors
4. REFERENCE LEAKS: return COPY, not internal reference
5. REQUIREMENTS CHECK: verify EACH requirement from TASK is implemented
Call pensar (categoria="debugging"). Do NOT check APIs or syntax.`;

const API_VERIFIER = `${HONESTY}
You are the API VERIFIER. Check: do APIs exist? Used correctly?
KNOWN FACTS: typeof() returns LOWERCASE. IsA("ClassName") RECOMMENDED. UpdateAsync callback MUST return value. pcall returns (success, result). task.wait/spawn/cancel exist. task.cancel(thread) NOT task:cancel. GetService correct. GenerateGuid returns UUID. math.min/max/pow/floor exist. "^" works in Luau. GetPlayerByUserId NOT GetPlayerById. GetPlayers() returns array. pairs/ipairs/type/setmetatable exist. player.UserId/Name/IsA correct.
Use buscar_web to verify any NOT listed. Do NOT check logic or syntax.`;

const EDGE_CASE_REVIEWER = `${HONESTY}
You are the EDGE CASE HUNTER. Check: nil inputs, BindToClose timeout (30s), race conditions, retry exhaustion, memory leaks.
Call pensar (categoria="debugging"). Do NOT check APIs or syntax.`;

const DEVILS_ADVOCATE = `${HONESTY}
You are the DEVIL'S ADVOCATE. Find what others MISSED.

IMPORTANT: Only report a bug if you can provide a SPECIFIC FIX (corrected code).
If you CANNOT provide a fix, it's a SUGGESTION, not a bug → APROVADO COM RESSALVAS.

1. What input would CRASH this code? (provide the fix)
2. What if caller MODIFIES return value? (provide the fix)
3. What if DataStore returns CORRUPTED data? (provide the fix)
4. Any variable that should be "local" but isn't? (provide the fix)
5. Any function returning a reference instead of a copy? (provide the fix)
6. Does any function do GetAsync then SetAsync? (provide the fix)

If a function DELEGATES to another function (e.g., saveAll calls savePlayer),
the delegated function's behavior is NOT a bug in the caller.
Only flag bugs in the CALLING function's own logic.

Call pensar (categoria="debugging"). Try hard to break it.`;

// ═══ v16: SURGICAL PATCHER ═══════════════════════════════════════════════
const SURGICAL_PATCHER = `You are a SURGICAL CODE PATCHER for Roblox Luau.

You receive:
- ONE buggy function (the function containing the bug)
- ONE bug description (what's wrong, what the fix should do)

Your job:
- Return the FIXED function — the ENTIRE function, with the bug fixed
- Do NOT touch any code OUTSIDE this function
- Do NOT add new variables, flags, or branches not needed for the fix
- Do NOT remove anything unrelated to the bug
- Keep the SAME function signature (name, params)
- Keep the SAME indentation style
- Use UpdateAsync, NEVER SetAsync
- ALL variables must be "local"

Output ONLY the fixed function in a \`\`\`lua block.
First line of the block must be the function signature (function ... or local function ...).
Last line must be the matching "end".`;

const PATCH_REVIEWER = `${HONESTY}
You are the PATCH REVIEWER. Compare the ORIGINAL buggy function against the PATCHED function.

Check:
1. Does the patch ACTUALLY FIX the described bug?
2. Does the patch INTRODUCE any new bug? (off-by-one, nil, race, reference leak)
3. Does the patch ADD anything unrelated? (extra flags, branches, variables)
4. Does the patch REMOVE anything unrelated to the bug?
5. Is the function signature UNCHANGED?
6. Are ALL variables still "local"?

If patch is GOOD (fixes bug, no new issues): VERDICT: APROVADO
If patch is BAD (doesn't fix, or introduces new bugs): VERDICT: REJEITADO + explain

Call pensar (categoria="debugging").`;

// ─── Helpers ─────────────────────────────────────────────────────────────
async function executeWebSearch(q){try{const r=execSync(`z-ai function -n web_search -a '${JSON.stringify({query:q,num:3})}'`,{encoding:"utf8",timeout:30000});const s=r.indexOf("["),e=r.lastIndexOf("]");if(s>=0&&e>s)return JSON.parse(r.slice(s,e+1)).map((r,i)=>`${i+1}. ${r.name}\n   ${r.snippet}`).join("\n\n");return"Nenhum.";}catch{return"[Error]";}}
function runSelene(code){try{const f=`/tmp/debate-${Date.now()}.luau`;writeFileSync(f,code);const r=execSync(`${SELENE_PATH} ${f} 2>&1 || true`,{encoding:"utf8",timeout:10000});unlinkSync(f);const w=[];for(const l of r.split("\n")){const m=l.match(/:\s*(\d+):\s*(\d+):\s*(\w+):\s*(.+)/);if(m)w.push({line:+m[1],type:m[3],msg:m[4].trim()});}return{warnings:w};}catch{return{warnings:[]};}}

async function callAgent(sys,msg,tools,maxTools,temp){const start=Date.now();const messages=[{role:"system",content:sys},{role:"user",content:msg}];let tc=0,tk=0;async function retry(p,m=5){for(let i=0;i<m;i++){try{return await getClient().chat.completions.create(p);}catch(e){if((e.status===429||e.status===503)&&i<m-1){await new Promise(r=>setTimeout(r,(i+1)*5000));continue;}throw e;}}}const base={model:MODEL,chat_template_kwargs:{thinking_mode:"enabled"},max_tokens:16384,temperature:temp,stream:false};while(tc<maxTools){const r=await retry({...base,messages,tools,tool_choice:"auto"});tk+=r.usage?.completion_tokens||0;const m=r.choices[0]?.message;if(m.tool_calls?.length){for(const t of m.tool_calls){tc++;const a=JSON.parse(t.function.arguments);if(t.function.name==="pensar"){console.log(`    💭 [${a.categoria}] ${a.pensamento?.slice(0,100)}...`);messages.push({role:"assistant",content:m.content||"(tool)",tool_calls:m.tool_calls});messages.push({role:"tool",tool_call_id:t.id,content:"OK. Continue."});}else if(t.function.name==="buscar_web"){console.log(`    🔍 "${a.query?.slice(0,70)}"`);const s=await executeWebSearch(a.query);messages.push({role:"assistant",content:m.content||"(tool)",tool_calls:m.tool_calls});messages.push({role:"tool",tool_call_id:t.id,content:s});}}continue;}return{content:m.content||"",elapsed:Date.now()-start,tokens:tk,toolCallsMade:tc};}messages.push({role:"user",content:"Veredito final agora."});const fr=await retry({...base,messages,tools:undefined,tool_choice:"none"});tk+=fr.usage?.completion_tokens||0;return{content:fr.choices[0]?.message?.content||"",elapsed:Date.now()-start,tokens:tk,toolCallsMade:tc};}

function extractCode(c){const m=c.match(/```(?:lua|luau)?\n([\s\S]*?)```/);if(m){let c=m[1].trim();const fl=c.split("\n")[0].trim().toLowerCase();if(fl==="lua"||fl==="luau")c=c.split("\n").slice(1).join("\n").trim();return c;}return c.trim();}
function parseReview(content){const bugs=[];const upper=content.toUpperCase();const re=/BUG\s*\[L(\d+)(?:\s*-\s*L(\d+))?\]\s*\n\s*PROBLEM:\s*(.+?)\n\s*FIX:\s*([\s\S]*?)(?=\n\s*BUG\s*\[L|\n\s*VERDICT|\n\s*APROVADO|\n\s*REJEITADO|$)/gi;let m;
while((m=re.exec(content))!==null){
  const fix=m[4].trim();
  const fixClean=cleanFix(fix);
  if(fixClean&&isCleanCode(fixClean)){
    bugs.push({line:+m[1],endLine:m[2]?+m[2]:null,problem:m[3].trim(),fix:fixClean});
  }
}
let verdict="RESSALVAS";
if(upper.includes("VERDICT: APROVADO"))verdict=upper.includes("RESSALVAS")?"RESSALVAS":"APROVADO";
else if(upper.includes("REJEITADO")&&bugs.length>0)verdict="REJEITADO";
else if(bugs.length>0)verdict="REJEITADO";
return{verdict,bugs};}
function parseLogicVerdict(content){const upper=content.toUpperCase();if(upper.includes("VERDICT: APROVADO")||upper.includes("VERDICT:APROVADO"))return{approved:true,issues:""};const issuesMatch=content.match(/ISSUES:\s*([\s\S]*?)(?=$)/i);return{approved:false,issues:issuesMatch?issuesMatch[1].trim():content};}
function cleanFix(fix){let f=fix;const fm=f.match(/```(?:lua|luau)?\n([\s\S]*?)```/);if(fm)f=fm[1].trim();return f.split("\n").filter(l=>{const t=l.trim();if(!t)return false;if(/^(Remov|Remove|Delete|SUGEST|SUGGES|TODO|Reestruturar|Mover|\(.*\))/i.test(t))return false;if(t.startsWith("```"))return false;return true;}).join("\n");}
function isCleanCode(fix){const lines=fix.split("\n");for(const l of lines){const t=l.trim();if(!t)continue;if(/^(Remov|Remove|Delete|SUGEST|SUGGES|TODO|Reestruturar|Mover|\(.*\))/i.test(t))return false;if(t.startsWith("```"))return false;}return true;}

// ─── v16: FUNCTION EXTRACTION & SURGICAL PATCH ───────────────────────────

/**
 * Find the FUNCTION block containing the given line.
 * Returns { name, startLine, endLine, body } where startLine/endLine are
 * 1-indexed and body is the full function text (function ... end).
 *
 * Strategy: scan from the given line UPWARDS to find the function signature,
 * then scan DOWNWARDS balancing `function/do/for/while/if` against `end`.
 */
function extractFunction(code, targetLine) {
  const lines = code.split("\n");
  if (targetLine < 1 || targetLine > lines.length) return null;

  // 1. Walk UP from targetLine to find the function signature.
  //    Match:
  //      (local\s+)?function\s+NAME(\s*\()
  //      NAME(\.\w+|:\w+)\s*=\s*function\s*\(
  let sigLine = -1;
  let funcName = null;
  for (let i = targetLine - 1; i >= 0; i--) {
    const l = lines[i];
    // Style 1: (local )function Foo.bar( or Foo:bar(
    const m1 = l.match(/^\s*(local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/);
    if (m1) {
      sigLine = i;
      funcName = m1[2];
      break;
    }
    // Style 2: Foo.bar = function( or Foo:bar = function(
    const m2 = l.match(/^\s*([A-Za-z_][\w.:]*)\s*=\s*function\s*\(/);
    if (m2) {
      sigLine = i;
      funcName = m2[1];
      break;
    }
  }
  if (sigLine === -1) return null;

  // 2. Walk DOWN from sigLine, balancing open/close keywords.
  //    Openers: function, do, for, while, if (when followed by then), else
  //    Closers: end
  //    We need to be careful: "function" in a function call (e.g. UpdateAsync(key, function(x) ... end))
  //    ALSO counts as an opener. So just count "function" + "do" + "for" + "while" + "if ... then".
  let depth = 0;
  let endLine = -1;
  for (let i = sigLine; i < lines.length; i++) {
    const l = lines[i];
    // Count openers (word boundary, not inside strings — approximate)
    const openers = (l.match(/\bfunction\b/g) || []).length
                  + (l.match(/\bdo\b/g) || []).length
                  + (l.match(/\bfor\b/g) || []).length
                  + (l.match(/\bwhile\b/g) || []).length
                  + (l.match(/\bif\b.*\bthen\b/g) || []).length
                  + (l.match(/\belseif\b.*\bthen\b/g) || []).length;
    // Count "else" as a soft opener (needs its own end via the outer if)
    // Actually in Lua, if/elseif/else all share ONE end. So don't count else.
    const closers = (l.match(/\bend\b/g) || []).length;
    depth += openers - closers;
    if (depth === 0) {
      endLine = i;
      break;
    }
  }
  if (endLine === -1) return null;

  return {
    name: funcName,
    startLine: sigLine + 1, // 1-indexed
    endLine: endLine + 1,
    body: lines.slice(sigLine, endLine + 1).join("\n"),
  };
}

/**
 * Replace the function in `code` whose signature line is at `startLine` (1-indexed)
 * with `newFuncBody`. Returns the new code.
 */
function replaceFunction(code, startLine, endLine, newFuncBody) {
  const lines = code.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine); // endLine is 1-indexed inclusive, so slice from endLine
  return [...before, ...newFuncBody.split("\n"), ...after].join("\n");
}

/**
 * Validate a patch: run Selene on the new code, compare warnings to old code.
 * Returns { ok, newWarnings }.
 *  - ok = true if newCode has FEWER or EQUAL warnings (no NEW ones introduced)
 *  - newWarnings = list of warning messages that didn't exist in oldCode
 */
function validatePatch(oldCode, newCode) {
  const oldSel = runSelene(oldCode);
  const newSel = runSelene(newCode);
  const oldMsgs = new Set(oldSel.warnings.map(w => `${w.type}:${w.msg}`));
  const newWarnings = newSel.warnings.filter(w => !oldMsgs.has(`${w.type}:${w.msg}`));
  return { ok: newWarnings.length === 0, newWarnings, oldCount: oldSel.warnings.length, newCount: newSel.warnings.length };
}

/**
 * SURGICAL PATCH: for a single bug, extract the containing function, ask
 * SURGICAL_PATCHER for the fixed function, replace it, validate with Selene,
 * and verify with PATCH_REVIEWER.
 *
 * Returns { ok, newCode, reason } — if ok=false, newCode=originalCode.
 */
async function surgicalPatch(code, bug, totalTokens, totalTime) {
  // 1. Extract the containing function
  const fn = extractFunction(code, bug.line);
  if (!fn) {
    // FALLBACK: SEARCH/REPLACE for module-level bugs
    console.log(`│      📍 No function — trying SEARCH/REPLACE`);
    return await searchReplacePatch(code, bug);
  }
  console.log(`│      📍 Function ${fn.name} (L${fn.startLine}-${fn.endLine})`);

  // 2. Ask SURGICAL_PATCHER for the fixed function
  const patchMsg = `BUG to fix:
PROBLEM: ${bug.problem}

ORIGINAL FUNCTION (L${fn.startLine}-${fn.endLine}):
\`\`\`lua
${fn.body}
\`\`\`

Return the FIXED function. Output ONLY the function in a \`\`\`lua block.`;
  const patchResult = await callAgent(SURGICAL_PATCHER, patchMsg, GEN_TOOLS, 2, PATCH_TEMP);
  const fixedFunc = extractCode(patchResult.content);
  if (!fixedFunc || fixedFunc.length < 10) {
    console.log(`│      ⚠️ Patcher returned empty/invalid`);
    return { ok: false, newCode: code, reason: "empty-patch", tokens: patchResult.tokens, time: patchResult.elapsed };
  }

  // 3. Verify signature matches — by FUNCTION NAME (last segment after `.` or `:`)
  const origSig = fn.body.split("\n")[0].trim();
  const newSig = fixedFunc.split("\n")[0].trim();
  const origFull = origSig.match(/function\s+([A-Za-z_][\w.:]*)/)?.[1]
                 || origSig.match(/([A-Za-z_][\w.:]*)\s*=\s*function/)?.[1]
                 || "";
  const newFull = newSig.match(/function\s+([A-Za-z_][\w.:]*)/)?.[1]
                || newSig.match(/([A-Za-z_][\w.:]*)\s*=\s*function/)?.[1]
                || "";
  // Take the last segment after `.` or `:` only — `Foo:bar` and `bar` both → `bar`
  const origName = origFull.split(/[.:]/).pop();
  const newName = newFull.split(/[.:]/).pop();
  if (!origName || !newName || origName !== newName) {
    console.log(`│      ⚠️ Signature mismatch: '${origFull}' → '${newFull}'`);
    return { ok: false, newCode: code, reason: "sig-mismatch", tokens: patchResult.tokens, time: patchResult.elapsed };
  }

  // 4. Replace in code
  const newCode = replaceFunction(code, fn.startLine, fn.endLine, fixedFunc);

  // 5. Validate with Selene (no NEW warnings)
  const validation = validatePatch(code, newCode);
  if (!validation.ok) {
    console.log(`│      ⚠️ Patch introduced ${validation.newWarnings.length} new Selene warnings — reverting`);
    return { ok: false, newCode: code, reason: "selene-regress", tokens: patchResult.tokens, time: patchResult.elapsed };
  }

  // 6. PATCH_REVIEWER: does the patch actually fix the bug?
  const reviewMsg = `ORIGINAL FUNCTION:
\`\`\`lua
${fn.body}
\`\`\`

PATCHED FUNCTION:
\`\`\`lua
${fixedFunc}
\`\`\`

BUG that should be fixed:
PROBLEM: ${bug.problem}

Does the patch fix the bug? Does it introduce new bugs?`;
  const review = await callAgent(PATCH_REVIEWER, reviewMsg, REVIEW_TOOLS, 3, REVIEW_TEMP);
  const reviewP = parseReview(review.content);
  if (reviewP.verdict === "REJEITADO") {
    console.log(`│      ⚠️ Patch reviewer REJECTED: ${reviewP.bugs.length} new bugs`);
    return { ok: false, newCode: code, reason: "reviewer-reject", tokens: patchResult.tokens + review.tokens, time: patchResult.elapsed + review.elapsed };
  }

  console.log(`│      ✅ Patch accepted (${validation.oldCount}→${validation.newCount} selene)`);
  return { ok: true, newCode, reason: "ok", tokens: patchResult.tokens + review.tokens, time: patchResult.elapsed + review.elapsed };
}

/**
 * Apply ALL bugs as surgical patches, ONE AT A TIME.
 * For each bug:
 *   - Try surgical patch
 *   - If fails, skip (will be reported as unresolved)
 * After all patches, return the patched code + list of unresolved bugs.
 */
async function applySurgicalPatches(code, bugs) {
  let currentCode = code;
  let totalTokens = 0, totalTime = 0;
  const unresolved = [];
  let applied = 0;

  // Sort bugs DESCENDING by line so earlier patches don't shift later line numbers
  // (only matters for the line lookup; once we find the function, we replace by
  //  function boundary which is line-shift-safe)
  const sorted = [...bugs].sort((a, b) => b.line - a.line);

  for (const bug of sorted) {
    console.log(`│  ── Patching [L${bug.line}] ${bug.problem.slice(0, 60)}`);
    const result = await surgicalPatch(currentCode, bug, 0, 0);
    totalTokens += result.tokens;
    totalTime += result.time;
    if (result.ok) {
      currentCode = result.newCode;
      applied++;
    } else {
      console.log(`│      ❌ Patch failed: ${result.reason}`);
      unresolved.push(bug);
    }
  }

  console.log(`│  📊 Surgical: ${applied}/${bugs.length} applied, ${unresolved.length} unresolved`);
  return { code: currentCode, unresolved, tokens: totalTokens, time: totalTime };
}

function buildReviewInput(code,task,testInput){const lines=code.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n");return`TASK: ${task}\n\nTEST INPUT: ${testInput}\n\nCODE TO REVIEW:\n${lines}\n\nCall pensar first, then review.`;}

// ─── v17: SEARCH/REPLACE FALLBACK ────────────────────────────────────────
const SEARCH_REPLACE_PATCHER = `You are a SEARCH/REPLACE patcher for Roblox Luau.

You receive:
- The full code with line numbers (context only)
- ONE bug at a specific line, with a description and a suggested FIX

Your job:
- Output TWO fenced blocks: SEARCH and REPLACE
- SEARCH: a block of EXACT lines from the original code (3-7 lines) that contains the bug. MUST match the original EXACTLY (whitespace, indentation).
- REPLACE: the corrected version of those same lines.
- DO NOT add or remove lines outside the SEARCH block.
- DO NOT change the line count drastically (keep it within ±2 lines of SEARCH).

FORMAT (STRICT):
\`\`\`search
<exact lines from original>
\`\`\`
\`\`\`replace
<corrected lines>
\`\`\`

Output ONLY the two blocks. No explanation.`;

async function searchReplacePatch(code, bug) {
  const codeLines = code.split("\n");
  const startL = Math.max(1, bug.line - 5);
  const endL = Math.min(codeLines.length, (bug.endLine||bug.line) + 5);
  const ctx = codeLines.slice(startL-1, endL).map((l,i)=>`L${startL+i}: ${l}`).join("\n");

  const msg = `BUG to fix at L${bug.line}:
PROBLEM: ${bug.problem}

SUGGESTED FIX (use as reference):
${bug.fix}

CODE CONTEXT (L${startL}-L${endL}):
${ctx}

Output SEARCH and REPLACE blocks.`;
  const result = await callAgent(SEARCH_REPLACE_PATCHER, msg, GEN_TOOLS, 2, PATCH_TEMP);
  const content = result.content;

  // Parse SEARCH and REPLACE blocks. Tolerate ``` or ''' or ~~~ fences, with optional language tag.
  const fence = /(`{3,}|'{3,}|~{3,})/;
  const blocks = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const fm = lines[i].match(fence);
    if (fm) {
      const fenceChar = fm[1][0];
      const fenceLen = fm[1].length;
      const header = lines[i].slice(fenceLen).trim().toLowerCase();
      // Collect until matching close fence
      const body = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].match(new RegExp(`^${fenceChar}{${fenceLen},}`));
        if (close) { i++; break; }
        body.push(lines[i]); i++;
      }
      blocks.push({ header, body: body.join("\n") });
    } else {
      i++;
    }
  }

  // Find SEARCH and REPLACE blocks (by header or by order)
  let search = null, replace = null;
  for (const b of blocks) {
    if (b.header === "search" || b.header === "'search'" || b.header === "\"search\"") search = b.body;
    else if (b.header === "replace" || b.header === "'replace'" || b.header === "\"replace\"") replace = b.body;
  }
  // Fallback: if no headers, take first two blocks
  if (!search && blocks.length >= 2) search = blocks[0].body;
  if (!replace && blocks.length >= 2) replace = blocks[1].body;

  if (!search || !replace) {
    console.log(`│      ⚠️ SEARCH/REPLACE parse failed (got ${blocks.length} blocks)`);
    return { ok: false, newCode: code, reason: "parse-fail", tokens: result.tokens, time: result.elapsed };
  }

  // Strip any "L<digit>: " prefix that the model may have copied
  search = search.split("\n").map(l => l.replace(/^\s*L\d+:\s*/, "")).join("\n").trim();
  replace = replace.split("\n").map(l => l.replace(/^\s*L\d+:\s*/, "")).join("\n").trim();

  // Find the SEARCH block in code (exact match first)
  let idx = code.indexOf(search);
  if (idx === -1) {
    // Try whitespace-normalized match (collapse multiple spaces, trim each line)
    const norm = s => s.split("\n").map(l => l.trim().replace(/\s+/g, " ")).join("\n");
    const normCode = norm(code);
    const normSearch = norm(search);
    const nIdx = normCode.indexOf(normSearch);
    if (nIdx === -1) {
      console.log(`│      ⚠️ SEARCH block not found in code`);
      return { ok: false, newCode: code, reason: "search-not-found", tokens: result.tokens, time: result.elapsed };
    }
    // Map normalized match back to original: find the line where normalized search starts
    // For simplicity, we count newlines up to nIdx in normCode, then map to original line.
    const startLineNorm = normCode.slice(0, nIdx).split("\n").length;
    const searchLineCount = normSearch.split("\n").length;
    // Replace lines [startLineNorm .. startLineNorm+searchLineCount-1] in original
    const origLines = code.split("\n");
    const before = origLines.slice(0, startLineNorm - 1);
    const after = origLines.slice(startLineNorm - 1 + searchLineCount);
    const newCode = [...before, ...replace.split("\n"), ...after].join("\n");
    const validation = validatePatch(code, newCode);
    if (!validation.ok) {
      console.log(`│      ⚠️ SEARCH/REPLACE (fuzzy) introduced ${validation.newWarnings.length} new Selene warnings — reverting`);
      return { ok: false, newCode: code, reason: "selene-regress", tokens: result.tokens, time: result.elapsed };
    }
    console.log(`│      ✅ SEARCH/REPLACE (fuzzy) accepted (${validation.oldCount}→${validation.newCount} selene)`);
    return { ok: true, newCode, reason: "ok-fuzzy", tokens: result.tokens, time: result.elapsed };
  }

  // Exact match: replace
  const newCode = code.slice(0, idx) + replace + code.slice(idx + search.length);

  // Validate with Selene
  const validation = validatePatch(code, newCode);
  if (!validation.ok) {
    console.log(`│      ⚠️ SEARCH/REPLACE introduced ${validation.newWarnings.length} new Selene warnings — reverting`);
    return { ok: false, newCode: code, reason: "selene-regress", tokens: result.tokens, time: result.elapsed };
  }

  console.log(`│      ✅ SEARCH/REPLACE accepted (${validation.oldCount}→${validation.newCount} selene)`);
  return { ok: true, newCode, reason: "ok", tokens: result.tokens, time: result.elapsed };
}

// ═══ MAIN ═══════════════════════════════════════════════════════════════
async function runDebate(task, testInput) {
  let totalTokens = 0, totalTime = 0;
  let logicIssues = "";

  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  CODE DEBATE v17 — Surgical Patcher + SEARCH/REPLACE         ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);

  // ═══ PHASE 1: LOGIC + API DESIGN ═════════════════════════════════════════
  console.log(`\n📋 PHASE 1: LOGIC DESIGN + API PATTERN VERIFICATION`);
  let logicFlow = "";
  for (let round = 1; round <= MAX_LOGIC_ROUNDS; round++) {
    console.log(`\n┌─── Logic Round ${round}/${MAX_LOGIC_ROUNDS} ────────────────────────┐`);
    console.log(`│  📐 Logic Designer...`);
    const logicMsg = round === 1 ? `Design logic for: ${task}\n\nTest inputs:\n${testInput}` : `Issues:\n${logicIssues}\n\nRevise logic.\n\nTask: ${task}\n\nTest inputs:\n${testInput}`;
    const gen = await callAgent(LOGIC_DESIGNER, logicMsg, GEN_TOOLS, 3, GEN_TEMP);
    logicFlow = gen.content; totalTokens += gen.tokens; totalTime += gen.elapsed;
    console.log(`│  📐 ${gen.tokens} tok, ${gen.elapsed}ms`);

    console.log(`│  🔍 Logic Verifier...`);
    const verify = await callAgent(LOGIC_VERIFIER, `Verify logic:\n${logicFlow}\n\nTest inputs:\n${testInput}`, REVIEW_TOOLS, 5, REVIEW_TEMP);
    totalTokens += verify.tokens; totalTime += verify.elapsed;
    const verifyResult = parseLogicVerdict(verify.content);
    console.log(`│  🔍 Logic: ${verifyResult.approved ? "✅" : "❌"}`);

    console.log(`│  🔌 API Design Reviewer...`);
    const apiReview = await callAgent(API_DESIGN_REVIEWER, `Verify API patterns:\n${logicFlow}`, REVIEW_TOOLS, 5, REVIEW_TEMP);
    totalTokens += apiReview.tokens; totalTime += apiReview.elapsed;
    const apiResult = parseLogicVerdict(apiReview.content);
    console.log(`│  🔌 API Design: ${apiResult.approved ? "✅" : "❌"}`);

    if (verifyResult.approved && apiResult.approved) { console.log(`│\n└─── ✅ LOGIC + API VERIFIED! ───┘`); break; }
    const issues = []; if (!verifyResult.approved) issues.push("LOGIC:\n" + verifyResult.issues); if (!apiResult.approved) issues.push("API:\n" + apiResult.issues);
    logicIssues = issues.join("\n\n");
    console.log(`└──────────────────────────────────────────────────────────────┘`);
  }

  // ═══ PHASE 2: CODE ═══════════════════════════════════════════════════════
  console.log(`\n📋 PHASE 2: CODE GENERATION + SURGICAL REVIEW`);
  console.log(`\n📝 Generating code from verified logic...`);
  let code = ""; let genAttempts = 0;
  while (code.split("\n").length < 10 && genAttempts < 3) {
    genAttempts++;
    const codeGen = await callAgent(CODE_GEN_FROM_LOGIC, `Translate this VERIFIED logic into Lua/Luau.\n\nLOGIC FLOW:\n${logicFlow}\n\nOutput ONLY code in \`\`\`lua block.`, GEN_TOOLS, 2, GEN_TEMP);
    code = extractCode(codeGen.content); totalTokens += codeGen.tokens; totalTime += codeGen.elapsed;
    console.log(`   Attempt ${genAttempts}: ${code.split("\n").length} lines`);
  }

  let bestCode = code, bestBugs = Infinity, bestRound = 0;
  let consecutiveWorse = 0; const history = [];
  let finalStatus = "UNKNOWN";

  for (let round = 1; round <= MAX_CODE_ROUNDS; round++) {
    console.log(`\n┌─── Code Round ${round}/${MAX_CODE_ROUNDS} ────────────────────────┐`);
    const reviewInput = buildReviewInput(code, task, testInput);
    const allBugs = [], verdicts = [];

    // Selene
    console.log(`│  🤖 Selene...`);
    const sel = runSelene(code);
    const selBugs = sel.warnings.map(w => ({line:w.line,problem:`[selene] ${w.msg}`,fix:`-- Fix: ${w.msg}`}));
    allBugs.push(...selBugs); verdicts.push({v:selBugs.length>0?"REJEITADO":"APROVADO",n:selBugs.length});
    console.log(`│  🤖 Selene: ${selBugs.length>0?"❌":"✅"} ${selBugs.length}`);

    // Logic Diff
    console.log(`│  📐 Logic Diff...`);
    const diffMsg = `Compare CODE against VERIFIED LOGIC.\n\nVERIFIED LOGIC:\n${logicFlow}\n\nCODE:\n${code.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n")}\n\nDoes code match logic? Any additions/omissions?`;
    const diff = await callAgent(LOGIC_DIFF_REVIEWER, diffMsg, REVIEW_TOOLS, 3, REVIEW_TEMP);
    totalTokens += diff.tokens; totalTime += diff.elapsed;
    const diffP = parseReview(diff.content);
    allBugs.push(...diffP.bugs); verdicts.push({v:diffP.verdict,n:diffP.bugs.length});
    console.log(`│  📐 Logic Diff: ${diffP.verdict==="APROVADO"?"✅":diffP.verdict==="RESSALVAS"?"🟡":"❌"} ${diffP.verdict} (${diffP.bugs.length} bugs)`);

    // Standard reviewers
    for (const [prompt, label, icon] of [
      [SYNTAX_CHECKER, "Syntax", "📝"],
      [CORRECTNESS_REVIEWER, "Correctness", "🧪"],
      [API_VERIFIER, "API Verify", "🔌"],
      [EDGE_CASE_REVIEWER, "Edge Cases", "⚡"],
      [DEVILS_ADVOCATE, "Devil's Advoc", "😈"],
    ]) {
      console.log(`│  ${icon} ${label}...`);
      const r = await callAgent(prompt, reviewInput, REVIEW_TOOLS, 5, REVIEW_TEMP);
      const p = parseReview(r.content); totalTokens += r.tokens; totalTime += r.elapsed;
      allBugs.push(...p.bugs); verdicts.push({v:p.verdict,n:p.bugs.length});
      console.log(`│  ${icon} ${label}: ${p.verdict==="APROVADO"?"✅":p.verdict==="RESSALVAS"?"🟡":"❌"} ${p.verdict} (${p.bugs.length})`);
    }

    // De-duplicate bugs by line
    const seen = new Set();
    const unique = allBugs.filter(b => { if(seen.has(b.line)) return false; seen.add(b.line); return true; });
    const approvals = verdicts.filter(v => v.v==="APROVADO"||v.v==="RESSALVAS").length;
    console.log(`│  📊 ${approvals}/${verdicts.length} approved, ${unique.length} bugs`);
    if (unique.length>0) for (const b of unique.slice(0,6)) console.log(`│    [L${b.line}] ${b.problem.slice(0,65)}`);

    if (unique.length<bestBugs) { bestBugs=unique.length; bestCode=code; bestRound=round; consecutiveWorse=0; } else consecutiveWorse++;
    history.push({round,approvals,bugs:unique.length,total:verdicts.length});

    // STRICT GATE: 0 bugs AND all reviewers approved (or RESSALVAS)
    if (unique.length===0 && approvals>=verdicts.length) {
      console.log(`│\n│  🔱 Self-validation...`);
      const sv = await callAgent(HONESTY, `Code approved. HONESTLY:\n1. Return reference to internal state?\n2. ALL variables local?\n3. What crashes it?\n4. GetAsync then SetAsync?\n\nCode:\n${code}\n\nClean: APROVADO. Bug: REJEITADO+BUG.`, REVIEW_TOOLS, 2, REVIEW_TEMP);
      totalTokens += sv.tokens; totalTime += sv.elapsed;
      const svP = parseReview(sv.content);
      console.log(`│  🔱 Self-val: ${svP.verdict==="APROVADO"?"✅":"❌"} ${svP.verdict}`);
      if (svP.bugs.length===0) {
        console.log(`│\n└─── ✅ ALL CHECKS PASSED! Round ${round} ──┘`);
        finalStatus = "SUCCESS";
        break;
      }
      else { allBugs.push(...svP.bugs); unique.push(...svP.bugs); }
    }

    // Revert if getting worse
    if (consecutiveWorse>=2 && bestRound<round) {
      console.log(`│  ⚠️ Revert to best (round ${bestRound}, ${bestBugs})`);
      code=bestCode; consecutiveWorse=0;
      console.log(`└──────────────────────────────────────────────────────────────┘`);
      continue;
    }

    // ─── v16: SURGICAL PATCH ────────────────────────────────────────────
    if (round<MAX_CODE_ROUNDS && unique.length>0) {
      console.log(`│\n│  🔧 Surgical patching ${unique.length} bugs...`);
      const patchResult = await applySurgicalPatches(code, unique);
      totalTokens += patchResult.tokens; totalTime += patchResult.time;
      code = patchResult.code;
      console.log(`│  ✅ Code: ${code.split("\n").length} lines, ${patchResult.unresolved.length} unresolved`);
      console.log(`└──────────────────────────────────────────────────────────────┘`);
    } else {
      console.log(`│\n└─── ⚠️ Max rounds reached. Best: round ${bestRound} ${bestBugs} bugs. ──┘`);
      finalStatus = "MAX_ROUNDS";
    }
  }

  const finalCode = bestBugs < (history[history.length-1]?.bugs||Infinity) ? bestCode : code;
  const lastRound = history[history.length-1];
  const success = finalStatus === "SUCCESS" || (lastRound && lastRound.bugs === 0);

  console.log(`\n╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Total: ${totalTokens.toLocaleString()} tok, ${(totalTime/1000).toFixed(1)}s | Best: round ${bestRound} ${bestBugs} bugs`);
  console.log(`║  Status: ${success ? "✅ SUCCESS (0 bugs)" : "❌ FAILURE — bugs remain"}`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  console.log(`\n📈 Evolution:`);
  for (const h of history) console.log(`   Round ${h.round}: ${"✅".repeat(Math.min(h.approvals,h.total))}${"❌".repeat(h.total-Math.min(h.approvals,h.total))} | ${h.bugs} bugs${h.round===bestRound?" ← BEST":""}`);
  console.log(`\n📄 FINAL CODE:`); console.log("```lua"); console.log(finalCode); console.log("```");

  return { code: finalCode, totalTokens, totalTime, bestBugs, success };
}

async function main() {
  const task = `Criar um módulo PlayerDataManager para Roblox (Luau) — SISTEMA CRÍTICO.
Funções: new(dataStoreName), loadPlayer(player) com SESSION LOCKING (GenerateGuid, verifica sessionId anterior atomicamente via UpdateAsync), savePlayer(player) via UpdateAsync (verifica sessionId, retry 3x backoff), startAutoSave(interval), stopAutoSave(), saveAll() para BindToClose, unloadPlayer(player).
Regras: NUNCA SetAsync. Cache [userId]={data,sessionId,version}. Nunca corromper. Validar player. Metatable OOP. TUDO local.`;
  const testInput = `1. loadPlayer novo. 2. loadPlayer com lock outro servidor. 3. savePlayer sessionId bate. 4. savePlayer sessionId NÃO bate. 5. savePlayer falha 3x. 6. unloadPlayer. 7. saveAll. 8. startAutoSave(60). 9. loadPlayer(nil).`;
  await runDebate(task, testInput);
}
main().catch(console.error);
