/**
 * mutation-medium-bugs1.test.ts — Targeted tests to kill MEDIUM priority
 * survived mutations identified by the mutation analyst in the following
 * files:
 *
 *   - src/researchHint.ts     (keyword classification logic)
 *   - src/honestySystem.ts    (L148-155 severity classification)
 *   - src/safetyReviewer.ts   (L218,222,225 JSON risk parsing)
 *   - src/dynamicWorkflow.ts  (L70,85 success/failure reporting)
 *   - src/promiseDetector.ts  (L205 crash on undefined input)
 *
 * Each `it(...)` block documents which mutation it kills and why the
 * pre-existing test suite let that mutation survive.
 *
 * NOTE: BUSINESS_RULES.md was referenced by the task brief but does not
 * exist in this repository. No §17 rule could therefore be read or
 * violated; this file follows the rest of the codebase's conventions
 * (vitest, `import`, no `require()`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── researchHint.ts ────────────────────────────────────────────────────────

import { detectResearchTrigger, generateResearchHint } from "../researchHint.js";

describe("mutation-killers / researchHint.ts — keyword classification", () => {
  /**
   * Mutation: L167 `if (hasCurrentState && hasVolatileTopic)` → `||`
   *
   * Survived because the existing test for "Anime Fighters simulator roblox"
   * only asserts `not.toBeNull()`. With `||`, the condition becomes
   * `false || true` = true (volatile topic present, no current_state), so
   * the function falls into the current_state branch and returns
   * "current_state" instead of "specific_product". Both are non-null, so
   * the loose assertion passes.
   *
   * Fix: assert the EXACT trigger kind.
   */
  it("returns 'specific_product' (not 'current_state') for volatile+entity without current_state", () => {
    const result = detectResearchTrigger("Anime Fighters simulator roblox");
    expect(result).toBe("specific_product");
  });

  /**
   * Mutation: L185 `if (hasVolatileTopic && isSpecificEntityQuery(q))` → `||`
   *
   * Survived because no test exercises a query that is a "specific entity"
   * (quoted / game-pattern) WITHOUT a volatile topic. With `||`, such a
   * query would erroneously return "specific_product".
   *
   * Fix: provide a quoted, non-volatile query and assert it returns null.
   */
  it("returns null for a quoted string with no volatile topic", () => {
    // 20+ chars, no volatile topic, no current_state, no timeless topic,
    // but isSpecificEntityQuery=true because of the double quotes.
    const result = detectResearchTrigger('tell me about "some random phrase"');
    expect(result).toBeNull();
  });

  /**
   * Mutation: L218 `if (q.includes('"') || q.includes("'")) return true;`
   *           `||` → `&&`
   *
   * Survived because the existing test for `me fale sobre "Anime Fighters"`
   * only asserts `not.toBeNull()`. With `&&`, isSpecificEntityQuery returns
   * false for queries that contain only `"` (no `'`). But because the
   * query ALSO contains the volatile topic "anime fighters", the
   * hasVolatileTopic && isSpecificEntityQuery at L185 is `true && false` =
   * false, so the function returns null instead of "specific_product".
   *
   * Wait — the existing assertion is `not.toBeNull()`, which would FAIL
   * under the mutation. So this test already kills it… but only by
   * accident: if "Anime Fighters" ever gets removed from VOLATILE_TOPICS,
   * the assertion would silently become a false positive. We pin the exact
   * return value to make the kill explicit and robust.
   */
  it("returns 'specific_product' for a quoted volatile product name", () => {
    const result = detectResearchTrigger('me fale sobre "Anime Fighters"');
    expect(result).toBe("specific_product");
  });

  /**
   * Mutation: L137 `if (q.length < 10) return null;` → `<=`
   *
   * Survived because no test exercises a query of EXACTLY 10 characters.
   * With `<=`, a 10-char query that should trigger is wrongly rejected.
   *
   * Fix: "news about" is exactly 10 chars and should trigger recent_news.
   */
  it("triggers for a 10-character news query (boundary of length<10 check)", () => {
    // "news about" is 10 chars (n-e-w-s- -a-b-o-u-t). The `< 10` check
    // must NOT reject it; `<= 10` would.
    const result = detectResearchTrigger("news about");
    expect(result).toBe("recent_news");
  });

  /**
   * Mutation: L150 `if (hasTimelessTopic && !hasVolatileTopic) return null;`
   *           `&&` → `||`
   *
   * Existing tests already kill this (e.g. "what happened in AI this week"),
   * but we add an explicit assertion to lock the behavior: a query that is
   * BOTH timeless AND volatile should NOT be suppressed at L150 (it should
   * fall through to the current_state + volatile branch).
   *
   * Example: "what is the latest version of the HTTP framework" — HTTP is
   * timeless, "framework" is volatile, "latest version" is current_state.
   * Original returns version_info. Mutated `||` would also return
   * version_info (because the mutated condition `true || false` = true
   * returns null, which is DIFFERENT). So this kills the mutation.
   */
  it("does NOT suppress trigger when both timeless and volatile topics are present", () => {
    const result = detectResearchTrigger("what is the latest version of the HTTP framework?");
    // Original: returns "version_info" (volatile + current_state + version keyword)
    // Mutated `||` at L150: returns null (suppressed early)
    expect(result).toBe("version_info");
  });

  /**
   * Mutation: L162 `if (isNewsQuery && !hasTimelessTopic)` → `!hasTimelessTopic`
   *           becomes `hasTimelessTopic` (remove negation)
   *
   * Existing tests already kill this. We add an explicit test for a news
   * query WITHOUT a timeless topic to make the kill robust.
   */
  it("returns 'recent_news' for news query without timeless topic", () => {
    const result = detectResearchTrigger("notícias sobre OpenAI");
    expect(result).toBe("recent_news");
  });

  /**
   * Mutation: L169-170 version keyword check `||` → `&&`
   *
   * If the version check requires ALL keywords instead of ANY, "version"
   * alone wouldn't match. Test that a query with only "version" (English)
   * still triggers version_info.
   */
  it("returns 'version_info' for query with only the 'version' keyword", () => {
    const result = detectResearchTrigger("what is the version of the react library?");
    expect(result).toBe("version_info");
  });

  /**
   * Mutation: L174-175 news keyword check `||` → `&&`
   *
   * If the news check requires ALL keywords, "happened" alone wouldn't match.
   */
  it("returns 'recent_news' for current_state+volatile query with 'happened'", () => {
    // "what happened with the claude api" — has current_state ("what"),
    // volatile ("claude", "api"), news keyword ("happened"). Should return
    // recent_news (L174-175 match before falling through to current_state).
    const result = detectResearchTrigger("what happened with the claude api?");
    expect(result).toBe("recent_news");
  });

  /**
   * Mutation: L221 simulator regex `return true` removed (block removal)
   *
   * Existing test "Anime Fighters simulator roblox" only asserts
   * `not.toBeNull()`. With the return removed, isSpecificEntityQuery
   * returns false, but the query still has volatile topic "roblox" +
   * "simulator". L185 returns false. Function returns null. The existing
   * `not.toBeNull()` assertion catches this. We pin the exact value.
   */
  it("isSpecificEntityQuery: simulator pattern returns 'specific_product'", () => {
    const result = detectResearchTrigger("blobfish simulator roblox");
    expect(result).toBe("specific_product");
  });

  /**
   * Mutation: L218 quotes check `return true` removed
   *
   * Pin exact return for a query that ONLY triggers via the quote branch
   * of isSpecificEntityQuery (no simulator pattern, has volatile topic,
   * NO current_state keyword — otherwise the current_state branch at L167
   * would intercept before L185 is reached).
   */
  it("isSpecificEntityQuery: single-quote triggers 'specific_product' for volatile topic", () => {
    // "'roblox' is interesting" — no current_state keyword ("is" alone
    // is not in CURRENT_STATE_KEYWORDS), has volatile topic "roblox",
    // matches the quote branch of isSpecificEntityQuery.
    const result = detectResearchTrigger("'roblox' is interesting");
    expect(result).toBe("specific_product");
  });

  /**
   * Mutation: generateResearchHint `?? null` → `|| null` (or similar)
   *
   * Pin the exact hint text for each trigger to catch any keyword/text
   * mutation in the hints map.
   */
  it("generateResearchHint: each trigger returns its specific hint text", () => {
    expect(generateResearchHint("specific_product", "x")).toContain("specific product");
    expect(generateResearchHint("current_state", "x")).toContain("CURRENT STATE");
    expect(generateResearchHint("version_info", "x")).toContain("VERSIONS");
    expect(generateResearchHint("recent_news", "x")).toContain("RECENT EVENTS");
    expect(generateResearchHint("factual_claim", "x")).toContain("factual claim");
  });
});

