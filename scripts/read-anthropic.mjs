import { webRead } from "../src/apiResearcher.js";

console.log("=== Anthropic Context Engineering ===\n");
const c1 = await webRead("https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents");
console.log(`Length: ${c1.length}`);
console.log(c1.slice(0, 8000));

console.log("\n\n=== Claude Code docs ===\n");
const c2 = await webRead("https://docs.anthropic.com/en/docs/claude-code/costs");
console.log(`Length: ${c2.length}`);
console.log(c2.slice(0, 5000));

process.exit(0);
