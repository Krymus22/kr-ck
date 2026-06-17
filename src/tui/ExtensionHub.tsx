/**
 * ExtensionHub.tsx — 3x3 grid panel for managing extensions.
 *
 * Layout:
 *   - Category tabs at top: [Skills] [Tools] [MCPs] [Plugins] [All]
 *   - 3x3 grid of extension cards (9 visible)
 *   - Scroll indicator if >9 items
 *   - Bottom: keyboard shortcuts + stats
 *
 * Keyboard:
 *   ← →     Navigate between items
 *   ↑ ↓     Scroll page
 *   Enter   Toggle enabled/disabled
 *   T       Cycle trigger mode
 *   1-4     Quick-set trigger mode (1=OFF, 2=FILE, 3=TASK, 4=EVERY)
 *   Tab     Switch category tab
 *   Esc     Close panel
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "./theme.js";
import {
  getAllExtensions,
  getExtensionsByCategory,
  toggleExtension,
  cycleTriggerMode,
  setTriggerMode,
  getTriggerLabel,
  getTriggerModes,
  getCategoryIcon,
  getHubSummary,
  type ExtensionEntry,
  type ExtensionCategory,
  type TriggerMode,
} from "../extensionCenter.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const GRID_COLS = 3;
const GRID_ROWS = 3;
const PAGE_SIZE = GRID_COLS * GRID_ROWS;

const CATEGORIES: Array<{ key: ExtensionCategory | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "skill", label: "Skills" },
  { key: "tool", label: "Tools" },
  { key: "mcp", label: "MCPs" },
  { key: "plugin", label: "Plugins" },
  { key: "feature", label: "Features" },
];

const TRIGGER_COLORS: Record<TriggerMode, string> = {
  disabled: colors.muted,
  on_file: colors.warning,
  on_task: colors.primary,
  always: colors.success,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtensionHubProps {
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ExtensionHub({ onClose }: Readonly<ExtensionHubProps>) {
  const [tabIndex, setTabIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [renderKey, setRenderKey] = useState(0);

  const currentTab = CATEGORIES[tabIndex] ?? CATEGORIES[0];
  const allItems = currentTab.key === "all"
    ? getAllExtensions()
    : getExtensionsByCategory(currentTab.key);

  const totalPages = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
  const currentPage = Math.floor(scrollTop / PAGE_SIZE);
  const visibleItems = allItems.slice(scrollTop, scrollTop + PAGE_SIZE);

  const clampCursor = useCallback((idx: number, items: readonly ExtensionEntry[]) => {
    return Math.max(0, Math.min(idx, items.length - 1));
  }, []);

  // ── Keyboard handling ───────────────────────────────────────────────
  useInput((inputChar, key) => {
    if (key.escape) { onClose(); return; }
    if (key.tab) {
      setTabIndex((prev) => (prev + 1) % CATEGORIES.length);
      setCursorIndex(0);
      setScrollTop(0);
      return;
    }
    handleNavigation(key, inputChar);
    handleActions(key, inputChar);
  });

  function handleNavigation(key: { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; ctrl?: boolean }, inputChar: string) {
    if (key.leftArrow) {
      setCursorIndex((prev) => clampCursor(prev - 1, visibleItems));
    } else if (key.rightArrow) {
      setCursorIndex((prev) => clampCursor(prev + 1, visibleItems));
    } else if (key.upArrow && !key.ctrl) {
      if (cursorIndex >= GRID_COLS) {
        setCursorIndex((prev) => clampCursor(prev - GRID_COLS, visibleItems));
      } else if (scrollTop > 0) {
        setScrollTop((prev) => Math.max(0, prev - PAGE_SIZE));
        setCursorIndex(0);
      }
    } else if (key.downArrow && !key.ctrl) {
      if (cursorIndex < (visibleItems.length - GRID_COLS)) {
        setCursorIndex((prev) => clampCursor(prev + GRID_COLS, visibleItems));
      } else if (scrollTop + PAGE_SIZE < allItems.length) {
        setScrollTop((prev) => Math.min(allItems.length - PAGE_SIZE, prev + PAGE_SIZE));
        setCursorIndex(0);
      }
    }
  }

  function handleActions(key: { return?: boolean }, inputChar: string) {
    if (key.return || inputChar === " ") {
      const item = visibleItems[cursorIndex];
      if (item) {
        toggleExtension(item.id);
        setRenderKey((n) => n + 1);
      }
    }
    if (inputChar === "t" || inputChar === "T") {
      const item = visibleItems[cursorIndex];
      if (item) {
        cycleTriggerMode(item.id);
        setRenderKey((n) => n + 1);
      }
    }
    const modes = getTriggerModes();
    if (inputChar >= "1" && inputChar <= "4") {
      const modeIdx = Number.parseInt(inputChar, 10) - 1;
      const item = visibleItems[cursorIndex];
      const mode = modes[modeIdx];
      if (item && mode) {
        setTriggerMode(item.id, mode);
        setRenderKey((n) => n + 1);
      }
    }
  }

  // ── Render ──────────────────────────────────────────────────────────
  const summary = getHubSummary();

  return (
    <Box key={`hub-${renderKey}`} flexDirection="column" borderStyle="double" borderColor={colors.primary} paddingX={1}>
      {/* Header */}
      <Box justifyContent="center" marginBottom={0}>
        <Text color={colors.primary} bold>
          ═══════════════ EXTENSION HUB ═══════════════
        </Text>
      </Box>

      {/* Category Tabs */}
      <Box justifyContent="center" gap={1} marginBottom={1}>
        {CATEGORIES.map((cat, i) => {
          const isActive = i === tabIndex;
          const catKey = cat.key;
          const count = catKey === "all"
            ? summary.total
            : summary.byCategory[catKey]?.total ?? 0;
          return (
            <Text
              key={cat.key}
              color={isActive ? colors.primary : colors.muted}
              bold={isActive}
            >
              {isActive ? "▶ " : "  "}
              {cat.label}
              <Text color={colors.muted}>({count})</Text>
            </Text>
          );
        })}
      </Box>

      {/* 3x3 Grid */}
      <Box flexDirection="column" gap={0}>
        {Array.from({ length: GRID_ROWS }, (_, row) => (
          <Box key={`row-${row}`} flexDirection="row" gap={1} justifyContent="center">
            {Array.from({ length: GRID_COLS }, (_, col) => {
              const idx = row * GRID_COLS + col;
              const item = visibleItems[idx];
              if (!item) {
                return <Box key={`empty-${col}`} width={22} />;
              }
              const isSelected = idx === cursorIndex;
              return (
                <ExtensionCard
                  key={item.id}
                  item={item}
                  selected={isSelected}
                />
              );
            })}
          </Box>
        ))}
      </Box>

      {/* Scroll indicator */}
      {totalPages > 1 && (
        <Box justifyContent="center" marginTop={0}>
          <Text color={colors.muted}>
            {"▓".repeat(currentPage + 1)}
            {"░".repeat(totalPages - currentPage - 1)}
            {" "}
            Page {currentPage + 1}/{totalPages}
          </Text>
        </Box>
      )}

      {/* Bottom bar */}
      <Box justifyContent="space-between" marginTop={1} borderTop borderTopColor={colors.muted}>
        <Text color={colors.muted} dimColor>
          ←→ select  ↑↓ scroll  ↵ toggle  T mode  1-4 quick  Tab switch  Esc close
        </Text>
        <Text color={colors.primary}>
          {summary.enabled}/{summary.total} active
        </Text>
      </Box>
    </Box>
  );
}

