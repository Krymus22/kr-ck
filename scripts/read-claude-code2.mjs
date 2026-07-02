import { webRead } from "../src/apiResearcher.js";

console.log("=== How Claude Code works (auto-compaction) ===\n");
const c1 = await webRead("https://docs.anthropic.com/en/docs/claude-code/how-claude-code-works");
console.log(`Length: ${c1.length}`);
console.log(c1.slice(0, 8000));

console.log("\n\n=== Reduce token usage (compaction strategies) ===\n");
const c2 = await webRead("https://docs.anthropic.com/en/docs/claude-code/costs#reduce-token-usage");
console.log(`Length: ${c2.length}`);
console.log(c2.slice(0, 8000));

process.exit(0);
