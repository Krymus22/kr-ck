/**
 * ExtensionHub.tsx - 3x3 grid panel for managing extensions and modes.
 *
 * Layout:
 *   - Category tabs at top: [All] [Skills] [Tools] [MCPs] [Plugins] [Features] [Modes]
 *   - 3x3 grid of cards (9 visible)
 *   - On "Modes" tab: shows project modes (Roblox, custom, ...) instead of extensions
 *   - Scroll indicator if >9 items
 *   - Bottom: keyboard shortcuts + stats + active mode
 *
 * Keyboard:
 *   <- ->     Navigate between items
 *   ^ v     Scroll page
 *   Enter   Toggle enabled/disabled (extensions) | Activate mode (Modes tab)
 *   T       Cycle trigger mode
 *   1-4     Quick-set trigger mode (1=OFF, 2=FILE, 3=TASK, 4=EVERY)
 *   S       Smart search (PATH + common locations + rokit.toml + registry PATH + scoop/cargo/winget + AI)
 *   A       AI-only search (just asks the LLM for suggestions — fast, 3-10s)
 *   X       eXtreme search (full filesystem scan on ALL drives, with progress + Esc to cancel)
 *   Tab     Switch category tab
 *   Esc     Close panel (or cancel extreme search if running)
 */

import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "./theme.js";
import { useTerminalWidth, calculateCardWidth } from "./useTerminal.js";
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
import {
  getAllModes,
  getActiveModeName,
  getActiveMode,
  applyMode,
  deactivateMode,
  type ModeDefinition,
} from "../modes.js";

// --- Constants --------------------------------------------------------------

const GRID_COLS = 3;
const GRID_ROWS = 3;
const PAGE_SIZE = GRID_COLS * GRID_ROWS;

type TabKey = ExtensionCategory | "all" | "modes";

const CATEGORIES: Array<{ key: TabKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "skill", label: "Skills" },
  { key: "tool", label: "Tools" },
  { key: "mcp", label: "MCPs" },
  { key: "plugin", label: "Plugins" },
  { key: "feature", label: "Features" },
  { key: "modes", label: "Modes" },
];

const TRIGGER_COLORS: Record<TriggerMode, string> = {
  disabled: colors.muted,
  on_file: colors.warning,
  on_task: colors.primary,
  always: colors.success,
};

// --- Types ------------------------------------------------------------------

export interface ExtensionHubProps {
  onClose: () => void;
}

// --- Component --------------------------------------------------------------

