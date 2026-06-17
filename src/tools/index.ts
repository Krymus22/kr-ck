/**
 * index.ts - Central registry for all external tools
 * 
 * This file exports all tool categories and provides
 * a function to register them all at once.
 */

import { Tool } from "../externalTools.js";
import { ROBLOX_TOOLS } from "./roblox.js";
import { PYTHON_TOOLS } from "./python.js";
import { NODE_TOOLS } from "./node.js";
import { RUST_TOOLS } from "./rust.js";
import { GO_TOOLS } from "./go.js";
import { DOCKER_TOOLS } from "./docker.js";

// --- All Tools --------------------------------------------------------------

export const ALL_TOOLS: Tool[] = [
  ...ROBLOX_TOOLS,
  ...PYTHON_TOOLS,
  ...NODE_TOOLS,
  ...RUST_TOOLS,
  ...GO_TOOLS,
  ...DOCKER_TOOLS
];

// --- Tool Counts ------------------------------------------------------------

export const TOOL_COUNTS = {
  roblox: ROBLOX_TOOLS.length,
  python: PYTHON_TOOLS.length,
  node: NODE_TOOLS.length,
  rust: RUST_TOOLS.length,
  go: GO_TOOLS.length,
  docker: DOCKER_TOOLS.length,
  total: ALL_TOOLS.length
};

// --- Get Tools by Category --------------------------------------------------

export function getToolsByCategory(category: string): Tool[] {
  switch (category) {
    case "roblox":
      return ROBLOX_TOOLS;
    case "python":
      return PYTHON_TOOLS;
    case "node":
      return NODE_TOOLS;
    case "rust":
      return RUST_TOOLS;
    case "go":
      return GO_TOOLS;
    case "docker":
      return DOCKER_TOOLS;
    default:
      return [];
  }
}

// --- Search Tools -----------------------------------------------------------

export function searchTools(query: string): Tool[] {
  const lower = query.toLowerCase();
  return ALL_TOOLS.filter(tool => 
    tool.name.toLowerCase().includes(lower) ||
    tool.description.toLowerCase().includes(lower) ||
    tool.category.toLowerCase().includes(lower)
  );
}

// --- List All Tool Names ----------------------------------------------------

export function listAllToolNames(): string[] {
  return ALL_TOOLS.map(tool => tool.name);
}
