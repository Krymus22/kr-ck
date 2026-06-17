/**
 * autocomplete-subcommands.test.ts - Tests for slash command + subcommand autocomplete.
 *
 * Verifies the new autocomplete behavior:
 *   1. When user types /effort, all 4 effort levels are suggested
 *   2. When user types /effort l, only "low" is suggested
 *   3. When user types /mode, all 4 subcommands are suggested (roblox/off/create/confirm)
 *   4. When user types /help (no subcommands), no subcommand suggestions appear
 *   5. Pagination works when there are more than 8 matches
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock i18n env before importing
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("autocomplete subcommands", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Helper: simulate the autocomplete matching logic (mirrors App.tsx)
  function getMatches(input: string, commands: Array<{ cmd: string; subcommands?: string[] }>) {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return [];

    // Use input.includes(" ") - trailing space matters!
    const hasSpace = input.includes(" ");
    if (!hasSpace) {
      const lower = trimmed.toLowerCase();
      return commands
        .filter((s) => s.cmd.startsWith(lower))
        .map((s) => ({ label: s.cmd, isSubcommand: false }));
    }

    // Subcommand mode: parse from original input (preserves trailing space)
    const spaceIdx = input.indexOf(" ");
    const cmdPart = input.slice(0, spaceIdx).toLowerCase();
    const subPart = input.slice(spaceIdx + 1).trim().toLowerCase();

    const cmd = commands.find((s) => s.cmd === cmdPart);
    if (!cmd || !cmd.subcommands) return [];

    return cmd.subcommands
      .filter((sub) => sub.startsWith(subPart))
      .map((sub) => ({ label: sub, isSubcommand: true }));
  }

  it("should suggest /effort in command mode when typing /e", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/e", commands);
    expect(matches.some((m) => m.label === "/effort")).toBe(true);
    expect(matches.some((m) => m.label === "/exit")).toBe(true);
  });

  it("should suggest all 4 effort subcommands when typing /effort + space", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/effort ", commands);
    expect(matches.length).toBe(4);
    const labels = matches.map((m) => m.label);
    expect(labels).toContain("low");
    expect(labels).toContain("medium");
    expect(labels).toContain("high");
    expect(labels).toContain("max");
  });

  it("should filter subcommands by prefix when typing /effort l", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/effort l", commands);
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe("low");
  });

  it("should filter subcommands by prefix when typing /effort m", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/effort m", commands);
    // Both "medium" and "max" start with "m"
    expect(matches.length).toBe(2);
    const labels = matches.map((m) => m.label);
    expect(labels).toContain("medium");
    expect(labels).toContain("max");
  });

  it("should filter subcommands by prefix when typing /effort me", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/effort me", commands);
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe("medium");
  });

  it("should suggest all 7 mode subcommands when typing /mode + space", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/mode ", commands);
    expect(matches.length).toBe(7);
    const labels = matches.map((m) => m.label);
    expect(labels).toContain("roblox");
    expect(labels).toContain("devops");
    expect(labels).toContain("off");
    expect(labels).toContain("create");
    expect(labels).toContain("confirm");
    expect(labels).toContain("new");
    expect(labels).toContain("keep");
  });

  it("should filter mode subcommands by prefix when typing /mode r", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/mode r", commands);
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe("roblox");
  });

  it("should return no matches for /help + space (help has no subcommands)", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/help ", commands);
    expect(matches.length).toBe(0);
  });

  it("should return no matches for /exit + space (exit has no subcommands)", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/exit ", commands);
    expect(matches.length).toBe(0);
  });

  it("should return no matches for unknown command /unknown + space", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/unknown ", commands);
    expect(matches.length).toBe(0);
  });

  it("should match commands case-insensitively", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/EFFORT", commands);
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe("/effort");
  });

  it("should match subcommands case-insensitively", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/effort LOW", commands);
    expect(matches.length).toBe(1);
    expect(matches[0].label).toBe("low");
  });

  it("should handle empty input gracefully", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("", commands);
    expect(matches.length).toBe(0);
  });

  it("should handle non-slash input gracefully", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("hello world", commands);
    expect(matches.length).toBe(0);
  });

  it("should show /effort in full command list when typing / alone", async () => {
    const { getLocalizedSlashCommands } = await import("./../i18n.js");
    const commands = getLocalizedSlashCommands();
    const matches = getMatches("/", commands);
    // All 19 commands should match
    expect(matches.length).toBe(19);
    expect(matches.some((m) => m.label === "/effort")).toBe(true);
    expect(matches.some((m) => m.label === "/mode")).toBe(true);
    expect(matches.some((m) => m.label === "/help")).toBe(true);
  });
});

describe("autocomplete pagination", () => {
  const PAGE_SIZE = 8;

  function calculateVisibleWindow(selectedIndex: number, total: number) {
    if (total <= PAGE_SIZE) return { start: 0, end: total };
    const halfPage = Math.floor(PAGE_SIZE / 2);
    let start: number;
    if (selectedIndex < halfPage) {
      start = 0;
    } else if (selectedIndex > total - halfPage - 1) {
      start = total - PAGE_SIZE;
    } else {
      start = selectedIndex - halfPage;
    }
    return { start, end: Math.min(start + PAGE_SIZE, total) };
  }

  it("should show all items when total <= PAGE_SIZE", () => {
    const w = calculateVisibleWindow(3, 5);
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
  });

  it("should show first 8 items when at index 0 of 19", () => {
    const w = calculateVisibleWindow(0, 19);
    expect(w.start).toBe(0);
    expect(w.end).toBe(8);
  });

  it("should center selection when at index 9 of 19", () => {
    const w = calculateVisibleWindow(9, 19);
    expect(w.start).toBe(5);  // 9 - 4
    expect(w.end).toBe(13);
  });

  it("should show last 8 items when at last index of 19", () => {
    const w = calculateVisibleWindow(18, 19);
    expect(w.start).toBe(11);  // 19 - 8
    expect(w.end).toBe(19);
  });

  it("should keep selected item visible when navigating down", () => {
    // Simulate user pressing Down through all 19 items
    for (let i = 0; i < 19; i++) {
      const w = calculateVisibleWindow(i, 19);
      expect(i).toBeGreaterThanOrEqual(w.start);
      expect(i).toBeLessThan(w.end);
    }
  });
});
