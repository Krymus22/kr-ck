/**
 * honestySystem.ts - 10-layer anti-sycophancy / anti-hallucination system.
 *
 * Each feature is independent and toggleable via the Extension Hub.
 * When enabled, they run automatically at the appropriate lifecycle point.
 *
 * Layers:
 *   1. Devil's Advocate Sub-Agent     - adversarial code review before finish
 *   2. Diff Reality Check              - verify file matches what AI claimed
 *   3. Read-Back Verification          - force IA to read file after editing
 *   4. Hallucination Detector          - check if symbols used actually exist
 *   5. Evidence Requirement            - claims must have tool call evidence
 *   6. User Claim Verification         - auto-verify user's factual claims
 *   7. Confidence-Action Mapping       - gate actions by confidence level
 *   8. Anonymous Peer Review           - blind code review (no context)
 *   9. Contradiction Tracker           - track claims across turns
 *  10. "Prove It" Mode                 - block responses without evidence
 *
 * Integration points:
 *   - agent.ts: pre-finish hook (#1, #8), post-response (#5, #9)
 *   - fileEdit.ts: post-edit (#2, #3, #4)
 *   - user message: pre-agent (#6)
 *   - think tool: confidence field (#7)
 *   - mode config: proveIt flag (#10)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface HonestyFeature {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface DevilAdvocateResult {
  issues: string[];
  severity: "none" | "low" | "medium" | "high";
  reviewed: boolean;
}

export interface DiffCheckResult {
  matches: boolean;
  missingKeywords: string[];
  message: string;
}

export interface HallucinationCheckResult {
  hallucinatedSymbols: string[];
  verifiedSymbols: string[];
  message: string;
}

export interface EvidenceCheckResult {
  unverifiedClaims: string[];
  verifiedClaims: string[];
  message: string;
}

export interface ContradictionResult {
  contradictions: Array<{ oldClaim: string; newClaim: string; turn: number }>;
  message: string;
}

// --- Feature registry ------------------------------------------------------

const FEATURES: HonestyFeature[] = [
  { id: "feature:devils_advocate", name: "Devil's Advocate", description: "Adversarial sub-agent reviews code before finishing (actively looks for bugs)", enabled: false },
  { id: "feature:diff_reality_check", name: "Diff Reality Check", description: "Verifica se o arquivo editado contem o que a IA disse que adicionou", enabled: false },
  { id: "feature:read_back_verify", name: "Read-Back Verification", description: "Forca a IA a ler o arquivo de volta apos editar antes de finalizar", enabled: false },
  { id: "feature:hallucination_detector", name: "Hallucination Detector", description: "Verifica se simbolos usados no codigo realmente existem no projeto", enabled: false },
  { id: "feature:evidence_requirement", name: "Evidence Requirement", description: "Claims factuais sem tool call de evidencia sao flagadas", enabled: false },
  { id: "feature:user_claim_verify", name: "User Claim Verification", description: "Verifica automaticamente claims factuais feitas pelo usuario", enabled: false },
  { id: "feature:confidence_mapping", name: "Confidence-Action Mapping", description: "IA deve classificar confianca (1-10) antes de agir; baixa confianca exige mais verificacao", enabled: false },
  { id: "feature:anonymous_review", name: "Anonymous Peer Review", description: "Sub-agente neutro revisa codigo as cegas (sem saber o que o usuario pediu)", enabled: false },
  { id: "feature:contradiction_tracker", name: "Contradiction Tracker", description: "Rastreia claims factuais e alerta se nova claim contradiz uma anterior", enabled: false },
  { id: "feature:prove_it_mode", name: "Prove It Mode", description: "Toda claim factual deve vir acompanhada de tool call que a comprova", enabled: false },
];

/** Get all honesty features (for Hub registration). */
export function getHonestyFeatures(): HonestyFeature[] {
  return [...FEATURES];
}

/** Check if a specific honesty feature is enabled. */
export async function isHonestyFeatureEnabled(featureId: string): Promise<boolean> {
  try {
    const { getExtension } = await import("./extensionCenter.js");
    const ext = getExtension(featureId);
    return ext?.enabled ?? false;
  } catch {
    return false;
  }
}

// --- 1. Devil's Advocate Sub-Agent -----------------------------------------

/**
 * Run a Devil's Advocate sub-agent that adversarially reviews the code
 * the main agent just wrote. Returns issues found.
 *
 * The sub-agent receives ONLY the diff/code (not the user's request),
 * so it has no incentive to agree with anything.
 */
