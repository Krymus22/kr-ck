/**
 * lspAst.ts — Language-agnostic AST parsing via tree-sitter WASM.
 * Provides symbol extraction, function/class detection, and import analysis
 * with real syntax tree parsing for 7 languages.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Symbol {
  name: string;
  type: "function" | "class" | "interface" | "type" | "variable" | "export" | "import" | "method";
  line: number;
  endLine?: number;
  col?: number;
  signature?: string;
  exported: boolean;
  docstring?: string;
}

export interface ImportInfo {
  module: string;
  symbols: string[];
  isDefault: boolean;
  isTypeOnly: boolean;
  line: number;
}

export interface ParseResult {
  language: string;
  symbols: Symbol[];
  imports: ImportInfo[];
  exports: string[];
  lineCount: number;
}

// ─── Tree-sitter WASM Loader ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TreeSitterParser: any = null;
let TreeSitterLanguage: any = null;
let parserInitialized = false;
const languageModules = new Map<string, any>();

const WASM_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "..",
  "node_modules",
  "tree-sitter-wasms",
  "out"
);

const EXT_TO_GRAMMAR: Record<string, string> = {
  ".ts": "tree-sitter-typescript",
  ".tsx": "tree-sitter-tsx",
  ".js": "tree-sitter-javascript",
  ".jsx": "tree-sitter-javascript",
  ".mjs": "tree-sitter-javascript",
  ".cjs": "tree-sitter-javascript",
  ".py": "tree-sitter-python",
  ".rs": "tree-sitter-rust",
  ".go": "tree-sitter-go",
  ".java": "tree-sitter-java",
};

const GRAMMAR_TO_EXT: Record<string, string> = {
  "tree-sitter-typescript": ".ts",
  "tree-sitter-tsx": ".tsx",
  "tree-sitter-javascript": ".js",
  "tree-sitter-python": ".py",
  "tree-sitter-rust": ".rs",
  "tree-sitter-go": ".go",
  "tree-sitter-java": ".java",
};

async function initParser(): Promise<void> {
  if (parserInitialized) return;

  try {
    const webTreeSitter = await import("web-tree-sitter");
    // web-tree-sitter@0.20.x: default export IS the Parser class
    TreeSitterParser = webTreeSitter.default ?? webTreeSitter;
    if (typeof TreeSitterParser.init === "function") {
      await TreeSitterParser.init();
    }
    // Language is a static property on Parser class
    TreeSitterLanguage = TreeSitterParser.Language ?? null;
    parserInitialized = true;
    log.debug("Tree-sitter WASM parser initialized");
  } catch (err) {
    log.warn(`Failed to initialize tree-sitter: ${(err as Error).message}`);
  }
}

async function getLanguage(grammarName: string): Promise<any> {
  if (languageModules.has(grammarName)) {
    return languageModules.get(grammarName);
  }

  const wasmPath = path.join(WASM_DIR, `${grammarName}.wasm`);
  if (!fs.existsSync(wasmPath)) {
    log.warn(`WASM grammar not found: ${wasmPath}`);
    return null;
  }

  if (!TreeSitterLanguage) {
    log.warn("TreeSitter.Language not available");
    return null;
  }

  try {
    const lang = await TreeSitterLanguage.load(wasmPath);
    languageModules.set(grammarName, lang);
    return lang;
  } catch (err) {
    log.warn(`Failed to load grammar ${grammarName}: ${(err as Error).message}`);
    return null;
  }
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_GRAMMAR[ext] ?? "tree-sitter-typescript";
}

// ─── Symbol Extraction ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSymbols(tree: any, sourceCode: string, langName: string): Symbol[] {
  const symbols: Symbol[] = [];
  const lines = sourceCode.split("\n");
  const root = tree.rootNode;

  function walk(node: any): void {
    if (!node) return;

    const nodeType = node.type;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const startCol = node.startPosition.column;

    // Extract symbol based on node type
    const symbol = extractSymbolFromNode(node, nodeType, startLine, endLine, startCol, lines);
    if (symbol) {
      symbols.push(symbol);
      // Don't recurse into children of matched top-level symbols
      // but DO continue walking siblings (don't return early)
    } else {
      // Recurse into children only for unmatched nodes
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }
    }
  }

  function extractSymbolFromNode(
    node: any,
    nodeType: string,
    startLine: number,
    endLine: number,
    startCol: number,
    lines: string[]
  ): Symbol | null {
    const line = lines[startLine - 1] ?? "";
    const exported = line.includes("export ");

    switch (nodeType) {
      case "function_declaration":
      case "function": {
        const name = getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "function", line: startLine, endLine, col: startCol, signature: sig, exported };
      }
      case "class_declaration":
      case "class": {
        const name = getChildText(node, "type_identifier") ?? getChildText(node, "identifier") ?? "anonymous";
        return { name, type: "class", line: startLine, endLine, col: startCol, exported };
      }
      case "interface_declaration": {
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "interface", line: startLine, endLine, col: startCol, exported };
      }
      case "type_alias_declaration": {
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "type", line: startLine, endLine, col: startCol, exported };
      }
      case "method_definition":
      case "method_declaration": {
        const name = getChildText(node, "property_identifier") ?? getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "method", line: startLine, endLine, col: startCol, signature: sig, exported };
      }
      case "variable_declaration":
      case "lexical_declaration": {
        const name = extractVariableName(node);
        if (name) {
          return { name, type: "variable", line: startLine, endLine, col: startCol, exported };
        }
        break;
      }
      case "export_statement": {
        // Handle export default, export const, etc.
        const child = node.child(1);
        if (child) {
          return extractSymbolFromNode(child, child.type, startLine, endLine, startCol, lines);
        }
        break;
      }
      case "function_definition": {
        // Python
        const name = getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "function", line: startLine, endLine, col: startCol, signature: sig, exported: line.includes("def ") && !line.startsWith("_") };
      }
      case "class_definition": {
        // Python
        const name = getChildText(node, "identifier") ?? "anonymous";
        return { name, type: "class", line: startLine, endLine, col: startCol, exported: !name.startsWith("_") };
      }
      case "decorated_definition": {
        // Python decorated functions/classes
        const def = findChildByType(node, "function_definition") ?? findChildByType(node, "class_definition");
        if (def) {
          return extractSymbolFromNode(def, def.type, def.startPosition.row + 1, def.endPosition.row + 1, def.startPosition.column, lines);
        }
        break;
      }
      case "function_item": {
        // Rust
        const name = getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        const isPub = line.includes("pub ");
        return { name, type: "function", line: startLine, endLine, col: startCol, signature: sig, exported: isPub };
      }
      case "impl_item": {
        // Rust impl block - extract methods
        break;
      }
      case "struct_item": {
        // Rust
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "class", line: startLine, endLine, col: startCol, exported: line.includes("pub ") };
      }
      case "enum_item": {
        // Rust
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "type", line: startLine, endLine, col: startCol, exported: line.includes("pub ") };
      }
      case "trait_item": {
        // Rust
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "interface", line: startLine, endLine, col: startCol, exported: line.includes("pub ") };
      }
      case "function_declaration": {
        // Go
        const name = getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "function", line: startLine, endLine, col: startCol, signature: sig, exported: exported };
      }
      case "method_declaration": {
        // Go
        const name = getChildText(node, "field_identifier") ?? getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "method", line: startLine, endLine, col: startCol, signature: sig, exported };
      }
      case "type_declaration": {
        // Go type
        const name = getChildText(node, "type_identifier") ?? "anonymous";
        return { name, type: "type", line: startLine, endLine, col: startCol, exported };
      }
      case "method_declaration": {
        // Java
        const name = getChildText(node, "identifier") ?? "anonymous";
        const sig = extractSignature(lines, startLine - 1);
        return { name, type: "method", line: startLine, endLine, col: startCol, signature: sig, exported };
      }
      case "class_declaration": {
        // Java
        const name = getChildText(node, "identifier") ?? "anonymous";
        return { name, type: "class", line: startLine, endLine, col: startCol, exported };
      }
    }

    return null;
  }

  walk(root);
  return symbols;
}

function getChildText(node: any, childType: string): string | null {
  if (!node) return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === childType) {
      return child.text;
    }
  }
  return null;
}

function findChildByType(node: any, childType: string): any | null {
  if (!node) return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === childType) {
      return child;
    }
  }
  return null;
}

function extractVariableName(node: any): string | null {
  if (!node) return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === "identifier" || child.type === "destructuring_pattern")) {
      return child.text;
    }
  }
  return null;
}

function extractSignature(lines: string[], lineIndex: number): string {
  const line = lines[lineIndex] ?? "";
  // Extract up to the opening brace or end of declaration
  const match = line.match(/^(\s*(?:export\s+)?(?:async\s+)?(?:function|def|fn|func|pub\s+fn|pub\s+async\s+fn|private\s+)?\s*\w+\s*\([^)]*\)(?:\s*:\s*\S+)?)/);
  return match?.[1]?.trim() ?? line.trim().slice(0, 120);
}

// ─── Import Extraction ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImports(tree: any, sourceCode: string, langName: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = sourceCode.split("\n");
  const root = tree.rootNode;

  function walk(node: any): void {
    if (!node) return;

    const nodeType = node.type;
    const startLine = node.startPosition.row + 1;

    if (nodeType === "import_statement" || nodeType === "import" || nodeType === "import_from_statement") {
      const importInfo = parseImportNode(node, startLine, lines, langName);
      if (importInfo) imports.push(importInfo);
    } else if (nodeType === "import_declaration") {
      // Java/Rust
      const importInfo = parseImportNode(node, startLine, lines, langName);
      if (importInfo) imports.push(importInfo);
    } else if (nodeType === "require_statement") {
      // CommonJS
      const importInfo = parseRequireNode(node, startLine, lines);
      if (importInfo) imports.push(importInfo);
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  function parseImportNode(
    node: any,
    line: number,
    lines: string[],
    lang: string
  ): ImportInfo | null {
    const text = node.text;
    const moduleMatch = text.match(/(?:from\s+|require\s*\(\s*|import\s+)(?:["'`])([^"'`]+)(?:["'`])/);
    const module = moduleMatch?.[1] ?? "";

    const isDefault = text.includes("import default") || text.match(/import\s+\w+\s+from/);
    const isTypeOnly = text.includes("type ") && text.includes("import");

    // Extract imported symbols
    const symbols: string[] = [];
    const symbolMatch = text.match(/\{([^}]+)\}/);
    if (symbolMatch) {
      symbols.push(...symbolMatch[1].split(",").map((s: string) => s.trim().split(/\s+as\s+/)[0]!.trim()));
    } else {
      const defaultMatch = text.match(/import\s+(\w+)/);
      if (defaultMatch) symbols.push(defaultMatch[1]!);
    }

    return { module, symbols, isDefault: !!isDefault, isTypeOnly, line };
  }

  function parseRequireNode(
    node: any,
    line: number,
    lines: string[]
  ): ImportInfo | null {
    const text = node.text;
    const match = text.match(/require\s*\(\s*["'`]([^"'`]+)["'`]/);
    if (!match) return null;
    return { module: match[1]!, symbols: [], isDefault: true, isTypeOnly: false, line };
  }

  walk(root);
  return imports;
}

// ─── Export Extraction ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractExports(tree: any, sourceCode: string): string[] {
  const exports: string[] = [];
  const lines = sourceCode.split("\n");
  const root = tree.rootNode;

  function walk(node: any): void {
    if (!node) return;

    const nodeType = node.type;
    if (nodeType === "export_statement" || nodeType === "export") {
      const text = node.text;
      // export { name1, name2 }
      const namedMatch = text.match(/\{([^}]+)\}/);
      if (namedMatch) {
        exports.push(...namedMatch[1].split(",").map((s: string) => s.trim().split(/\s+as\s+/)[0]!.trim()));
      }
      // export default
      if (text.includes("default")) {
        exports.push("default");
      }
      // export const/function/class name
      const nameMatch = text.match(/export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/);
      if (nameMatch) {
        exports.push(nameMatch[1]!);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return [...new Set(exports)];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function parseSource(
  sourceCode: string,
  language?: string
): Promise<ParseResult> {
  await initParser();

  if (!TreeSitterParser || !parserInitialized) {
    return fallbackParse(sourceCode, language);
  }

  const langName = language ?? "typescript";
  const lang = await getLanguage(langName);

  if (!lang) {
    return fallbackParse(sourceCode, language);
  }

  try {
    const parser = new TreeSitterParser();
    parser.setLanguage(lang);
    const tree = parser.parse(sourceCode);

    const symbols = extractSymbols(tree, sourceCode, langName);
    const imports = extractImports(tree, sourceCode, langName);
    const exports = extractExports(tree, sourceCode);
    const lineCount = sourceCode.split("\n").length;

    return { language: langName, symbols, imports, exports, lineCount };
  } catch (err) {
    log.warn(`Tree-sitter parse failed: ${(err as Error).message}`);
    return fallbackParse(sourceCode, language);
  }
}

export async function parseFile(filePath: string): Promise<ParseResult> {
  try {
    if (!fs.existsSync(filePath)) {
      return { language: "unknown", symbols: [], imports: [], exports: [], lineCount: 0 };
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(filePath).filter((f) => /\.(ts|tsx|js|jsx|py|rs|go|java)$/i.test(f));
      const allSymbols: Symbol[] = [];
      const allImports: ImportInfo[] = [];
      const allExports: string[] = [];

      for (const file of files.slice(0, 50)) {
        const result = await parseFile(path.join(filePath, file));
        allSymbols.push(...result.symbols.map((s) => ({ ...s, docstring: `${file}:${s.line}` })));
        allImports.push(...result.imports);
        allExports.push(...result.exports);
      }

      return {
        language: "directory",
        symbols: allSymbols,
        imports: allImports,
        exports: allExports,
        lineCount: 0,
      };
    }

    const sourceCode = fs.readFileSync(filePath, "utf8");
    const langName = detectLanguage(filePath);
    return await parseSource(sourceCode, langName);
  } catch (err) {
    log.warn(`Failed to parse file ${filePath}: ${(err as Error).message}`);
    return { language: "unknown", symbols: [], imports: [], exports: [], lineCount: 0 };
  }
}

export function findSymbol(parseResult: ParseResult, name: string): Symbol | undefined {
  return parseResult.symbols.find((s) => s.name === name);
}

export function findDependencies(parseResult: ParseResult): ImportInfo[] {
  return parseResult.imports;
}

// ─── Fallback (regex-based) ─────────────────────────────────────────────────

function fallbackParse(sourceCode: string, language?: string): ParseResult {
  const lines = sourceCode.split("\n");
  const langName = language ?? "typescript";
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const exports: string[] = [];

  // TypeScript/JavaScript patterns
  const tsPatterns: RegExp[] = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+)?interface\s+(\w+)/,
    /^(?:export\s+)?type\s+(\w+)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/,
  ];

  // Python patterns
  const pyPatterns: RegExp[] = [
    /^(?:async\s+)?def\s+(\w+)/,
    /^class\s+(\w+)/,
  ];

  // Rust patterns
  const rustPatterns: RegExp[] = [
    /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    /^(?:pub\s+)?struct\s+(\w+)/,
    /^(?:pub\s+)?enum\s+(\w+)/,
    /^(?:pub\s+)?trait\s+(\w+)/,
  ];

  // Go patterns
  const goPatterns: RegExp[] = [
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
    /^type\s+(\w+)\s+struct/,
    /^type\s+(\w+)\s+interface/,
  ];

  // Java patterns
  const javaPatterns: RegExp[] = [
    /^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface)\s+(\w+)/,
    /^(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
  ];

  let symbolPatterns: RegExp[];
  let importPattern: RegExp;
  let exportPattern: RegExp;

  switch (langName) {
    case "tree-sitter-python":
    case "python":
      symbolPatterns = pyPatterns;
      importPattern = /^(?:from\s+(\S+)\s+)?import\s+(.+)/;
      exportPattern = /^__all__\s*=/;
      break;
    case "tree-sitter-rust":
    case "rust":
      symbolPatterns = rustPatterns;
      importPattern = /^use\s+([\w:]+)\s*;/;
      exportPattern = /^pub\s+(?:fn|struct|enum|trait)\s+(\w+)/;
      break;
    case "tree-sitter-go":
    case "go":
      symbolPatterns = goPatterns;
      importPattern = /^import\s+(?:"([^"]+)"|(\w+)\s+"([^"]+)")/;
      exportPattern = /^func\s+([A-Z]\w+)/;
      break;
    case "tree-sitter-java":
    case "java":
      symbolPatterns = javaPatterns;
      importPattern = /^import\s+(?:static\s+)?([\w.]+)\s*;/;
      exportPattern = /^public\s+(?:class|interface)\s+(\w+)/;
      break;
    default:
      symbolPatterns = tsPatterns;
      importPattern = /(?:import|from|require)\s+.*?["'`]([^"'`]+)["'`]/;
      exportPattern = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    for (const pattern of symbolPatterns) {
      const match = pattern.exec(line);
      if (match) {
        const name = match[1]!;
        let type: Symbol["type"] = "function";
        if (line.includes("class")) type = "class";
        else if (line.includes("interface")) type = "interface";
        else if (line.includes("type ")) type = "type";
        else if (line.includes("struct")) type = "class";
        else if (line.includes("enum")) type = "type";
        else if (line.includes("trait")) type = "interface";
        else if (line.includes("=")) type = "variable";

        const isExported = line.includes("export") || line.includes("pub ") || (!name.startsWith("_") && langName.includes("python"));
        symbols.push({ name, type, line: i + 1, exported: isExported });
        break;
      }
    }

    const importMatch = importPattern.exec(line);
    if (importMatch) {
      const module = importMatch[1] ?? importMatch[2] ?? importMatch[3] ?? "";
      imports.push({
        module,
        symbols: [],
        isDefault: false,
        isTypeOnly: false,
        line: i + 1,
      });
    }

    const exportMatch = exportPattern.exec(line);
    if (exportMatch) {
      exports.push(exportMatch[1]!);
    }
  }

  return { language: langName, symbols, imports, exports, lineCount: lines.length };
}
