/**
 * utf8Safety.ts - Force UTF-8 encoding across all platforms.
 *
 * Problem solved: the previous code hardcoded `LANG=pt_BR.UTF-8` on Linux/macOS,
 * but that locale is only honoured if the system actually has it generated
 * (`locale -a | grep pt_BR`). On minimal containers, WSL, and CI runners,
 * `pt_BR.UTF-8` is frequently absent and the glibc silently falls back to
 * the `C`/`POSIX` locale (ASCII), which renders `você` as `voc├¬` in the TUI.
 *
 * On Windows, the problem is different: cmd.exe and PowerShell default to
 * CP437 or CP1252 code pages. `chcp 65001` switches to UTF-8 but only for
 * the current console session, and it can fail silently when stdin is
 * redirected or when running inside Git Bash / WSL terminals.
 *
 * Strategy:
 *  1. (Windows only) Call `chcp 65001` AND `SetConsoleOutputCP(65001)` via
 *     multiple fallback paths. Also set `PYTHONIOENCODING` and `PYTHONUTF8`.
 *  2. (All platforms) Probe `locale -a` for any UTF-8 locale, prefer
 *      pt_BR.UTF-8 → en_US.UTF-8 → C.UTF-8 (always available on glibc 2.35+
 *      and musl). Set LANG/LC_ALL accordingly.
 *  3. (All platforms) Force Python children to UTF-8 via PYTHONIOENCODING
 *      and PYTHONUTF8=1.
 *  4. (All platforms) Force Node stdio to UTF-8 via setDefaultEncoding.
 *  5. (Windows only) Patch process.stdout.write to always emit UTF-8 bytes
 *      even if the underlying console is in a legacy code page.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

export interface Utf8SetupResult {
  platform: string;
  probedLocales: string[];
  chosen: string;
  fallbackUsed: boolean;
  reason: string;
}

/** Cache of `locale -a` output to avoid repeated subprocess calls. */
let cachedLocaleList: string[] | null = null;

/**
 * Returns the list of locales available on the system via `locale -a`.
 * Returns an empty array on platforms without `locale` (e.g., Windows, Alpine
 * without glibc, sandboxes without shell access).
 */