export function ExtensionHub({ onClose }: Readonly<ExtensionHubProps>) {
  const [tabIndex, setTabIndex] = useState(0);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [renderKey, setRenderKey] = useState(0);
  const [modeFilter, setModeFilter] = useState(false);

  // Search state
  const [searching, setSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<{
    currentTool: string;
    toolsDone: number;
    toolsTotal: number;
    results: Array<{ toolName: string; status: string; binaryPath: string | null; version: string | null }>;
  } | null>(null);

  // Extreme search state (separate from regular search)
  // 'X' key triggers a full-filesystem scan on ALL drives, with progress and Esc-to-cancel.
  // We keep a ref to an abort signal object so the useInput handler can flip .aborted=true.
  const [extremeSearching, setExtremeSearching] = useState(false);
  const [extremeProgress, setExtremeProgress] = useState<{
    currentTool: string;
    currentPath: string;
    toolsDone: number;
    toolsTotal: number;
    results: Array<{ toolName: string; status: string; binaryPath: string | null; version: string | null }>;
  } | null>(null);
  const [extremeAbortSignal, setExtremeAbortSignal] = useState<{ aborted: boolean } | null>(null);

  // AI search state — 'A' key triggers a fast LLM-only lookup (3-10s).
  // Asks the model to suggest unlikely-but-plausible paths based on OS + cwd,
  // then verifies each suggestion with fs.existsSync.
  const [aiSearching, setAiSearching] = useState(false);
  const [aiProgress, setAiProgress] = useState<{
    currentTool: string;
    currentPath: string;
    toolsDone: number;
    toolsTotal: number;
    results: Array<{ toolName: string; status: string; binaryPath: string | null; version: string | null }>;
  } | null>(null);

  const currentTab = CATEGORIES[tabIndex] ?? CATEGORIES[0];
  const isModesTab = currentTab.key === "modes";

  // For modes tab, use modes list; otherwise extensions
  const allModes = isModesTab ? getAllModes() : [];
  const activeModeName = getActiveModeName();
  const activeMode = getActiveMode();

  // Get raw items based on current tab
  const rawItems: readonly ExtensionEntry[] = isModesTab
    ? []
    : currentTab.key === "all"
    ? getAllExtensions()
    : getExtensionsByCategory(currentTab.key as ExtensionCategory);

  // Apply mode filter: when active, only show items that belong to the active mode
  const allItems: readonly ExtensionEntry[] = (() => {
    if (!modeFilter || !activeMode || isModesTab) return rawItems;
    const modeItemIds = new Set([
      ...activeMode.enableTools,
      ...activeMode.enableSkills,
      ...activeMode.enableFeatures,
    ]);
    return rawItems.filter((item) => modeItemIds.has(item.id));
  })();

  // Total items in current tab (extensions or modes)
  const totalItems = isModesTab ? allModes.length : allItems.length;

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.floor(scrollTop / PAGE_SIZE);
  const lastPageStart = Math.max(0, (totalPages - 1) * PAGE_SIZE);

  const visibleModes = isModesTab ? allModes.slice(scrollTop, scrollTop + PAGE_SIZE) : [];
  const visibleItems = isModesTab ? [] : allItems.slice(scrollTop, scrollTop + PAGE_SIZE);

  const clampCursor = useCallback((idx: number, max: number) => {
    return Math.max(0, Math.min(idx, max - 1));
  }, []);

  // -- Keyboard handling -----------------------------------------------
  useInput((inputChar, key) => {
    // Esc has dual behavior: cancel extreme search if running, otherwise close panel
    if (key.escape) {
      if (extremeSearching && extremeAbortSignal) {
        extremeAbortSignal.aborted = true;
        setExtremeSearching(false);
        setExtremeProgress((prev) => prev ? { ...prev, currentPath: "(cancelado pelo usuario)" } : prev);
        setRenderKey((n) => n + 1);
        return;
      }
      onClose();
      return;
    }
    if (key.tab) {
      setTabIndex((prev) => (prev + 1) % CATEGORIES.length);
      setCursorIndex(0);
      setScrollTop(0);
      return;
    }
    // 'M' toggles mode filter (only show items from active mode)
    if (inputChar === "m" || inputChar === "M") {
      if (!isModesTab && getActiveModeName()) {
        setModeFilter((prev) => !prev);
        setCursorIndex(0);
        setScrollTop(0);
        setRenderKey((n) => n + 1);
      }
      return;
    }

    // 'S' triggers manual tool search (smart + AI + common locations + deep fallback)
    if (inputChar === "s" || inputChar === "S") {
      if (!isModesTab && !searching && !extremeSearching && !aiSearching) {
        triggerToolSearch();
      }
      return;
    }
    // 'A' triggers AI-ONLY search — fast LLM lookup (3-10s total).
    // Good as a quick first pass before falling back to S or X.
    if (inputChar === "a" || inputChar === "A") {
      if (!isModesTab && !searching && !extremeSearching && !aiSearching) {
        triggerAiSearch();
      }
      return;
    }
    // 'X' triggers EXTREME search — full filesystem scan on ALL drives
    // with progress and Esc-to-cancel. Use this when 'S' doesn't find a tool
    // that you KNOW is installed somewhere unusual.
    if (inputChar === "x" || inputChar === "X") {
      if (!isModesTab && !searching && !extremeSearching && !aiSearching) {
        triggerExtremeSearch();
      }
      return;
    }
    handleNavigation(key, inputChar);
    handleActions(key, inputChar);
  });

  // -- Manual tool search (triggered by 'S' key) --------------------------
  function triggerToolSearch() {
    setSearching(true);
    setSearchProgress({ currentTool: "(iniciando)", toolsDone: 0, toolsTotal: 0, results: [] });
    setRenderKey((n) => n + 1);

    // Determine which tools to search for:
    // - If mode is active: search only tools from that mode
    // - If no mode: search all tools in the registry
    const mode = getActiveMode();
    let toolIds: string[];
    if (mode && mode.enableTools.length > 0) {
      toolIds = mode.enableTools;
    } else {
      toolIds = getAllExtensions().filter((e) => e.category === "tool").map((e) => e.id);
    }

    import("../toolDetector.js").then(({ searchAllTools, getModeToolNames }) => {
      const toolNames = getModeToolNames(toolIds);

      searchAllTools(toolNames, (progress) => {
        setSearchProgress({
          currentTool: progress.currentTool,
          toolsDone: progress.toolsDone,
          toolsTotal: progress.toolsTotal,
          results: progress.results.map((r) => ({
            toolName: r.toolName,
            status: r.status,
            binaryPath: r.binaryPath,
            version: r.version,
          })),
        });
        setRenderKey((n) => n + 1);
      }).then(() => {
        setSearching(false);
        setRenderKey((n) => n + 1);
      }).catch(() => {
        setSearching(false);
        setRenderKey((n) => n + 1);
      });
    }).catch(() => {
      setSearching(false);
      setRenderKey((n) => n + 1);
    });
  }

  // -- Extreme tool search (triggered by 'X' key) --------------------------
  // Full filesystem scan on ALL drives. Slow (1-10 min) but finds binaries
  // ANYWHERE on the system. Esc cancels mid-scan.
  function triggerExtremeSearch() {
    setExtremeSearching(true);
    setExtremeProgress({
      currentTool: "(iniciando)",
      currentPath: "(preparando para escanear todas as unidades...)",
      toolsDone: 0,
      toolsTotal: 0,
      results: [],
    });
    setRenderKey((n) => n + 1);

    // Create an abort signal object that the Esc handler can flip
    const abortSignal = { aborted: false };
    setExtremeAbortSignal(abortSignal);

    // Determine which tools to search for (same logic as triggerToolSearch)
    const mode = getActiveMode();
    let toolIds: string[];
    if (mode && mode.enableTools.length > 0) {
      toolIds = mode.enableTools;
    } else {
      toolIds = getAllExtensions().filter((e) => e.category === "tool").map((e) => e.id);
    }

    import("../toolDetector.js").then(({ extremeSearchAllTools, getModeToolNames }) => {
      const toolNames = getModeToolNames(toolIds);

      extremeSearchAllTools(toolNames, (progress) => {
        setExtremeProgress({
          currentTool: progress.currentTool,
          currentPath: progress.currentPath,
          toolsDone: progress.toolsDone,
          toolsTotal: progress.toolsTotal,
          results: progress.results.map((r) => ({
            toolName: r.toolName,
            status: r.status,
            binaryPath: r.binaryPath,
            version: r.version,
          })),
        });
        setRenderKey((n) => n + 1);
      }, abortSignal).then(() => {
        setExtremeSearching(false);
        setExtremeAbortSignal(null);
        setRenderKey((n) => n + 1);
      }).catch(() => {
        setExtremeSearching(false);
        setExtremeAbortSignal(null);
        setRenderKey((n) => n + 1);
      });
    }).catch(() => {
      setExtremeSearching(false);
      setExtremeAbortSignal(null);
      setRenderKey((n) => n + 1);
    });
  }

  // -- AI-only search (triggered by 'A' key) -------------------------------
  // Fast: just asks the LLM "where might this binary be?" and verifies with
  // fs.existsSync. 3-10s total. Good first pass before falling back to S or X.
  function triggerAiSearch() {
    setAiSearching(true);
    setAiProgress({
      currentTool: "(iniciando)",
      currentPath: "(conectando ao LLM...)",
      toolsDone: 0,
      toolsTotal: 0,
      results: [],
    });
    setRenderKey((n) => n + 1);

    // Determine which tools to search for (same logic as triggerToolSearch)
    const mode = getActiveMode();
    let toolIds: string[];
    if (mode && mode.enableTools.length > 0) {
      toolIds = mode.enableTools;
    } else {
      toolIds = getAllExtensions().filter((e) => e.category === "tool").map((e) => e.id);
    }

    import("../toolDetector.js").then(({ aiOnlySearchAllTools, getModeToolNames }) => {
      const toolNames = getModeToolNames(toolIds);

      aiOnlySearchAllTools(toolNames, (progress) => {
        setAiProgress({
          currentTool: progress.currentTool,
          currentPath: progress.currentPath,
          toolsDone: progress.toolsDone,
          toolsTotal: progress.toolsTotal,
          results: progress.results.map((r) => ({
            toolName: r.toolName,
            status: r.status,
            binaryPath: r.binaryPath,
            version: r.version,
          })),
        });
        setRenderKey((n) => n + 1);
      }).then(() => {
        setAiSearching(false);
        setRenderKey((n) => n + 1);
      }).catch(() => {
        setAiSearching(false);
        setRenderKey((n) => n + 1);
      });
    }).catch(() => {
      setAiSearching(false);
      setRenderKey((n) => n + 1);
    });
  }

  function handleNavigation(key: { leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; ctrl?: boolean }, inputChar: string) {
    const maxItems = isModesTab ? visibleModes.length : visibleItems.length;
    if (key.leftArrow) {
      setCursorIndex((prev) => clampCursor(prev - 1, maxItems || 1));
    } else if (key.rightArrow) {
      setCursorIndex((prev) => clampCursor(prev + 1, maxItems || 1));
    } else if (key.upArrow && !key.ctrl) {
      if (cursorIndex >= GRID_COLS) {
        setCursorIndex((prev) => clampCursor(prev - GRID_COLS, maxItems || 1));
      } else if (scrollTop > 0) {
        setScrollTop((prev) => Math.max(0, prev - PAGE_SIZE));
        setCursorIndex(0);
      }
    } else if (key.downArrow && !key.ctrl) {
      if (cursorIndex < (maxItems - GRID_COLS)) {
        setCursorIndex((prev) => clampCursor(prev + GRID_COLS, maxItems || 1));
      } else if (scrollTop + PAGE_SIZE < totalItems) {
        setScrollTop((prev) => Math.min(prev + PAGE_SIZE, lastPageStart));
        setCursorIndex(0);
      }
    }
  }

  // sonar-disable-next-line typescript:S3776
function handleActions(key: { return?: boolean }, inputChar: string) {
    if (key.return || inputChar === " ") {
      if (isModesTab) {
        const mode = visibleModes[cursorIndex];
        if (mode) {
          // Activate the selected mode (async, but we trigger immediate re-render)
          applyMode(mode.name).then((result) => {
            if (result.success) {
              setRenderKey((n) => n + 1);
            }
          }).catch(() => {
            // ignore - logged by applyMode
          });
          setRenderKey((n) => n + 1);
        }
        return;
      }
      const item = visibleItems[cursorIndex];
      if (item) {
        toggleExtension(item.id);
        setRenderKey((n) => n + 1);
      }
    }

    // 'D' on Modes tab deactivates the current mode
    if (isModesTab && (inputChar === "d" || inputChar === "D")) {
      deactivateMode();
      setRenderKey((n) => n + 1);
      return;
    }

    if (isModesTab) return; // other shortcuts don't apply to modes

    // 'I' installs the selected tool if it's missing
    if (inputChar === "i" || inputChar === "I") {
      const item = visibleItems[cursorIndex];
      if (item && item.category === "tool" && !item.installed) {
        // Extract tool name from the extension id (e.g., "tool:rojo_build" → "rojo")
        const toolName = item.id.replace("tool:", "").replace(/_\w+$/, "");
        import("../toolInstaller.js").then(({ installTool }) => {
          installTool(toolName).then((result) => {
            if (result.success) {
              setRenderKey((n) => n + 1);
            }
          }).catch(() => {
            // ignore — logged by installer
          });
        }).catch(() => {
          // toolInstaller not available
        });
        setRenderKey((n) => n + 1);
      }
      return;
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

  // -- Render ----------------------------------------------------------
  const summary = getHubSummary();
  const activeModeLabel = getActiveModeName();

  // Width-aware card sizing: cards adapt to terminal width instead of the
  // old hardcoded width={cardWidth}. On a 100-col terminal we get 31-col cards,
  // on a 60-col terminal we get 18-col cards (still usable).
  const termWidth = useTerminalWidth();
  const cardWidth = calculateCardWidth(termWidth, GRID_COLS, 1, 2);

  return (
    <Box key={`hub-${renderKey}`} flexDirection="column" borderStyle="double" borderColor={colors.primary} paddingX={1}>
      {/* Header */}
      <Box justifyContent="center" marginBottom={0}>
        <Text color={colors.primary} bold>
          ======= EXTENSION HUB ========
        </Text>
      </Box>

      {/* Active mode indicator + filter status (if any) */}
      {activeModeLabel && (
        <Box justifyContent="center">
          <Text color={colors.success} bold>
            Active mode: {activeModeLabel}
          </Text>
          {modeFilter && (
            <Text color={colors.warning} bold> | FILTRO: só do modo ativo</Text>
          )}
        </Box>
      )}

      {/* Category Tabs */}
      <Box justifyContent="center" gap={1} marginBottom={1}>
        {CATEGORIES.map((cat, i) => {
          const isActive = i === tabIndex;
          const catKey = cat.key;
          let count: number;
          if (catKey === "all") {
            count = summary.total;
          } else if (catKey === "modes") {
            count = getAllModes().length;
          } else {
            count = summary.byCategory[catKey as ExtensionCategory]?.total ?? 0;
          }
          return (
            <Text
              key={cat.key}
              color={isActive ? colors.primary : colors.muted}
              bold={isActive}
            >
              {isActive ? "> " : "  "}
              {cat.label}
              <Text color={colors.muted}>({count})</Text>
            </Text>
          );
        })}
      </Box>

      {/* 3x3 Grid - either extensions or modes */}
      <Box flexDirection="column" gap={0}>
        {Array.from({ length: GRID_ROWS }, (_, row) => (
          <Box key={`row-${row}`} flexDirection="row" gap={1} justifyContent="center">
            {Array.from({ length: GRID_COLS }, (_, col) => {
              const idx = row * GRID_COLS + col;
              if (isModesTab) {
                const mode = visibleModes[idx];
                if (!mode) {
                  return <Box key={`empty-${col}`} width={cardWidth} />;
                }
                const isSelected = idx === cursorIndex;
                return (
                  <ModeCard
                    key={mode.name}
                    mode={mode}
                    selected={isSelected}
                    isActive={mode.name === activeModeName}
                    cardWidth={cardWidth}
                  />
                );
              }
              const item = visibleItems[idx];
              if (!item) {
                return <Box key={`empty-${col}`} width={cardWidth} />;
              }
              const isSelected = idx === cursorIndex;
              return (
                <ExtensionCard
                  key={item.id}
                  item={item}
                  selected={isSelected}
                  cardWidth={cardWidth}
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
            {"#".repeat(currentPage + 1)}
            {"-".repeat(totalPages - currentPage - 1)}
            {" "}
            Page {currentPage + 1}/{totalPages}
          </Text>
        </Box>
      )}

      {/* Tool search panel (shown when searching or when search has results) */}
      {(searching || (searchProgress && searchProgress.results.length > 0)) && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={searching ? colors.warning : colors.muted} paddingLeft={1} paddingRight={1}>
          <Text color={searching ? colors.warning : colors.primary} bold>
            {searching ? `Buscando tools... (${searchProgress?.toolsDone ?? 0}/${searchProgress?.toolsTotal ?? 0})` : `Busca completa (${searchProgress?.results.length ?? 0} tools)`}
          </Text>
          {searching && searchProgress && (
            <Text color={colors.muted}> Procurando: {searchProgress.currentTool}...</Text>
          )}
          {searchProgress?.results.map((r, i) => (
            <Text key={`search-${i}`} color={r.status === "missing" ? colors.error : colors.success}>
              {" "}{r.status === "missing" ? "X" : "v"} {r.toolName}
              {r.version ? ` v${r.version}` : ""}
              {r.binaryPath ? ` @ ${r.binaryPath.length > 50 ? "..." + r.binaryPath.slice(-47) : r.binaryPath}` : " (nao encontrado)"}
            </Text>
          ))}
        </Box>
      )}

      {/* Extreme search panel (shown when extreme search is running, was cancelled,
          or has results). Stays visible after cancellation so the user sees feedback. */}
      {(extremeSearching || extremeProgress) && (
        <Box flexDirection="column" marginTop={1} borderStyle="bold" borderColor={extremeSearching ? colors.error : (extremeProgress?.currentPath?.includes("cancelado") ? colors.warning : colors.success)} paddingLeft={1} paddingRight={1}>
          <Text color={extremeSearching ? colors.error : (extremeProgress?.currentPath?.includes("cancelado") ? colors.warning : colors.success)} bold>
            {extremeSearching
              ? `BUSCA EXTREMA... (${extremeProgress?.toolsDone ?? 0}/${extremeProgress?.toolsTotal ?? 0}) — Esc cancela`
              : extremeProgress?.currentPath?.includes("cancelado")
              ? `BUSCA EXTREMA CANCELADA — Esc fecha o hub`
              : `Busca extrema completa (${extremeProgress?.results.length ?? 0} tools)`}
          </Text>
          {extremeSearching && extremeProgress && (
            <Box flexDirection="column">
              <Text color={colors.warning}> Tool: {extremeProgress.currentTool}</Text>
              <Text color={colors.muted}> Path: {extremeProgress.currentPath}</Text>
            </Box>
          )}
          {extremeProgress?.results.map((r, i) => (
            <Text key={`xsearch-${i}`} color={r.status === "missing" ? colors.error : colors.success}>
              {" "}{r.status === "missing" ? "X" : "v"} {r.toolName}
              {r.version ? ` v${r.version}` : ""}
              {r.binaryPath ? ` @ ${r.binaryPath.length > 50 ? "..." + r.binaryPath.slice(-47) : r.binaryPath}` : " (nao encontrado)"}
            </Text>
          ))}
        </Box>
      )}

      {/* AI search panel (shown when AI search is running or has results) */}
      {(aiSearching || (aiProgress && aiProgress.results.length > 0)) && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={aiSearching ? colors.primary : colors.muted} paddingLeft={1} paddingRight={1}>
          <Text color={aiSearching ? colors.primary : colors.success} bold>
            {aiSearching
              ? `BUSCA IA... (${aiProgress?.toolsDone ?? 0}/${aiProgress?.toolsTotal ?? 0})`
              : `Busca IA completa (${aiProgress?.results.length ?? 0} tools)`}
          </Text>
          {aiSearching && aiProgress && (
            <Box flexDirection="column">
              <Text color={colors.warning}> Tool: {aiProgress.currentTool}</Text>
              <Text color={colors.muted}> {aiProgress.currentPath}</Text>
            </Box>
          )}
          {aiProgress?.results.map((r, i) => (
            <Text key={`aisearch-${i}`} color={r.status === "missing" ? colors.error : colors.success}>
              {" "}{r.status === "missing" ? "X" : "v"} {r.toolName}
              {r.version ? ` v${r.version}` : ""}
              {r.binaryPath ? ` @ ${r.binaryPath.length > 50 ? "..." + r.binaryPath.slice(-47) : r.binaryPath}` : " (IA nao achou)"}
            </Text>
          ))}
        </Box>
      )}

      {/* Description of selected item (terminal equivalent of hover tooltip) */}
      {isModesTab && visibleModes[cursorIndex] && (
        <ModeDescription mode={visibleModes[cursorIndex]} isActive={visibleModes[cursorIndex].name === activeModeName} />
      )}
      {!isModesTab && visibleItems[cursorIndex] && (
        <Box marginTop={1} paddingLeft={1} paddingRight={1} borderStyle="round" borderColor={colors.muted}>
          <Text color={colors.white} wrap="truncate">
            {visibleItems[cursorIndex].description || "No description available."}
          </Text>
        </Box>
      )}

      {/* Bottom bar */}
      <Box justifyContent="space-between" marginTop={1} borderTop borderTopColor={colors.muted}>
        <Text color={colors.muted} dimColor>
          {isModesTab
            ? "  <-> select  ^v scroll  Enter activate  D deactivate  Tab switch  Esc close"
            : "  <- sel  ^v scr  <- tog T 1-4 I M A=ai S=smart X=eXtreme Tab Esc"}
        </Text>
        <Text color={colors.primary}>
          {isModesTab
            ? `${allModes.length} modes${activeModeName ? ` | active: ${activeModeName}` : ""}`
            : modeFilter
            ? `${allItems.filter(i => i.enabled).length}/${allItems.length} active (filtered)`
            : `${summary.enabled}/${summary.total} active`}
        </Text>
      </Box>
    </Box>
  );
}

// --- Mode Card ---------------------------------------------------------------

function ModeCard({ mode, selected, isActive, cardWidth }: Readonly<{ mode: ModeDefinition; selected: boolean; isActive: boolean; cardWidth: number }>) {
  const borderColor = selected ? colors.primary : (isActive ? colors.success : colors.muted);
  const icon = mode.icon ?? "M";
  const kind = mode.builtIn ? "BUILT-IN" : "USER";
  const statusText = isActive ? "[ATIVO]" : `[${kind}]`;
  const statusColor = isActive ? colors.success : (mode.builtIn ? colors.primary : colors.muted);

  return (
    <Box
      width={cardWidth}
      flexDirection="column"
      borderStyle={selected || isActive ? "bold" : "round"}
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Name row */}
      <Box>
        <Text color={isActive ? colors.success : colors.white} bold={selected || isActive}>
          {selected ? ">" : " "} {icon} {mode.name.slice(0, 14)}
        </Text>
      </Box>

      {/* Status row */}
      <Box>
        <Text color={statusColor} bold={isActive}>
          {statusText}
        </Text>
        <Text color={colors.muted}> </Text>
        <Text color={colors.muted}>
          T{mode.enableTools.length} S{mode.enableSkills.length} F{mode.enableFeatures.length}
        </Text>
      </Box>

      {/* Label (truncated) */}
      <Box>
        <Text color={colors.muted} wrap="truncate">
          {mode.label.slice(0, 19)}
        </Text>
      </Box>
    </Box>
  );
}

// --- Mode Description (tooltip) ---------------------------------------------

function ModeDescription({ mode, isActive }: Readonly<{ mode: ModeDefinition; isActive: boolean }>) {
  const lines: string[] = [];
  lines.push(`${mode.label} (${mode.name})${isActive ? " - ATIVO" : ""}`);
  lines.push(mode.description);
  lines.push("");
  lines.push(`Tools:     ${mode.enableTools.length}  |  Skills:     ${mode.enableSkills.length}  |  Features: ${mode.enableFeatures.length}`);
  lines.push(`Effort:    ${mode.effortLevel ?? "default"}  |  Strict: ${mode.strictMode ?? false}  |  Read-before-write: ${mode.readBeforeWrite ?? false}`);
  if (mode.luauValidation && mode.luauValidation.length > 0) {
    lines.push(`Luau validation: ${mode.luauValidation.length} rule(s) - ${mode.luauValidation.map((r) => `${r.tool}${r.blocking ? "*" : ""}`).join(", ")}`);
  }
  if (mode.userPrompt) {
    lines.push(`User prompt: "${mode.userPrompt}"`);
  }
  return (
    <Box marginTop={1} paddingLeft={1} paddingRight={1} borderStyle="round" borderColor={colors.muted} flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`card-${i}`} color={i === 0 ? colors.primary : colors.white} bold={i === 0} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

// --- Extension Card ---------------------------------------------------------

function ExtensionCard({ item, selected, cardWidth }: Readonly<{ item?: ExtensionEntry; selected: boolean; cardWidth: number }>) {
  if (!item) return <Box width={cardWidth} />;
  const borderColor = selected ? colors.primary : colors.muted;
  const icon = getCategoryIcon(item.category);
  const triggerLabel = getTriggerLabel(item.triggerMode);
  const triggerColor = TRIGGER_COLORS[item.triggerMode] ?? colors.muted;
  const isOn = item.enabled && item.triggerMode !== "disabled";

  // Tool status: missing (red), found (yellow), working (green)
  // For non-tool categories (skills, features, modes), always show as "ok"
  const isToolCategory = item.category === "tool";
  const toolStatus: "missing" | "found" | "ok" = !isToolCategory
    ? "ok"
    : !item.installed
    ? "missing"
    : "found";

  const statusLabel = isToolCategory
    ? toolStatus === "missing"
      ? "[FALTA]"
      : toolStatus === "found"
      ? "[OK]"
      : "[OK]"
    : "";

  const statusColor = toolStatus === "missing" ? colors.error : toolStatus === "found" ? colors.success : colors.muted;

  return (
    <Box
      width={cardWidth}
      flexDirection="column"
      borderStyle={selected ? "bold" : "round"}
      borderColor={borderColor}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Name row */}
      <Box>
        <Text color={item.enabled ? colors.white : colors.muted} bold={selected}>
          {selected ? ">" : " "} {icon} {item.name.slice(0, 14)}
        </Text>
      </Box>

      {/* Status + Trigger */}
      <Box>
        <Text color={isOn ? colors.success : colors.muted}>
          {isOn ? "ON" : "OFF"}
        </Text>
        <Text color={colors.muted}> </Text>
        <Text color={triggerColor} bold={item.triggerMode !== "disabled"}>
          [{triggerLabel}]
        </Text>
        {isToolCategory && (
          <Text color={statusColor}> {statusLabel}</Text>
        )}
      </Box>

      {/* Install hint for missing tools */}
      {isToolCategory && toolStatus === "missing" && selected && (
        <Box>
          <Text color={colors.warning}> Pressione I para instalar</Text>
        </Box>
      )}
    </Box>
  );
}

