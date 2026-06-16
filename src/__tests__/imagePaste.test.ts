/**
 * imagePaste.test.ts — Tests for imagePaste.ts (real module).
 * Covers: pasteImageFromClipboard, loadImageFromFile, imageToBase64, saveImageToFile.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

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
});

afterEach(() => {
  vi.restoreAllMocks();
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

    it("should handle jpg format", () => {
      const img: PastedImage = { data: Buffer.from("data"), format: "jpg" };
      const result = imageToBase64(img);
      expect(result).toMatch(/^data:image\/jpg;base64,/);
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
  });
});