export async function runDevilsAdvocate(
  editedFiles: Array<{ path: string; content: string }>,
  agentClaims: string
): Promise<DevilAdvocateResult> {
  if (!(await isHonestyFeatureEnabled("feature:devils_advocate"))) {
    return { issues: [], severity: "none", reviewed: false };
  }

  try {
    const { runSubAgent } = await import("./subAgents.js");
    const codeSummary = editedFiles
      .map((f) => `### ${path.basename(f.path)}\n\`\`\`\n${f.content.slice(0, 4000)}\n\`\`\``)
      .join("\n\n");

    const question = `Review this code adversarially. Find ALL problems: bugs, edge cases, nil propagation, race conditions, missing error handling, incorrect API usage, type mismatches. Be BRUTAL. If you find nothing wrong, say "Nada encontrado" - but try hard first.

Code to review:
${codeSummary}

Agent's claims about what it did:
${agentClaims.slice(0, 1000)}

List every issue you find. If none, say "Nada encontrado".`;

    const result = await runSubAgent({ question, powerful: false, maxToolCalls: 5 });
    if (!result) {
      return { issues: [], severity: "none", reviewed: false };
    }

    // Parse severity from result
    const lower = result.toLowerCase();
    let severity: DevilAdvocateResult["severity"] = "none";
    if (lower.includes("crITICAL") || lower.includes("grave") || lower.includes("high")) severity = "high";
    else if (lower.includes("medium") || lower.includes("medio") || lower.includes("moderado")) severity = "medium";
    else if (lower.includes("low") || lower.includes("baixo") || lower.includes("leve")) severity = "low";
    else if (!lower.includes("nada encontrado")) severity = "medium"; // default if issues found

    const issues = result
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*") || /^\d+\./.test(l.trim()))
      .map((l) => l.trim())
      .slice(0, 10);

    log.info(`[HONESTY:DevilsAdvocate] severity=${severity}, issues=${issues.length}`);
    return { issues, severity, reviewed: true };
  } catch (err) {
    log.warn(`[HONESTY:DevilsAdvocate] failed: ${(err as Error).message}`);
    return { issues: [], severity: "none", reviewed: false };
  }
}

// --- 2. Diff Reality Check --------------------------------------------------

/**
 * After editing a file, read it back and verify that the keywords the AI
 * mentioned in its response are actually present in the file.
 *
 * Example: AI says "I added try-catch" but the file doesn't contain "try" or "catch".
 */
export async function diffRealityCheck(
  filePath: string,
  agentResponse: string
): Promise<DiffCheckResult> {
  if (!(await isHonestyFeatureEnabled("feature:diff_reality_check"))) {
    return { matches: true, missingKeywords: [], message: "" };
  }

  try {
    if (!fs.existsSync(filePath)) {
      return { matches: true, missingKeywords: [], message: "" };
    }
    const content = fs.readFileSync(filePath, "utf8").toLowerCase();

    const claimPatterns = [
      { regex: /added\s+(?:a\s+)?try[-\s]?catch/i, keywords: ["try", "catch"] },
      { regex: /adicion(?:ei|ou)\s+(?:um\s+)?try[-\s]?catch/i, keywords: ["try", "catch"] },
      { regex: /added\s+(?:error|exception)\s+handling/i, keywords: ["error", "catch"] },
      { regex: /adicion(?:ei|ou)\s+tratamento\s+de\s+erro/i, keywords: ["error", "catch"] },
      { regex: /added\s+(?:a\s+)?guard\s+clause/i, keywords: ["if"] },
      { regex: /added\s+(?:a\s+)?nil\s+check/i, keywords: ["if"] },
      { regex: /added\s+(?:a\s+)?validation/i, keywords: ["if"] },
      { regex: /added\s+(?:a\s+)?test/i, keywords: ["it(", "describe(", "test("] },
      { regex: /cri(?:ei|ou)\s+(?:um\s+)?teste/i, keywords: ["it(", "describe(", "test("] },
      { regex: /added\s+(?:a\s+)?comment/i, keywords: ["--", "//"] },
    ];

    const expectedKeywords: string[] = [];
    for (const { regex, keywords } of claimPatterns) {
      if (regex.test(agentResponse)) {
        expectedKeywords.push(...keywords);
      }
    }

    // Check which expected keywords are missing
    const missing = expectedKeywords.filter((kw) => !content.includes(kw.toLowerCase()));
    const uniqueMissing = [...new Set(missing)];

    if (uniqueMissing.length === 0) {
      return { matches: true, missingKeywords: [], message: "" };
    }

    const msg = `[DIFF REALITY CHECK] Você disse que adicionou algo, mas as seguintes keywords NÃO foram encontradas no arquivo ${path.basename(filePath)}: ${uniqueMissing.join(", ")}. Verifique se a edição foi aplicada corretamente.`;
    log.warn(`[HONESTY:DiffCheck] ${msg}`);
    return { matches: false, missingKeywords: uniqueMissing, message: msg };
  } catch (err) {
    log.debug(`[HONESTY:DiffCheck] error: ${(err as Error).message}`);
    return { matches: true, missingKeywords: [], message: "" };
  }
}

