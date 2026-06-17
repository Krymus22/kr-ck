/**
 * syntaxHighlight.ts - Syntax highlighting for terminal output using ANSI colors.
 */

// Simple regex-based syntax highlighter for common languages
// Returns text with ANSI escape codes for terminal coloring

const KEYWORDS: Record<string, string[]> = {
  typescript: [
    "import", "export", "from", "const", "let", "var", "function", "return",
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
    "class", "extends", "implements", "interface", "type", "enum", "namespace",
    "async", "await", "new", "this", "super", "throw", "try", "catch", "finally",
    "typeof", "instanceof", "in", "of", "as", "default", "void", "null", "undefined",
    "true", "false", "private", "public", "protected", "static", "readonly", "abstract",
    "satisfies", "keyof", "infer", "never", "unknown", "any", "string", "number", "boolean",
  ],
  python: [
    "def", "class", "import", "from", "return", "if", "elif", "else", "for", "while",
    "try", "except", "finally", "raise", "with", "as", "yield", "lambda", "pass",
    "break", "continue", "True", "False", "None", "and", "or", "not", "in", "is",
    "self", "cls", "async", "await", "global", "nonlocal", "del", "assert",
  ],
  rust: [
    "fn", "let", "mut", "const", "struct", "enum", "impl", "trait", "pub", "use",
    "mod", "crate", "self", "super", "return", "if", "else", "for", "while", "loop",
    "match", "break", "continue", "move", "ref", "async", "await", "where", "dyn",
    "true", "false", "Some", "None", "Ok", "Err", "Self", "Box", "Vec", "String",
  ],
  go: [
    "package", "import", "func", "return", "if", "else", "for", "range", "switch",
    "case", "default", "var", "const", "type", "struct", "interface", "map", "chan",
    "go", "select", "defer", "nil", "true", "false", "make", "new", "len", "cap",
  ],
  java: [
    "public", "private", "protected", "class", "interface", "enum", "extends", "implements",
    "void", "int", "long", "double", "float", "boolean", "char", "byte", "short", "String",
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
    "try", "catch", "finally", "throw", "throws", "new", "this", "super", "static", "final",
    "abstract", "synchronized", "volatile", "transient", "instanceof", "null", "true", "false",
  ],
};

const COMMENT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [/\/\/.*$/, /\/\*[\s\S]*?\*\//],
  python: [/#.*$/, /"""[\s\S]*?"""/, /'''[\s\S]*?'''/],
  rust: [/\/\/.*$/, /\/\*[\s\S]*?\*\//],
  go: [/\/\/.*$/, /\/\*[\s\S]*?\*\//],
  java: [/\/\/.*$/, /\/\*[\s\S]*?\*\//],
};

export function highlightSyntax(code: string, language: string = "typescript"): string {
  const keywords = KEYWORDS[language] ?? KEYWORDS.typescript;
  const commentPatterns = COMMENT_PATTERNS[language] ?? COMMENT_PATTERNS.typescript;

  const lines = code.split("\n");
  const highlighted: string[] = [];

  for (const line of lines) {
    let result = line;

    // Highlight strings first (to avoid coloring keywords inside strings)
    result = result.replaceAll(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, (m) => `\x1b[32m${m}\x1b[0m`);

    // Highlight comments
    for (const pattern of commentPatterns) {
      result = result.replace(pattern, (m) => `\x1b[90m${m}\x1b[0m`);
    }

    // Highlight numbers
    result = result.replaceAll(/\b(\d+\.?\d*(?:_\d+)*)\b/g, (m) => `\x1b[33m${m}\x1b[0m`);

    // Highlight keywords
    for (const kw of keywords) {
      const kwPattern = new RegExp(String.raw`\b(${kw})\b`, "g");
      result = result.replace(kwPattern, (m) => `\x1b[36m${m}\x1b[0m`);
    }

    // Highlight function calls
    result = result.replaceAll(/\b([a-zA-Z_]\w*)\s*\(/g, (m, name) => `\x1b[35m${name}\x1b[0m(`);

    highlighted.push(result);
  }

  return highlighted.join("\n");
}

export function detectLanguageFromExt(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript",
    ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript",
    ".py": "python", ".pyw": "python",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
  };
  return map[ext.toLowerCase()] ?? "typescript";
}
