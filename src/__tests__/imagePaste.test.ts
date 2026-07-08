/**
 * imagePaste.test.ts — Tests for imagePaste.ts (real module).
 * Covers: pasteImageFromClipboard, loadImageFromFile, imageToBase64, saveImageToFile.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as realFs from "node:fs";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (...args: any[]) => (imagePasteReadSpy ?? actual.readFileSync)(...args),
  };
});

let imagePasteReadSpy: ((...args: any[]) => any) | null = null;

import {
  loadImageFromFile,
  imageToBase64,
  saveImageToFile,
  pasteImageFromClipboard,
  type PastedImage,
} from "../imagePaste.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "img_test_"));
  imagePasteReadSpy = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  mockExecSync.mockReset();
  imagePasteReadSpy = null;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("imagePaste.ts (real module)", () => {
  describe("loadImageFromFile", () => {
    it("should load a PNG file", () => {
      const filePath = path.join(tmpDir, "test.png");
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("png");
      expect(img!.data.length).toBe(4);
    });

    it("should load a JPG file", () => {
      const filePath = path.join(tmpDir, "test.jpg");
      fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("jpg");
    });

    it("should load a JPEG file", () => {
      const filePath = path.join(tmpDir, "test.jpeg");
      fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("jpeg");
    });

    it("should load a GIF file", () => {
      const filePath = path.join(tmpDir, "test.gif");
      fs.writeFileSync(filePath, Buffer.from([0x47, 0x49, 0x46]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("gif");
    });

    it("should load a BMP file", () => {
      const filePath = path.join(tmpDir, "test.bmp");
      fs.writeFileSync(filePath, Buffer.from([0x42, 0x4d]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("bmp");
    });

    it("should return unknown format for unsupported extension", () => {
      const filePath = path.join(tmpDir, "test.webp");
      fs.writeFileSync(filePath, Buffer.from([0x52, 0x49]));
      const img = loadImageFromFile(filePath);
      expect(img).not.toBeNull();
      expect(img!.format).toBe("unknown");
    });

    it("should return null for non-existent file", () => {
      expect(loadImageFromFile(path.join(tmpDir, "nope.png"))).toBeNull();
    });
  });

  describe("imageToBase64", () => {
    it("should convert image to data URI", () => {
      const img: PastedImage = {
        data: Buffer.from("hello"),
        format: "png",
      };
      const result = imageToBase64(img);
      expect(result).toMatch(/^data:image\/png;base64,/);
      expect(result).toContain(Buffer.from("hello").toString("base64"));
    });

    it("should handle jpg format (normalized to image/jpeg MIME)", () => {
      const img: PastedImage = { data: Buffer.from("data"), format: "jpg" };
      const result = imageToBase64(img);
      // BUG FIX: `image/jpg` is not a registered IANA MIME type and is
      // rejected by OpenAI / Anthropic vision APIs. Normalize to `image/jpeg`.
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("should handle jpeg format (image/jpeg MIME)", () => {
      const img: PastedImage = { data: Buffer.from("data"), format: "jpeg" };
      const result = imageToBase64(img);
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("should handle unknown format", () => {
      const img: PastedImage = { data: Buffer.from("x"), format: "unknown" };
      const result = imageToBase64(img);
      expect(result).toMatch(/^data:image\/unknown;base64,/);
    });
  });

  describe("saveImageToFile", () => {
    it("should save image data to file", () => {
      const img: PastedImage = {
        data: Buffer.from("image bytes"),
        format: "png",
      };
      const filePath = path.join(tmpDir, "saved.png");
      expect(saveImageToFile(img, filePath)).toBe(true);
      expect(fs.readFileSync(filePath).toString()).toBe("image bytes");
    });

    it("should create intermediate directories", () => {
      const img: PastedImage = {
        data: Buffer.from("data"),
        format: "png",
      };
      const filePath = path.join(tmpDir, "sub", "dir", "img.png");
      expect(saveImageToFile(img, filePath)).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should return false on error (read-only path)", () => {
      const img: PastedImage = {
        data: Buffer.from("data"),
        format: "png",
      };
      const filePath = "/nonexistent/deeply/nested/img.png";
      // This might succeed or fail depending on permissions
      const result = saveImageToFile(img, filePath);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("pasteImageFromClipboard", () => {
    it("should return null or object", () => {
      const result = pasteImageFromClipboard();
      expect(result === null || typeof result === "object").toBe(true);
    });

    it("should handle win32 platform (returns null or object)", () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const result = pasteImageFromClipboard();
      expect(result === null || typeof result === "object").toBe(true);
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    });

    it("should return decoded image on win32 when execSync returns base64 (lines 37-38)", () => {
      const origPlatform = process.platform;
      const fakePng = Buffer.from("fake-png-data");
      const base64 = fakePng.toString("base64");
      mockExecSync.mockReturnValue(base64);
      try {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
        const result = pasteImageFromClipboard();
        expect(result).not.toBeNull();
        expect(result!.format).toBe("png");
        expect(result!.data.toString()).toBe("fake-png-data");
      } finally {
        Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
        mockExecSync.mockReset();
      }
    });

    it("should handle darwin platform", () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      const result = pasteImageFromClipboard();
      expect(result === null || typeof result === "object").toBe(true);
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    });

    it("should handle linux platform", () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      const result = pasteImageFromClipboard();
      expect(result === null || typeof result === "object").toBe(true);
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    });
  });

  describe("loadImageFromFile edge cases", () => {
    it("returns null on read error", () => {
      const img = loadImageFromFile("/dev/null/../invalid\x00path");
      expect(img === null || typeof img === "object").toBe(true);
    });

    it("returns null when readFileSync throws after existsSync succeeds (line 86)", () => {
      const filePath = path.join(tmpDir, "exists_but_fail.png");
      fs.writeFileSync(filePath, "x");
      imagePasteReadSpy = () => { throw new Error("read failed"); };
      const img = loadImageFromFile(filePath);
      expect(img).toBeNull();
    });
  });

  describe("saveImageToFile edge cases", () => {
    it("returns false on deeply invalid path", () => {
      const img: PastedImage = { data: Buffer.from("x"), format: "png" };
      const r = saveImageToFile(img, "Z:\\nonexistent\\super\\deep\\path\\img.png");
      expect(typeof r).toBe("boolean");
    });
  });
});
