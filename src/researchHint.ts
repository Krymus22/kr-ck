/**
 * researchHint.ts - Smart hints to encourage the IA to verify factual claims
 * with web search instead of relying on potentially outdated training data.
 *
 * PROBLEM:
 * The IA has web search available (buscar_web) but often answers factual
 * questions from training data without verifying. This leads to outdated
 * or wrong information when:
 *   - Games have been updated (mechanics change, new content added)
 *   - APIs have new versions (breaking changes, deprecated methods)
 *   - Products have changed (pricing, features, availability)
 *   - Recent events (news, announcements, releases)
 *
 * The IA should PROACTIVELY use buscar_web when:
 *   1. Asked about a specific product/game/service (may have changed)
 *   2. Asked about current state ("what is", "how does X work" for products)
 *   3. Making claims about versions, release dates, current features
 *   4. Asked about something with "latest", "current", "new", "recent"
 *
 * The IA should NOT be forced to search when:
 *   - Programming basics (print, loops, syntax) — won't change
 *   - General concepts (OOP, HTTP, algorithms) — timeless
 *   - Math, logic, design patterns — timeless
 *   - The user is asking the IA to DO something (write code, edit file)
 *     rather than ANSWER something factual
 *
 * This module injects a SUBTLE HINT into the system prompt (not a hard
 * requirement). The IA can still answer from training if it's confident,
 * but it knows it SHOULD verify for certain topics.
 */

// ─── Trigger Detection ──────────────────────────────────────────────────────

/**
 * Detect if a user query is about something that CHANGES OVER TIME and
 * therefore should be verified with web search rather than answered from
 * (potentially outdated) training data.
 *
 * Returns the category of trigger, or null if no trigger.
 */
export type ResearchTrigger =
  | "specific_product"    // "Anime Fighters", "Roblox game", specific named thing
  | "current_state"       // "what is X" for products/services (may have changed)
  | "version_info"        // "latest version", "when was X released"
  | "recent_news"         // "what happened", "news about"
  | "factual_claim"       // IA is about to make a claim that could be wrong
  | null;

/**
 * Keywords that indicate the user is asking about something current/verifiable.
 * These suggest the answer may have changed since training data was collected.
 */
const CURRENT_STATE_KEYWORDS = [
  // English
  "what is", "what are", "tell me about", "how does", "how do",
  "is it true", "is it still", "does it still", "are they still",
  "current", "latest", "newest", "recent", "updated", "changed",
  "version", "release", "released", "launched", "announced",
  "today", "this week", "this month", "this year",
  "what happened", "happened", "news about", "news",
  // Portuguese
  "o que é", "o que e", "como funciona", "como e",
  "qual a versão", "qual a versao", "quando foi",
  "atual", "recente", "último", "ultimo", "nova", "novo",
  "mudou", "atualizou", "lançou", "lancou", "anunciou",
  "hoje", "esta semana", "este mês", "este mes",
  "notícia", "noticia", "notícias", "noticias",
  "aconteceu", "o que aconteceu",
];

/**
 * Product/game keywords that suggest the topic changes over time.
 * If the query mentions one of these AND a current_state keyword,
 * the IA should verify with web search.
 */
const VOLATILE_TOPICS = [
  // Games / gaming
  "roblox", "game", "jogo", "simulator", "rpg", "mmorpg",
  "minecraft", "fortnite", "anime fighters", "blox fruits",
  // Tech products that update frequently
  "api", "library", "framework", "biblioteca",
  "npm", "package", "pacote",
  "react", "vue", "angular", "svelte", "next.js", "nextjs",
  "roblox studio", "luau", "rojo", "wally",
  // Services with pricing/feature changes
  "openai", "anthropic", "claude", "chatgpt", "gpt",
  "gemini", "copilot", "cursor",
  "aws", "azure", "gcp", "vercel", "netlify",
  // Anything with "version" or "update"
];

/**
 * Topics that are TIMELESS — the IA should NOT be forced to search for these.
 * Even if a current_state keyword appears, if the topic is timeless, skip.
 */
