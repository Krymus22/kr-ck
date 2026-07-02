import { webSearch } from "../src/apiResearcher.js";

// Use the Claude-Killer's own webSearch (which has Bing + Searx + official APIs)
console.log("=== Search 1: Roblox Studio MCP official ===");
const results = await webSearch("Roblox Studio MCP server official native 2026", 8, true);
for (const r of results) {
  console.log(`Title: ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet?.slice(0, 150)}`);
  console.log("");
}

console.log("\n=== Search 2: GitHub Roblox MCP ===");
const results2 = await webSearch("roblox mcp server github model context protocol", 8);
for (const r of results2) {
  console.log(`Title: ${r.title}`);
  console.log(`URL: ${r.url}`);
  console.log(`Snippet: ${r.snippet?.slice(0, 150)}`);
  console.log("");
}

process.exit(0);
