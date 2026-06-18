/**
 * useTerminal.ts — Hooks for terminal dimensions and width-aware layout.
 *
 * The Ink framework exposes `useStdout()` which gives access to the raw
 * stdout stream, including its `columns` property (terminal width in cells).
 * However, this value can be 0/undefined in non-TTY environments (piped
 * output, CI, some test runners). We wrap it with sensible defaults and
 * re-render on terminal resize.
 *
 * Components that need width-aware layout (cards, banners, separators)
 * should call `useTerminalWidth()` and use the returned value instead of
 * hardcoded numbers like `width={22}` or `"=".repeat(50)`.
 */

import { useState, useEffect, useCallback } from "react";
import { useStdout } from "ink";

/** Minimum terminal width we'll attempt to render at (below this, we degrade gracefully). */
export const MIN_TERMINAL_WIDTH = 60;

/** Default width when stdout.columns is unavailable (non-TTY / CI). */
export const DEFAULT_TERMINAL_WIDTH = 100;

/**
 * Returns the current terminal width (in columns), re-rendering on resize.
 *
 * Falls back to DEFAULT_TERMINAL_WIDTH when stdout.columns is unavailable
 * (e.g., piped output in tests or CI). Always returns at least MIN_TERMINAL_WIDTH.
 */
export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => {
    const cols = stdout?.columns ?? process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
    return Math.max(MIN_TERMINAL_WIDTH, cols);
  });

  useEffect(() => {
    if (!stdout) return;
    const handler = () => {
      const cols = stdout.columns ?? DEFAULT_TERMINAL_WIDTH;
      setWidth(Math.max(MIN_TERMINAL_WIDTH, cols));
    };
    // Initial sync (in case useState missed a later value)
    handler();
    // Listen for resize events
    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);

  return width;
}

/**
 * Calculate card width for a grid layout given terminal width and column count.
 *
 * Example: terminalWidth=100, columns=3, gap=2, padding=2
 *   availableForCards = 100 - 2 - (3-1)*2 = 94
 *   cardWidth = floor(94 / 3) = 31
 *
 * Always returns at least 10 (below that, content overflows borders).
 */
export function calculateCardWidth(
  terminalWidth: number,
  columns: number,
  gap: number = 1,
  padding: number = 2,
): number {
  const available = terminalWidth - padding - (columns - 1) * gap;
  return Math.max(10, Math.floor(available / columns));
}

/**
 * Repeat a separator character to fit the terminal width.
 * Useful for banners and dividers.
 *
 * Example: useSeparator("=", 100) → "==========...==========" (100 chars)
 */
export function useSeparator(char: string = "=", width?: number): string {
  const termWidth = useTerminalWidth();
  const targetWidth = width ?? termWidth;
  return char.repeat(Math.max(1, targetWidth));
}

/**
 * Truncate a string to fit within maxChars, adding ellipsis if truncated.
 * If the string is shorter than maxChars, returns it unchanged.
 *
 * Preserves the start of the string (more useful than middle truncation
 * for paths and identifiers).
 */
export function truncateStr(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 3) return s.slice(0, maxChars);
  return s.slice(0, maxChars - 3) + "...";
}

/**
 * Truncate a path string in the middle, preserving both start and end.
 * Useful for file paths where both the filename and root are important.
 *
 * Example: truncateMiddle("/very/long/path/to/file.luau", 20) → "/very/...file.luau"
 */
export function truncateMiddle(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 3) return s.slice(0, maxChars);
  const keep = maxChars - 3; // 3 for "..."
  const startLen = Math.ceil(keep * 0.4);
  const endLen = Math.floor(keep * 0.6);
  return s.slice(0, startLen) + "..." + s.slice(s.length - endLen);
}

/**
 * Returns a callback that truncates a string based on a prefix length.
 * Useful when you have a fixed prefix like "  -> toolName(args) " and
 * want to truncate the remaining content to fit the terminal.
 */
export function useMaxContentWidth(prefixLength: number): (s: string) => string {
  const termWidth = useTerminalWidth();
  const maxChars = Math.max(20, termWidth - prefixLength);
  return useCallback((s: string) => truncateStr(s, maxChars), [maxChars]);
}
