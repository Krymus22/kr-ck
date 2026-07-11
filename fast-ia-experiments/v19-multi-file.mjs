#!/usr/bin/env node
/**
 * v18: MULTI-FILE CODE DEBATE — DAG + Contracts + Cross-File Integration
 *
 * ARCHITECTURE:
 *   Phase 0: Architect designs module DAG + contracts (no code)
 *   Phase 1: Per-module LOGIC (topological order, contracts of deps inline)
 *   Phase 2: Per-module CODE (topological order, contracts of deps inline)
 *            → uses v17 surgical patcher + SEARCH/REPLACE fallback
 *   Phase 3: Cross-file integration review
 *   Phase 4: Smoke test (Selene per file + require graph)
 *
 * CONSTRAINTS (per user):
 *   - NO hardcoded examples in prompts (only generic rules)
 *   - NO larger AI help (DiffusionGemma 26B only)
 *   - Iterate until 0 bugs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const OpenAI = require("/home/z/my-project/claude-killer/node_modules/openai").default;
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// Force unbuffered stdout (so redirected logs flush immediately)
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
if (process.stderr._handle) process.stderr._handle.setBlocking(true);

const envContent = readFileSync("/home/z/my-project/claude-killer/.env", "utf8");
const keysMatch = envContent.match(/^NVIDIA_API_KEYS=(.+)$/m);
const allKeys = keysMatch[1].split(",").filter(k => k.startsWith("nvapi-"));

// ─── v19: RATE LIMITER (token bucket per key, 40 req / 60s sliding window) ───
const RATE_LIMIT_PER_KEY = 40;          // NVIDIA NIM: 40 req/min per key
const RATE_WINDOW_MS = 60_000;          // 60 seconds
const RATE_MAX_PER_KEY = RATE_LIMIT_PER_KEY - 2;  // stop at 38 to be safe (margin of 2)

// Per-key timestamp log of recent requests
const keyRequestLog = allKeys.map(() => []);
let rateLimiterStats = { waits: 0, totalWaitMs: 0, requests: 0 };

function purgeOldRequests(now) {
  for (const log of keyRequestLog) {
    while (log.length > 0 && now - log[0] >= RATE_WINDOW_MS) log.shift();
  }
}

function findBestKey() {
  const now = Date.now();
  purgeOldRequests(now);
  // Pick the key with FEWEST recent requests (most capacity)
  let bestIdx = 0, bestCount = Infinity;
  for (let i = 0; i < keyRequestLog.length; i++) {
    if (keyRequestLog[i].length < bestCount) {
      bestCount = keyRequestLog[i].length;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, count: bestCount };
}

async function waitForSlot() {
  while (true) {
    const { idx, count } = findBestKey();
    if (count < RATE_MAX_PER_KEY) {
      // Reserve a slot NOW (record timestamp) so concurrent callers don't all grab the same key
      keyRequestLog[idx].push(Date.now());
      rateLimiterStats.requests++;
      return idx;
    }
    // Need to wait — find when the oldest request in the most-loaded key will expire
    const now = Date.now();
    let minWaitMs = Infinity;
    for (const log of keyRequestLog) {
      if (log.length >= RATE_MAX_PER_KEY) {
        const waitMs = (log[0] + RATE_WINDOW_MS) - now + 100; // +100ms safety
        if (waitMs < minWaitMs) minWaitMs = waitMs;
      }
    }
    if (minWaitMs === Infinity || minWaitMs < 0) minWaitMs = 1000;
    rateLimiterStats.waits++;
    rateLimiterStats.totalWaitMs += minWaitMs;
    if (rateLimiterStats.waits % 10 === 0) {
      const usage = keyRequestLog.map(l => l.length).join(",");
      console.log(`    ⏳ Rate limit: waiting ${minWaitMs}ms (key usage: [${usage}]/${RATE_MAX_PER_KEY})`);
    }
    await new Promise(r => setTimeout(r, minWaitMs));
  }
}

let keyIndex = 0;
async function getClient() {
  const idx = await waitForSlot();
  const k = allKeys[idx];
  return new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey: k });
}

const MODEL = "google/diffusiongemma-26b-a4b-it";
const MAX_ARCH_ROUNDS = 4;
const MAX_LOGIC_ROUNDS = 4;
const MAX_CODE_ROUNDS = 6;
const MAX_INTEG_ROUNDS = 4;
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

// ═══ PHASE 0: ARCHITECT ══════════════════════════════════════════════════
const ARCHITECT = `You are a SOFTWARE ARCHITECT for Roblox Luau.
Design a MULTI-FILE system based on the task. Output a STRUCTURED SPEC.

Rules:
- Each module = ONE Luau file (ModuleScript).
- Modules have dependencies (require graph). Identify them.
- Define the PUBLIC API of each module: every exported function/method with its signature.
- A signature MUST include: function name, parameter names+types, return type(s).
- Dependencies must be ACYCLIC (DAG).
- Order modules in TOPOLOGICAL ORDER (deps first).

Output format (STRICT — no extra text outside this structure):

=== MODULE: <name> ===
FILE: <filename>.lua
DEPENDS_ON: <comma-separated module names, or "none">
DESCRIPTION: <1-2 sentence purpose>
PUBLIC API:
- <signature 1>
- <signature 2>
- ...
END MODULE

Repeat for each module. Then:

=== DAG ORDER ===
<module1> -> <module2> -> <module3> ...

Use pensar (categoria="architecture") to plan first.`;

const ARCH_VERIFIER = `## HONESTY RULES
1. NEVER approve without verifying.
2. Trace the dependency graph mentally.
Verify the architecture spec:
- Is the DAG acyclic? (no circular deps)
- Does every module's PUBLIC API cover its stated purpose?
- Are signatures complete (params+types+return)?
- Does the topological order respect dependencies?
- Are there MISSING modules (mentioned in DEPENDS_ON but not defined)?
- Are there UNUSED modules (defined but never depended on by anyone, except the entry point)?

If ALL correct: VERDICT: APROVADO
If any wrong: VERDICT: REJEITADO + ISSUES (list what's wrong)

Use pensar (categoria="debugging").`;

// ═══ PHASE 1: LOGIC DESIGNER (per module) ════════════════════════════════
function logicDesignerPrompt(moduleName) {
  return `You are a SYSTEM ARCHITECT. Design the LOGIC for ONE Roblox Luau module: ${moduleName}.
DO NOT write Lua code. Write the LOGIC FLOW in structured pseudocode.
Use pensar (categoria="architecture") to plan, then pensar (categoria="debugging") to trace.
FORMAT: FUNCTION <name>(<params>): STEP 1: ... RETURN: ...
Be SPECIFIC about DataStore methods, UpdateAsync callback, pcall, nil handling.
CRITICAL: NEVER GetAsync→SetAsync (race). ALWAYS UpdateAsync for read-modify-write. NEVER SetAsync. Check conditions INSIDE UpdateAsync callback.
If the module uses other modules' APIs (per DEPENDS_ON), reference them by exact name + signature.`;
}

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
7. Cross-module calls MUST match the imported module's PUBLIC API signature.
Use pensar (categoria="debugging"). Use buscar_web to verify.
If ALL correct: VERDICT: APROVADO. If any wrong: VERDICT: REJEITADO + ISSUES.`;

// ═══ PHASE 2: CODE (per module, from verified logic) ═════════════════════
function codeGenPrompt(moduleName) {
  return `You are a Lua/Luau programmer for Roblox.
You receive a VERIFIED LOGIC FLOW for module: ${moduleName}.
Translate it into Lua/Luau code.

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
- For dependencies: require them via require(script.Parent.<ModuleName>) or similar
- Output in a \`\`\`lua block (first line is code, NOT "lua")`;
}

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
7. Cross-module call mismatch (wrong param count/type/return)? (provide the fix)

If a function DELEGATES to another function (e.g., saveAll calls savePlayer),
the delegated function's behavior is NOT a bug in the caller.
Only flag bugs in the CALLING function's own logic.

Call pensar (categoria="debugging"). Try hard to break it.`;

// ═══ PHASE 3: CROSS-FILE INTEGRATION ═════════════════════════════════════
const INTEGRATION_REVIEWER = `${HONESTY}
You are the CROSS-FILE INTEGRATION REVIEWER. You see ALL files of the system.

For EACH cross-module call (A calls B.foo(args)):
1. Does B.foo exist in B's PUBLIC API? (check the API definition)
2. Do the arg COUNT and TYPES match B.foo's signature?
3. Does A handle B.foo's return value correctly (type, nil)?
4. Is the require() call correct? (path matches the module name)

For EACH shared data flow (A produces X, B consumes X):
5. Is the data shape consistent (same keys/types)?

For EACH cross-module STATE assumption:
6. Does A call B in the right ORDER (e.g., init before use)?
7. Does B's lifecycle match A's expectations (load before save)?

Report bugs in the format:
BUG [FILE=<filename> L<line>]
PROBLEM: <1 sentence>
FIX: <VALID LUA CODE for THAT file>

If ALL correct: VERDICT: APROVADO
If any mismatch: VERDICT: REJEITADO + BUG blocks

Call pensar (categoria="debugging"). Use buscar_web to verify Roblox APIs.`;

// ═══ v17 SURGICAL PATCHER (reused) ═══════════════════════════════════════
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

// ─── Helpers ─────────────────────────────────────────────────────────────
async function executeWebSearch(q){try{const r=execSync(`z-ai function -n web_search -a '${JSON.stringify({query:q,num:3})}'`,{encoding:"utf8",timeout:30000});const s=r.indexOf("["),e=r.lastIndexOf("]");if(s>=0&&e>s)return JSON.parse(r.slice(s,e+1)).map((r,i)=>`${i+1}. ${r.name}\n   ${r.snippet}`).join("\n\n");return"Nenhum.";}catch{return"[Error]";}}
function runSelene(code){try{const f=`/tmp/debate-${Date.now()}-${Math.random().toString(36).slice(2,6)}.luau`;writeFileSync(f,code);const r=execSync(`${SELENE_PATH} ${f} 2>&1 || true`,{encoding:"utf8",timeout:10000});unlinkSync(f);const w=[];for(const l of r.split("\n")){const m=l.match(/:\s*(\d+):\s*(\d+):\s*(\w+):\s*(.+)/);if(m)w.push({line:+m[1],type:m[3],msg:m[4].trim()});}return{warnings:w};}catch{return{warnings:[]};}}

async function callAgent(sys,msg,tools,maxTools,temp){const start=Date.now();const messages=[{role:"system",content:sys},{role:"user",content:msg}];let tc=0,tk=0;async function retry(p,m=5){for(let i=0;i<m;i++){try{const client=await getClient();return await client.chat.completions.create(p);}catch(e){if((e.status===429||e.status===503)&&i<m-1){await new Promise(r=>setTimeout(r,(i+1)*5000));continue;}throw e;}}}const base={model:MODEL,chat_template_kwargs:{thinking_mode:"enabled"},max_tokens:16384,temperature:temp,stream:false};while(tc<maxTools){const r=await retry({...base,messages,tools,tool_choice:"auto"});tk+=r.usage?.completion_tokens||0;const m=r.choices[0]?.message;if(m.tool_calls?.length){for(const t of m.tool_calls){tc++;const a=JSON.parse(t.function.arguments);if(t.function.name==="pensar"){console.log(`    💭 [${a.categoria}] ${a.pensamento?.slice(0,100)}...`);messages.push({role:"assistant",content:m.content||"(tool)",tool_calls:m.tool_calls});messages.push({role:"tool",tool_call_id:t.id,content:"OK. Continue."});}else if(t.function.name==="buscar_web"){console.log(`    🔍 "${a.query?.slice(0,70)}"`);const s=await executeWebSearch(a.query);messages.push({role:"assistant",content:m.content||"(tool)",tool_calls:m.tool_calls});messages.push({role:"tool",tool_call_id:t.id,content:s});}}continue;}return{content:m.content||"",elapsed:Date.now()-start,tokens:tk,toolCallsMade:tc};}messages.push({role:"user",content:"Veredito final agora."});const fr=await retry({...base,messages,tools:undefined,tool_choice:"none"});tk+=fr.usage?.completion_tokens||0;return{content:fr.choices[0]?.message?.content||"",elapsed:Date.now()-start,tokens:tk,toolCallsMade:tc};}

function extractCode(c){const m=c.match(/```(?:lua|luau)?\n([\s\S]*?)```/);if(m){let c=m[1].trim();const fl=c.split("\n")[0].trim().toLowerCase();if(fl==="lua"||fl==="luau")c=c.split("\n").slice(1).join("\n").trim();return c;}return c.trim();}
function parseReview(content){const bugs=[];const upper=content.toUpperCase();const re=/BUG\s*\[(?:FILE=\S+\s+)?L(\d+)(?:\s*-\s*L(\d+))?\]\s*\n\s*PROBLEM:\s*(.+?)\n\s*FIX:\s*([\s\S]*?)(?=\n\s*BUG\s*\[L|\n\s*VERDICT|\n\s*APROVADO|\n\s*REJEITADO|$)/gi;let m;
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

// ─── Architecture spec parser ────────────────────────────────────────────
function parseArchitectureSpec(content) {
  const modules = [];
  const moduleRe = /===\s*MODULE:\s*(\S+)\s*===\s*\n([\s\S]*?)(?=\n===\s*MODULE:|\n===\s*DAG\s+ORDER:|$)/g;
  let m;
  while ((m = moduleRe.exec(content)) !== null) {
    const name = m[1].trim();
    const body = m[2].trim();
    const fileMatch = body.match(/FILE:\s*(\S+)/);
    const depsMatch = body.match(/DEPENDS_ON:\s*(.+)/);
    const descMatch = body.match(/DESCRIPTION:\s*(.+)/);
    const apiMatch = body.match(/PUBLIC API:\s*\n([\s\S]*?)(?:\nEND MODULE|$)/);
    const deps = depsMatch ? depsMatch[1].trim().replace(/,$/, "").split(",").map(s=>s.trim()).filter(s=>s && s.toLowerCase()!=="none") : [];
    const api = apiMatch ? apiMatch[1].split("\n").map(l=>l.replace(/^\s*-\s*/, "").trim()).filter(l=>l) : [];
    modules.push({
      name,
      file: fileMatch ? fileMatch[1].trim() : `${name}.lua`,
      deps,
      description: descMatch ? descMatch[1].trim() : "",
      api,
    });
  }
  // DAG order
  const dagMatch = content.match(/===\s*DAG\s+ORDER:\s*===\s*\n(.+)/);
  let dagOrder = [];
  if (dagMatch) {
    // Parse "A -> B -> C" or "A, B, C" or "1. A 2. B 3. C"
    const line = dagMatch[1].trim();
    if (line.includes("->")) {
      dagOrder = line.split("->").map(s => s.trim()).filter(s=>s);
    } else if (line.includes(",")) {
      dagOrder = line.split(",").map(s => s.trim()).filter(s=>s);
    } else {
      dagOrder = line.split(/\s+/).filter(s=>s && !/^\d+\.$/.test(s));
    }
  }
  // Fallback: derive from deps (Kahn's algorithm)
  if (dagOrder.length === 0 && modules.length > 0) {
    const inDeg = new Map(modules.map(m => [m.name, 0]));
    modules.forEach(m => m.deps.forEach(d => { if (inDeg.has(d)) inDeg.set(m.name, inDeg.get(m.name) + 1); }));
    const queue = modules.filter(m => inDeg.get(m.name) === 0).map(m => m.name);
    const order = [];
    while (queue.length) {
      const n = queue.shift();
      order.push(n);
      modules.filter(m => m.deps.includes(n)).forEach(m => {
        inDeg.set(m.name, inDeg.get(m.name) - 1);
        if (inDeg.get(m.name) === 0) queue.push(m.name);
      });
    }
    dagOrder = order;
  }
  return { modules, dagOrder };
}

