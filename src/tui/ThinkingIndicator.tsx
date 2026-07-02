/**
 * ThinkingIndicator.tsx - Animated status indicator with real activity tracking.
 *
 * Bug fixed: the old version showed "PENSANDO..." forever, regardless of what
 * the agent was actually doing (streaming tokens, executing a tool, running
 * the quality gate, etc.). Now it subscribes to the global ActivityTracker
 * and shows the current activity with elapsed time.
 *
 * Falls back to "PENSANDO..." if no activity is pushed (backwards compat).
 */

import React, { useState, useEffect, useRef } from "react";
import { Text } from "ink";
import { colors } from "./theme.js";
import {
  subscribeToActivity,
  getActivitySnapshot,
  type ActivitySnapshot,
} from "../activityTracker.js";

interface ThinkingIndicatorProps {
  active: boolean;
  /** Custom label to show instead of "PENSANDO" (e.g., "COMPACTANDO"). */
  label?: string;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

/**
 * Returns a spinner character for the current frame.
 *
 * Uses ASCII-only spinner (|/-\) when USE_ASCII_SPINNER env var is set OR
 * when running on Windows terminals that may not render Braille patterns
 * correctly. Otherwise uses Braille patterns for a smoother animation.
 *
 * The Braille chars (U+2800 block) are widely supported on modern terminals
 * but can render as garbage on:
 *   - Windows cmd.exe with default fonts (Consolas doesn't have Braille)
 *   - Old terminal emulators without Unicode font fallback
 *   - SSH sessions with mismatched locale
 *
 * BUG FIX (audit issue #6): previously the modulo was hardcoded to %10 even
 * in ASCII mode (which has only 4 frames), causing the spinner to skip
 * frames 4-9 and produce jittery animation. Now the modulo is dynamic
 * based on the actual frames array length.
 */
const SPINNER_FRAMES_ASCII = ["|", "/", "-", "\\"];
const SPINNER_FRAMES_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getSpinnerFrames(): string[] {
  // Detect: env var forces ASCII, otherwise use Braille (modern terminals
  // including Windows Terminal, VS Code terminal, and most Linux terminals
  // support Braille patterns).
  const useAscii = process.env.USE_ASCII_SPINNER === "1" ||
    (process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM_PROGRAM);
  return useAscii ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES_BRAILLE;
}

function spinnerChar(idx: number): string {
  const frames = getSpinnerFrames();
  return frames[idx % frames.length] ?? "•";
}

export function ThinkingIndicator({ active, label }: Readonly<ThinkingIndicatorProps>) {
  const [dots, setDots] = useState("");
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(getActivitySnapshot());
  const spinnerIdx = useRef(0);

  // Subscribe to activity tracker — re-render on every push/pop.
  useEffect(() => {
    if (!active) return;
    const unsub = subscribeToActivity((snap) => setSnapshot(snap));
    return unsub;
  }, [active]);

  // Spinner + elapsed time + dot animation tick (every 200ms).
  useEffect(() => {
    if (!active) return;
    const frames = getSpinnerFrames();
    const interval = setInterval(() => {
      // BUG FIX (audit issue #6): use frames.length for modulo, not hardcoded 10.
      // ASCII spinner has 4 frames; Braille has 10. Hardcoding 10 caused ASCII
      // mode to skip frames and jitter.
      spinnerIdx.current = (spinnerIdx.current + 1) % frames.length;
      setDots((prev) => (prev.length >= 3 ? "" : prev + "."));
      // Force re-render to update elapsed time even when stack is unchanged
      setSnapshot(getActivitySnapshot());
    }, 200);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return null;

  const hasActivity = snapshot.current !== null;
  const elapsed = formatElapsed(snapshot.elapsedMs);
  const elapsedStr = elapsed ? ` (${elapsed})` : "";

  if (hasActivity) {
    const spinner = spinnerChar(spinnerIdx.current);
    const label = snapshot.displayLabel;
    return (
      <Text color={colors.muted}> {spinner} {label}{elapsedStr} </Text>
    );
  }

  // Fallback: legacy "PENSANDO..." (when no activity was pushed)
  // If a custom label was provided (e.g., "COMPACTANDO"), use it instead.
  const displayLabel = label ?? "PENSANDO";
  return (
    <Text color={colors.muted}> • {displayLabel}{dots} </Text>
  );
}
