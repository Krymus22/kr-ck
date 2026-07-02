// Debug: save Bing HTML to file for analysis
const query = "Anime Fighters Simulator roblox";
const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=5&setlang=en`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
const resp = await fetch(searchUrl, {
  signal: controller.signal,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  redirect: "follow",
});
clearTimeout(timer);
const html = await resp.text();

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const debugFile = path.join(os.tmpdir(), "bing-debug.html");
fs.writeFileSync(debugFile, html);
console.log(`HTML saved to: ${debugFile} (${html.length} bytes)`);

// Now let's manually extract the FIRST b_algo block to see its real structure
const blocks = html.split(/class="b_algo"/).slice(1);
console.log(`\nNumber of b_algo blocks: ${blocks.length}`);

// Decode entities first (like our parser does)
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const decoded = decodeEntities(html);
const decodedBlocks = decoded.split(/class="b_algo"/).slice(1);

console.log("\n=== FIRST b_algo block (first 800 chars) ===");
console.log(decodedBlocks[0]?.slice(0, 800) ?? "(none)");

console.log("\n=== SECOND b_algo block (first 800 chars) ===");
console.log(decodedBlocks[1]?.slice(0, 800) ?? "(none)");

// Now let's see what URLs our parser extracts vs what's actually there
console.log("\n=== URL extraction analysis ===");
for (let i = 0; i < Math.min(3, decodedBlocks.length); i++) {
  const block = decodedBlocks[i];
  console.log(`\n--- Block ${i + 1} ---`);
  
  // Our parser looks for u=a1...
  const urlMatch = block.match(/u=a1([A-Za-z0-9+/=_-]+)/);
  if (urlMatch) {
    let encoded = urlMatch[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = 4 - (encoded.length % 4);
    if (padding !== 4) encoded += "=".repeat(padding);
    try {
      const url = Buffer.from(encoded, "base64").toString("utf8");
      console.log(`  u=a1 URL: ${url}`);
    } catch (e) {
      console.log(`  u=a1 decode failed: ${e.message}`);
    }
  } else {
    console.log(`  No u=a1 match found`);
  }
  
  // Let's look for ALL href links in the block
  const hrefs = [...block.matchAll(/href="([^"]+)"/g)].map(m => m[1]).slice(0, 5);
  console.log(`  First 5 hrefs in block:`);
  hrefs.forEach((h, j) => console.log(`    ${j + 1}. ${h.slice(0, 100)}`));
  
  // Look for h2 tag (title)
  const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  if (h2Match) {
    const title = h2Match[1].replace(/<[^>]+>/g, "").trim();
    console.log(`  h2 title: ${title}`);
  }
}

process.exit(0);