// ─── honestySystem.ts (L148-155 severity classification) ────────────────────

// Mock apiClient.chat so runDevilsAdvocate is deterministic.
vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../activityTracker.js", () => ({ pushActivity: vi.fn(() => () => {}) }));

// Enable the feature:devils_advocate feature flag so runDevilsAdvocate
// doesn't short-circuit at L114-116 (which returns severity="none"
// regardless of what the LLM says).
vi.mock("../extensionCenter.js", () => ({
  getExtension: vi.fn((id: string) =>
    id === "feature:devils_advocate"
      ? { id, name: "Devil's Advocate", enabled: true, triggerMode: "on_task" }
      : { id, name: id, enabled: false, triggerMode: "disabled" }
  ),
}));

// Mock subAgents.runSubAgent — runDevilsAdvocate calls it via dynamic
// import. Without this mock, the function would try to spawn a real
// sub-agent and the chatMock below would never be consulted.
vi.mock("../subAgents.js", () => ({
  runSubAgent: vi.fn(),
}));

import { chat } from "../apiClient.js";
const chatMock = vi.mocked(chat);

import { runSubAgent } from "../subAgents.js";
const runSubAgentMock = vi.mocked(runSubAgent);

import { runDevilsAdvocate, clearAllHonestyState } from "../honestySystem.js";

