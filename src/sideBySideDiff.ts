/**
 * sideBySideDiff.ts — Colorful side-by-side diff viewer for terminal.
 */

// Colors used for diff rendering (inline constants to avoid circular deps)
const colors = {
  success: "green",
  error: "red",
  warning: "yellow",
  muted: "gray",
};

export interface DiffLine {
  oldNum: number | null;
  newNum: number | null;
  oldContent: string;
  newContent: string;
  type: "same" | "added" | "removed" | "changed";
}

function emitRemovedLine(oldLines: string[], oldIdx: number, result: DiffLine[]): void {
  result.push({
    oldNum: oldIdx + 1,
    newNum: null,
    oldContent: oldLines[oldIdx],
    newContent: "",
    type: "removed",
  });
}

function emitAddedLine(newLines: string[], newIdx: number, result: DiffLine[]): void {
  result.push({
    oldNum: null,
    newNum: newIdx + 1,
    oldContent: "",
    newContent: newLines[newIdx],
    type: "added",
  });
}

function emitRemovedBeforeLcs(oldLines: string[], oldIdx: number, lcsEntry: string, result: DiffLine[]): number {
  let idx = oldIdx;
  while (idx < oldLines.length && oldLines[idx] !== lcsEntry) {
    emitRemovedLine(oldLines, idx, result);
    idx++;
  }
  return idx;
}

function emitAddedBeforeLcs(newLines: string[], newIdx: number, lcsEntry: string, result: DiffLine[]): number {
  let idx = newIdx;
  while (idx < newLines.length && newLines[idx] !== lcsEntry) {
    emitAddedLine(newLines, idx, result);
    idx++;
  }
  return idx;
}

export function computeSideBySideDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx >= lcs.length) {
      if (oldIdx < oldLines.length) emitRemovedLine(oldLines, oldIdx++, result);
      if (newIdx < newLines.length) emitAddedLine(newLines, newIdx++, result);
      continue;
    }

    oldIdx = emitRemovedBeforeLcs(oldLines, oldIdx, lcs[lcsIdx], result);
    newIdx = emitAddedBeforeLcs(newLines, newIdx, lcs[lcsIdx], result);

    if (lcsIdx < lcs.length) {
      result.push({
        oldNum: oldIdx + 1,
        newNum: newIdx + 1,
        oldContent: oldLines[oldIdx] ?? "",
        newContent: newLines[newIdx] ?? "",
        type: "same",
      });
      oldIdx++;
      newIdx++;
      lcsIdx++;
    }
  }

  return result;
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

export function renderSideBySide(diff: DiffLine[], maxLineWidth: number = 80): string {
  const halfWidth = Math.floor((maxLineWidth - 5) / 2);
  const lines: string[] = [];

  // Header
  lines.push(
    `\x1b[1m\x1b[47m${"OLD".padEnd(halfWidth)} │ ${"NEW".padEnd(halfWidth)}\x1b[0m`,
    `${"─".repeat(halfWidth)}─┼─${"─".repeat(halfWidth)}`
  );

  for (const line of diff) {
    const oldTruncated = line.oldContent.slice(0, halfWidth).padEnd(halfWidth);
    const newTruncated = line.newContent.slice(0, halfWidth).padEnd(halfWidth);

    let coloredOld: string;
    let coloredNew: string;

    switch (line.type) {
      case "removed":
        coloredOld = `\x1b[41m\x1b[37m${oldTruncated}\x1b[0m`;
        coloredNew = `${" ".repeat(halfWidth)}`;
        break;
      case "added":
        coloredOld = `${" ".repeat(halfWidth)}`;
        coloredNew = `\x1b[42m\x1b[37m${newTruncated}\x1b[0m`;
        break;
      case "same":
        coloredOld = `\x1b[90m${oldTruncated}\x1b[0m`;
        coloredNew = `\x1b[90m${newTruncated}\x1b[0m`;
        break;
      default:
        coloredOld = oldTruncated;
        coloredNew = newTruncated;
    }

    const oldNum = line.oldNum === null ? "    " : String(line.oldNum).padStart(4);
    const newNum = line.newNum === null ? "    " : String(line.newNum).padStart(4);

    lines.push(`${oldNum} ${coloredOld} │ ${newNum} ${coloredNew}`);
  }

  return lines.join("\n");
}

export function generateUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const diff = computeSideBySideDiff(oldText, newText);
  const lines: string[] = [];

  lines.push(
    `\x1b[36m--- a/${filePath}\x1b[0m`,
    `\x1b[32m+++ b/${filePath}\x1b[0m`
  );

  for (const line of diff) {
    if (line.type === "removed") {
      lines.push(`\x1b[31m- ${line.oldContent}\x1b[0m`);
    } else if (line.type === "added") {
      lines.push(`\x1b[32m+ ${line.newContent}\x1b[0m`);
    } else {
      lines.push(`  ${line.oldContent}`);
    }
  }

  return lines.join("\n");
}
