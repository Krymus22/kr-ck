/**
 * theme.ts - Color palette and style constants for the Ink TUI.
 *
 * Icons are re-exported from icons.ts (which uses the `figures` package for
 * automatic Unicode → ASCII fallback). Do NOT define icons here — add new
 * icons to icons.ts and re-export below.
 */

import {
  icons as figuresIcons,
  getCategoryIcon as figuresGetCategoryIcon,
} from "./icons.js";

export const colors = {
  primary: "#6EE7F7",
  secondary: "#A78BFA",
  success: "#34D399",
  warning: "#FBBF24",
  error: "#F87171",
  muted: "#6B7280",
  white: "#FFFFFF",
  bg: "#1F2937",
} as const;

/**
 * Icons object — re-exported from icons.ts for single-import convenience.
 *
 * Kept backward-compatible with the old theme.ts icons object via aliases:
 *   - icons.arrow     → icons.arrowRight  (figures arrow)
 *   - icons.circle    → icons.square      (figures squareSmall)
 *   - icons.warn      → icons.warning     (figures warning)
 *   - icons.error     → icons.cross       (figures cross)
 *   - icons.thinking  → icons.bullet      (figures bullet)
 *
 * New code should prefer the figures-style names (check, cross, arrowRight,
 * bullet, etc.) over the legacy aliases.
 */
export const icons = {
  ...figuresIcons,
  // Legacy aliases — keep so existing imports from theme.ts still work
  arrow: figuresIcons.arrowRight,
  circle: figuresIcons.square,
  warn: figuresIcons.warning,
  error: figuresIcons.cross,
  thinking: figuresIcons.bullet,
} as const;

/** Re-export getCategoryIcon from icons.ts for convenience. */
export { figuresGetCategoryIcon as getCategoryIcon };

