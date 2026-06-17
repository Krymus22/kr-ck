/**
 * python.ts - Python development tools
 * 
 * Tools for pytest, ruff, mypy, pip, uv
 */

import { Tool } from "../externalTools.js";

export const PYTHON_TOOLS: Tool[] = [
  // --- Pytest ------------------------------------------------------------
  {
    name: "pytest_run",
    description: "Run Python tests with pytest",
    category: "python",
    command: "pytest",
    args: [],
    flags: [
      { name: "path", type: "string", description: "Test file or directory" },
      { name: "-v", type: "boolean", description: "Verbose output" },
      { name: "-x", type: "boolean", description: "Stop on first failure" },
      { name: "--tb", type: "string", description: "Traceback style (short/long/line)" },
      { name: "-k", type: "string", description: "Run tests matching pattern" },
      { name: "--cov", type: "string", description: "Coverage report" },
      { name: "--junitxml", type: "string", description: "JUnit XML report" }
    ],
    detection: {
      method: "binary",
      check: "pytest --version"
    },
    context: {
      whenToUse: [
        "run python tests",
        "run pytest",
        "test python code",
        "run unit tests"
      ],
      requiresProject: ["pyproject.toml"],
      examples: ["pytest tests/", "pytest -v test_app.py", "pytest -x --tb=short"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const lines = output.split("\n");
      const summary = lines.at(-2) ?? "";
      const passed = /(\d+) passed/.exec(summary);
      const failed = /(\d+) failed/.exec(summary);
      const errors = /(\d+) error/.exec(summary);
      
      return {
        success: !failed && !errors,
        output,
        metadata: {
          passed: passed ? Number.parseInt(passed[1], 10) : 0,
          failed: failed ? Number.parseInt(failed[1], 10) : 0,
          errors: errors ? Number.parseInt(errors[1], 10) : 0
        }
      };
    }
  },
  
  // --- Ruff (Linter) ----------------------------------------------------
  {
    name: "ruff_lint",
    description: "Lint Python code with Ruff",
    category: "python",
    command: "ruff",
    args: ["check"],
    flags: [
      { name: "path", type: "string", description: "File or directory to lint" },
      { name: "--fix", type: "boolean", description: "Auto-fix issues" },
      { name: "--output-format", type: "string", description: "Output format (text/json)" },
      { name: "--select", type: "string", description: "Rules to select" },
      { name: "--ignore", type: "string", description: "Rules to ignore" }
    ],
    detection: {
      method: "binary",
      check: "ruff --version"
    },
    context: {
      whenToUse: [
        "lint python code",
        "check python style",
        "ruff lint",
        "python linter"
      ],
      examples: ["ruff check src/", "ruff check --fix src/", "ruff check --select E,W src/"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const regex = /^(.+?):(\d+):(\d+): ([A-Z]\d+) (.+)$/gm;
      const issues: any[] = [];
      let match;
      while ((match = regex.exec(output)) !== null) {
        issues.push({
          file: match[1],
          line: Number.parseInt(match[2], 10),
          column: Number.parseInt(match[3], 10),
          code: match[4],
          message: match[5]
        });
      }
      return {
        success: issues.length === 0,
        output,
        metadata: { issues, count: issues.length }
      };
    }
  },
  
  {
    name: "ruff_format",
    description: "Format Python code with Ruff",
    category: "python",
    command: "ruff",
    args: ["format"],
    flags: [
      { name: "path", type: "string", description: "File or directory to format" },
      { name: "--check", type: "boolean", description: "Check only, don't modify" },
      { name: "--diff", type: "boolean", description: "Show diff" }
    ],
    detection: {
      method: "binary",
      check: "ruff --version"
    },
    context: {
      whenToUse: [
        "format python code",
        "ruff format",
        "python formatter"
      ],
      examples: ["ruff format src/", "ruff format --check src/"]
    },
    outputParser: "raw"
  },
  
  // --- Mypy (Type Checker) ----------------------------------------------
  {
    name: "mypy_check",
    description: "Type-check Python code with mypy",
    category: "python",
    command: "mypy",
    args: [],
    flags: [
      { name: "path", type: "string", description: "File or directory to check" },
      { name: "--strict", type: "boolean", description: "Strict mode" },
      { name: "--ignore-missing-imports", type: "boolean", description: "Ignore missing imports" },
      { name: "--show-error-codes", type: "boolean", description: "Show error codes" }
    ],
    detection: {
      method: "binary",
      check: "mypy --version"
    },
    context: {
      whenToUse: [
        "type check python",
        "mypy check",
        "python types",
        "check python types"
      ],
      examples: ["mypy src/", "mypy --strict src/", "mypy --ignore-missing-imports src/"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const errors = output.split("\n").filter(l => l.includes("error:"));
      return {
        success: errors.length === 0,
        output,
        metadata: { errorCount: errors.length }
      };
    }
  },
  
  // --- Pip ---------------------------------------------------------------
  {
    name: "pip_install",
    description: "Install Python packages with pip",
    category: "python",
    command: "pip",
    args: ["install"],
    flags: [
      { name: "package", type: "string", required: true, description: "Package name" },
      { name: "--upgrade", type: "boolean", description: "Upgrade to latest version" },
      { name: "--user", type: "boolean", description: "Install for current user" }
    ],
    detection: {
      method: "binary",
      check: "pip --version"
    },
    context: {
      whenToUse: [
        "install python package",
        "pip install",
        "add python dependency"
      ],
      examples: ["pip install requests", "pip install --upgrade pip"]
    },
    outputParser: "raw"
  },
  
  // --- Uv (Fast Pip) ----------------------------------------------------
  {
    name: "uv_install",
    description: "Install Python packages with uv (fast pip)",
    category: "python",
    command: "uv",
    args: ["pip", "install"],
    flags: [
      { name: "package", type: "string", required: true, description: "Package name" },
      { name: "--upgrade", type: "boolean", description: "Upgrade to latest version" }
    ],
    detection: {
      method: "binary",
      check: "uv --version"
    },
    context: {
      whenToUse: [
        "uv install",
        "fast python install"
      ],
      examples: ["uv pip install requests"]
    },
    outputParser: "raw"
  },
  
  {
    name: "uv_sync",
    description: "Sync Python dependencies with uv",
    category: "python",
    command: "uv",
    args: ["sync"],
    flags: [],
    detection: {
      method: "binary",
      check: "uv --version"
    },
    context: {
      whenToUse: [
        "uv sync",
        "sync python dependencies"
      ],
      requiresProject: ["pyproject.toml"],
      examples: ["uv sync"]
    },
    outputParser: "raw"
  },
  
  // --- Python Venv ------------------------------------------------------
  {
    name: "python_venv",
    description: "Create Python virtual environment",
    category: "python",
    command: "python",
    args: ["-m", "venv"],
    flags: [
      { name: "path", type: "string", description: "Venv path (default: .venv)" }
    ],
    detection: {
      method: "binary",
      check: "python --version"
    },
    context: {
      whenToUse: [
        "create virtual environment",
        "python venv",
        "create venv"
      ],
      examples: ["python -m venv .venv"]
    },
    outputParser: "raw"
  }
];