// ─── Extension Card ─────────────────────────────────────────────────────────

function ExtensionCard({ item, selected }: Readonly<{ item?: ExtensionEntry; selected: boolean }>) {
  if (!item) return <Box width={22} />;
  const borderColor = selected ? colors.primary : colors.muted;
  const icon = getCategoryIcon(item.category);
  const triggerLabel = getTriggerLabel(item.triggerMode);
  const triggerColor = TRIGGER_COLORS[item.triggerMode] ?? colors.muted;

  return (
    <Box
      width={22}
      flexDirection="column"
      borderStyle={selected ? "bold" : "round"}
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Name row */}
      <Box>
        <Text color={item.enabled ? colors.white : colors.muted} bold={selected}>
          {selected ? "▸" : " "} {icon} {item.name.slice(0, 14)}
        </Text>
      </Box>

      {/* Status + Trigger */}
      <Box>
        <Text color={item.enabled ? colors.success : colors.muted}>
          {item.enabled ? "●" : "○"}
        </Text>
        <Text color={colors.muted}> </Text>
        <Text color={triggerColor} bold={item.triggerMode !== "disabled"}>
          [{triggerLabel}]
        </Text>
        {!item.installed && (
          <Text color={colors.error}> ⚠</Text>
        )}
      </Box>
    </Box>
  );
}
