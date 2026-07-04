/**
 * FolderBrowser.tsx - Interactive folder selector (like Claude Code's project picker).
 *
 * Shows a navigable folder tree. User uses arrow keys to move, Enter to descend
 * into a folder, Backspace to go up, and selects the current folder with Enter
 * on the "✓ SELECT" entry.
 *
 * Keyboard:
 *   ↑ ↓       Navigate between folders
 *   Enter     Descend into folder (or select if on "✓ SELECT" entry)
 *   Backspace Go to parent directory
 *   Esc       Cancel (don't change cwd)
 *   Tab       Quick-select current folder (same as Enter on "✓ SELECT")
 *
 * Special handling:
 *   - On Windows root (C:\), shows all available drives (C:, D:, etc.)
 *   - Filters out hidden folders (starting with ".") and node_modules
 *   - Shows breadcrumb of current path at top
 *   - Auto-scrolls if list is longer than viewport (15 items)
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import fs from "node:fs";
import path from "node:path";
import { colors } from "./theme.js";

const VIEWPORT_SIZE = 15;

interface FolderEntry {
  name: string;
  isParent: boolean;
  isSelect: boolean;
  isDrive?: boolean;
}

interface FolderBrowserProps {
  initialPath?: string;
  onSelect: (selectedPath: string) => void;
  onCancel: () => void;
}

export function FolderBrowser({ initialPath, onSelect, onCancel }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath ?? process.cwd());
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // Detect if we're at a Windows drive root (C:\, D:\, etc.)
  const isWindowsDriveRoot = (p: string): boolean => {
    return process.platform === "win32" && /^[A-Z]:\\$/.test(p);
  };

  // Check if a drive exists (Windows only)
  const driveExists = (drive: string): boolean => {
    try {
      fs.accessSync(drive + "\\");
      return true;
    } catch {
      return false;
    }
  };

  // Load entries for the current path
  const loadEntries = useCallback((dir: string) => {
    const result: FolderEntry[] = [];

    try {
      // Add ".." (parent) entry unless at true root
      const parent = path.dirname(dir);
      if (parent !== dir) {
        result.push({ name: ".. (parent)", isParent: true, isSelect: false });
      }

      if (isWindowsDriveRoot(dir)) {
        // At Windows drive root — list all available drives
        for (let i = 65; i <= 90; i++) {
          const drive = String.fromCharCode(i) + ":";
          if (driveExists(drive)) {
            result.push({ name: drive + "\\", isParent: false, isSelect: false, isDrive: true });
          }
        }
      } else {
        // Normal directory — list subdirectories
        const dirents = fs.readdirSync(dir, { withFileTypes: true });
        const subdirs = dirents
          .filter((d) => {
            if (!d.isDirectory()) return false;
            // Filter out hidden folders and common noise
            if (d.name.startsWith(".")) return false;
            if (d.name === "node_modules") return false;
            return true;
          })
          .map((d) => d.name)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (const name of subdirs) {
          result.push({ name, isParent: false, isSelect: false });
        }
      }

      // Add "✓ SELECT" entry at the end
      result.push({ name: "✓ SELECT THIS FOLDER", isParent: false, isSelect: true });

      setEntries(result);
      setError(null);
      setSelectedIndex(0);
      setScrollTop(0);
    } catch (err) {
      setError(`Cannot read directory: ${(err as Error).message}`);
      setEntries([]);
    }
  }, []);

  // Reload entries when currentPath changes
  useEffect(() => {
    loadEntries(currentPath);
  }, [currentPath, loadEntries]);

  // Adjust scroll if selection is out of viewport
  useEffect(() => {
    if (selectedIndex < scrollTop) {
      setScrollTop(selectedIndex);
    } else if (selectedIndex >= scrollTop + VIEWPORT_SIZE) {
      setScrollTop(selectedIndex - VIEWPORT_SIZE + 1);
    }
  }, [selectedIndex, scrollTop]);

  useInput((input, key) => {
    if (error) {
      if (key.escape || key.return) onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(entries.length - 1, i + 1));
    } else if (key.return || key.tab) {
      const selected = entries[selectedIndex];
      if (!selected) return;

      if (selected.isSelect) {
        // Confirm selection
        onSelect(currentPath);
      } else if (selected.isParent) {
        // Go to parent
        const parent = path.dirname(currentPath);
        if (parent !== currentPath) {
          setCurrentPath(parent);
        }
      } else if (selected.isDrive) {
        // Navigate to a Windows drive root
        setCurrentPath(selected.name);
      } else {
        // Descend into subdirectory
        setCurrentPath(path.join(currentPath, selected.name));
      }
    } else if (key.escape) {
      onCancel();
    } else if (key.backspace || key.delete) {
      // Go to parent on Backspace
      const parent = path.dirname(currentPath);
      if (parent !== currentPath) {
        setCurrentPath(parent);
      }
    } else if (input === "h" || input === "H") {
      // 'h' shortcut: go home
      const home = process.env.HOME ?? process.env.USERPROFILE ?? require("node:os").homedir();
      setCurrentPath(home);
    }
  });

  // Detect project type in current folder
  const hasRobloxProject = entries.length > 0 && fs.existsSync(path.join(currentPath, "default.project.json"));
  const hasNodeProject = entries.length > 0 && fs.existsSync(path.join(currentPath, "package.json"));

  // Visible entries (with scroll)
  const visibleEntries = entries.slice(scrollTop, scrollTop + VIEWPORT_SIZE);
  const itemsAbove = scrollTop;
  const itemsBelow = Math.max(0, entries.length - scrollTop - VIEWPORT_SIZE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.primary} paddingX={1} paddingY={0}>
      {/* Header */}
      <Box>
        <Text color={colors.primary} bold>
          📁 Select working directory
        </Text>
      </Box>

      {/* Breadcrumb */}
      <Box marginBottom={0}>
        <Text color={colors.muted}>Path: </Text>
        <Text color={colors.white} bold>{currentPath}</Text>
      </Box>

      {/* Project indicators */}
      {(hasRobloxProject || hasNodeProject) && (
        <Box>
          <Text color={colors.success}>
            {hasRobloxProject ? "✓ Roblox project  " : ""}
            {hasNodeProject ? "✓ Node.js project" : ""}
          </Text>
        </Box>
      )}

      {/* Error state */}
      {error && (
        <Box flexDirection="column">
          <Text color={colors.error}>⚠ {error}</Text>
          <Text color={colors.muted}>Press Esc to cancel</Text>
        </Box>
      )}

      {/* Folder list */}
      {!error && (
        <Box flexDirection="column" marginTop={0}>
          {itemsAbove > 0 && (
            <Text color={colors.muted}>  ↑ {itemsAbove} more above</Text>
          )}
          {visibleEntries.map((entry, idx) => {
            const realIndex = scrollTop + idx;
            const isSelected = realIndex === selectedIndex;
            const icon = entry.isSelect ? "✓" : entry.isParent ? "↑" : entry.isDrive ? "💽" : "📁";
            const color = entry.isSelect ? colors.success : entry.isParent ? colors.muted : colors.white;
            return (
              <Box key={realIndex}>
                <Text color={isSelected ? colors.primary : colors.muted}>
                  {isSelected ? "▸ " : "  "}
                </Text>
                <Text color={color} bold={isSelected || entry.isSelect}>
                  {icon} {entry.name}
                </Text>
              </Box>
            );
          })}
          {itemsBelow > 0 && (
            <Text color={colors.muted}>  ↓ {itemsBelow} more below</Text>
          )}
        </Box>
      )}

      {/* Footer / shortcuts */}
      <Box marginTop={1}>
        <Text color={colors.muted}>
          ↑↓ navigate · Enter open/select · ⌫ back · H home · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