// --- 3. Read-Back Verification ---------------------------------------------

/**
 * Tracks whether the AI read a file back after editing it.
 * The agent loop checks this before allowing finish_reason.
 */
const filesEditedButNotReadBack = new Set<string>();

/** Called by fileEdit.ts after a successful write. */
export function markFileAsEdited(filePath: string): void {
  filesEditedButNotReadBack.add(path.resolve(filePath));
}

/** Called by agent.ts when ler_arquivo is called. */
export function markFileAsReadBack(filePath: string): void {
  filesEditedButNotReadBack.delete(path.resolve(filePath));
}

/** Returns true if there are files that were edited but not read back. */
export async function hasUnreadBackFiles(): Promise<boolean> {
  if (!(await isHonestyFeatureEnabled("feature:read_back_verify"))) {
    return false;
  }
  return filesEditedButNotReadBack.size > 0;
}

/** Returns the list of files that were edited but not read back. */
export function getUnreadBackFiles(): string[] {
  return Array.from(filesEditedButNotReadBack);
}

/** Get the warning message for unread files. */
export function getReadBackWarning(): string {
  const files = getUnreadBackFiles();
  if (files.length === 0) return "";
  const fileList = files.map((f) => `  - ${path.basename(f)}`).join("\n");
  return `[READ-BACK REQUIRED] You edited these files but did not read them back to confirm:\n${fileList}\n\nUse ler_arquivo on each before finishing. Verify the code is as you expect.`;
}

// --- 4. Hallucination Detector ---------------------------------------------

/**
 * Check if symbols (function names, method calls) used in the edited code
 * actually exist in the project. Uses the impact analyzer's symbol extraction.
 */
export async function detectHallucinations(
  filePath: string,
  content: string
): Promise<HallucinationCheckResult> {
  if (!(await isHonestyFeatureEnabled("feature:hallucination_detector"))) {
    return { hallucinatedSymbols: [], verifiedSymbols: [], message: "" };
  }

  try {
    const { extractSymbols } = await import("./impactAnalyzer.js");

    // Extract function/method calls from the content (heuristic: word followed by paren)
    const callPattern = /([A-Za-z_][A-Za-z0-9_]*)(?:[:.]\w+)?\s*\(/g;
    const calls = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(content)) !== null) {
      const name = match[1]!;
      // Skip language keywords and common patterns
      if (["if", "for", "while", "function", "return", "local", "and", "or", "not", "print", "require", "type", "typeof", "tostring", "tonumber", "pairs", "ipairs", "next", "select", "assert", "error", "pcall", "setmetatable", "getmetatable", "rawget", "rawset", "rawequal", "unpack", "string", "table", "math", "os", "io", "coroutine", "task"].includes(name)) continue;
      if (name.length < 3) continue;
      calls.add(name);
    }

    // Check which calls exist as defined symbols in the same file
    const definedSymbols = extractSymbols(filePath, content).map((s) => s.name);
    const verified: string[] = [];
    const hallucinated: string[] = [];

    for (const call of calls) {
      if (definedSymbols.includes(call)) {
        verified.push(call);
      } else {
        // Check if it's a Roblox API (common service calls)
        const robloxApis = ["GetService", "FindFirstChild", "WaitForChild", "GetChildren", "GetDescendants", "Destroy", "Clone", "Connect", "Wait", "Fire", "InvokeServer", "InvokeClient", "SetAsync", "GetAsync", "UpdateAsync", "RemoveAsync", "IncrementAsync", "Instance", "Vector3", "CFrame", "Color3", "UDim2", "UDim", "TweenInfo", "Ray", "Region3", "BrickColor"];
        if (robloxApis.includes(call) || call.startsWith("Get") || call.startsWith("Set") || call.startsWith("Is")) {
          verified.push(call); // Assume built-in API
        } else {
          hallucinated.push(call);
        }
      }
    }

    if (hallucinated.length === 0) {
      return { hallucinatedSymbols: [], verifiedSymbols: verified, message: "" };
    }

    const msg = `[HALLUCINATION DETECTOR] As seguintes funções/métodos foram usados em ${path.basename(filePath)} mas não foram definidos neste arquivo: ${hallucinated.join(", ")}. Verifique se elas existem em outro arquivo (require) ou se são APIs válidas. Se não existem, você pode estar alucinando.`;
    log.warn(`[HONESTY:Hallucination] ${msg}`);
    return { hallucinatedSymbols: hallucinated, verifiedSymbols: verified, message: msg };
  } catch (err) {
    log.debug(`[HONESTY:Hallucination] error: ${(err as Error).message}`);
    return { hallucinatedSymbols: [], verifiedSymbols: [], message: "" };
  }
}