function buildContractBlock(module) {
  return `MODULE: ${module.name}
FILE: ${module.file}
DEPENDS_ON: ${module.deps.length ? module.deps.join(", ") : "none"}
DESCRIPTION: ${module.description}
PUBLIC API:
${module.api.map(a => `- ${a}`).join("\n")}`;
}

function buildDepsContracts(modules, deps) {
  if (!deps || deps.length === 0) return "(no dependencies — base module)";
  const blocks = deps.map(dn => {
    const dep = modules.find(m => m.name === dn);
    return dep ? buildContractBlock(dep) : `(MODULE ${dn} not found)`;
  });
  return blocks.join("\n\n");
}

// ─── v17 SURGICAL PATCHER (reused, with file awareness) ──────────────────
function extractFunction(code, targetLine) {
  const lines = code.split("\n");
  if (targetLine < 1 || targetLine > lines.length) return null;
  let sigLine = -1;
  let funcName = null;
  for (let i = targetLine - 1; i >= 0; i--) {
    const l = lines[i];
    const m1 = l.match(/^\s*(local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/);
    if (m1) { sigLine = i; funcName = m1[2]; break; }
    const m2 = l.match(/^\s*([A-Za-z_][\w.:]*)\s*=\s*function\s*\(/);
    if (m2) { sigLine = i; funcName = m2[1]; break; }
  }
  if (sigLine === -1) return null;
  let depth = 0;
  let endLine = -1;
  for (let i = sigLine; i < lines.length; i++) {
    const l = lines[i];
    const openers = (l.match(/\bfunction\b/g) || []).length
                  + (l.match(/\bdo\b/g) || []).length
                  + (l.match(/\bfor\b/g) || []).length
                  + (l.match(/\bwhile\b/g) || []).length
                  + (l.match(/\bif\b.*\bthen\b/g) || []).length
                  + (l.match(/\belseif\b.*\bthen\b/g) || []).length;
    const closers = (l.match(/\bend\b/g) || []).length;
    depth += openers - closers;
    if (depth === 0) { endLine = i; break; }
  }
  if (endLine === -1) return null;
  return {
    name: funcName,
    startLine: sigLine + 1,
    endLine: endLine + 1,
    body: lines.slice(sigLine, endLine + 1).join("\n"),
  };
}

function replaceFunction(code, startLine, endLine, newFuncBody) {
  const lines = code.split("\n");
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  return [...before, ...newFuncBody.split("\n"), ...after].join("\n");
}

function validatePatch(oldCode, newCode) {
  const oldSel = runSelene(oldCode);
  const newSel = runSelene(newCode);
  const oldMsgs = new Set(oldSel.warnings.map(w => `${w.type}:${w.msg}`));
  const newWarnings = newSel.warnings.filter(w => !oldMsgs.has(`${w.type}:${w.msg}`));
  return { ok: newWarnings.length === 0, newWarnings, oldCount: oldSel.warnings.length, newCount: newSel.warnings.length };
}

async function surgicalPatch(code, bug) {
  const fn = extractFunction(code, bug.line);
  if (!fn) {
    console.log(`│      📍 No function — trying SEARCH/REPLACE`);
    return await searchReplacePatch(code, bug);
  }
  console.log(`│      📍 Function ${fn.name} (L${fn.startLine}-${fn.endLine})`);

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

  const origSig = fn.body.split("\n")[0].trim();
  const newSig = fixedFunc.split("\n")[0].trim();
  const origFull = origSig.match(/function\s+([A-Za-z_][\w.:]*)/)?.[1]
                 || origSig.match(/([A-Za-z_][\w.:]*)\s*=\s*function/)?.[1] || "";
  const newFull = newSig.match(/function\s+([A-Za-z_][\w.:]*)/)?.[1]
                || newSig.match(/([A-Za-z_][\w.:]*)\s*=\s*function/)?.[1] || "";
  const origName = origFull.split(/[.:]/).pop();
  const newName = newFull.split(/[.:]/).pop();
  if (!origName || !newName || origName !== newName) {
    console.log(`│      ⚠️ Signature mismatch: '${origFull}' → '${newFull}'`);
    return { ok: false, newCode: code, reason: "sig-mismatch", tokens: patchResult.tokens, time: patchResult.elapsed };
  }

  const newCode = replaceFunction(code, fn.startLine, fn.endLine, fixedFunc);
  const validation = validatePatch(code, newCode);
  if (!validation.ok) {
    console.log(`│      ⚠️ Patch introduced ${validation.newWarnings.length} new Selene warnings — reverting`);
    return { ok: false, newCode: code, reason: "selene-regress", tokens: patchResult.tokens, time: patchResult.elapsed };
  }

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

  let search = null, replace = null;
  for (const b of blocks) {
    if (b.header === "search" || b.header === "'search'" || b.header === "\"search\"") search = b.body;
    else if (b.header === "replace" || b.header === "'replace'" || b.header === "\"replace\"") replace = b.body;
  }
  if (!search && blocks.length >= 2) search = blocks[0].body;
  if (!replace && blocks.length >= 2) replace = blocks[1].body;

  if (!search || !replace) {
    console.log(`│      ⚠️ SEARCH/REPLACE parse failed (got ${blocks.length} blocks)`);
    return { ok: false, newCode: code, reason: "parse-fail", tokens: result.tokens, time: result.elapsed };
  }

  search = search.split("\n").map(l => l.replace(/^\s*L\d+:\s*/, "")).join("\n").trim();
  replace = replace.split("\n").map(l => l.replace(/^\s*L\d+:\s*/, "")).join("\n").trim();

  let idx = code.indexOf(search);
  if (idx === -1) {
    const norm = s => s.split("\n").map(l => l.trim().replace(/\s+/g, " ")).join("\n");
    const normCode = norm(code);
    const normSearch = norm(search);
    const nIdx = normCode.indexOf(normSearch);
    if (nIdx === -1) {
      console.log(`│      ⚠️ SEARCH block not found in code`);
      return { ok: false, newCode: code, reason: "search-not-found", tokens: result.tokens, time: result.elapsed };
    }
    const startLineNorm = normCode.slice(0, nIdx).split("\n").length;
    const searchLineCount = normSearch.split("\n").length;
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

  const newCode = code.slice(0, idx) + replace + code.slice(idx + search.length);
  const validation = validatePatch(code, newCode);
  if (!validation.ok) {
    console.log(`│      ⚠️ SEARCH/REPLACE introduced ${validation.newWarnings.length} new Selene warnings — reverting`);
    return { ok: false, newCode: code, reason: "selene-regress", tokens: result.tokens, time: result.elapsed };
  }
  console.log(`│      ✅ SEARCH/REPLACE accepted (${validation.oldCount}→${validation.newCount} selene)`);
  return { ok: true, newCode, reason: "ok", tokens: result.tokens, time: result.elapsed };
}

async function applySurgicalPatches(code, bugs) {
  let currentCode = code;
  let totalTokens = 0, totalTime = 0;
  const unresolved = [];
  let applied = 0;
  const sorted = [...bugs].sort((a, b) => b.line - a.line);
  for (const bug of sorted) {
    console.log(`│  ── Patching [L${bug.line}] ${bug.problem.slice(0, 60)}`);
    const result = await surgicalPatch(currentCode, bug);
    totalTokens += result.tokens;
    totalTime += result.time;
    if (result.ok) { currentCode = result.newCode; applied++; }
    else { console.log(`│      ❌ Patch failed: ${result.reason}`); unresolved.push(bug); }
  }
  console.log(`│  📊 Surgical: ${applied}/${bugs.length} applied, ${unresolved.length} unresolved`);
  return { code: currentCode, unresolved, tokens: totalTokens, time: totalTime };
}

function buildReviewInput(code, task, testInput) {
  const lines = code.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n");
  return `TASK: ${task}\n\nTEST INPUT: ${testInput}\n\nCODE TO REVIEW:\n${lines}\n\nCall pensar first, then review.`;
}

// ═══ MAIN: MULTI-FILE ORCHESTRATION ═══════════════════════════════════════
async function runMultiFileDebate(task, testInput) {
  let totalTokens = 0, totalTime = 0;
  const stats = { phases: {} };

  console.log(`\n╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  MULTI-FILE DEBATE v19 — DAG + Contracts + Rate-Limited        ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);

  // ═══ PHASE 0: ARCHITECTURE ═════════════════════════════════════════════
  console.log(`\n📋 PHASE 0: ARCHITECTURE DESIGN`);
  let archSpec = null;
  let archIssues = "";
  for (let round = 1; round <= MAX_ARCH_ROUNDS; round++) {
    console.log(`\n┌─── Arch Round ${round}/${MAX_ARCH_ROUNDS} ────────────────────────┐`);
    console.log(`│  📐 Architect...`);
    const archMsg = round === 1 ? `Design the system for: ${task}\n\nTest inputs:\n${testInput}` : `Issues:\n${archIssues}\n\nRevise the architecture.\n\nTask: ${task}\n\nTest inputs:\n${testInput}`;
    const gen = await callAgent(ARCHITECT, archMsg, GEN_TOOLS, 3, GEN_TEMP);
    totalTokens += gen.tokens; totalTime += gen.elapsed;
    console.log(`│  📐 ${gen.tokens} tok, ${gen.elapsed}ms`);

    console.log(`│  🔍 Arch Verifier...`);
    const verify = await callAgent(ARCH_VERIFIER, `Verify architecture spec:\n${gen.content}`, REVIEW_TOOLS, 5, REVIEW_TEMP);
    totalTokens += verify.tokens; totalTime += verify.elapsed;
    const verifyResult = parseLogicVerdict(verify.content);
    console.log(`│  🔍 Arch: ${verifyResult.approved ? "✅" : "❌"}`);

    // Try to parse anyway (even if not approved, partial spec might work)
    const parsed = parseArchitectureSpec(gen.content);
    console.log(`│  📦 Parsed: ${parsed.modules.length} modules, DAG order: ${parsed.dagOrder.join(" → ") || "(none)"}`);

    if (verifyResult.approved && parsed.modules.length >= 2 && parsed.dagOrder.length === parsed.modules.length) {
      archSpec = parsed;
      console.log(`│\n└─── ✅ ARCHITECTURE VERIFIED! ───┘`);
      break;
    }
    archIssues = verifyResult.issues + `\n\nParsed: ${parsed.modules.length} modules, DAG order: ${parsed.dagOrder.length} (expected ${parsed.modules.length}). If parsing failed, output STRICT format.`;
    if (round === MAX_ARCH_ROUNDS && parsed.modules.length >= 2) {
      // Use the last parsed spec even if not approved
      console.log(`│  ⚠️ Using unverified spec (max rounds)`);
      archSpec = parsed;
    }
    console.log(`└──────────────────────────────────────────────────────────────┘`);
  }

  if (!archSpec || archSpec.modules.length === 0) {
    console.log(`\n❌ ARCHITECTURE FAILED — cannot proceed`);
    return { success: false, reason: "arch-failed" };
  }

  stats.phases.arch = { modules: archSpec.modules.length, dag: archSpec.dagOrder };
  console.log(`\n📦 Modules:`);
  for (const m of archSpec.modules) {
    console.log(`   • ${m.name} (${m.file}) — deps: [${m.deps.join(", ") || "none"}] — API: ${m.api.length} entries`);
  }

  // ═══ PHASE 1 + 2: PER-MODULE (LOGIC + CODE) in topological order ═══════
  const moduleCode = new Map(); // moduleName → code
  const moduleLogic = new Map(); // moduleName → logicFlow

  for (const moduleName of archSpec.dagOrder) {
    const mod = archSpec.modules.find(m => m.name === moduleName);
    if (!mod) continue;

    console.log(`\n╔══ MODULE: ${moduleName} (${mod.file}) ════════════════════════════`);
    console.log(`║  Deps: [${mod.deps.join(", ") || "none"}]`);

    const depsContracts = buildDepsContracts(archSpec.modules, mod.deps);

    // ── Phase 1: Logic ──
    console.log(`║\n║  📐 PHASE 1: LOGIC DESIGN`);
    let logicFlow = "";
    let logicIssues = "";
    let logicApproved = false;
    for (let round = 1; round <= MAX_LOGIC_ROUNDS; round++) {
      console.log(`║  ┌── Logic Round ${round}/${MAX_LOGIC_ROUNDS} ──────────────┐`);
      const logicMsg = round === 1
        ? `Design logic for module ${moduleName}.\n\nMODULE SPEC:\n${buildContractBlock(mod)}\n\nDEPENDENCIES' CONTRACTS:\n${depsContracts}\n\nTask context: ${task}\n\nTest inputs:\n${testInput}`
        : `Issues:\n${logicIssues}\n\nRevise logic for ${moduleName}.\n\nMODULE SPEC:\n${buildContractBlock(mod)}\n\nDEPENDENCIES' CONTRACTS:\n${depsContracts}\n\nTask: ${task}\n\nTest inputs:\n${testInput}`;
      const gen = await callAgent(logicDesignerPrompt(moduleName), logicMsg, GEN_TOOLS, 3, GEN_TEMP);
      logicFlow = gen.content; totalTokens += gen.tokens; totalTime += gen.elapsed;
      console.log(`║  │  📐 ${gen.tokens} tok, ${gen.elapsed}ms`);

      console.log(`║  │  🔍 Logic Verifier...`);
      const verify = await callAgent(LOGIC_VERIFIER, `Verify logic for ${moduleName}:\n${logicFlow}\n\nTest inputs:\n${testInput}\n\nDependencies' contracts:\n${depsContracts}`, REVIEW_TOOLS, 5, REVIEW_TEMP);
      totalTokens += verify.tokens; totalTime += verify.elapsed;
      const verifyResult = parseLogicVerdict(verify.content);
      console.log(`║  │  🔍 Logic: ${verifyResult.approved ? "✅" : "❌"}`);

      console.log(`║  │  🔌 API Design Reviewer...`);
      const apiReview = await callAgent(API_DESIGN_REVIEWER, `Verify API patterns for ${moduleName}:\n${logicFlow}\n\nDependencies' contracts:\n${depsContracts}`, REVIEW_TOOLS, 5, REVIEW_TEMP);
      totalTokens += apiReview.tokens; totalTime += apiReview.elapsed;
      const apiResult = parseLogicVerdict(apiReview.content);
      console.log(`║  │  🔌 API Design: ${apiResult.approved ? "✅" : "❌"}`);

      if (verifyResult.approved && apiResult.approved) {
        console.log(`║  └── ✅ LOGIC VERIFIED! ──┘`);
        logicApproved = true;
        break;
      }
      const issues = [];
      if (!verifyResult.approved) issues.push("LOGIC:\n" + verifyResult.issues);
      if (!apiResult.approved) issues.push("API:\n" + apiResult.issues);
      logicIssues = issues.join("\n\n");
      console.log(`║  └──────────────────────────┘`);
    }
    moduleLogic.set(moduleName, logicFlow);

    // ── Phase 2: Code ──
    console.log(`║\n║  📝 PHASE 2: CODE GENERATION + REVIEW`);
    let code = ""; let genAttempts = 0;
    while (code.split("\n").length < 10 && genAttempts < 3) {
      genAttempts++;
      const codeGen = await callAgent(codeGenPrompt(moduleName), `Translate this VERIFIED logic into Lua/Luau for module ${moduleName}.\n\nLOGIC FLOW:\n${logicFlow}\n\nMODULE SPEC:\n${buildContractBlock(mod)}\n\nDEPENDENCIES' CONTRACTS (use these EXACT signatures when calling):\n${depsContracts}\n\nOutput ONLY code in \`\`\`lua block.`, GEN_TOOLS, 2, GEN_TEMP);
      code = extractCode(codeGen.content); totalTokens += codeGen.tokens; totalTime += codeGen.elapsed;
      console.log(`║     Attempt ${genAttempts}: ${code.split("\n").length} lines`);
    }

    let bestCode = code, bestBugs = Infinity, bestRound = 0;
    let consecutiveWorse = 0; const history = [];
    let moduleSuccess = false;

    for (let round = 1; round <= MAX_CODE_ROUNDS; round++) {
      console.log(`║  ┌── Code Round ${round}/${MAX_CODE_ROUNDS} ──────────────┐`);
      const reviewInput = `MODULE: ${moduleName}\nTASK: ${task}\n\nMODULE SPEC:\n${buildContractBlock(mod)}\n\nDEPENDENCIES' CONTRACTS:\n${depsContracts}\n\nTEST INPUT: ${testInput}\n\nCODE TO REVIEW:\n${code.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n")}\n\nCall pensar first, then review.`;
      const allBugs = [], verdicts = [];

      // Selene
      console.log(`║  │  🤖 Selene...`);
      const sel = runSelene(code);
      const selBugs = sel.warnings.map(w => ({line:w.line,problem:`[selene] ${w.msg}`,fix:`-- Fix: ${w.msg}`}));
      allBugs.push(...selBugs); verdicts.push({v:selBugs.length>0?"REJEITADO":"APROVADO",n:selBugs.length});
      console.log(`║  │  🤖 Selene: ${selBugs.length>0?"❌":"✅"} ${selBugs.length}`);

      // Logic Diff
      console.log(`║  │  📐 Logic Diff...`);
      const diffMsg = `Compare CODE against VERIFIED LOGIC for module ${moduleName}.\n\nVERIFIED LOGIC:\n${logicFlow}\n\nCODE:\n${code.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n")}\n\nDoes code match logic? Any additions/omissions?`;
      const diff = await callAgent(LOGIC_DIFF_REVIEWER, diffMsg, REVIEW_TOOLS, 3, REVIEW_TEMP);
      totalTokens += diff.tokens; totalTime += diff.elapsed;
      const diffP = parseReview(diff.content);
      allBugs.push(...diffP.bugs); verdicts.push({v:diffP.verdict,n:diffP.bugs.length});
      console.log(`║  │  📐 Logic Diff: ${diffP.verdict==="APROVADO"?"✅":diffP.verdict==="RESSALVAS"?"🟡":"❌"} ${diffP.verdict} (${diffP.bugs.length} bugs)`);

      // Standard reviewers
      for (const [prompt, label, icon] of [
        [SYNTAX_CHECKER, "Syntax", "📝"],
        [CORRECTNESS_REVIEWER, "Correctness", "🧪"],
        [API_VERIFIER, "API Verify", "🔌"],
        [EDGE_CASE_REVIEWER, "Edge Cases", "⚡"],
        [DEVILS_ADVOCATE, "Devil's Advoc", "😈"],
      ]) {
        console.log(`║  │  ${icon} ${label}...`);
        const r = await callAgent(prompt, reviewInput, REVIEW_TOOLS, 5, REVIEW_TEMP);
        const p = parseReview(r.content); totalTokens += r.tokens; totalTime += r.elapsed;
        allBugs.push(...p.bugs); verdicts.push({v:p.verdict,n:p.bugs.length});
        console.log(`║  │  ${icon} ${label}: ${p.verdict==="APROVADO"?"✅":p.verdict==="RESSALVAS"?"🟡":"❌"} ${p.verdict} (${p.bugs.length})`);
      }

      const seen = new Set();
      const unique = allBugs.filter(b => { if(seen.has(b.line)) return false; seen.add(b.line); return true; });
      const approvals = verdicts.filter(v => v.v==="APROVADO"||v.v==="RESSALVAS").length;
      console.log(`║  │  📊 ${approvals}/${verdicts.length} approved, ${unique.length} bugs`);

      if (unique.length<bestBugs) { bestBugs=unique.length; bestCode=code; bestRound=round; consecutiveWorse=0; } else consecutiveWorse++;
      history.push({round,approvals,bugs:unique.length,total:verdicts.length});

      if (unique.length===0 && approvals>=verdicts.length) {
        console.log(`║  │  🔱 Self-validation...`);
        const sv = await callAgent(HONESTY, `Code for module ${moduleName} approved. HONESTLY:\n1. Return reference to internal state?\n2. ALL variables local?\n3. What crashes it?\n4. GetAsync then SetAsync?\n5. Cross-module call signature mismatch?\n\nCode:\n${code}\n\nClean: APROVADO. Bug: REJEITADO+BUG.`, REVIEW_TOOLS, 2, REVIEW_TEMP);
        totalTokens += sv.tokens; totalTime += sv.elapsed;
        const svP = parseReview(sv.content);
        console.log(`║  │  🔱 Self-val: ${svP.verdict==="APROVADO"?"✅":"❌"} ${svP.verdict}`);
        if (svP.bugs.length===0) {
          console.log(`║  └── ✅ ALL CHECKS PASSED! Round ${round} ──┘`);
          moduleSuccess = true;
          break;
        }
        else { allBugs.push(...svP.bugs); unique.push(...svP.bugs); }
      }

      if (consecutiveWorse>=2 && bestRound<round) {
        console.log(`║  │  ⚠️ Revert to best (round ${bestRound}, ${bestBugs})`);
        code=bestCode; consecutiveWorse=0;
        console.log(`║  └──────────────────────────┘`);
        continue;
      }

      if (round<MAX_CODE_ROUNDS && unique.length>0) {
        console.log(`║  │  🔧 Surgical patching ${unique.length} bugs...`);
        const patchResult = await applySurgicalPatches(code, unique);
        totalTokens += patchResult.tokens; totalTime += patchResult.time;
        code = patchResult.code;
        console.log(`║  │  ✅ Code: ${code.split("\n").length} lines, ${patchResult.unresolved.length} unresolved`);
        console.log(`║  └──────────────────────────┘`);
      } else {
        console.log(`║  └── ⚠️ Max rounds. Best: round ${bestRound} ${bestBugs} bugs ──┘`);
      }
    }

    const finalCode = bestBugs < (history[history.length-1]?.bugs||Infinity) ? bestCode : code;
    moduleCode.set(moduleName, finalCode);
    console.log(`║\n║  📦 Module ${moduleName}: ${moduleSuccess ? "✅ SUCCESS" : `⚠️ ${bestBugs} bugs remain`} (${finalCode.split("\n").length} lines)`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
  }

  // ═══ PHASE 3: CROSS-FILE INTEGRATION ═══════════════════════════════════
  console.log(`\n📋 PHASE 3: CROSS-FILE INTEGRATION REVIEW`);
  let integrationSuccess = false;
  let integrationHistory = [];

  for (let round = 1; round <= MAX_INTEG_ROUNDS; round++) {
    console.log(`\n┌─── Integration Round ${round}/${MAX_INTEG_ROUNDS} ────────────────┐`);

    // Build full system view: all modules with contracts + code
    let systemView = `TASK: ${task}\n\nTEST INPUT: ${testInput}\n\n=== SYSTEM OVERVIEW ===\n`;
    systemView += `DAG ORDER: ${archSpec.dagOrder.join(" → ")}\n\n`;
    for (const m of archSpec.modules) {
      systemView += `\n${buildContractBlock(m)}\n\nCODE (${m.file}):\n`;
      const c = moduleCode.get(m.name) || "(no code)";
      systemView += c.split("\n").map((l,i)=>`L${i+1}: ${l}`).join("\n");
      systemView += "\n";
    }

    console.log(`│  🔌 Integration Reviewer...`);
    const review = await callAgent(INTEGRATION_REVIEWER, systemView + `\n\nVerify cross-file integration. Report bugs with FILE=<filename> L<line>.`, REVIEW_TOOLS, 5, REVIEW_TEMP);
    totalTokens += review.tokens; totalTime += review.elapsed;
    const reviewP = parseReview(review.content);
    console.log(`│  🔌 Integration: ${reviewP.verdict==="APROVADO"?"✅":reviewP.verdict==="RESSALVAS"?"🟡":"❌"} ${reviewP.verdict} (${reviewP.bugs.length} bugs)`);

    if (reviewP.bugs.length === 0 && reviewP.verdict !== "REJEITADO") {
      console.log(`│\n└─── ✅ INTEGRATION PASSED! ───┘`);
      integrationSuccess = true;
      integrationHistory.push({round, bugs: 0});
      break;
    }

    // Group bugs by file
    const bugsByFile = new Map();
    // The bug format includes FILE=<filename>; if missing, we need to infer from line context
    // Re-extract with file info from raw content
    const fileBugRe = /BUG\s*\[FILE=(\S+?)(?:\.lua)?\s+L(\d+)(?:\s*-\s*L(\d+))?\]\s*\n\s*PROBLEM:\s*(.+?)\n\s*FIX:\s*([\s\S]*?)(?=\n\s*BUG\s*\[|\n\s*VERDICT|\n\s*APROVADO|\n\s*REJEITADO|$)/gi;
    let fm;
    let rawBugs = [];
    while ((fm = fileBugRe.exec(review.content)) !== null) {
      const fix = cleanFix(fm[5]);
      if (fix && isCleanCode(fix)) {
        rawBugs.push({ file: fm[1].trim(), line: +fm[2], endLine: fm[3] ? +fm[3] : null, problem: fm[4].trim(), fix });
      }
    }
    // If no FILE= prefix, use the bugs without file info (will be hard to apply)
    if (rawBugs.length === 0) {
      // Fall back to the standard parseReview bugs (no file info)
      for (const b of reviewP.bugs) {
        // Try to find which file contains this line pattern
        // For simplicity, log them
        console.log(`│    [unknown file L${b.line}] ${b.problem.slice(0, 70)}`);
      }
      console.log(`│  ⚠️ No FILE= prefix on bugs — cannot patch automatically`);
      integrationHistory.push({round, bugs: reviewP.bugs.length});
      console.log(`└──────────────────────────────────────────────────────────────┘`);
      continue;
    }

    for (const b of rawBugs) {
      // Normalize file name (strip .lua suffix if present)
      const fileName = b.file.replace(/\.lua$/i, "");
      const moduleName = archSpec.modules.find(m => m.file === fileName + ".lua" || m.name === fileName)?.name;
      if (!moduleName) {
        console.log(`│    [unknown module ${b.file}] ${b.problem.slice(0, 70)}`);
        continue;
      }
      if (!bugsByFile.has(moduleName)) bugsByFile.set(moduleName, []);
      bugsByFile.get(moduleName).push(b);
    }

    console.log(`│  📊 Bugs by file:`);
    for (const [modName, bugs] of bugsByFile) {
      console.log(`│    ${modName}: ${bugs.length} bugs`);
    }

    // Patch each file
    for (const [moduleName, bugs] of bugsByFile) {
      const code = moduleCode.get(moduleName);
      if (!code) continue;
      console.log(`│  🔧 Patching ${moduleName} (${bugs.length} bugs)...`);
      const patchResult = await applySurgicalPatches(code, bugs);
      totalTokens += patchResult.tokens; totalTime += patchResult.time;
      moduleCode.set(moduleName, patchResult.code);
    }

    integrationHistory.push({round, bugs: rawBugs.length});
    console.log(`└──────────────────────────────────────────────────────────────┘`);
  }

  // ═══ PHASE 4: SMOKE TEST ═══════════════════════════════════════════════
  console.log(`\n📋 PHASE 4: SMOKE TEST`);
  let smokePass = true;
  for (const m of archSpec.modules) {
    const code = moduleCode.get(m.name);
    if (!code) { console.log(`  ❌ ${m.name}: no code`); smokePass = false; continue; }
    const sel = runSelene(code);
    console.log(`  ${sel.warnings.length === 0 ? "✅" : "❌"} ${m.name} (${m.file}): ${sel.warnings.length} Selene warnings`);
    if (sel.warnings.length > 0) smokePass = false;
  }

  // ═══ SUMMARY ═══════════════════════════════════════════════════════════
  const success = integrationSuccess && smokePass;
  console.log(`\n╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║  Total: ${totalTokens.toLocaleString()} tok, ${(totalTime/1000).toFixed(1)}s | API reqs: ${rateLimiterStats.requests} | waits: ${rateLimiterStats.waits} (${(rateLimiterStats.totalWaitMs/1000).toFixed(1)}s)`);
  console.log(`║  Modules: ${archSpec.modules.length} | Integration: ${integrationSuccess ? "✅" : "❌"} | Smoke: ${smokePass ? "✅" : "❌"}`);
  console.log(`║  Status: ${success ? "✅ SUCCESS (0 bugs)" : "❌ FAILURE — bugs remain"}`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  console.log(`\n📈 Integration Evolution:`);
  for (const h of integrationHistory) console.log(`   Round ${h.round}: ${h.bugs} bugs`);

  // Write final files
  try {
    mkdirSync("/home/z/my-project/download/v18-output", { recursive: true });
    for (const m of archSpec.modules) {
      const code = moduleCode.get(m.name) || "-- (no code generated)";
      writeFileSync(`/home/z/my-project/download/v18-output/${m.file}`, code);
      console.log(`   📄 Wrote ${m.file} (${code.split("\n").length} lines)`);
    }
    // Also write the spec
    let specText = `# Architecture Spec\n\nDAG: ${archSpec.dagOrder.join(" → ")}\n\n`;
    for (const m of archSpec.modules) specText += buildContractBlock(m) + "\n\n";
    writeFileSync("/home/z/my-project/download/v18-output/SPEC.md", specText);
  } catch (e) {
    console.log(`   ⚠️ Failed to write output: ${e.message}`);
  }

  // Print all final code
  console.log(`\n📄 FINAL CODE PER MODULE:`);
  for (const m of archSpec.modules) {
    const code = moduleCode.get(m.name) || "-- (no code)";
    console.log(`\n=== ${m.name} (${m.file}) ===`);
    console.log("```lua");
    console.log(code);
    console.log("```");
  }

  return { success, totalTokens, totalTime, modules: archSpec.modules.length, integrationHistory };
}

async function main() {
  const task = `Criar sistema de Economia + Inventário + Loja para Roblox (Luau) — MULTI-FILE.
Módulos:
1. DataStoreManager — base: new(dataStoreName), loadPlayer(player), savePlayer(player), unloadPlayer(player) com session locking via UpdateAsync.
2. EconomyManager — deps: DataStoreManager. new(), getBalance(player) -> number, addCoins(player, amount) -> boolean, removeCoins(player, amount) -> boolean (transacional: se não tem saldo, falha), savePlayer(player), startAutoSave(interval).
3. InventoryManager — deps: DataStoreManager. new(), addItem(player, itemId, qty) -> boolean, removeItem(player, itemId, qty) -> boolean, getItems(player) -> table (cópia), hasItem(player, itemId, qty) -> boolean, savePlayer(player), startAutoSave(interval).
4. ShopService — deps: EconomyManager + InventoryManager. buyItem(player, itemId, qty) -> boolean (ATÔMICO: removeCoins E addItem, rollback se falhar), sellItem(player, itemId, qty) -> boolean (removeItem E addCoins).
5. ShopCommands — deps: ShopService. registerCommands() para chat: "/buy <itemId> <qty>", "/sell <itemId> <qty>".
Regras: NUNCA SetAsync. TUDO UpdateAsync. TUDO local. Metatable OOP. Transações atômicas (rollback em caso de falha).`;
  const testInput = `1. loadPlayer novo. 2. addCoins 100. 3. removeCoins 50 (sucesso). 4. removeCoins 1000 (falha). 5. addItem "sword" 1. 6. buyItem "potion" 5 (custo 25 cada, total 125 — mas só tem 50 → falha). 7. addCoins 1000. 8. buyItem "potion" 5 (sucesso). 9. sellItem "potion" 5 (sucesso). 10. unloadPlayer. 11. saveAll para BindToClose. 12. startAutoSave(60). 13. loadPlayer(nil). 14. buyItem com itemId inválido.`;
  await runMultiFileDebate(task, testInput);
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
process.on("unhandledRejection", (reason) => { console.error("UNHANDLED REJECTION:", reason); });
process.on("uncaughtException", (err) => { console.error("UNCAUGHT:", err); });
