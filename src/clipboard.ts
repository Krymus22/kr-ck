/**
 * clipboard.ts — Clipboard integration: copy/paste text and images.
 */

import { execSync } from "node:child_process";
import * as log from "./logger.js";

export function copyToClipboard(text: string): boolean {
  try {
    if (process.platform === "win32") {
      // PowerShell Set-Clipboard
      const escaped = text.replaceAll('"', '""');
      execSync(`powershell -Command "Set-Clipboard -Value '${escaped}'"`, { encoding: "utf8" });
    } else if (process.platform === "darwin") {
      execSync("pbcopy", { input: text, encoding: "utf8" });
    } else {
      // Linux: try xclip, then xsel
      try {
        execSync("xclip -selection clipboard", { input: text, encoding: "utf8" });
      } catch {
        execSync("xsel --clipboard --input", { input: text, encoding: "utf8" });
      }
    }
    log.success("Copied to clipboard");
    return true;
  } catch (err) {
    log.error(`Clipboard copy failed: ${(err as Error).message}`);
    return false;
  }
}

export function pasteFromClipboard(): string | null {
  try {
    if (process.platform === "win32") {
      return execSync("powershell -Command \"Get-Clipboard\"", { encoding: "utf8" }).trim();
    } else if (process.platform === "darwin") {
      return execSync("pbpaste", { encoding: "utf8" }).trim();
    } else {
      try {
        return execSync("xclip -selection clipboard -o", { encoding: "utf8" }).trim();
      } catch {
        return execSync("xsel --clipboard --output", { encoding: "utf8" }).trim();
      }
    }
  } catch {
    return null;
  }
}

export function copyFileToClipboard(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      execSync(`powershell -Command "Get-Item '${filePath}' | Set-Clipboard"`, { encoding: "utf8" });
    } else if (process.platform === "darwin") {
      execSync(`osascript -e 'set the clipboard to (read (POSIX file "${filePath}") as JPEG)' 2>/dev/null || cat "${filePath}" | pbcopy`);
    } else {
      execSync(`xclip -selection clipboard < "${filePath}"`);
    }
    return true;
  } catch {
    return false;
  }
}