// --- 5. Evidence Requirement ------------------------------------------------

/** Claims that require evidence (tool calls). */
const CLAIM_PATTERNS = [
  { pattern: /(?:testes?|tests?)\s*(?:pass(?:aram|am)|pass|passing)/i, tool: "executar_testes", claim: "testes passam" },
  { pattern: /(?:código|code)\s*(?:funciona|works|working)/i, tool: "executar_comando", claim: "código funciona" },
  { pattern: /(?:validado|validated|verificado|verified)/i, tool: null, claim: "validado/verificado" },
  { pattern: /(?:está|is)\s*(?:correto|correct|certo|right)/i, tool: null, claim: "está correto" },
  { pattern: /(?:sem|no|without)\s*(?:erros?|errors?|bugs?)/i, tool: null, claim: "sem erros" },
  { pattern: /(?:API|api)\s*(?:existe|exists|válida|valid)/i, tool: "pesquisar_api_atualizada", claim: "API existe/é válida" },
  { pattern: /(?:atualizado|updated|latest)/i, tool: "pesquisar_api_atualizada", claim: "está atualizado" },
];

/**
 * Check if the agent's response contains factual claims that lack
 * supporting tool calls in the conversation history.
 */
export async function checkEvidenceRequirement(
  agentResponse: string,
  toolCallHistory: string[]
): Promise<EvidenceCheckResult> {
  if (!(await isHonestyFeatureEnabled("feature:evidence_requirement"))) {
    return { unverifiedClaims: [], verifiedClaims: [], message: "" };
  }

  const unverified: string[] = [];
  const verified: string[] = [];

  for (const { pattern, tool, claim } of CLAIM_PATTERNS) {
    if (pattern.test(agentResponse)) {
      if (tool && toolCallHistory.includes(tool)) {
        verified.push(claim);
      } else if (tool) {
        unverified.push(`"${claim}" (deveria ter chamado ${tool})`);
      } else {
        // Generic claim without specific tool requirement - flag if no verification tools were called
        const hasVerification = toolCallHistory.some((t) =>
          ["executar_testes", "executar_comando", "ler_arquivo", "pesquisar_api_atualizada"].includes(t)
        );
        if (!hasVerification) {
          unverified.push(`"${claim}" (no verification tool was called)`);
        } else {
          verified.push(claim);
        }
      }
    }
  }

  if (unverified.length === 0) {
    return { unverifiedClaims: [], verifiedClaims: verified, message: "" };
  }

  const msg = `[EVIDENCE REQUIRED] As seguintes claims não têm evidência (tool calls) que as suportem:\n${unverified.map((c) => `  - ${c}`).join("\n")}\n\nVerifique antes de afirmar. Use a tool apropriada (executar_testes, executar_comando, etc) ou diga "preciso verificar" em vez de afirmar.`;
  log.warn(`[HONESTY:Evidence] ${msg}`);
  return { unverifiedClaims: unverified, verifiedClaims: verified, message: msg };
}

// --- 6. User Claim Verification --------------------------------------------