const TIMELESS_TOPICS = [
  // Programming basics (don't change)
  "print", "console.log", "printf", "echo",
  "for loop", "while loop", "if statement", "switch",
  "function", "method", "class", "object", "array", "string",
  "variable", "constante", "variável",
  // Concepts (timeless)
  "algorithm", "algoritmo", "data structure", "estrutura de dados",
  "design pattern", "padrão de projeto",
  "big o", "complexity", "complexidade",
  "recursion", "recursão", "recursao",
  // Math (timeless)
  "math", "matemática", "matematica", "calculus", "cálculo",
  "algebra", "geometry", "geometria",
  // HTTP/web basics (don't change)
  "http", "https", "rest", "restful", "json", "xml",
  "get request", "post request", "status code",
  // OOP/functional concepts (timeless)
  "inheritance", "herança", "heranca", "polymorphism",
  "encapsulation", "abstraction",
  "closure", "callback", "promise", "async", "await",
];

/**
 * Detect if the user's query should trigger a research hint.
 *
 * Logic:
 *   1. Check if query contains a current_state keyword (what is, latest, etc.)
 *   2. Check if query mentions a volatile topic (game, API, product)
 *   3. If both → trigger (suggest verification)
 *   4. If query has current_state but topic is timeless → NO trigger
 *   5. If query is a command (write code, edit file) → NO trigger
 */
export function detectResearchTrigger(userQuery: string): ResearchTrigger {
  const q = userQuery.toLowerCase().trim();

  // Skip if it's a command (user wants IA to DO something, not ANSWER)
  // These start with imperatives and don't need fact-checking
  if (isCommandQuery(q)) return null;

  // Skip if the query is too short (less than 10 chars)
  if (q.length < 10) return null;

  // Check for current_state keywords
  const hasCurrentState = CURRENT_STATE_KEYWORDS.some(kw => q.includes(kw));

  // Check for volatile topics
  const hasVolatileTopic = VOLATILE_TOPICS.some(topic => q.includes(topic));

  // Check for timeless topics (anti-trigger)
  const hasTimelessTopic = TIMELESS_TOPICS.some(topic => q.includes(topic));

  // If query mentions a timeless topic, don't trigger even if it has
  // current_state keywords. "What is a for loop" doesn't need web search.
  if (hasTimelessTopic && !hasVolatileTopic) return null;

  // SPECIAL CASE: queries explicitly about recent events/news should ALWAYS
  // trigger, even without a volatile topic. "What happened this week?" is
  // clearly about current events that training data can't know.
  const isNewsQuery =
    q.includes("what happened") || q.includes("aconteceu") ||
    q.includes("news about") || q.includes("news") ||
    q.includes("notícia") || q.includes("noticia") ||
    (q.includes("this week") && q.includes("happened")) ||
    (q.includes("this month") && q.includes("happened"));

  if (isNewsQuery && !hasTimelessTopic) {
    return "recent_news";
  }

  // If query has current_state + volatile topic → should verify
  if (hasCurrentState && hasVolatileTopic) {
    // Check if it's specifically about versions/releases
    if (q.includes("version") || q.includes("versão") || q.includes("versao") ||
        q.includes("release") || q.includes("lanç") || q.includes("lanc")) {
      return "version_info";
    }
    // Check if it's about news/recent events
    if (q.includes("news") || q.includes("notícia") || q.includes("noticia") ||
        q.includes("happened") || q.includes("aconteceu")) {
      return "recent_news";
    }
    return "current_state";
  }

  // If query mentions a specific named entity (proper noun pattern)
  // but no current_state keyword, still trigger if it's a product/game
  // Example: "Anime Fighters" without "what is" — IA might still
  // answer from training and be wrong
  if (hasVolatileTopic && isSpecificEntityQuery(q)) {
    return "specific_product";
  }

  return null;
}

/**
 * Check if the query is a command (user wants the IA to DO something).
 * Commands don't need fact-checking — they need execution.
 */