describe("mutation-killers / honestySystem.ts L148-155 — severity classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllHonestyState();
  });

  /**
   * The existing tests at honestySystem-deep.test.ts L82-135 only assert
   * `typeof result.severity === "string"`. This lets ANY mutation in the
   * if/else-if cascade at L148-151 survive, because every branch produces
   * a string (including the "none" branch when the feature is disabled,
   * which is what the existing tests actually exercise).
   *
   * Each test below pins the EXACT severity value for one branch. We mock
   * runSubAgent to return the content that the LLM would have produced,
   * and enable the feature flag so runDevilsAdvocate reaches L139-151.
   */

  it("severity='high' when LLM mentions 'critical'", async () => {
    runSubAgentMock.mockResolvedValue("Found a critical bug");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("high");
  });

  it("severity='high' when LLM mentions 'grave' (PT)", async () => {
    runSubAgentMock.mockResolvedValue("Achei um problema grave aqui");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("high");
  });

  it("severity='high' when LLM mentions 'high'", async () => {
    runSubAgentMock.mockResolvedValue("high risk issue");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("high");
  });

  /**
   * Mutation: L148 `|| lower.includes("high")` removed.
   *
   * If "high" is removed from L148, a message with only "high" (no
   * "critical" or "grave") would fall through to L149 (medium) or L151
   * (default medium). Test catches this.
   */

  it("severity='medium' when LLM mentions 'medium'", async () => {
    runSubAgentMock.mockResolvedValue("medium severity issue");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("medium");
  });

  it("severity='medium' when LLM mentions 'moderado' (PT)", async () => {
    runSubAgentMock.mockResolvedValue("problema moderado encontrado");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("medium");
  });

  it("severity='low' when LLM mentions 'low'", async () => {
    runSubAgentMock.mockResolvedValue("low impact issue");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("low");
  });

  it("severity='low' when LLM mentions 'leve' (PT)", async () => {
    runSubAgentMock.mockResolvedValue("problema leve apenas");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("low");
  });

  /**
   * Mutation: L151 `else if (!lower.includes("nada encontrado")) severity = "medium";`
   *           `!` removed → `lower.includes("nada encontrado")` would set
   *           severity to "medium" when "nada encontrado" IS present (the
   *           opposite of the intent).
   *
   * Original: when LLM says "nada encontrado", severity stays at "none"
   * (initial value). Mutated: severity becomes "medium".
   */
  it("severity='none' when LLM says 'Nada encontrado'", async () => {
    runSubAgentMock.mockResolvedValue("Nada encontrado");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("none");
  });

  /**
   * Mutation: L151 default branch removed. When LLM finds issues but
   * doesn't use any of the magic keywords, severity should default to
   * "medium" (not "none").
   */
  it("severity='medium' (default) when LLM finds issues without magic keywords", async () => {
    runSubAgentMock.mockResolvedValue("I see a problem here, please check");
    const result = await runDevilsAdvocate(
      [{ path: "f.luau", content: "local x = 1" }],
      "claim"
    );
    expect(result.severity).toBe("medium");
  });

  /**
   * Sanity: chatMock is unused by runDevilsAdvocate (it calls runSubAgent
   * directly). The reference is kept to silence the unused-imports linter
   * and to document that the LLM path goes through subAgents, not chat.
   */
  it("sanity: chatMock is wired (unused by runDevilsAdvocate, which uses runSubAgent)", () => {
    expect(typeof chatMock).toBe("function");
  });
});

