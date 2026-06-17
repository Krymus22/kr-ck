/**
 * node.ts - Node.js development tools
 * 
 * Tools for npm, yarn, pnpm, eslint, prettier, tsc
 */

import { Tool } from "../externalTools.js";

export const NODE_TOOLS: Tool[] = [
  // --- NPM --------------------------------------------------------------
  {
    name: "npm_install",
    description: "Install Node.js dependencies with npm",
    category: "node",
    command: "npm",
    args: ["install"],
    flags: [
      { name: "package", type: "string", description: "Package name" },
      { name: "--save-dev", type: "boolean", description: "Install as dev dependency" },
      { name: "--global", type: "boolean", description: "Install globally" },
      { name: "--legacy-peer-deps", type: "boolean", description: "Use legacy peer deps" }
    ],
    detection: {
      method: "binary",
      check: "npm --version"
    },
    context: {
      whenToUse: [
        "install node packages",
        "npm install",
        "install dependencies"
      ],
      requiresProject: ["package.json"],
      examples: ["npm install", "npm install express", "npm install --save-dev @types/node"]
    },
    outputParser: "raw"
  },
  
  {
    name: "npm_run",
    description: "Run npm script",
    category: "node",
    command: "npm",
    args: ["run"],
    flags: [
      { name: "script", type: "string", required: true, description: "Script name" },
      { name: "args", type: "string", description: "Script arguments" }
    ],
    detection: {
      method: "binary",
      check: "npm --version"
    },
    context: {
      whenToUse: [
        "run npm script",
        "npm run",
        "run build",
        "run test"
      ],
      requiresProject: ["package.json"],
      examples: ["npm run build", "npm run test", "npm run lint"]
    },
    outputParser: "raw"
  },
  
  {
    name: "npm_update",
    description: "Update Node.js packages",
    category: "node",
    command: "npm",
    args: ["update"],
    flags: [
      { name: "package", type: "string", description: "Package to update" },
      { name: "--global", type: "boolean", description: "Update globally" }
    ],
    detection: {
      method: "binary",
      check: "npm --version"
    },
    context: {
      whenToUse: [
        "update node packages",
        "npm update",
        "upgrade dependencies"
      ],
      requiresProject: ["package.json"],
      examples: ["npm update", "npm update express"]
    },
    outputParser: "raw"
  },
  
  // --- Yarn -------------------------------------------------------------
  {
    name: "yarn_install",
    description: "Install Node.js dependencies with Yarn",
    category: "node",
    command: "yarn",
    args: ["install"],
    flags: [
      { name: "package", type: "string", description: "Package name" }
    ],
    detection: {
      method: "binary",
      check: "yarn --version"
    },
    context: {
      whenToUse: [
        "yarn install",
        "install with yarn"
      ],
      requiresProject: ["package.json"],
      examples: ["yarn install"]
    },
    outputParser: "raw"
  },
  
  {
    name: "yarn_run",
    description: "Run Yarn script",
    category: "node",
    command: "yarn",
    args: [],
    flags: [
      { name: "script", type: "string", required: true, description: "Script name" }
    ],
    detection: {
      method: "binary",
      check: "yarn --version"
    },
    context: {
      whenToUse: [
        "yarn run",
        "run yarn script"
      ],
      requiresProject: ["package.json"],
      examples: ["yarn build", "yarn test"]
    },
    outputParser: "raw"
  },
  
  // --- PNPM -------------------------------------------------------------
  {
    name: "pnpm_install",
    description: "Install Node.js dependencies with pnpm",
    category: "node",
    command: "pnpm",
    args: ["install"],
    flags: [
      { name: "package", type: "string", description: "Package name" }
    ],
    detection: {
      method: "binary",
      check: "pnpm --version"
    },
    context: {
      whenToUse: [
        "pnpm install",
        "install with pnpm"
      ],
      requiresProject: ["package.json"],
      examples: ["pnpm install"]
    },
    outputParser: "raw"
  },
  
  // --- ESLint -----------------------------------------------------------
  {
    name: "eslint_lint",
    description: "Lint JavaScript/TypeScript code with ESLint",
    category: "node",
    command: "eslint",
    args: [],
    flags: [
      { name: "path", type: "string", description: "File or directory to lint" },
      { name: "--fix", type: "boolean", description: "Auto-fix issues" },
      { name: "--ext", type: "string", description: "File extensions" }
    ],
    detection: {
      method: "binary",
      check: "eslint --version"
    },
    context: {
      whenToUse: [
        "lint javascript",
        "lint typescript",
        "eslint lint",
        "check code quality"
      ],
      requiresProject: ["package.json"],
      examples: ["eslint src/", "eslint --fix src/", "eslint --ext .ts,.tsx src/"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const errors = output.split("\n").filter(l => l.includes("error"));
      const warnings = output.split("\n").filter(l => l.includes("warning"));
      return {
        success: errors.length === 0,
        output,
        metadata: { errors: errors.length, warnings: warnings.length }
      };
    }
  },
  
  // --- Prettier ---------------------------------------------------------
  {
    name: "prettier_format",
    description: "Format code with Prettier",
    category: "node",
    command: "prettier",
    args: ["--write"],
    flags: [
      { name: "path", type: "string", description: "File or directory to format" },
      { name: "--check", type: "boolean", description: "Check only, don't modify" },
      { name: "--list-different", type: "boolean", description: "List files that differ" }
    ],
    detection: {
      method: "binary",
      check: "prettier --version"
    },
    context: {
      whenToUse: [
        "format code",
        "prettier format",
        "auto format"
      ],
      requiresProject: ["package.json"],
      examples: ["prettier --write src/", "prettier --check src/"]
    },
    outputParser: "raw"
  },
  
  // --- TypeScript Compiler ----------------------------------------------
  {
    name: "tsc_build",
    description: "Build TypeScript project with tsc",
    category: "node",
    command: "tsc",
    args: [],
    flags: [
      { name: "--watch", type: "boolean", description: "Watch mode" },
      { name: "--noEmit", type: "boolean", description: "Type check only" },
      { name: "--project", type: "string", description: "tsconfig path" }
    ],
    detection: {
      method: "binary",
      check: "tsc --version"
    },
    context: {
      whenToUse: [
        "build typescript",
        "tsc build",
        "compile typescript",
        "type check"
      ],
      requiresProject: ["tsconfig.json"],
      examples: ["tsc", "tsc --noEmit", "tsc --watch"]
    },
    outputParser: "structured",
    customParser: (output: string) => {
      const errors = output.split("\n").filter(l => l.includes("error TS"));
      return {
        success: errors.length === 0,
        output,
        metadata: { errorCount: errors.length }
      };
    }
  },
  
  // --- Node -------------------------------------------------------------
  {
    name: "node_run",
    description: "Run Node.js script",
    category: "node",
    command: "node",
    args: [],
    flags: [
      { name: "script", type: "string", required: true, description: "Script path" },
      { name: "--inspect", type: "boolean", description: "Enable debugger" },
      { name: "--experimental-modules", type: "boolean", description: "Enable ES modules" }
    ],
    detection: {
      method: "binary",
      check: "node --version"
    },
    context: {
      whenToUse: [
        "run node script",
        "execute javascript",
        "node run"
      ],
      examples: ["node index.js", "node --inspect server.js"]
    },
    outputParser: "raw"
  },
  
  // --- Npx --------------------------------------------------------------
  {
    name: "npx_run",
    description: "Run package binary with npx",
    category: "node",
    command: "npx",
    args: [],
    flags: [
      { name: "command", type: "string", required: true, description: "Command to run" },
      { name: "--yes", type: "boolean", description: "Auto-confirm" }
    ],
    detection: {
      method: "binary",
      check: "npx --version"
    },
    context: {
      whenToUse: [
        "run package",
        "npx run",
        "execute package"
      ],
      examples: ["npx create-react-app my-app", "npx --yes prettier --write src/"]
    },
    outputParser: "raw"
  }
];