function isCommandQuery(q: string): boolean {
  const commandPatterns = [
    // English imperatives
    /^(write|create|make|build|add|remove|delete|fix|update|edit|change|move|copy|run|test|install|deploy)\b/,
    // Portuguese imperatives
    /^(escreve|cria|crie|faça|faca|adicione|remove|deleta|corrija|atualiza|edita|muda|move|copia|roda|teste|instala|implanta)\b/,
    // File/code operations
    /\b(arquivo|file|script|code|código|função|function|classe|class)\b.*\b(para|to|in|em)\b/,
  ];
  return commandPatterns.some(pattern => pattern.test(q));
}

/**
 * Check if the query mentions a specific named entity (proper noun).
 * This detects queries like "Anime Fighters" or "Bloons TD 6" where
 * the IA might answer from training without verifying.
 *
 * Heuristic: if the query has a capitalized word (in original) that's
 * not at the start of a sentence, it's likely a proper noun.
 */
function isSpecificEntityQuery(q: string): boolean {
  // Check for quoted names: "Anime Fighters"
  if (q.includes('"') || q.includes("'")) return true;

  // Check for game-like patterns: "X simulator", "X Y simulator"
  if (/\b\w+\s+(simulator|simulador|rpg|mmorpg|td|tower defense)\b/.test(q)) return true;

  // Check for multi-word capitalized names (at least 2 words)
  // We check the original query, not lowercase
  return false;
}

// ─── Hint Generation ────────────────────────────────────────────────────────

/**
 * Generate a research hint message to inject into the conversation.
 * The hint is SUBTLE — it suggests verification but doesn't force it.
 *
 * The message is added as a system message BEFORE the IA responds,
 * so the IA sees it and can decide to use buscar_web proactively.
 */
export function generateResearchHint(trigger: ResearchTrigger, userQuery: string): string | null {
  if (!trigger) return null;

  const hints: Record<Exclude<ResearchTrigger, null>, string> = {
    specific_product: [
      "[RESEARCH HINT] You're being asked about a specific product/game/service.",
      "Your training data may be OUTDATED — games update, APIs change, features get added/removed.",
      "CONSIDER using buscar_web() to verify current information BEFORE answering.",
      "If you answer from training data alone, you may give outdated or wrong information.",
      "This is ESPECIALLY important for: game mechanics, current features, recent updates, pricing.",
    ].join("\n"),

    current_state: [
      "[RESEARCH HINT] You're being asked about the CURRENT STATE of something.",
      "Things change: features get added/removed, APIs get updated, products get redesigned.",
      "Your training data has a cutoff date and may not reflect current reality.",
      "STRONGLY CONSIDER using buscar_web() to verify before answering.",
      "If you're confident the information is timeless (math, algorithms, syntax), you can skip.",
    ].join("\n"),

    version_info: [
      "[RESEARCH HINT] You're being asked about VERSIONS or RELEASES.",
      "Version numbers, release dates, and changelogs change CONSTANTLY.",
      "Your training data is DEFINITELY outdated for version-specific questions.",
      "USE buscar_web() to get current version info before answering.",
      "Do NOT guess version numbers or release dates from training data.",
    ].join("\n"),

    recent_news: [
      "[RESEARCH HINT] You're being asked about RECENT EVENTS or NEWS.",
      "Your training data has a cutoff date and CANNOT know about recent events.",
      "You MUST use buscar_web() to answer this — do not guess or hallucinate.",
      "If search returns no results, say 'I don't have recent information about this' — don't make things up.",
    ].join("\n"),

    factual_claim: [
      "[RESEARCH HINT] You're about to make a factual claim.",
      "If the claim is about something that changes (products, APIs, games, prices),",
      "verify with buscar_web() first. Training data may be outdated.",
    ].join("\n"),
  };

  return hints[trigger] ?? null;
}

/**
 * Check if the IA's response contains claims that should have been verified.
 * This is a POST-response check — if the IA answered without searching
 * and the topic was volatile, we can flag it for the next turn.
 *
 * NOT YET IMPLEMENTED — this would require analyzing the IA's response
 * content, which is complex. For now, we rely on pre-response hints.
 */
// export function shouldHaveResearched(userQuery: string, iaResponse: string): boolean { ... }
