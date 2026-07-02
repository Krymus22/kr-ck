import { webSearch, getLastSearchSource } from "../src/apiResearcher.js";

// Test 1: Search that should return Roblox-specific results
console.log("=== Test 1: 'Anime Fighters Simulator roblox' ===");
let results = await webSearch("Anime Fighters Simulator roblox", 5);
console.log(`Source: ${getLastSearchSource()}`);
for (const r of results) {
  console.log(`  Title: ${r.title}`);
  console.log(`  URL: ${r.url}`);
  console.log(`  Snippet: ${r.snippet?.slice(0, 100)}`);
  console.log("");
}

// Test 2: Generic search
console.log("\n=== Test 2: 'React useState documentation' ===");
results = await webSearch("React useState documentation", 3);
console.log(`Source: ${getLastSource()}`);
for (const r of results) {
  console.log(`  Title: ${r.title}`);
  console.log(`  URL: ${r.url}`);
  console.log("");
}

// Test 3: Let's see the RAW HTML Bing returns to debug the parser
console.log("\n=== Test 3: Raw Bing HTML analysis ===");
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
console.log(`Status: ${resp.status}`);
console.log(`HTML length: ${html.length}`);
console.log(`b_algo count: ${(html.match(/class="b_algo"/g) || []).length}`);
console.log(`b_caption count: ${(html.match(/class="b_caption"/g) || []).length}`);
console.log(`First 500 chars of HTML:`);
console.log(html.slice(0, 500));

// Check if Bing is showing a CAPTCHA or block page
if (html.includes("captcha") || html.includes("CAPTCHA")) {
  console.log("\n⚠️ BING CAPTCHA DETECTED!");
}
if (html.includes("blocked") || html.includes("denied")) {
  console.log("\n⚠️ BING BLOCKING DETECTED!");
}

process.exit(0);

function getLastSource() {
  return getLastSearchSource();
}