/** Patterns that look like factual claims from the user. */
const USER_CLAIM_PATTERNS = [
  { pattern: /(?:tem|has|have)\s+(\d+)\s*(?:linhas?|lines?)/i, type: "line_count" },
  { pattern: /(?:usa|uses|using)\s+(react|vue|angular|svelte|roblox|terraform|kubernetes)/i, type: "tech_stack" },
  { pattern: /(?:já|already)\s*(?:tem|has|have|configured|configurado)\s+(\w+)/i, type: "has_feature" },
  { pattern: /(?:está|is)\s*(?:funcionando|working|configured|configurado)/i, type: "is_working" },
];

/**
 * Check if the user's message contains factual claims that should be verified
 * before the AI agrees with them.
 *
 * Returns a list of claims that need verification.
 */
export async function checkUserClaims(
  userMessage: string
): Promise<{ claims: string[]; message: string }> {
  if (!(await isHonestyFeatureEnabled("feature:user_claim_verify"))) {
    return { claims: [], message: "" };
  }

  const claims: string[] = [];
  for (const { pattern, type } of USER_CLAIM_PATTERNS) {
    const match = userMessage.match(pattern);
    if (match) {
      claims.push(`User claimed: "${match[0]}" (type: ${type}) - VERIFY before agreeing`);
    }
  }

  if (claims.length === 0) {
    return { claims: [], message: "" };
  }

  const msg = `[USER CLAIM VERIFICATION] O usuário fez as seguintes claims factuais. VERIFIQUE cada uma antes de concordar:\n${claims.map((c) => `  - ${c}`).join("\n")}`;
  log.info(`[HONESTY:UserClaims] ${msg}`);
  return { claims, message: msg };
}

// --- 7. Confidence-Action Mapping ------------------------------------------

/**
 * Extract confidence level from a pensar() call.
 * Returns 0 if no confidence was provided.
 *
 * BUG FIX (audit issue #5): previously only recognized the literal pattern
 * `confian[çc]a: N` where N is an integer 0-9. Common variants like
 * `100%`, `1.0`, `high`/`medium`/`low` were silently ignored, returning 0
 * even when the model clearly stated a confidence level.
 *
 * Now recognizes:
 *   - "confian[çc]a: 8"        → 8
 *   - "confian[çc]a: 8/10"     → 8
 *   - "confian[çc]a: 80%"      → 8 (normalized 0-100 → 0-10)
 *   - "confidence: 0.8"        → 8 (decimal 0-1 → 0-10)
 *   - "confidence: high"       → 9 (qualitative high → 9/10)
 *   - "confidence: medium"     → 6 (qualitative medium → 6/10)
 *   - "confidence: low"        → 3 (qualitative low → 3/10)
 *   - "confidence: 5/10"       → 5
 *
 * Accepts both PT ("confianca"/"confiança") and EN ("confidence") spellings,
 * with `:` or `=` as separator, case-insensitive.
 *
 * Returned value is always clamped to [1, 10] (matching the 1-10 scale used
 * by checkConfidenceAction below).
 */
export function extractConfidence(pensarContent: string): number {
  const text = pensarContent.toLowerCase();

  // 1. Try numeric pattern: "confian[çc]a: N" or "confidence: N"
  //    Accepts N as integer (0-10 or 0-100), decimal (0.0-1.0 or 0.0-10.0),
  //    or fraction (N/10 or N/100).
  const numericMatch = text.match(/confian[cç]a\s*[:=]\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?%?|confidence\s*[:=]\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?%?/i);
  if (numericMatch) {
    const rawStr = numericMatch[1] ?? numericMatch[3] ?? "0";
    const raw = parseFloat(rawStr);
    const denom = numericMatch[2] ?? numericMatch[4] ?? null;
    const hadPercentSign = /%/i.test(numericMatch[0] ?? "");
    // BUG FIX (P-1 property test): distinguir inteiro "1" (escala 1-10) de
    // decimal "1.0" (escala 0.0-1.0). Antes, ambos caíam no branch
    // `raw <= 1.0` e eram multiplicados por 10 — assim "confianca: 1"
    // retornava 10 (confiança MÁXIMA), bypassando o gate confidence <= 3
    // do checkConfidenceAction. Agora só multiplicamos por 10 quando o
    // match contém explicitamente um ponto decimal.
    const hasDecimalPoint = rawStr.includes(".");

    let normalized: number;
    if (hadPercentSign || raw > 10) {
      // 0-100 scale (percent or large integer) → divide by 10
      normalized = raw / 10;
    } else if (denom !== null) {
      // explicit fraction like "8/10" or "80/100"
      const d = parseInt(denom, 10);
      normalized = d === 100 ? raw / 10 : d === 10 ? raw : raw / 10;
    } else if (hasDecimalPoint && raw <= 1.0) {
      // decimal 0.0-1.0 (com ponto explícito) → multiply by 10
      normalized = raw * 10;
    } else {
      // 1-10 integer scale — use as-is
      normalized = raw;
    }
    return Math.max(1, Math.min(10, Math.round(normalized)));
  }

  // 2. Try qualitative pattern: "confidence: high|medium|low"
  //    Also accepts PT: "alta|média|media|baixa"
  const qualitativeMatch = text.match(/confian[cç]a\s*[:=]\s*(\w+)|confidence\s*[:=]\s*(\w+)/i);
  if (qualitativeMatch) {
    const word = (qualitativeMatch[1] ?? qualitativeMatch[2] ?? "").toLowerCase();
    if (["high", "alta", "alto", "muito alta", "very high"].includes(word)) return 9;
    if (["medium", "media", "media", "medio", "medio", "moderate"].includes(word)) return 6;
    if (["low", "baixa", "baixo", "muito baixa", "very low"].includes(word)) return 3;
  }

  return 0; // not provided
}

