import { webSearch, webRead } from "../src/apiResearcher.js";

console.log("=== Search 1: Claude Code context compaction ===");
const r1 = await webSearch("Claude Code context compaction how it works 2026", 8, true);
for (const r of r1) {
  console.log(`Title: ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet?.slice(0, 200)}`);
  console.log("");
}

console.log("\n=== Search 2: LLM context window compaction techniques ===");
const r2 = await webSearch("LLM context window compaction summarization techniques 2026", 8);
for (const r of r2) {
  console.log(`Title: ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet?.slice(0, 200)}`);
  console.log("");
}

console.log("\n=== Search 3: Anthropic context engineering ===");
const r3 = await webSearch("anthropic context engineering memory compaction agent", 6);
for (const r of r3) {
  console.log(`Title: ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet?.slice(0, 200)}`);
  console.log("");
}

process.exit(0);
