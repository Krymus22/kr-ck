import { webRead } from "../src/apiResearcher.js";

console.log("=== Claude Code memory/context docs ===\n");
const c1 = await webRead("https://docs.anthropic.com/en/docs/claude-code/memory");
console.log(`Length: ${c1.length}`);
console.log(c1.slice(0, 6000));

console.log("\n\n=== Claude Code best practices ===\n");
const c2 = await webRead("https://docs.anthropic.com/en/docs/claude-code/best-practices");
console.log(`Length: ${c2.length}`);
console.log(c2.slice(0, 6000));

process.exit(0);
