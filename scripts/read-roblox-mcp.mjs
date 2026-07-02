import { webRead } from "../src/apiResearcher.js";

console.log("=== Lendo documentação oficial do Roblox Studio MCP ===\n");
const content = await webRead("https://create.roblox.com/docs/studio/mcp");
console.log(content.slice(0, 6000));

console.log("\n\n=== Lendo GitHub do Roblox MCP ===\n");
const content2 = await webRead("https://github.com/Roblox/studio-rust-mcp-server");
console.log(content2.slice(0, 6000));

process.exit(0);
