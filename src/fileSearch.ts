// fileSearch.ts - Glob-style file search using patterns like **/*.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

export interface GlobOptions {
  pattern: string;
  cwd?: string;
  maxDepth?: number;
  ignore?: string[];
}

/**
 * Simple glob implementation supporting **, *, and ? patterns.
 */
export function globSearch(opts: GlobOptions): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const pattern = opts.pattern;
  const ignore = opts.ignore ?? ["node_modules", ".git", "dist", ".next"];
  const maxDepth = opts.maxDepth ?? 20;

  log.toolCall("buscar_arquivos", { pattern, cwd });

  const results: string[] = [];
  searchDir(cwd, pattern, ignore, results, 0, maxDepth, cwd);

  log.toolResult("buscar_arquivos", true, `${results.length} files`);
  return results;
}

function searchDir(
  dir: string,
  pattern: string,
  ignore: string[],
  results: string[],
  depth: number,
  maxDepth: number,
  rootDir: string
): void {
  if (depth > maxDepth) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // permission denied or other error
  }

  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath).replaceAll("\\", "/");

    if (entry.isDirectory()) {
      searchDir(fullPath, pattern, ignore, results, depth + 1, maxDepth, rootDir);
    } else if (entry.isFile()) {
      if (matchesGlob(relPath, pattern) || matchesGlob(entry.name, pattern)) {
        results.push(relPath);
      }
    }
  }
}

/**
 * Match a path against a glob pattern.
 * Supports: **, *, ?, {a,b}
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  // Normalize separators
  const normalizedPath = filePath.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");

  // Handle {a,b,c} patterns
  if (normalizedPattern.includes("{")) {
    const expanded = expandBraces(normalizedPattern);
    return expanded.some((p) => matchesGlob(normalizedPath, p));
  }

  // Convert glob to regex
  const regexStr = globToRegex(normalizedPattern);
  try {
    const re = new RegExp(`^${regexStr}$`, "i");
    return re.test(normalizedPath);
  } catch {
    return false;
  }
}

function globToRegex(glob: string): string {
  let re = "";
  let i = 0;

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches everything including /
        re += ".*";
        i += 2;
        // Skip optional trailing /
        if (glob[i] === "/") i++;
      } else {
        // * matches everything except /
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === ".") {
      re += String.raw`\.`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  return re;
}

function expandBraces(pattern: string): string[] {
  const results: string[] = [];
  const match = /^(.*?)\{([^}]+)\}(.*)$/.exec(pattern);
  if (!match) return [pattern];

  const prefix = match[1];
  const alternatives = match[2].split(",");
  const suffix = match[3];

  for (const alt of alternatives) {
    const expanded = expandBraces(prefix + alt + suffix);
    results.push(...expanded);
  }

  return results;
}

export function findFilesByExtension(ext: string, cwd?: string): string[] {
  return globSearch({ pattern: `**/*${ext}`, cwd });
}

export function findFilesByName(name: string, cwd?: string): string[] {
  return globSearch({ pattern: `**/${name}`, cwd });
}
