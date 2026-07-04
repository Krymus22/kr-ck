import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ENV_PATH = "/home/z/my-project/claude-killer/.env";
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
process.env.HOME = "/home/z";
process.chdir("/home/z/my-project/claude-killer");

const agent = await import("/home/z/my-project/claude-killer/dist/agent.js");
const history = await import("/home/z/my-project/claude-killer/dist/history.js");
const modes = await import("/home/z/my-project/claude-killer/dist/modes.js");

modes.setActiveMode("normal");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-debug-"));
const tmpFile = path.join(tmpDir, "edit.ts");
fs.writeFileSync(tmpFile, "export const x = 1;\n");

history.resetHistory();
const tc = [];
try {
  const r = await agent.runAgentLoop(
    `Read ${tmpFile} using ler_arquivo. Then use editar_arquivo to change "x = 1" to "x = 42". Reply with the value of x.`,
    undefined, undefined, undefined, undefined,
    (n, a) => { tc.push(n); console.log(`[TOOL] ${n}(${JSON.stringify(a).slice(0, 200)})`); },
    (n, ok, rs) => { console.log(`[RESULT] ${n} ok=${ok}: ${rs.slice(0, 150)}`); },
    undefined, false,
  );
  console.log("Final:", r.slice(0, 80));
  console.log("File:", fs.readFileSync(tmpFile, "utf8"));
  console.log("Tool calls:", tc.length);
} catch(e) {
  console.log("Error:", e.message.slice(0, 150));
  console.log("File:", fs.readFileSync(tmpFile, "utf8"));
}
fs.rmSync(tmpDir, { recursive: true, force: true });