export function listSystemLocales(): string[] {
  if (cachedLocaleList !== null) return cachedLocaleList;
  if (platform() === "win32") {
    cachedLocaleList = [];
    return cachedLocaleList;
  }
  try {
    const out = execSync("locale -a 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedLocaleList = out
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    cachedLocaleList = [];
  }
  return cachedLocaleList;
}

/**
 * Picks the best UTF-8 locale from the system, in priority order:
 *   1. pt_BR.UTF-8 / pt_BR.utf8 (matches TUI language)
 *   2. en_US.UTF-8 / en_US.utf8 (universal fallback)
 *   3. Any locale ending in .UTF-8 or .utf8
 *   4. C.UTF-8 / C.utf8 (glibc 2.35+ and musl ship this always)
 *
 * Returns `null` if no UTF-8 locale is detected — caller should then
 * explicitly set `LANG=C.UTF-8` (which works on glibc 2.35+ and musl).
 */
export function pickBestUtf8Locale(): { locale: string | null; tried: string[] } {
  const available = listSystemLocales();
  const tried: string[] = [];

  const candidates = [
    "pt_BR.UTF-8",
    "pt_BR.utf8",
    "pt_PT.UTF-8",
    "pt_PT.utf8",
    "en_US.UTF-8",
    "en_US.utf8",
    "C.UTF-8",
    "C.utf8",
  ];

  for (const c of candidates) {
    tried.push(c);
    if (available.includes(c)) return { locale: c, tried };
  }

  // Last resort: any locale that ends with .UTF-8 or .utf8
  const anyUtf8 = available.find((l) => /\.(UTF-8|utf8)$/i.test(l));
  if (anyUtf8) return { locale: anyUtf8, tried };

  return { locale: null, tried };
}

/**
 * Apply UTF-8 environment variables and Node stdio defaults.
 *
 * Idempotent — safe to call multiple times. Returns a diagnostics object.
 *
 * Post-conditions (always true after this runs):
 *   - process.env.LANG is set to a UTF-8-capable locale (never POSIX/C alone)
 *   - process.env.LC_ALL mirrors LANG (or is unset if LANG was already correct)
 *   - process.env.PYTHONIOENCODING === "utf-8"
 *   - process.env.PYTHONUTF8 === "1"
 *   - process.stdout/stderr have setDefaultEncoding("utf8") called if possible
 *   - (Windows only) Console code page is 65001 (UTF-8)
 *   - (Windows only) process.stdout.write is patched to emit UTF-8 bytes
 *     directly, bypassing the legacy console code page
 */
export function forceUtf8Environment(): Utf8SetupResult {
  const pf = platform();
  const { locale: best, tried } = pickBestUtf8Locale();

  // Pick the locale to set. If `best` is null, use "C.UTF-8" which works on
  // glibc 2.35+ (Debian 12, Ubuntu 22.04+, Fedora 36+) and on all musl systems
  // (Alpine). On older glibc it's a no-op (won't break anything, but accented
  // chars may still misrender — at that point the user needs to run
  // `locale-gen pt_BR.UTF-8`).
  const chosen = best ?? "C.UTF-8";
  const fallbackUsed = best === null;

  // Only overwrite LANG if it's unset or non-UTF-8 (respect user's explicit
  // choice if they already set LANG=fr_FR.UTF-8 etc.)
  const currentLang = process.env.LANG ?? "";
  const currentIsUtf8 = /\.(UTF-8|utf8)$/i.test(currentLang);
  if (!currentIsUtf8) {
    process.env.LANG = chosen;
  }
  // LC_ALL: mirror LANG if not already a UTF-8 locale
  const currentLcAll = process.env.LC_ALL ?? "";
  const lcAllIsUtf8 = /\.(UTF-8|utf8)$/i.test(currentLcAll);
  if (!lcAllIsUtf8) {
    process.env.LC_ALL = process.env.LANG;
  }

  // Python: force UTF-8 regardless of locale
  process.env.PYTHONIOENCODING ??= "utf-8";
  process.env.PYTHONUTF8 ??= "1";

  // Node stdio: set default encoding to utf8 (affects how strings are
  // serialized to bytes on the wire). On Node 18+ this is already the
  // default, but on older Node or weird TTYs it may not be.
  try {
    const stdout = process.stdout as unknown as { setDefaultEncoding?: (e: string) => void };
    const stderr = process.stderr as unknown as { setDefaultEncoding?: (e: string) => void };
    if (typeof stdout.setDefaultEncoding === "function") stdout.setDefaultEncoding("utf8");
    if (typeof stderr.setDefaultEncoding === "function") stderr.setDefaultEncoding("utf8");
  } catch {
    // ignore - not critical
  }

  // Windows-specific: switch console to UTF-8 AND patch stdout to emit
  // UTF-8 bytes directly. The console code page change is done via
  // `chcp 65001` + `SetConsoleOutputCP` (PowerShell). The stdout patch
  // is the critical fix — Node.js on Windows still uses the console's
  // code page when writing to a TTY, which can be CP437/CP1252 even
  // after `chcp 65001` in some terminal hosts (notably Git Bash and
  // ConEmu). Patching stdout.write to always encode as UTF-8 ensures
  // accented chars render correctly regardless of the console CP.
  if (pf === "win32") {
    forceWindowsConsoleUtf8();
    patchWindowsStdoutForUtf8();
  }

  return {
    platform: pf,
    probedLocales: tried,
    chosen,
    fallbackUsed,
    reason: fallbackUsed
      ? "No UTF-8 locale found in `locale -a`; falling back to C.UTF-8 (glibc 2.35+ or musl required)."
      : `Selected ${chosen} from available system locales.`,
  };
}

/**
 * Windows-only: switch the console to UTF-8 code page (65001).
 *
 * Tries multiple paths because no single approach works in every Windows
 * terminal host:
 *   1. `chcp 65001` — works in cmd.exe, may fail in PowerShell ISE
 *   2. `SetConsoleOutputCP(65001)` via PowerShell — works in PowerShell
 *   3. (Fallback) Just set env var — child processes will inherit it
 */
function forceWindowsConsoleUtf8(): void {
  // Path 1: chcp 65001 for cmd.exe
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {
    // PowerShell or non-cmd shell — try next path
  }

  // Path 2: SetConsoleOutputCP via PowerShell (more reliable than chcp)
  try {
    execSync(
      `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8"`,
      { stdio: "ignore" }
    );
  } catch {
    // PowerShell not available or in Constrained Language Mode
  }

  // Path 3: Set environment vars that affect child processes and some
  // Node.js internals on Windows.
  process.env.PYTHONLEGACYWINDOWSSTDIO ??= "0";
}

/**
 * Windows-only: patch process.stdout.write to always emit UTF-8 bytes.
 *
 * On Windows, Node.js's process.stdout (when it's a TTY) uses the console's
 * current code page to encode strings. Even after `chcp 65001`, some
 * terminal hosts (Git Bash, ConEmu, Cmder) report a different code page to
 * Node, causing accented chars to be encoded as CP437/CP1252 and then
 * misinterpreted by the terminal as UTF-8 → garbage like `voc├¬`.
 *
 * The fix: override the `write` method so strings are first converted to
 * UTF-8 Buffer, then written as raw bytes. Buffers bypass the code page
 * conversion entirely.
 *
 * This patch is idempotent — if called twice, the second call detects the
 * already-patched write and skips re-patching.
 */
let stdoutPatched = false;
let stderrPatched = false;

function patchWindowsStdoutForUtf8(): void {
  if (stdoutPatched) return;
  const stdout = process.stdout as any;
  if (!stdout || typeof stdout.write !== "function") return;

  const origWrite = stdout.write.bind(stdout);
  stdout.write = function patchedWrite(data: any, ...args: any[]): boolean {
    if (typeof data === "string") {
      // Convert string to UTF-8 Buffer and write as bytes. This bypasses
      // the console code page entirely.
      const buf = Buffer.from(data, "utf8");
      // args may contain encoding/callback — strip encoding since we're
      // sending a Buffer now.
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
      return cb ? origWrite(buf, cb) : origWrite(buf);
    }
    // Already a Buffer or other type — pass through unchanged
    return origWrite(data, ...args);
  };
  stdoutPatched = true;

  // Same for stderr
  if (stderrPatched) return;
  const stderr = process.stderr as any;
  if (!stderr || typeof stderr.write !== "function") return;
  const origWriteErr = stderr.write.bind(stderr);
  stderr.write = function patchedWriteErr(data: any, ...args: any[]): boolean {
    if (typeof data === "string") {
      const buf = Buffer.from(data, "utf8");
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
      return cb ? origWriteErr(buf, cb) : origWriteErr(buf);
    }
    return origWriteErr(data, ...args);
  };
  stderrPatched = true;
}

/**
 * Diagnostic helper: returns a human-readable report of the current UTF-8
 * state. Used by the `/utf8` slash command and by tests.
 */
export function diagnoseUtf8(): string {
  const lines: string[] = [];
  lines.push("UTF-8 diagnostics:");
  lines.push(`  platform:       ${platform()}`);
  lines.push(`  LANG:           ${process.env.LANG ?? "(unset)"}`);
  lines.push(`  LC_ALL:         ${process.env.LC_ALL ?? "(unset)"}`);
  lines.push(`  PYTHONIOENCODING: ${process.env.PYTHONIOENCODING ?? "(unset)"}`);
  lines.push(`  PYTHONUTF8:     ${process.env.PYTHONUTF8 ?? "(unset)"}`);
  const available = listSystemLocales();
  const utf8Available = available.filter((l) => /\.(UTF-8|utf8)$/i.test(l));
  lines.push(`  locales total:  ${available.length}`);
  lines.push(`  locales UTF-8:  ${utf8Available.length}`);
  if (utf8Available.length > 0 && utf8Available.length <= 10) {
    lines.push(`    - ${utf8Available.join("\n    - ")}`);
  }
  const langOk = /\.(UTF-8|utf8)$/i.test(process.env.LANG ?? "");
  lines.push(`  LANG is UTF-8:  ${langOk ? "YES" : "NO"}`);
  return lines.join("\n");
}
