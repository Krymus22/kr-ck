/**
 * configSeeder.ts - First-run seeding of bundled defaults into the user's home directory.
 *
 * Bundled defaults live under `defaults/` in the package root (next to dist/).
 * On first run (or when the seed marker file is missing), this module copies:
 *
 *   defaults/tools/*.json -> ~/.claude-killer/tools/*.json   (CLI tool definitions)
 *   defaults/skills/*.md  -> ~/.claude-killer/skills/*.md     (skill / library docs)
 *
 * After seeding, the user can freely edit, add, or delete any file in
 * ~/.claude-killer/ without touching the package code. The seed marker file
 * (~/.claude-killer/.seeded-v1) prevents re-seeding on subsequent runs.
 *
 * To force a re-seed: delete ~/.claude-killer/.seeded-v1
 * To reset everything: delete ~/.claude-killer/ entirely
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as log from "./logger.js";

const SEED_VERSION = "v3";
const SEED_MARKER = `.seeded-${SEED_VERSION}`;

/** Resolve the bundled defaults directory. Works both in dev (src/) and prod (dist/). */
function findDefaultsDir(): string | null {
  // In ESM, `import.meta.url` points to the current module file.
  // From dist/configSeeder.js, defaults are at ../../defaults/
  // From src/configSeeder.ts (dev), defaults are at ../../defaults/
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "defaults"),       // dist/ -> ../defaults
    path.join(here, "..", "..", "defaults"), // src/ -> ../../defaults (when run via ts-node)
    path.join(process.cwd(), "defaults"),    // last resort: cwd
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) {
      return c;
    }
  }
  return null;
}

function getUserConfigDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
    ".claude-killer"
  );
}

function copyDirRecursive(src: string, dest: string): number {
  let copied = 0;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      // Don't overwrite existing user customizations
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        copied++;
      } else {
        log.debug(`Seed: skipping existing file ${destPath}`);
      }
    }
  }
  return copied;
}

/**
 * Seed bundled defaults into the user's home config directory.
 *
 * Idempotent: only runs once per SEED_VERSION. To re-seed, delete the marker file.
 *
 * @returns the number of files copied (0 if already seeded or no defaults found)
 */
export function seedUserConfig(): number {
  const userDir = getUserConfigDir();
  const marker = path.join(userDir, SEED_MARKER);

  // Already seeded for this version
  if (fs.existsSync(marker)) {
    return 0;
  }

  const defaultsDir = findDefaultsDir();
  if (!defaultsDir) {
    log.debug("Seed: no defaults/ directory found, skipping");
    return 0;
  }

  // Make sure user config dir exists
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  let totalCopied = 0;

  // Seed tools/ subdir
  const defaultToolsDir = path.join(defaultsDir, "tools");
  if (fs.existsSync(defaultToolsDir)) {
    const userToolsDir = path.join(userDir, "tools");
    totalCopied += copyDirRecursive(defaultToolsDir, userToolsDir);
  }

  // Seed skills/ subdir
  const defaultSkillsDir = path.join(defaultsDir, "skills");
  if (fs.existsSync(defaultSkillsDir)) {
    const userSkillsDir = path.join(userDir, "skills");
    totalCopied += copyDirRecursive(defaultSkillsDir, userSkillsDir);
  }

  // Seed modes/ subdir (NEW in v2)
  const defaultModesDir = path.join(defaultsDir, "modes");
  if (fs.existsSync(defaultModesDir)) {
    const userModesDir = path.join(userDir, "modes");
    totalCopied += copyDirRecursive(defaultModesDir, userModesDir);
  }

  // Write the seed marker so we don't re-seed next time
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify(
        {
          version: SEED_VERSION,
          seededAt: new Date().toISOString(),
          source: defaultsDir,
          filesCopied: totalCopied,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (err) {
    log.warn(`Seed: failed to write marker file: ${(err as Error).message}`);
  }

  if (totalCopied > 0) {
    log.info(
      `Seed: copied ${totalCopied} default files to ${userDir} (version ${SEED_VERSION})`
    );
  }
  return totalCopied;
}

/** Force a re-seed on the next startup by deleting the marker file. */
export function forceReseedOnNextRun(): void {
  const userDir = getUserConfigDir();
  const marker = path.join(userDir, SEED_MARKER);
  try {
    if (fs.existsSync(marker)) {
      fs.unlinkSync(marker);
      log.info("Seed: marker removed, will re-seed on next run");
    }
  } catch (err) {
    log.warn(`Seed: failed to remove marker: ${(err as Error).message}`);
  }
}

/** For testing: returns whether the seed marker exists. */
export function isSeeded(): boolean {
  return fs.existsSync(path.join(getUserConfigDir(), SEED_MARKER));
}
