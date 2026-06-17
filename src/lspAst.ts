/**
 * lspAst.ts - Language-agnostic AST parsing via tree-sitter WASM.
 * Provides symbol extraction, function/class detection, and import analysis
 * with real syntax tree parsing for 7 languages.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

// --- Types -------------------------------------------------------------------

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

// --- Tree-sitter WASM Loader ------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TreeSitterParser: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let TreeSitterLanguage: any = null;
let parserInitialized = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/** Detect whether an import statement is a default import. */
function isDefaultImport(text: string): boolean {
  if (text.includes("import default")) return true;
  return /import\s+\w+\s+from/.test(text);
}

async function initParser(): Promise<void> {
  if (parserInitialized) return;

  try {
    const webTreeSitter = await import("web-tree-sitter");
    TreeSitterParser = webTreeSitter.default ?? webTreeSitter;
    if (typeof TreeSitterParser.init === "function") {
      await TreeSitterParser.init();
    }
    TreeSitterLanguage = TreeSitterParser.Language ?? null;
    parserInitialized = true;
    log.debug("Tree-sitter WASM parser initialized");
  } catch (err) {
    log.warn(`Failed to initialize tree-sitter: ${err instanceof Error ? err.message : String(err)}`);
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
    log.warn(`Failed to load grammar ${grammarName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_GRAMMAR[ext] ?? "tree-sitter-typescript";
}

// --- Symbol Extraction ------------------------------------------------------

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration", "function", "function_definition", "function_item",
]);
const CLASS_NODE_TYPES = new Set([
  "class_declaration", "class", "class_definition", "struct_item",
]);
const TYPE_NODE_TYPES = new Set([
  "interface_declaration", "type_alias_declaration", "type_declaration",
  "enum_item", "trait_item",
]);
const METHOD_NODE_TYPES = new Set(["method_definition", "method_declaration"]);
const VARIABLE_NODE_TYPES = new Set(["variable_declaration", "lexical_declaration"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  if (FUNCTION_NODE_TYPES.has(nodeType)) {
    return buildFunctionSymbol(node, nodeType, startLine, endLine, startCol, lines, exported);
  }
  if (CLASS_NODE_TYPES.has(nodeType)) {
    return buildClassSymbol(node, nodeType, startLine, endLine, startCol, exported);
  }
  if (TYPE_NODE_TYPES.has(nodeType)) {
    return buildTypeSymbol(node, nodeType, startLine, endLine, startCol, exported);
  }
  if (METHOD_NODE_TYPES.has(nodeType)) {
    return buildMethodSymbol(node, startLine, endLine, startCol, lines, exported);
  }
  if (VARIABLE_NODE_TYPES.has(nodeType)) {
    const name = extractVariableName(node);
    return name ? { name, type: "variable", line: startLine, endLine, col: startCol, exported } : null;
  }
  if (nodeType === "export_statement") {
    const child = node.child(1);
    return child
      ? extractSymbolFromNode(child, child.type, startLine, endLine, startCol, lines)
      : null;
  }
  if (nodeType === "decorated_definition") {
    return extractDecoratedSymbol(node, startLine, endLine, startCol, lines);
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFunctionSymbol(
  node: any,
  nodeType: string,
  startLine: number,
  endLine: number,
  startCol: number,
  lines: string[],
  exported: boolean
): Symbol {
  const name = getChildText(node, "identifier") ?? "anonymous";
  const sig = extractSignature(lines, startLine - 1);
  const line = lines[startLine - 1] ?? "";

  let isExported = exported;
  if (nodeType === "function_definition") {
    isExported = line.includes("def ") && !line.startsWith("_");
  } else if (nodeType === "function_item") {
    isExported = line.includes("pub ");
  }

  return { name, type: "function", line: startLine, endLine, col: startCol, signature: sig, exported: isExported };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildClassSymbol(
  node: any,
  nodeType: string,
  startLine: number,
  endLine: number,
  startCol: number,
  exported: boolean
): Symbol {
  const name = getChildText(node, "type_identifier") ?? getChildText(node, "identifier") ?? "anonymous";
  const isExported = nodeType === "class_definition" ? !name.startsWith("_") : exported;
  return { name, type: "class", line: startLine, endLine, col: startCol, exported: isExported };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTypeSymbol(
  node: any,
  nodeType: string,
  startLine: number,
  endLine: number,
  startCol: number,
  exported: boolean
): Symbol {
  const name = getChildText(node, "type_identifier") ?? "anonymous";
  const typeMap: Record<string, Symbol["type"]> = {
    interface_declaration: "interface",
    type_alias_declaration: "type",
    type_declaration: "type",
    enum_item: "type",
    trait_item: "interface",
  };
  return { name, type: typeMap[nodeType] ?? "type", line: startLine, endLine, col: startCol, exported };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMethodSymbol(
  node: any,
  startLine: number,
  endLine: number,
  startCol: number,
  lines: string[],
  exported: boolean
): Symbol {
  const name = getChildText(node, "property_identifier") ?? getChildText(node, "identifier") ?? "anonymous";
  const sig = extractSignature(lines, startLine - 1);
  return { name, type: "method", line: startLine, endLine, col: startCol, signature: sig, exported };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDecoratedSymbol(
  node: any,
  startLine: number,
  endLine: number,
  startCol: number,
  lines: string[]
): Symbol | null {
  const def = findChildByType(node, "function_definition") ?? findChildByType(node, "class_definition");
  return def
    ? extractSymbolFromNode(def, def.type, def.startPosition.row + 1, def.endPosition.row + 1, def.startPosition.column, lines)
    : null;
}

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

    const symbol = extractSymbolFromNode(node, nodeType, startLine, endLine, startCol, lines);
    if (symbol) {
      symbols.push(symbol);
    } else {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) walk(child);
      }
    }
  }

  walk(root);
  return symbols;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChildText(node: any, childType: string): string | null {
  if (!node) return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === childType) {
      return child.text;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findChildByType(node: any, childType: string): any {
  if (!node) return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === childType) {
      return child;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  if (!/function|def|fn|func/.test(line)) {
    return line.trim().slice(0, 120);
  }
  const match = /^(\s*(?:\S+\s+)*\w+\s*\([^)]*\)(?:\s*:\s*\S+)?)/.exec(line);
  return match?.[1]?.trim() ?? line.trim().slice(0, 120);
}

// --- Import Extraction ------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImports(tree: any, sourceCode: string, langName: string): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const lines = sourceCode.split("\n");
  const root = tree.rootNode;

  function walk(node: any): void {
    if (!node) return;

    const nodeType = node.type;
    const startLine = node.startPosition.row + 1;

    if (
      nodeType === "import_statement" ||
      nodeType === "import" ||
      nodeType === "import_from_statement" ||
      nodeType === "import_declaration"
    ) {
      const importInfo = parseImportNode(node, startLine, lines, langName);
      if (importInfo) imports.push(importInfo);
    } else if (nodeType === "require_statement") {
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
    const moduleMatch = /(?:from\s+|require\s*\(\s*|import\s+)(?:["'`])([^"'`]+)(?:["'`])/.exec(text);
    const module = moduleMatch?.[1] ?? "";

    const isDefault = isDefaultImport(text);
    const isTypeOnly = text.includes("type ") && text.includes("import");

    const symbols: string[] = [];
    const symbolMatch = /\{([^}]+)\}/.exec(text);
    if (symbolMatch) {
      const parts = symbolMatch[1]?.split(",") ?? [];
      symbols.push(...parts.map(s => s.trim().split(/\s+as\s+/)[0]?.trim() ?? ""));
    } else {
      const defaultMatch = /import\s+(\w+)/.exec(text);
      if (defaultMatch) symbols.push(defaultMatch[1] ?? "unknown");
    }

    return { module, symbols, isDefault: !!isDefault, isTypeOnly, line };
  }

  function parseRequireNode(
    node: any,
    line: number,
    lines: string[]
  ): ImportInfo | null {
    const text = node.text;
    const match = /require\s*\(\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (!match) return null;
    return { module: match[1] ?? "", symbols: [], isDefault: true, isTypeOnly: false, line };
  }

  walk(root);
  return imports;
}

// --- Export Extraction ------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractExports(tree: any, sourceCode: string): string[] {
  const exports: string[] = [];
  const root = tree.rootNode;

  function walk(node: any): void {
    if (!node) return;

    const nodeType = node.type;
    if (nodeType === "export_statement" || nodeType === "export") {
      const text = node.text;
      const namedMatch = /\{([^}]+)\}/.exec(text);
      if (namedMatch) {
        const parts = namedMatch[1]?.split(",") ?? [];
        exports.push(...parts.map(s => s.trim().split(/\s+as\s+/)[0]?.trim() ?? ""));
      }
      if (text.includes("default")) {
        exports.push("default");
      }
      const nameMatch = /export\s+(?:const|let|var|function|class|async\s+function)\s+(\w+)/.exec(text);
      if (nameMatch) {
        exports.push(nameMatch[1] ?? "unknown");
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

// --- Public API -------------------------------------------------------------

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
    log.warn(`Tree-sitter parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackParse(sourceCode, language);
  }
}

async function parseDirectory(dirPath: string): Promise<ParseResult> {
  const files = fs.readdirSync(dirPath).filter((f) => /\.(ts|tsx|js|jsx|py|rs|go|java)$/i.test(f));
  const allSymbols: Symbol[] = [];
  const allImports: ImportInfo[] = [];
  const allExports: string[] = [];

  for (const file of files.slice(0, 50)) {
    const result = await parseFile(path.join(dirPath, file));
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

export async function parseFile(filePath: string): Promise<ParseResult> {
  try {
    if (!fs.existsSync(filePath)) {
      return { language: "unknown", symbols: [], imports: [], exports: [], lineCount: 0 };
    }

    if (fs.statSync(filePath).isDirectory()) {
      return parseDirectory(filePath);
    }

    const sourceCode = fs.readFileSync(filePath, "utf8");
    const langName = detectLanguage(filePath);
    return await parseSource(sourceCode, langName);
  } catch (err) {
    log.warn(`Failed to parse file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return { language: "unknown", symbols: [], imports: [], exports: [], lineCount: 0 };
  }
}

export function findSymbol(parseResult: ParseResult, name: string): Symbol | undefined {
  return parseResult.symbols.find((s) => s.name === name);
}

export function findDependencies(parseResult: ParseResult): ImportInfo[] {
  return parseResult.imports;
}

// --- Fallback (regex-based) -------------------------------------------------

interface LangConfig {
  symbolPatterns: RegExp[];
  importPattern: RegExp;
  exportPattern: RegExp;
}

function getLangConfig(langName: string): LangConfig {
  const tsPatterns: RegExp[] = [
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /^(?:export\s+)?class\s+(\w+)/,
    /^(?:export\s+)?interface\s+(\w+)/,
    /^(?:export\s+)?type\s+(\w+)/,
    /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/,
  ];

  switch (langName) {
    case "tree-sitter-python":
    case "python":
      return {
        symbolPatterns: [
          /^(?:async\s+)?def\s+(\w+)/,
          /^class\s+(\w+)/,
        ],
        importPattern: /^(?:from\s+(\S+)\s+)?import\s+(.+)/,
        exportPattern: /^__all__\s*=/,
      };
    case "tree-sitter-rust":
    case "rust":
      return {
        symbolPatterns: [
          /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
          /^(?:pub\s+)?struct\s+(\w+)/,
          /^(?:pub\s+)?enum\s+(\w+)/,
          /^(?:pub\s+)?trait\s+(\w+)/,
        ],
        importPattern: /^use\s+([\w:]+)\s*;/,
        exportPattern: /^pub\s+(?:fn|struct|enum|trait)\s+(\w+)/,
      };
    case "tree-sitter-go":
    case "go":
      return {
        symbolPatterns: [
          /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/,
          /^type\s+(\w+)\s+struct/,
          /^type\s+(\w+)\s+interface/,
        ],
        importPattern: /^import\s+(?:"([^"]+)"|(\w+)\s+"([^"]+)")/,
        exportPattern: /^func\s+([A-Z]\w+)/,
      };
    case "tree-sitter-java":
    case "java":
      return {
        symbolPatterns: [
          /^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface)\s+(\w+)/,
          /^(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
        ],
        importPattern: /^import\s+(?:static\s+)?([\w.]+)\s*;/,
        exportPattern: /^public\s+(?:class|interface)\s+(\w+)/,
      };
    default:
      return {
        symbolPatterns: tsPatterns,
        importPattern: /(?:import|from|require)\s+.*?["'`]([^"'`]+)["'`]/,
        exportPattern: /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/,
      };
  }
}

function classifySymbolType(line: string): Symbol["type"] {
  if (line.includes("class")) return "class";
  if (line.includes("interface")) return "interface";
  if (line.includes("type ")) return "type";
  if (line.includes("struct")) return "class";
  if (line.includes("enum")) return "type";
  if (line.includes("trait")) return "interface";
  if (line.includes("=")) return "variable";
  return "function";
}

function fallbackParse(sourceCode: string, language?: string): ParseResult {
  const lines = sourceCode.split("\n");
  const langName = language ?? "typescript";
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const exports: string[] = [];

  const config = getLangConfig(langName);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    for (const pattern of config.symbolPatterns) {
      const match = pattern.exec(line);
      if (match) {
        const name = match[1] ?? "unknown";
        const type = classifySymbolType(line);
        const isExported = line.includes("export") || line.includes("pub ") || (!name.startsWith("_") && langName.includes("python"));
        symbols.push({ name, type, line: i + 1, exported: isExported });
        break;
      }
    }

    const importMatch = config.importPattern.exec(line);
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

    const exportMatch = config.exportPattern.exec(line);
    if (exportMatch) {
      exports.push(exportMatch[1] ?? "unknown");
    }
  }

  return { language: langName, symbols, imports, exports, lineCount: lines.length };
}
