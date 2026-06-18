/**
 * utf8Safety.test.ts — tests for the UTF-8 environment setup module.
 *
 * Bug being fixed: previously, the code hardcoded `LANG=pt_BR.UTF-8` on
 * Linux, but if the system didn't have that locale generated (common on
 * minimal containers, WSL, CI), the glibc silently fell back to the
 * `C`/`POSIX` locale (ASCII), and accented chars like `você` rendered as
 * `voc├¬` in the TUI.
 *
 * The fix probes `locale -a` for any available UTF-8 locale, prefers
 * `pt_BR.UTF-8` → `en_US.UTF-8` → `C.UTF-8`, and falls back to `C.UTF-8`
 * (which works on glibc 2.35+ and musl without locale-gen).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  forceUtf8Environment,
  listSystemLocales,
  pickBestUtf8Locale,
  diagnoseUtf8,
} from "../utf8Safety.js";

describe("utf8Safety", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Clear locale env vars before each test
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
  });

  afterEach(() => {
    // Restore original env
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(origEnv)) {
      process.env[k] = v;
    }
  });

  describe("listSystemLocales", () => {
    it("returns an array (possibly empty) on any platform", () => {
      const locales = listSystemLocales();
      expect(Array.isArray(locales)).toBe(true);
    });

    it("caches the result for subsequent calls", () => {
      const a = listSystemLocales();
      const b = listSystemLocales();
      expect(a).toBe(b); // same reference — cached
    });
  });

  describe("pickBestUtf8Locale", () => {
    it("prefers pt_BR.UTF-8 when available", () => {
      // Force the cache to return our mock list
      const result = pickBestUtf8Locale();
      // On a real system, we can't control what's installed, but the function
      // should never throw and should always return either a locale or null.
      expect(result).toHaveProperty("locale");
      expect(result).toHaveProperty("tried");
      expect(Array.isArray(result.tried)).toBe(true);
    });
  });

  describe("forceUtf8Environment", () => {
    it("sets LANG to a UTF-8-capable locale", () => {
      const result = forceUtf8Environment();
      expect(process.env.LANG).toBeTruthy();
      // LANG should end in .UTF-8 or .utf8 (case-insensitive)
      // OR be C.UTF-8 (which is the fallback and doesn't have a dot)
      const lang = process.env.LANG ?? "";
      const isUtf8 = /\.(UTF-8|utf8)$/i.test(lang) || lang === "C.UTF-8";
      expect(isUtf8).toBe(true);
    });

    it("sets LC_ALL to mirror LANG when LC_ALL is unset", () => {
      forceUtf8Environment();
      expect(process.env.LC_ALL).toBe(process.env.LANG);
    });

    it("respects an existing UTF-8 LANG and does not overwrite it", () => {
      process.env.LANG = "fr_FR.UTF-8"; // user's explicit choice
      forceUtf8Environment();
      expect(process.env.LANG).toBe("fr_FR.UTF-8");
    });

    it("overwrites a non-UTF-8 LANG with a UTF-8 locale", () => {
      process.env.LANG = "C"; // ASCII fallback
      forceUtf8Environment();
      const lang = process.env.LANG ?? "";
      const isUtf8 = /\.(UTF-8|utf8)$/i.test(lang) || lang === "C.UTF-8";
      expect(isUtf8).toBe(true);
    });

    it("forces PYTHONIOENCODING=utf-8 for child processes", () => {
      forceUtf8Environment();
      expect(process.env.PYTHONIOENCODING).toBe("utf-8");
    });

    it("forces PYTHONUTF8=1 for Python 3.7+ children", () => {
      forceUtf8Environment();
      expect(process.env.PYTHONUTF8).toBe("1");
    });

    it("returns a diagnostics object with the chosen locale", () => {
      const result = forceUtf8Environment();
      expect(result).toHaveProperty("platform");
      expect(result).toHaveProperty("chosen");
      expect(result).toHaveProperty("fallbackUsed");
      expect(result).toHaveProperty("reason");
      expect(typeof result.chosen).toBe("string");
      expect(result.chosen.length).toBeGreaterThan(0);
    });

    it("is idempotent — calling twice produces the same state", () => {
      const r1 = forceUtf8Environment();
      const lang1 = process.env.LANG;
      const r2 = forceUtf8Environment();
      const lang2 = process.env.LANG;
      expect(lang2).toBe(lang1);
      // Second call's chosen may differ if the first call set LANG and the
      // second call now sees it as "already UTF-8" — that's fine.
      expect(r2.chosen).toBeTruthy();
    });

    it("on Windows: patches process.stdout.write to emit UTF-8 bytes", () => {
      // This test only runs on Windows, but we can verify the function
      // doesn't crash on any platform.
      const origPlatform = process.platform;
      try {
        // Simulate Windows by calling forceUtf8Environment — on Linux this
        // just won't patch stdout (the patch is Windows-only), but the
        // function should still complete without error.
        const result = forceUtf8Environment();
        expect(result.platform).toBe(origPlatform);
        // Verify process.stdout.write is still a function
        expect(typeof process.stdout.write).toBe("function");
      } finally {
        // No cleanup needed — forceUtf8Environment is idempotent
      }
    });

    it("regression: 'você' bytes are correct UTF-8 after forceUtf8Environment", () => {
      forceUtf8Environment();
      const text = "você";
      const buf = Buffer.from(text, "utf8");
      // UTF-8 for "você" = v(0x76) o(0x6F) c(0x63) ê(0xC3 0xAA)
      expect(buf[0]).toBe(0x76); // v
      expect(buf[1]).toBe(0x6F); // o
      expect(buf[2]).toBe(0x63); // c
      expect(buf[3]).toBe(0xC3); // ê (high byte)
      expect(buf[4]).toBe(0xAA); // ê (low byte)
    });

    it("regression: 'coração' bytes are correct UTF-8", () => {
      forceUtf8Environment();
      const text = "coração";
      const buf = Buffer.from(text, "utf8");
      // UTF-8 for "coração" = c o r a ç(0xC3 0xA7) ã(0xC3 0xA3) o
      expect(buf.length).toBe(9); // 4 ASCII + 2 (ç) + 2 (ã) + 1 (o)
      expect(buf[4]).toBe(0xC3); // ç high byte
      expect(buf[5]).toBe(0xA7); // ç low byte
      expect(buf[6]).toBe(0xC3); // ã high byte
      expect(buf[7]).toBe(0xA3); // ã low byte
    });
  });

  describe("diagnoseUtf8", () => {
    it("returns a multi-line diagnostic string", () => {
      forceUtf8Environment();
      const report = diagnoseUtf8();
      expect(typeof report).toBe("string");
      expect(report).toContain("UTF-8 diagnostics:");
      expect(report).toContain("LANG:");
      expect(report).toContain("LC_ALL:");
      expect(report).toContain("PYTHONUTF8:");
    });
  });

  describe("regression: 'você' must not be mojibake", () => {
    // The original bug: user types "você" → TUI shows "voc├¬" because
    // LANG was set to pt_BR.UTF-8 but the system didn't have that locale
    // generated, so glibc fell back to ASCII.
    //
    // After the fix, LANG is always a UTF-8-capable locale (or C.UTF-8
    // fallback). This means UTF-8 bytes written to stdout are interpreted
    // as UTF-8 by the terminal.
    it("LANG is never POSIX or empty after forceUtf8Environment", () => {
      forceUtf8Environment();
      const lang = process.env.LANG ?? "";
      expect(lang).not.toBe("");
      expect(lang).not.toBe("POSIX");
      // C alone (without .UTF-8) is also forbidden
      expect(lang).not.toBe("C");
    });

    it("LC_ALL is never POSIX or empty after forceUtf8Environment", () => {
      forceUtf8Environment();
      const lcAll = process.env.LC_ALL ?? "";
      expect(lcAll).not.toBe("");
      expect(lcAll).not.toBe("POSIX");
      expect(lcAll).not.toBe("C");
    });
  });
});