// ─── safetyReviewer.ts (L218, L222, L225 — JSON risk parsing) ────────────────

vi.mock("../i18n.js", () => ({
  t: vi.fn((key: string) => `[i18n:${key}]`),
  default: { t: vi.fn((key: string) => `[i18n:${key}]`) },
}));

// modeExtensions returns built-in patterns so reviewCodeSafety can reach the
// LLM-call branch without depending on a loaded mode.
vi.mock("../modeExtensions.js", () => ({
  getActiveSafetyPatterns: vi.fn(async () => {
    const { getDangerousPatterns } = await import("../safetyReviewer.js");
    return getDangerousPatterns();
  }),
}));

import { reviewCodeSafety } from "../safetyReviewer.js";

describe("mutation-killers / safetyReviewer.ts L218,222,225 — JSON risk parsing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The existing tests at safetyReviewer-extended.test.ts L286-348 only
   * assert `result.risk` equals the expected value. They never check
   * `result.reasoning`. This lets mutations at L222 (`===` → `!==`) and
   * L225 (`=== "string"` → `!== "string"`) survive, because the mutated
   * code falls through to keyword matching which can still produce the
   * right `risk` value (just with the wrong `reasoning`).
   *
   * Fix: pin the exact `reasoning` string from obj.reasoning.
   */

  /**
   * Mutation: L222 `risk === "low"` → `risk !== "low"`
   *
   * For content `{"risk": "low", "reasoning": "safe read"}`:
   *   Original: returns risk="low", reasoning="safe read"
   *   Mutated:  falls through to keyword matching. Content has `"low"`
   *             keyword. Returns risk="low", reasoning=content.slice(0,500)
   *             (the raw JSON string).
   *
   * Asserting `reasoning === "safe read"` kills the mutation.
   */
  it("parses JSON {risk:'low'} and returns obj.reasoning (not content.slice)", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '{"risk": "low", "reasoning": "safe read"}' } }],
    } as any);
    const result = await reviewCodeSafety(`store:SetAsync("k", "v")`, "f.luau");
    expect(result.risk).toBe("low");
    expect(result.reasoning).toBe("safe read");
  });

  /**
   * Mutation: L222 `risk === "high"` → `risk !== "high"`
   *
   * Same pattern: original returns reasoning from obj.reasoning, mutated
   * returns content.slice. Pin the exact reasoning.
   */
  it("parses JSON {risk:'high'} and returns obj.reasoning", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '{"risk": "high", "reasoning": "destructive op"}' } }],
    } as any);
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("high");
    expect(result.reasoning).toBe("destructive op");
  });

  /**
   * Mutation: L222 `risk === "none"` → `risk !== "none"`
   *
   * For content `{"risk": "none", "reasoning": "no issues"}`:
   *   Original: returns risk="none", reasoning="no issues"
   *   Mutated:  falls through. No "high"/"low" keywords in content.
   *             Returns risk="none", reasoning=content.slice (raw JSON).
   *
   * The existing test suite has NO test for risk="none" coming from JSON
   * (only risk="none" from heuristic-only path with no LLM call). This
   * mutation survives. Asserting reasoning kills it.
   */
  it("parses JSON {risk:'none'} and returns obj.reasoning", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '{"risk": "none", "reasoning": "no issues found"}' } }],
    } as any);
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("none");
    expect(result.reasoning).toBe("no issues found");
  });

  /**
   * Mutation: L225 `typeof obj.reasoning === "string"` → `!== "string"`
   *
   * For content with a string reasoning:
   *   Original: returns obj.reasoning (the string)
   *   Mutated:  returns "" (empty string) because the ternary flips
   *
   * Asserting reasoning is the actual string (not empty) kills the mutation.
   * (Covered by the three tests above — they all check reasoning is the
   * string from JSON, not empty.)
   */

  /**
   * Mutation: L218 `start >= 0` → `start > 0`
   *
   * For content where JSON starts at position 0 (the common case):
   *   Original: start=0, condition `0 >= 0` is true. Parses JSON.
   *   Mutated:  start=0, condition `0 > 0` is false. Falls through to
   *             keyword matching. Returns reasoning=content.slice.
   *
   * All tests above use JSON starting at position 0 and check reasoning,
   * so they kill this mutation too.
   *
   * Explicit boundary test:
   */
  it("parses JSON that starts at position 0 (boundary of start>=0 check)", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '{"risk": "low", "reasoning": "boundary"}' } }],
    } as any);
    const result = await reviewCodeSafety(`store:SetAsync("k", "v")`, "f.luau");
    expect(result.risk).toBe("low");
    expect(result.reasoning).toBe("boundary");
  });

  /**
   * Mutation: L218 `&&` → `||`
   *
   * For content with `{` but no `}`: start=N>=0, end=-1.
   *   Original: `N >= 0 && -1 > N` = false. Skip JSON parsing.
   *   Mutated:  `N >= 0 || -1 > N` = true. Tries JSON.parse, throws,
   *             caught, falls through to keyword matching.
   *
   * Behaviorally equivalent in most cases. This is likely a FALSE
   * POSITIVE mutation (no observable difference). We document it as such
   * and add a test that verifies the keyword fallback still works.
   */
  it("falls back to keyword matching when JSON is malformed (no closing brace)", async () => {
    chatMock.mockResolvedValue({
      // No closing brace — JSON.parse will throw.
      choices: [{ message: { content: 'risk: high — destructive operation detected' } }],
    } as any);
    const result = await reviewCodeSafety(`store:RemoveAsync("k")`, "f.luau");
    expect(result.risk).toBe("high");
  });

  /**
   * Mutation: L225 when obj.reasoning is NOT a string (e.g., null, number)
   *
   * The ternary `typeof obj.reasoning === "string" ? obj.reasoning : ""`
   * should return "" when reasoning is missing or non-string.
   *
   * Test: JSON with reasoning:null should return reasoning="" (not "null"
   * or the stringified null).
   */
  it("returns empty reasoning when JSON has reasoning:null", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '{"risk": "low", "reasoning": null}' } }],
    } as any);
    const result = await reviewCodeSafety(`store:SetAsync("k", "v")`, "f.luau");
    expect(result.risk).toBe("low");
    expect(result.reasoning).toBe("");
  });
});

