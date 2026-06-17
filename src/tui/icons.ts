/**
 * icons.ts — Cross-platform terminal icons with fallbacks.
 *
 * Uses the 'figures' package which automatically replaces Unicode symbols
 * with ASCII equivalents on terminals that don't support them.
 *
 * On Windows: the app sets chcp 65001 (UTF-8) at startup, so these
 * symbols should render correctly in cmd.exe, PowerShell, and Windows Terminal.
 */

import figures from "figures";

const F = figures as any;

export const icons = {
  // Status indicators
  check: F.tick ?? "v",
  cross: F.cross ?? "x",
  bullet: F.bullet ?? "*",
  circleOn: F.circleFilled ?? "[*]",
  circleOff: F.squareSmall ?? "[ ]",
  warning: F.warning ?? "!",
  info: F.info ?? "i",
  question: F.questionMarkPrefix ?? "?",

  // Navigation
  pointer: F.pointer ?? ">",
  arrowRight: F.arrowRight ?? "->",
  arrowLeft: F.arrowLeft ?? "<-",
  arrowUp: F.arrowUp ?? "^",
  arrowDown: F.arrowDown ?? "v",

  // Category icons (clear, recognizable, not emojis)
  skill: "S",      // Skills: letter S
  tool: "T",       // Tools: letter T (wrench)
  mcp: "M",        // MCP: letter M (plug)
  plugin: "P",     // Plugins: letter P (puzzle)
  feature: "F",    // Features: letter F (gear)

  // UI elements
  ellipsis: F.ellipsis ?? "...",
  dot: F.dot ?? ".",
  pointerSmall: F.pointerSmall ?? ">",
  square: F.square ?? "[]",
  triangleRight: F.triangleRightSmall ?? ">",
  hamburger: F.hamburger ?? "=",
  star: F.star ?? "*",
  heart: F.heart ?? "<3",

  // Loading
  tick: F.tick ?? "v",
  ballot: F.ballotCross ?? "x",
  checkboxOn: F.checkboxOn ?? "[x]",
  checkboxOff: F.checkboxOff ?? "[ ]",
} as const;

/**
 * Get an icon for a category.
 */
export function getCategoryIcon(category: string): string {
  switch (category) {
    case "skill": return icons.skill;
    case "tool": return icons.tool;
    case "mcp": return icons.mcp;
    case "plugin": return icons.plugin;
    case "feature": return icons.feature;
    default: return "?";
  }
}