/**
 * Check if the confidence level is too low for the action being taken.
 * Returns a warning message if confidence is low and no verification was done.
 */
export async function checkConfidenceAction(
  confidence: number,
  actionType: "write" | "finish"
): Promise<{ blocked: boolean; message: string }> {
  if (!(await isHonestyFeatureEnabled("feature:confidence_mapping"))) {
    return { blocked: false, message: "" };
  }

  if (confidence === 0) {
    // Confidence not provided - warn but don't block
    return {
      blocked: false,
      message: "[CONFIDENCE] You did not provide confidence level (1-10) in pensar(). Consider adding: confianca: N",
    };
  }

  if (actionType === "write" && confidence <= 3) {
    return {
      blocked: true,
      message: `[CONFIDENCE LOW] Confiança=${confidence}/10. Too low to write. Research more (ler_arquivo) before editing.`,
    };
  }

  if (actionType === "finish" && confidence <= 5) {
    return {
      blocked: false,
      message: `[CONFIDENCE MEDIUM] Confiança=${confidence}/10. Consider running tests (executar_testes) before finishing.`,
    };
  }

  return { blocked: false, message: "" };
}

// --- 8. Anonymous Peer Review ----------------------------------------------

/**
 * Run a blind code review sub-agent. Unlike Devil's Advocate (adversarial),
 * this one is neutral - it just reviews the code without knowing what was
 * asked or what the user expects.
 */
export async function runAnonymousReview(
  editedFiles: Array<{ path: string; content: string }>
): Promise<{ issues: string[]; reviewed: boolean }> {
  if (!(await isHonestyFeatureEnabled("feature:anonymous_review"))) {
    return { issues: [], reviewed: false };
  }

  try {
    const { runSubAgent } = await import("./subAgents.js");
    const code = editedFiles
      .map((f) => `### ${path.basename(f.path)}\n\`\`\`\n${f.content.slice(0, 4000)}\n\`\`\``)
      .join("\n\n");

    const question = `Review this code. List ALL problems you find: bugs, missing error handling, type issues, race conditions, nil propagation, incorrect API usage. Be objective. If code is good, say "Code looks good".

${code}`;

    const result = await runSubAgent({ question, powerful: false, maxToolCalls: 3 });
    if (!result) {
      return { issues: [], reviewed: false };
    }

    const issues = result
      .split("\n")
      .filter((l) => l.trim().startsWith("-") || l.trim().startsWith("*") || /^\d+\./.test(l.trim()))
      .map((l) => l.trim())
      .slice(0, 10);

    log.info(`[HONESTY:AnonymousReview] reviewed=${true}, issues=${issues.length}`);
    return { issues, reviewed: true };
  } catch (err) {
    log.warn(`[HONESTY:AnonymousReview] failed: ${(err as Error).message}`);
    return { issues: [], reviewed: false };
  }
}

// --- 9. Contradiction Tracker -----------------------------------------------

/** Store of claims made by the AI across turns. */
const claimStore: Array<{ claim: string; turn: number; value?: string }> = [];
let currentTurn = 0;