// ─── dynamicWorkflow.ts (L70, L85 — success/failure reporting) ──────────────

// Note: `vi.mock("../subAgents.js")` is already declared above (in the
// honestySystem section). Vitest hoists all `vi.mock` calls to the top of
// the file, so a single mock applies across all describe blocks. We reuse
// the already-imported `runSubAgent` / `runSubAgentMock`.

import { executeWorkflow } from "../dynamicWorkflow.js";

describe("mutation-killers / dynamicWorkflow.ts L70,85 — per-step success reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSubAgentMock.mockResolvedValue("ok");
  });

  /**
   * Background: the `steps` array was internal — only `steps.length` was
   * exposed via `stepsExecuted`. The per-step `success` flag at L70/L85
   * was effectively dead code, so mutations like `result !== null` →
   * `result === null` survived.
   *
   * Fix: `WorkflowResult` now exposes `steps: WorkflowStep[]`. Tests can
   * verify the per-step success flag.
   */

  /**
   * Mutation: L70 `success: result !== null` → `success: result === null`
   *
   * When runSubAgent returns a non-null string, the original sets
   * success=true. Mutated sets success=false.
   */
  it("records success=true for a step where agent() returned a non-null string", async () => {
    runSubAgentMock.mockResolvedValue("agent answer");
    const result = await executeWorkflow('const x = await agent("question");');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.success).toBe(true);
    expect(result.steps[0]!.result).toBe("agent answer");
  });

  /**
   * Mutation: L70 `success: result !== null` → `success: result === null`
   *
   * When runSubAgent returns null, the original sets success=false.
   * Mutated sets success=true.
   */
  it("records success=false for a step where agent() returned null", async () => {
    runSubAgentMock.mockResolvedValue(null as any);
    const result = await executeWorkflow('const x = await agent("question");');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.success).toBe(false);
    expect(result.steps[0]!.result).toBe("null");
  });

  /**
   * Mutation: L70 `result ?? "null"` → `result || "null"`
   *
   * When runSubAgent returns an empty string "", original keeps "" via ??
   * (nullish coalescing). Mutated uses || which converts "" to "null".
   */
  it("records the actual empty string when agent() returns '' (?? vs ||)", async () => {
    runSubAgentMock.mockResolvedValue("");
    const result = await executeWorkflow('const x = await agent("question");');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.result).toBe("");
    expect(result.steps[0]!.success).toBe(true); // "" is not null
  });

  /**
   * Mutation: L74 (error branch) `success: false` → `success: true`
   *
   * When runSubAgent throws, the catch block should record success=false.
   */
  it("records success=false and the error message when agent() throws", async () => {
    runSubAgentMock.mockRejectedValue(new Error("agent crashed"));
    const result = await executeWorkflow('const x = await agent("question");');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.success).toBe(false);
    expect(result.steps[0]!.result).toBe("agent crashed");
  });

  /**
   * Mutation: L85 `success: results[i] !== null` → `success: results[i] === null`
   *
   * Same as L70 but for parallel() calls.
   */
  it("parallel(): records success=true for non-null and success=false for null results", async () => {
    runSubAgentMock
      .mockResolvedValueOnce("answer1")
      .mockResolvedValueOnce(null as any);
    const result = await executeWorkflow('await parallel("q1", "q2");');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.success).toBe(true);
    expect(result.steps[0]!.result).toBe("answer1");
    expect(result.steps[1]!.success).toBe(false);
    expect(result.steps[1]!.result).toBe("null");
  });

  /**
   * Mutation: L85 `results[i] ?? "null"` → `results[i] || "null"`
   *
   * Empty string vs "null".
   */
  it("parallel(): records '' for empty-string results (?? vs ||)", async () => {
    runSubAgentMock
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("ok");
    const result = await executeWorkflow('await parallel("q1", "q2");');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.result).toBe("");
    expect(result.steps[0]!.success).toBe(true);
    expect(result.steps[1]!.result).toBe("ok");
  });

  /**
   * Mutation: L70 description `question.slice(0, 100)` → `question.slice(0, 99)` (or similar)
   *
   * Pin the description text exactly.
   */
  it("records the question (truncated to 100 chars) as step.description", async () => {
    const longQuestion = "a".repeat(150);
    const result = await executeWorkflow(`const x = await agent("${longQuestion}");`);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.description).toBe("a".repeat(100));
    expect(result.steps[0]!.description).toHaveLength(100);
  });

  /**
   * Sanity: empty script returns steps=[].
   */
  it("returns steps=[] for an empty script", async () => {
    const result = await executeWorkflow("");
    expect(result.steps).toEqual([]);
  });
});

