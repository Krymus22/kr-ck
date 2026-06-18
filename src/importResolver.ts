/**
 * importResolver.ts - Verify imports exist and export correct symbols.
 *
 * After editing a file, checks if:
 *   1. All import/require paths resolve to existing files
 *   2. The imported symbols are actually exported by the target file
 *
 * Supports:
 *   - TypeScript/JS: import { X } from './path', import X from 'path'
 *   - Luau: local X = require(path)
 *   - Python: from module import X, import module
 *   - Rust: use crate::module::X
 *   - Go: import "package/path"
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface ImportCheckResult {
  ok: boolean;
  missingImports: Array<{ symbol: string; source: string; reason: string }>;
  message: string;
}

// --- Import extraction -----------------------------------------------------

interface ImportEntry {
  symbols: string[];  // what's imported ([] = entire module)
  source: string;     // path/string after 'from' or in require()
  line: number;
}

/**
 * Extract imports from source code based on file extension.
 */
function extractImports(filePath: string, content: string): ImportEntry[] {
  const ext = path.extname(filePath).toLowerCase();
  const lines = content.split("\n");
  const imports: ImportEntry[] = [];

  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    // import { X, Y } from './path'
    // import X from './path'
    // import * as X from './path'
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Named imports: import { X, Y } from 'path'
      const namedMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
      if (namedMatch) {
        const symbols = namedMatch[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
        imports.push({ symbols, source: namedMatch[2]!, line: i + 1 });
        continue;
      }
      // Default import: import X from 'path'
      const defaultMatch = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (defaultMatch) {
        imports.push({ symbols: [defaultMatch[1]!], source: defaultMatch[2]!, line: i + 1 });
        continue;
      }
      // Namespace import: import * as X from 'path'
      const nsMatch = line.match(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (nsMatch) {
        imports.push({ symbols: [nsMatch[1]!], source: nsMatch[2]!, line: i + 1 });
        continue;
      }
    }
  } else if (ext === ".luau" || ext === ".lua") {
    // local X = require(path)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = line.match(/local\s+(\w+)\s*=\s*require\s*\(\s*(.+?)\s*\)/);
      if (match) {
        imports.push({ symbols: [match[1]!], source: match[2]!, line: i + 1 });
      }
    }
  } else if (ext === ".py") {
    // from module import X, Y
    // import module
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const fromMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
      if (fromMatch) {
        const symbols = fromMatch[2]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim());
        imports.push({ symbols, source: fromMatch[1]!, line: i + 1 });
        continue;
      }
      const importMatch = line.match(/^import\s+([\w.]+)/);
      if (importMatch) {
        imports.push({ symbols: [], source: importMatch[1]!, line: i + 1 });
      }
    }
  } else if (ext === ".rs") {
    // use crate::module::X
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = line.match(/use\s+([\w:]+)::(\w+)/);
      if (match) {
        imports.push({ symbols: [match[2]!], source: match[1]!, line: i + 1 });
      }
    }
  } else if (ext === ".go") {
    // import "path" or import ( block )
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line.startsWith("import")) {
        const match = line.match(/"([^"]+)"/);
        if (match) {
          imports.push({ symbols: [], source: match[1]!, line: i + 1 });
        }
      }
    }
  }

  return imports;
}

/**
 * Resolve a relative import path to an absolute file path.
 */
function resolveImportPath(source: string, fromFile: string): string | null {
  // Skip non-relative imports (node_modules, packages, etc.)
  if (!source.startsWith(".") && !source.startsWith("/")) {
    return null;  // External module - skip
  }

  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, source);

  // Try exact path, then with extensions
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".luau", ".lua", ".py", ".rs", ".go", "/index.ts", "/index.js"];
  if (fs.existsSync(resolved)) return resolved;
  for (const ext of extensions) {
    if (fs.existsSync(resolved + ext)) return resolved + ext;
    if (fs.existsSync(resolved + ext.replace("/", ""))) return resolved + ext.replace("/", "");
  }
  return null;
}

// --- Public API -------------------------------------------------------------

/**
 * Check if all imports in a file resolve to existing files.
 * Returns list of missing imports.
 */
export function checkImports(filePath: string, content: string): ImportCheckResult {
  const imports = extractImports(filePath, content);
  if (imports.length === 0) {
    return { ok: true, missingImports: [], message: "" };
  }

  const missing: Array<{ symbol: string; source: string; reason: string }> = [];

  for (const imp of imports) {
    const resolved = resolveImportPath(imp.source, filePath);
    if (resolved === null) {
      // Check if this was a relative path that couldn't be resolved
      if (imp.source.startsWith(".")) {
        // Relative path that doesn't resolve = missing file
        for (const sym of imp.symbols) {
          missing.push({
            symbol: sym,
            source: imp.source,
            reason: `File not found: ${imp.source}`,
          });
        }
      }
      // Skip external modules
      continue;
    }

    if (!fs.existsSync(resolved)) {
      for (const sym of imp.symbols) {
        missing.push({
          symbol: sym,
          source: imp.source,
          reason: `File not found: ${imp.source} (resolved to ${resolved})`,
        });
      }
    } else {
      // File exists - check if symbols are exported
      if (imp.symbols.length > 0) {
        const targetContent = fs.readFileSync(resolved, "utf8");
        for (const sym of imp.symbols) {
          // Check if symbol is exported (simplified check)
          const exportPatterns = [
            new RegExp(`export\\s+(?:const|let|var|function|class|type|interface)\\s+${sym}\\b`),
            new RegExp(`export\\s+\\{[^}]*\\b${sym}\\b[^}]*\\}`),
            new RegExp(`module\\.exports\\b.*\\b${sym}\\b`),
            new RegExp(`return\\s+\\{[^}]*\\b${sym}\\b`, "i"),  // Luau table return
          ];
          const isExported = exportPatterns.some((p) => p.test(targetContent));
          if (!isExported) {
            missing.push({
              symbol: sym,
              source: imp.source,
              reason: `Symbol "${sym}" not exported by ${path.basename(resolved)}`,
            });
          }
        }
      }
    }
  }

  if (missing.length === 0) {
    return { ok: true, missingImports: [], message: "" };
  }

  const msg = `[IMPORT RESOLVER] ${missing.length} import issue(s) found:\n${missing.map((m) => `  - ${m.symbol} from "${m.source}": ${m.reason}`).join("\n")}`;
  log.warn(`[IMPORT_RESOLVER] ${msg}`);
  return { ok: false, missingImports: missing, message: msg };
}
