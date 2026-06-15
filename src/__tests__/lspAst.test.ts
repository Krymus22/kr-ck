/**
 * lspAst.test.ts — Tests for AST parsing module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile, parseSource, findSymbol, findDependencies } from "../lspAst.js";

const TEST_DIR = path.join(process.cwd(), "__test_astdir__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, "types.ts"),
    `export interface User { name: string; age: number; }
export type ID = string | number;
export function greet(name: string): string { return "Hello " + name; }
export class Calculator { add(a: number, b: number) { return a + b; } }
const internal = 42;
import { foo } from "bar";
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "python.py"),
    `def hello():
    pass

class Foo:
    def bar(self):
        pass

from os import path
import sys
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "rust.rs"),
    `pub fn add(a: i32, b: i32) -> i32 { a + b }
struct Point { x: f64, y: f64 }
enum Color { Red, Green, Blue }
trait Drawable { fn draw(&self); }
use std::collections::HashMap;
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "go.go"),
    `package main
import "fmt"
func main() { fmt.Println("hello") }
type User struct { Name string }
interface Stringer { String() string }
`,
    "utf8"
  );
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseFile", () => {
  it("should parse TypeScript file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    expect(result.language).toBe("tree-sitter-typescript");
    expect(result.symbols.length).toBeGreaterThan(0);
    expect(result.imports.length).toBeGreaterThan(0);
    expect(result.lineCount).toBeGreaterThan(0);
  });

  it("should detect exported symbols", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const exported = result.symbols.filter((s) => s.exported);
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.some((s) => s.name === "greet")).toBe(true);
  });

  it("should parse Python file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "python.py"));
    expect(result.language).toBe("tree-sitter-python");
    expect(result.symbols.some((s) => s.name === "hello")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Foo")).toBe(true);
  });

  it("should parse Rust file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "rust.rs"));
    expect(result.language).toBe("tree-sitter-rust");
    expect(result.symbols.some((s) => s.name === "add")).toBe(true);
    expect(result.symbols.some((s) => s.name === "Point")).toBe(true);
  });

  it("should parse Go file", async () => {
    const result = await parseFile(path.join(TEST_DIR, "go.go"));
    expect(result.language).toBe("tree-sitter-go");
    expect(result.symbols.some((s) => s.name === "main")).toBe(true);
  });

  it("should return empty for non-existent file", async () => {
    const result = await parseFile("/nonexistent/file.ts");
    expect(result.lineCount).toBe(0);
  });
});

describe("parseSource", () => {
  it("should parse source string", async () => {
    const result = await parseSource("const x = 1;\nexport function foo() {}", "tree-sitter-typescript");
    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
  });
});

describe("findSymbol", () => {
  it("should find a specific symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "greet");
    expect(symbol).toBeDefined();
    expect(symbol!.type).toBe("function");
  });

  it("should return undefined for non-existent symbol", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const symbol = findSymbol(result, "nonexistent");
    expect(symbol).toBeUndefined();
  });
});

describe("findDependencies", () => {
  it("should extract imports", async () => {
    const result = await parseFile(path.join(TEST_DIR, "types.ts"));
    const deps = findDependencies(result);
    expect(deps.length).toBeGreaterThan(0);
  });
});