// ─── promiseDetector.ts (L205 — crash on undefined input) ───────────────────

import {
  detectFalsePromise,
  resetFalsePromiseCounter,
} from "../promiseDetector.js";

describe("mutation-killers / promiseDetector.ts L205 — crash on undefined/null input", () => {
  beforeEach(() => {
    resetFalsePromiseCounter();
  });

  /**
   * Mutation: L205 `if (!agentMessage || agentMessage.length === 0)`
   *           → `if (agentMessage || agentMessage.length === 0)`
   *           (i.e., remove the `!` negation on agentMessage)
   *
   * Existing tests only pass `""` (empty string). The `!agentMessage`
   * guard is what handles `undefined` and `null` safely. Without it,
   * `agentMessage.length` throws TypeError on undefined/null.
   *
   * Test: pass undefined (cast to any to bypass TS) and assert it returns
   * the empty-message result without throwing.
   */
  it("does not crash when agentMessage is undefined (returns detected=false)", () => {
    const r = detectFalsePromise(undefined as any, 0, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/empty message/);
  });

  it("does not crash when agentMessage is null (returns detected=false)", () => {
    const r = detectFalsePromise(null as any, 0, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/empty message/);
  });

  /**
   * Mutation: L205 `agentMessage.length === 0` → `agentMessage.length !== 0`
   *
   * For empty string "": original returns detected=false (empty message).
   * Mutated: `!agentMessage` is true (empty string is falsy), so condition
   * is `true || (anything)` = true. Same behavior. The mutation survives
   * because `!agentMessage` already short-circuits for "".
   *
   * However, if BOTH `!agentMessage` is removed AND `=== 0` is mutated,
   * the empty string case would not be caught. The tests above for
   * undefined/null kill the `!agentMessage` removal. We add an explicit
   * empty-string test for completeness.
   */
  it("returns detected=false for empty string with reason 'empty message'", () => {
    const r = detectFalsePromise("", 0, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/empty message/);
  });

  /**
   * Mutation: L205 `||` → `&&`
   *
   * For undefined: `!agentMessage` is true, `agentMessage.length === 0`
   * would crash. With `&&`, the second operand is only evaluated if the
   * first is true. `true && (crash)` crashes. So this mutation would
   * crash on undefined.
   *
   * Already killed by the undefined test above.
   */

  /**
   * Mutation: L201 `if (toolsCalled > 0 || filesTouched > 0)` → `&&`
   *
   * For toolsCalled=1, filesTouched=0: original returns "actions were
   * taken". Mutated: `1 > 0 && 0 > 0` = false. Falls through to L205.
   * If agentMessage is a promise phrase, mutated would detect=false (no
   * longer), but for non-promise messages it might return "no promise
   * phrase detected" instead of "actions were taken".
   *
   * Test: toolsCalled=1, filesTouched=0, message with promise phrase.
   * Original: returns "actions were taken". Mutated: detects the promise.
   */
  it("returns 'actions were taken' when tools>0 even with a promise phrase", () => {
    const r = detectFalsePromise("vou investigar isso", 1, 0);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/actions were taken/);
  });

  it("returns 'actions were taken' when files>0 even with a promise phrase", () => {
    const r = detectFalsePromise("let me check", 0, 1);
    expect(r.detected).toBe(false);
    expect(r.reason).toMatch(/actions were taken/);
  });
});