/** Increment turn counter (called at start of each user turn). */
export function incrementTurn(): void {
  currentTurn++;
}

/** Extract version-like and numeric claims from agent response. */
function extractClaims(text: string): Array<{ claim: string; value?: string }> {
  const claims: Array<{ claim: string; value?: string }> = [];

  // Version numbers: "X 7.6.1", "version 0.31.0", "v2.0"
  const versionPattern = /(\w+)\s+(?:version\s+)?(?:v)?(\d+\.\d+(?:\.\d+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = versionPattern.exec(text)) !== null) {
    claims.push({ claim: match[1]!.toLowerCase(), value: match[2] });
  }

  // Counts: "1695 tests", "43k lines"
  const countPattern = /(\d+)\s+(tests?|lines?|files?|funções?|functions?)/gi;
  while ((match = countPattern.exec(text)) !== null) {
    claims.push({ claim: match[2]!.toLowerCase(), value: match[1] });
  }

  return claims;
}

/**
 * Check if the agent's response contradicts any previous claim.
 * Returns contradictions found.
 */
export async function checkContradictions(
  agentResponse: string
): Promise<ContradictionResult> {
  if (!(await isHonestyFeatureEnabled("feature:contradiction_tracker"))) {
    return { contradictions: [], message: "" };
  }

  const newClaims = extractClaims(agentResponse);
  const contradictions: Array<{ oldClaim: string; newClaim: string; turn: number }> = [];

  for (const newClaim of newClaims) {
    // Check if this claim was made before with a different value
    const previous = claimStore.filter((c) => c.claim === newClaim.claim && c.value !== newClaim.value);
    for (const prev of previous) {
      contradictions.push({
        oldClaim: `${prev.claim}=${prev.value} (turno ${prev.turn})`,
        newClaim: `${newClaim.claim}=${newClaim.value} (turno ${currentTurn})`,
        turn: prev.turn,
      });
    }
  }

  // Store new claims
  for (const claim of newClaims) {
    claimStore.push({ ...claim, turn: currentTurn });
  }

  // Prune old claims (keep last 100)
  if (claimStore.length > 100) {
    claimStore.splice(0, claimStore.length - 100);
  }

  if (contradictions.length === 0) {
    return { contradictions: [], message: "" };
  }

  const msg = `[CONTRADICTION DETECTED] You made claims that contradict earlier claims:\n${contradictions.map((c) => `  - Before: ${c.oldClaim} | Now: ${c.newClaim}`).join("\n")}\n\nWhich one is correct? Verify before continuing.`;
  log.warn(`[HONESTY:Contradiction] ${msg}`);
  return { contradictions, message: msg };
}

// --- 10. "Prove It" Mode ----------------------------------------------------

/**
 * Check if "Prove It" mode is active (via mode config).
 * When active, ALL factual claims in the response must have supporting
 * tool calls in history. Claims without evidence block the response.
 */
export async function isProveItModeActive(): Promise<boolean> {
  if (!(await isHonestyFeatureEnabled("feature:prove_it_mode"))) {
    return false;
  }
  // Also check if active mode has proveIt flag (future: add to ModeDefinition)
  return true; // If feature is enabled in Hub, it's active
}

/**
 * Combined evidence check for Prove It mode.
 * Stricter than Evidence Requirement - BLOCKS the response entirely.
 */
export async function proveItCheck(
  agentResponse: string,
  toolCallHistory: string[]
): Promise<{ blocked: boolean; message: string }> {
  const active = await isProveItModeActive();
  if (!active) {
    return { blocked: false, message: "" };
  }

  const evidence = await checkEvidenceRequirement(agentResponse, toolCallHistory);
  if (evidence.unverifiedClaims.length > 0) {
    return {
      blocked: true,
      message: `[PROVE IT MODE] Response blocked. Unverified claims:\n${evidence.unverifiedClaims.map((c) => `  - ${c}`).join("\n")}\n\nUse an appropriate tool to verify each claim before responding.`,
    };
  }
  return { blocked: false, message: "" };
}

// --- Reset / cleanup --------------------------------------------------------

/** Reset per-turn state (called at start of each user turn). */
export function resetHonestyTurn(): void {
  filesEditedButNotReadBack.clear();
  incrementTurn();
}

/** Clear all state (for tests). */
export function clearAllHonestyState(): void {
  filesEditedButNotReadBack.clear();
  claimStore.length = 0;
  currentTurn = 0;
}
