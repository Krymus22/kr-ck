/**
 * rust.ts - Rust development tools
 * 
 * Tools for cargo, clippy, rustfmt
 */

import { Tool } from "../externalTools.js";

export const RUST_TOOLS: Tool[] = [
  // --- Cargo Build ------------------------------------------------------
  {
    name: "cargo_build",
    description: "Build Rust project with Cargo",
    category: "rust",
    command: "cargo",
    args: ["build"],
    flags: [
      { name: "--release", type: "boolean", description: "Build in release mode" },
      { name: "--target", type: "string", description: "Build target triple" },
      { name: "--package", type: "string", description: "Package to build" },
      { name: "--workspace", type: "boolean", description: "Build entire workspace" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "build rust project",
        "cargo build",
        "compile rust"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo build", "cargo build --release"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const errors = output.split("\n").filter(l => l.includes("error"));
      return {
        success: errors.length === 0,
        output,
        metadata: { errorCount: errors.length }
      };
    }
  },
  
  // --- Cargo Run --------------------------------------------------------
  {
    name: "cargo_run",
    description: "Run Rust binary with Cargo",
    category: "rust",
    command: "cargo",
    args: ["run"],
    flags: [
      { name: "--release", type: "boolean", description: "Run in release mode" },
      { name: "--args", type: "string", description: "Arguments for the binary" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "run rust program",
        "cargo run",
        "execute rust"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo run", "cargo run --release", "cargo run -- arg1 arg2"]
    },
    outputParser: "raw"
  },
  
  // --- Cargo Test -------------------------------------------------------
  {
    name: "cargo_test",
    description: "Run Rust tests with Cargo",
    category: "rust",
    command: "cargo",
    args: ["test"],
    flags: [
      { name: "--release", type: "boolean", description: "Test in release mode" },
      { name: "--package", type: "string", description: "Package to test" },
      { name: "--lib", type: "boolean", description: "Test only library" },
      { name: "--test", type: "string", description: "Test binary to run" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "run rust tests",
        "cargo test",
        "test rust code"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo test", "cargo test --lib", "cargo test my_test"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const passed = /(\d+) passed/.exec(output);
      const failed = /(\d+) failed/.exec(output);
      return {
        success: !failed || Number.parseInt(failed[1], 10) === 0,
        output,
        metadata: {
          passed: passed ? Number.parseInt(passed[1], 10) : 0,
          failed: failed ? Number.parseInt(failed[1], 10) : 0
        }
      };
    }
  },
  
  // --- Cargo Clippy -----------------------------------------------------
  {
    name: "cargo_clippy",
    description: "Lint Rust code with Clippy",
    category: "rust",
    command: "cargo",
    args: ["clippy"],
    flags: [
      { name: "--all-targets", type: "boolean", description: "Check all targets" },
      { name: "--all-features", type: "boolean", description: "Check all features" },
      { name: "--fix", type: "boolean", description: "Auto-fix issues" },
      { name: "--package", type: "string", description: "Package to check" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "lint rust code",
        "cargo clippy",
        "check rust style",
        "rust linter"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo clippy", "cargo clippy --all-targets", "cargo clippy --fix"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const warnings = output.split("\n").filter(l => l.includes("warning"));
      const errors = output.split("\n").filter(l => l.includes("error"));
      return {
        success: errors.length === 0,
        output,
        metadata: { warnings: warnings.length, errors: errors.length }
      };
    }
  },
  
  // --- Cargo fmt --------------------------------------------------------
  {
    name: "cargo_fmt",
    description: "Format Rust code with rustfmt",
    category: "rust",
    command: "cargo",
    args: ["fmt"],
    flags: [
      { name: "--check", type: "boolean", description: "Check only, don't modify" },
      { name: "--all", type: "boolean", description: "Format all packages" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "format rust code",
        "cargo fmt",
        "rust formatter"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo fmt", "cargo fmt --check"]
    },
    outputParser: "raw"
  },
  
  // --- Cargo Add --------------------------------------------------------
  {
    name: "cargo_add",
    description: "Add dependency to Cargo.toml",
    category: "rust",
    command: "cargo",
    args: ["add"],
    flags: [
      { name: "package", type: "string", required: true, description: "Package name" },
      { name: "--dev", type: "boolean", description: "Add as dev dependency" },
      { name: "--features", type: "string", description: "Features to enable" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "add rust dependency",
        "cargo add",
        "add crate"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo add serde", "cargo add --dev assert_cmd"]
    },
    outputParser: "raw"
  },
  
  // --- Cargo Doc --------------------------------------------------------
  {
    name: "cargo_doc",
    description: "Generate Rust documentation",
    category: "rust",
    command: "cargo",
    args: ["doc"],
    flags: [
      { name: "--open", type: "boolean", description: "Open in browser" },
      { name: "--no-deps", type: "boolean", description: "Don't build dependencies" },
      { name: "--package", type: "string", description: "Package to document" }
    ],
    detection: {
      method: "binary",
      check: "cargo --version"
    },
    context: {
      whenToUse: [
        "generate rust docs",
        "cargo doc",
        "rust documentation"
      ],
      requiresProject: ["Cargo.toml"],
      examples: ["cargo doc --open", "cargo doc --no-deps"]
    },
    outputParser: "raw"
  },
  
  // --- Rustup -----------------------------------------------------------
  {
    name: "rustup_update",
    description: "Update Rust toolchain",
    category: "rust",
    command: "rustup",
    args: ["update"],
    flags: [],
    detection: {
      method: "binary",
      check: "rustup --version"
    },
    context: {
      whenToUse: [
        "update rust",
        "rustup update",
        "update rust toolchain"
      ],
      examples: ["rustup update"]
    },
    outputParser: "raw"
  }
];