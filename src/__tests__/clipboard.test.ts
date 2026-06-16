/**
 * clipboard.test.ts — Tests for clipboard.ts (real module).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
}));

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import { execSync } from "node:child_process";
import { copyToClipboard, pasteFromClipboard, copyFileToClipboard } from "../clipboard.js";

beforeEach(() => {
  vi.mocked(execSync).mockReturnValue("" as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("clipboard.ts (real module)", () => {
  describe("copyToClipboard", () => {
    it("should return true on success (win32)", () => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      expect(copyToClipboard("hello")).toBe(true);
    });

    it("should return true on success (darwin)", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      expect(copyToClipboard("hello")).toBe(true);
    });

    it("should return true on success (linux with xclip)", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      expect(copyToClipboard("hello")).toBe(true);
    });

    it("should fall back to xsel on linux when xclip fails", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error("xclip not found"); })
        .mockReturnValue("" as any);
      expect(copyToClipboard("hello")).toBe(true);
    });

    it("should return false on complete failure", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync).mockImplementation(() => { throw new Error("fail"); });
      expect(copyToClipboard("hello")).toBe(false);
    });
  });

  describe("pasteFromClipboard", () => {
    it("should return text on success (win32)", () => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      vi.mocked(execSync).mockReturnValue("clipboard content" as any);
      expect(pasteFromClipboard()).toBe("clipboard content");
    });

    it("should return text on success (darwin)", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      vi.mocked(execSync).mockReturnValue("clipboard content\n" as any);
      expect(pasteFromClipboard()).toBe("clipboard content");
    });

    it("should return text on success (linux)", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync).mockReturnValue("clipboard content" as any);
      expect(pasteFromClipboard()).toBe("clipboard content");
    });

    it("should fall back to xsel on linux", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error("xclip fail"); })
        .mockReturnValue("from xsel" as any);
      expect(pasteFromClipboard()).toBe("from xsel");
    });

    it("should return null on complete failure", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync).mockImplementation(() => { throw new Error("fail"); });
      expect(pasteFromClipboard()).toBeNull();
    });
  });

  describe("copyFileToClipboard", () => {
    it("should return true on success (win32)", () => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      expect(copyFileToClipboard("file.txt")).toBe(true);
    });

    it("should return true on success (darwin)", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      expect(copyFileToClipboard("file.txt")).toBe(true);
    });

    it("should return true on success (linux)", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      expect(copyFileToClipboard("file.txt")).toBe(true);
    });

    it("should return false on failure", () => {
      vi.stubGlobal("process", { ...process, platform: "linux" });
      vi.mocked(execSync).mockImplementation(() => { throw new Error("fail"); });
      expect(copyFileToClipboard("file.txt")).toBe(false);
    });
  });
});
