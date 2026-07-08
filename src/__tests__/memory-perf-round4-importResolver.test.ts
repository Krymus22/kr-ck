/**
 * memory-perf-round4-importResolver.test.ts
 *
 * Verifies that importResolver.checkImports caches file reads within a
 * single call. Uses vi.mock("node:fs") to count readFileSync invocations
 * because vi.spyOn cannot redefine ESM module-namespace exports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Track readFileSync calls WITHOUT breaking real fs behavior.
// We import the real module, wrap readFileSync in a counting spy, and
// re-export the rest unchanged. The importResolver module under test
// imports `node:fs` so it will pick up this mock.
let readCalls: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: vi.fn((...args: Parameters<typeof fs.readFileSync>) => {
      readCalls.push(String(args[0]));
      return real.readFileSync(...args);
    }),
  };
});

// Import AFTER the mock is registered so the resolver picks up the spy.
const { checkImports } = await import("../importResolver.js");

describe("[Round 4] importResolver.checkImports per-call read cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ir-mock-"));
    readCalls = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads each unique resolved target file at most once per checkImports call", () => {
    const target = path.join(tmpDir, "utils.ts");
    fs.writeFileSync(target, "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "utf8");

    const src = path.join(tmpDir, "src.ts");
    const srcContent =
      "import { a } from './utils';\n" +
      "import { b } from './utils';\n" +
      "import { c } from './utils';\n";
    fs.writeFileSync(src, srcContent, "utf8");

    readCalls = [];
    const result = checkImports(src, srcContent);

    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);

    // Count reads of the TARGET file specifically (the source content is
    // passed in as an argument, not read from disk by checkImports).
    const targetReads = readCalls.filter((p) => p === target).length;
    expect(targetReads).toBe(1); // cached after first read
  });

  it("reads two DIFFERENT target files exactly once each", () => {
    const t1 = path.join(tmpDir, "a.ts");
    const t2 = path.join(tmpDir, "b.ts");
    fs.writeFileSync(t1, "export const x = 1;\n", "utf8");
    fs.writeFileSync(t2, "export const y = 2;\n", "utf8");

    const src = path.join(tmpDir, "src.ts");
    const srcContent =
      "import { x } from './a';\n" +
      "import { y } from './b';\n";
    fs.writeFileSync(src, srcContent, "utf8");

    readCalls = [];
    const result = checkImports(src, srcContent);
    expect(result.ok).toBe(true);

    const t1Reads = readCalls.filter((p) => p === t1).length;
    const t2Reads = readCalls.filter((p) => p === t2).length;
    expect(t1Reads).toBe(1);
    expect(t2Reads).toBe(1);
  });
});
