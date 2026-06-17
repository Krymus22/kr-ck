/**
 * go.ts - Go development tools
 * 
 * Tools for go build, go test, go mod, golangci-lint
 */

import { Tool } from "../externalTools.js";

export const GO_TOOLS: Tool[] = [
  // --- Go Build ---------------------------------------------------------
  {
    name: "go_build",
    description: "Build Go project",
    category: "go",
    command: "go",
    args: ["build"],
    flags: [
      { name: "package", type: "string", description: "Package to build" },
      { name: "-o", type: "string", description: "Output file" },
      { name: "-v", type: "boolean", description: "Verbose output" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "build go project",
        "go build",
        "compile go"
      ],
      requiresProject: ["go.mod"],
      examples: ["go build ./...", "go build -o myapp", "go build -v ./cmd/server"]
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
  
  // --- Go Run -----------------------------------------------------------
  {
    name: "go_run",
    description: "Run Go program",
    category: "go",
    command: "go",
    args: ["run"],
    flags: [
      { name: "package", type: "string", required: true, description: "Package to run" },
      { name: "args", type: "string", description: "Program arguments" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "run go program",
        "go run",
        "execute go"
      ],
      requiresProject: ["go.mod"],
      examples: ["go run main.go", "go run ./cmd/server"]
    },
    outputParser: "raw"
  },
  
  // --- Go Test ----------------------------------------------------------
  {
    name: "go_test",
    description: "Run Go tests",
    category: "go",
    command: "go",
    args: ["test"],
    flags: [
      { name: "package", type: "string", description: "Package to test" },
      { name: "-v", type: "boolean", description: "Verbose output" },
      { name: "-cover", type: "boolean", description: "Show coverage" },
      { name: "-race", type: "boolean", description: "Enable race detector" },
      { name: "-run", type: "string", description: "Run specific test" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "run go tests",
        "go test",
        "test go code"
      ],
      requiresProject: ["go.mod"],
      examples: ["go test ./...", "go test -v -cover", "go test -run TestMyFunc"]
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
  
  // --- Go Mod -----------------------------------------------------------
  {
    name: "go_mod_download",
    description: "Download Go modules",
    category: "go",
    command: "go",
    args: ["mod", "download"],
    flags: [],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "download go modules",
        "go mod download"
      ],
      requiresProject: ["go.mod"],
      examples: ["go mod download"]
    },
    outputParser: "raw"
  },
  
  {
    name: "go_mod_tidy",
    description: "Tidy Go modules",
    category: "go",
    command: "go",
    args: ["mod", "tidy"],
    flags: [],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "tidy go modules",
        "go mod tidy",
        "clean go dependencies"
      ],
      requiresProject: ["go.mod"],
      examples: ["go mod tidy"]
    },
    outputParser: "raw"
  },
  
  {
    name: "go_get",
    description: "Add Go dependency",
    category: "go",
    command: "go",
    args: ["get"],
    flags: [
      { name: "package", type: "string", required: true, description: "Package to add" },
      { name: "-u", type: "boolean", description: "Update to latest version" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "add go dependency",
        "go get",
        "install go package"
      ],
      requiresProject: ["go.mod"],
      examples: ["go get github.com/gin-gonic/gin", "go get -u ./..."]
    },
    outputParser: "raw"
  },
  
  // --- Go Vet -----------------------------------------------------------
  {
    name: "go_vet",
    description: "Vet Go code for suspicious constructs",
    category: "go",
    command: "go",
    args: ["vet"],
    flags: [
      { name: "package", type: "string", description: "Package to vet" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "vet go code",
        "go vet",
        "check go code"
      ],
      requiresProject: ["go.mod"],
      examples: ["go vet ./...", "go vet ./cmd/server"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      return {
        success: output.trim().length === 0,
        output,
        metadata: { issues: output.split("\n").filter(l => l.trim()).length }
      };
    }
  },
  
  // --- Go Fmt -----------------------------------------------------------
  {
    name: "go_fmt",
    description: "Format Go code",
    category: "go",
    command: "go",
    args: ["fmt"],
    flags: [
      { name: "package", type: "string", description: "Package to format" }
    ],
    detection: {
      method: "binary",
      check: "go version"
    },
    context: {
      whenToUse: [
        "format go code",
        "go fmt",
        "go formatter"
      ],
      requiresProject: ["go.mod"],
      examples: ["go fmt ./...", "go fmt ./cmd/server"]
    },
    outputParser: "raw"
  },
  
  // --- Golangci-lint ----------------------------------------------------
  {
    name: "golangci_lint",
    description: "Lint Go code with golangci-lint",
    category: "go",
    command: "golangci-lint",
    args: ["run"],
    flags: [
      { name: "path", type: "string", description: "Package to lint" },
      { name: "--fix", type: "boolean", description: "Auto-fix issues" },
      { name: "--config", type: "string", description: "Config file" }
    ],
    detection: {
      method: "binary",
      check: "golangci-lint --version"
    },
    context: {
      whenToUse: [
        "lint go code",
        "golangci-lint",
        "go linter"
      ],
      requiresProject: ["go.mod"],
      examples: ["golangci-lint run", "golangci-lint run --fix", "golangci-lint run ./..."]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const issues = output.split("\n").filter(l => l.includes(":"));
      return {
        success: issues.length === 0,
        output,
        metadata: { issueCount: issues.length }
      };
    }
  }
];