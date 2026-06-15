/**
 * imagePaste.ts — Image paste support: paste images from clipboard or files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export interface PastedImage {
  data: Buffer;
  format: "png" | "jpg" | "jpeg" | "gif" | "bmp" | "unknown";
  width?: number;
  height?: number;
}

export function pasteImageFromClipboard(): PastedImage | null {
  try {
    if (process.platform === "win32") {
      // Windows: PowerShell to get clipboard image
      const script = `
        Add-Type -AssemblyName System.Windows.Forms
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        if ($img -ne $null) {
          $ms = New-Object System.IO.MemoryStream
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $bytes = $ms.ToArray()
          [Convert]::ToBase64String($bytes)
        }
      `;
      const result = execSync(`powershell -Command "${script.replaceAll("\n", " ")}"`, {
        encoding: "utf8",
        timeout: 5000,
      }).trim();

      if (!result) return null;

      const data = Buffer.from(result, "base64");
      return { data, format: "png" };
    } else if (process.platform === "darwin") {
      // macOS: Use osascript to get clipboard image
      const tmpFile = path.join("/tmp", `paste_${Date.now()}.png`);
      try {
        execSync(`osascript -e 'set pngData to the clipboard as «class PNGf»' -e 'set fp to open for access (POSIX file "${tmpFile}") with write permission' -e 'write pngData to fp' -e 'close access fp'`, {
          timeout: 5000,
        });
        const data = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        return { data, format: "png" };
      } catch {
        return null;
      }
    } else {
      // Linux: xclip
      try {
        const result = execSync("xclip -selection clipboard -t image/png -o", {
          encoding: "binary",
          timeout: 5000,
        });
        return { data: Buffer.from(result, "binary"), format: "png" };
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

export function loadImageFromFile(filePath: string): PastedImage | null {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;

    const ext = path.extname(resolved).toLowerCase();
    const formatMap: Record<string, PastedImage["format"]> = {
      ".png": "png", ".jpg": "jpg", ".jpeg": "jpeg",
      ".gif": "gif", ".bmp": "bmp",
    };

    const data = fs.readFileSync(resolved);
    return {
      data,
      format: formatMap[ext] ?? "unknown",
    };
  } catch {
    return null;
  }
}

export function imageToBase64(image: PastedImage): string {
  return `data:image/${image.format};base64,${image.data.toString("base64")}`;
}

export function saveImageToFile(image: PastedImage, filePath: string): boolean {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, image.data);
    return true;
  } catch {
    return false;
  }
}
