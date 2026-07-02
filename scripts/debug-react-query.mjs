// Debug: test React query that returned Picasso results
const query = "React useState documentation";
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
});
clearTimeout(timer);
const html = await resp.text();

// Decode entities
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const decoded = decodeEntities(html);
const blocks = decoded.split(/class="b_algo"/).slice(1);
console.log(`Query: "${query}"`);
console.log(`b_algo blocks: ${blocks.length}`);

for (let i = 0; i < Math.min(5, blocks.length); i++) {
  const block = blocks[i];
  const h2Match = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = h2Match ? h2Match[1].replace(/<[^>]+>/g, "").trim() : "(no h2)";
  
  const urlMatch = block.match(/u=a1([A-Za-z0-9+/=_-]+)/);
  let url = "(no url)";
  if (urlMatch) {
    let encoded = urlMatch[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = 4 - (encoded.length % 4);
    if (padding !== 4) encoded += "=".repeat(padding);
    try { url = Buffer.from(encoded, "base64").toString("utf8"); } catch {}
  }
  
  console.log(`\n${i + 1}. Title: ${title}`);
  console.log(`   URL: ${url}`);
}

// Also check: is the title page showing the right query?
const titleMatch = html.match(/<title>([^<]+)<\/title>/);
console.log(`\nPage title: ${titleMatch?.[1] ?? "(none)"}`);

process.exit(0);
