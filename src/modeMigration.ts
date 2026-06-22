/**
 * modeMigration.ts — Migrates old config format to new mode-based structure.
 *
 * Sprint 2: When the claude-killer starts up and detects old config files
 * (hub.json, old-format mode JSONs without "toolsDir"), this module:
 *   1. Creates the new folder structure (~/.claude-killer/modes/<mode>/)
 *   2. Copies config.json from defaults to user's modes dir
 *   3. Backs up old files (.bak)
 *   4. Logs what was migrated
 *
 * This is a ONE-TIME migration — after it runs, the new structure is in place
 * and the old files are backed up but no longer used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

interface MigrationResult {
  migrated: boolean;
  backedUp: string[];
  created: string[];
  errors: string[];
}

/**
 * Check if the user's config is in the old format (needs migration).
 * Old format: has ~/.claude-killer/hub.json but NO ~/.claude-killer/modes/roblox/config.json
 *
 * Sprint B (BUG-A fix): também retorna true se existir legacy `<mode>.json`
 * coexistindo com `<mode>/config.json` (precisa ser removido).
 */
export function needsMigration(): boolean {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const ckDir = path.join(home, ".claude-killer");

  // If no .claude-killer dir, nothing to migrate (fresh install)
  if (!fs.existsSync(ckDir)) return false;

  // Check if new structure already exists.
  // Sprint B: considerar 2 casos de "novo formato já presente":
  //   1. ~/.claude-killer/modes/roblox/config.json (directory format) — novo
  //   2. ~/.claude-killer/modes/roblox.json com toolsDir (flat-file novo) — novo
  // Se qualquer um dos dois existe, NÃO retorna true por essa razão.
  const newConfigPath = path.join(ckDir, "modes", "roblox", "config.json");
  const flatNewConfigPath = path.join(ckDir, "modes", "roblox.json");
  let hasNewFormat = fs.existsSync(newConfigPath);
  if (!hasNewFormat && fs.existsSync(flatNewConfigPath)) {
    try {
      const flatContent = JSON.parse(fs.readFileSync(flatNewConfigPath, "utf8"));
      // Se tem toolsDir, está em formato novo (mesmo sendo flat file)
      if (flatContent.toolsDir) hasNewFormat = true;
    } catch {
      // ignore parse error
    }
  }
  if (!hasNewFormat) return true; // needs new structure

  // Check if old hub.json exists (legacy indicator)
  const hubJsonPath = path.join(ckDir, "hub.json");
  if (fs.existsSync(hubJsonPath)) return true;

  // Sprint B: check for legacy `<mode>.json` files (enableTools sem toolsDir)
  // coexisting with new format. Esses precisam ser removidos pela migration.
  const oldModesDir = path.join(ckDir, "modes");
  if (fs.existsSync(oldModesDir)) {
    try {
      for (const file of fs.readdirSync(oldModesDir)) {
        if (file === "active.json" || !file.endsWith(".json")) continue;
        const filePath = path.join(oldModesDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
          // Old format has "enableTools" but no "toolsDir"
          if (content.enableTools && !content.toolsDir) {
            // Check if new-format dir exists for this mode → legacy needs to be removed
            const modeName = content.name ?? path.basename(file, ".json");
            const newDirPath = path.join(oldModesDir, modeName, "config.json");
            if (fs.existsSync(newDirPath)) {
              return true; // legacy needs removal
            }
            return true; // old format, no new dir yet — needs full migration
          }
        } catch {
          // Can't parse, skip
        }
      }
    } catch {
      // Can't read dir, skip
    }
  }

  return false;
}

/**
 * Run the migration.
 * Creates new folder structure, copies defaults, backs up old files.
 */
export function migrateToModeStructure(): MigrationResult {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const ckDir = path.join(home, ".claude-killer");
  const result: MigrationResult = { migrated: false, backedUp: [], created: [], errors: [] };

  if (!fs.existsSync(ckDir)) {
    result.errors.push("No .claude-killer directory found");
    return result;
  }

  // 1. Back up hub.json if it exists
  const hubJsonPath = path.join(ckDir, "hub.json");
  if (fs.existsSync(hubJsonPath)) {
    const backupPath = path.join(ckDir, "hub.json.bak");
    try {
      fs.copyFileSync(hubJsonPath, backupPath);
      result.backedUp.push("hub.json → hub.json.bak");
      log.info("[MIGRATION] Backed up hub.json");
    } catch (err) {
      result.errors.push(`Failed to back up hub.json: ${(err as Error).message}`);
    }
  }

  // 2. Create mode folder structures from defaults
  const defaultsModesDir = path.join(process.cwd(), "defaults", "modes");
  if (!fs.existsSync(defaultsModesDir)) {
    // Try relative to __dirname (when running from dist/)
    const altPath = path.join(__dirname, "..", "defaults", "modes");
    if (fs.existsSync(altPath)) {
      // use altPath
    } else {
      result.errors.push("Cannot find defaults/modes/ directory");
      return result;
    }
  }

  // Find mode directories (folders with config.json)
  const modesBaseDir = fs.existsSync(defaultsModesDir) ? defaultsModesDir : path.join(__dirname, "..", "defaults", "modes");

  try {
    for (const entry of fs.readdirSync(modesBaseDir)) {
      const entryPath = path.join(modesBaseDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;

      const configPath = path.join(entryPath, "config.json");
      if (!fs.existsSync(configPath)) continue;

      // Create user's mode directory structure
      const userModeDir = path.join(ckDir, "modes", entry);
      const subdirs = ["tools", "manifests", "skills", "hooks", "mcps", "inbox"];

      for (const subdir of subdirs) {
        const dirPath = path.join(userModeDir, subdir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          result.created.push(`modes/${entry}/${subdir}/`);
        }
      }

      // Copy config.json if it doesn't exist
      const userConfigPath = path.join(userModeDir, "config.json");
      if (!fs.existsSync(userConfigPath)) {
        fs.copyFileSync(configPath, userConfigPath);
        result.created.push(`modes/${entry}/config.json`);
      }

      // Copy skills
      const skillsDir = path.join(entryPath, "skills");
      if (fs.existsSync(skillsDir)) {
        const userSkillsDir = path.join(userModeDir, "skills");
        for (const skillFile of fs.readdirSync(skillsDir)) {
          const destPath = path.join(userSkillsDir, skillFile);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(path.join(skillsDir, skillFile), destPath);
          }
        }
      }

      // Copy manifests
      const manifestsDir = path.join(entryPath, "manifests");
      if (fs.existsSync(manifestsDir)) {
        const userManifestsDir = path.join(userModeDir, "manifests");
        for (const manifestFile of fs.readdirSync(manifestsDir)) {
          const destPath = path.join(userManifestsDir, manifestFile);
          if (!fs.existsSync(destPath)) {
            fs.copyFileSync(path.join(manifestsDir, manifestFile), destPath);
          }
        }
      }

      // Copy inbox README
      const inboxReadme = path.join(entryPath, "inbox", "README.md");
      if (fs.existsSync(inboxReadme)) {
        const destReadme = path.join(userModeDir, "inbox", "README.md");
        if (!fs.existsSync(destReadme)) {
          fs.copyFileSync(inboxReadme, destReadme);
        }
      }

      log.info(`[MIGRATION] Created mode structure for: ${entry}`);
    }
  } catch (err) {
    result.errors.push(`Failed to create mode structures: ${(err as Error).message}`);
  }

  // 3. Back up AND REMOVE old mode JSON files (roblox.json, devops.json in modes/)
  // Sprint B (BUG-A fix): não basta fazer backup — `getAllModes()` faz
  // `map.set(name, mode)` onde user modes sobrescrevem built-ins. Se o
  // legacy `<mode>.json` (com enableTools/luauValidation) coexistir com o
  // novo `<mode>/config.json` (com tools/validators), o legacy sempre ganha.
  // Solução: depois de garantir que o novo formato está em `<mode>/config.json`,
  // REMOVER o legacy `<mode>.json` (com backup .bak).
  const userModesDir = path.join(ckDir, "modes");
  if (fs.existsSync(userModesDir)) {
    try {
      for (const file of fs.readdirSync(userModesDir)) {
        if (file.endsWith(".json") && file !== "active.json") {
          const filePath = path.join(userModesDir, file);
          const backupPath = filePath + ".bak";
          try {
            // Only act if it's an old-format file (has enableTools but no toolsDir)
            const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
            if (content.enableTools && !content.toolsDir) {
              const modeName = content.name ?? path.basename(file, ".json");
              const newConfigPath = path.join(userModesDir, modeName, "config.json");
              // Backup sempre (para recovery)
              fs.copyFileSync(filePath, backupPath);
              result.backedUp.push(`${file} → ${file}.bak`);
              log.info(`[MIGRATION] Backed up old ${file}`);
              // Sprint B: SE o novo formato existe em <mode>/config.json,
              // REMOVE o legacy. Caso contrário, deixa (precisamos do legacy
              // até que o novo seja criado em outro passo).
              if (fs.existsSync(newConfigPath)) {
                fs.unlinkSync(filePath);
                result.backedUp.push(`${file} (REMOVED — superseded by ${modeName}/config.json)`);
                log.info(`[MIGRATION] Removed legacy ${file} (superseded by ${modeName}/config.json)`);
              } else {
                log.warn(`[MIGRATION] Kept legacy ${file} (no ${modeName}/config.json yet to replace it)`);
              }
            }
          } catch {
            // Can't parse or not JSON, skip
          }
        }
      }
    } catch {
      // Can't read dir, skip
    }
  }

  result.migrated = result.created.length > 0 || result.backedUp.length > 0;
  return result;
}

/**
 * Run migration if needed (called on startup).
 * Returns true if migration was performed.
 */
export function runMigrationIfNeeded(): boolean {
  if (!needsMigration()) return false;

  log.info("[MIGRATION] Old config format detected. Running migration...");
  const result = migrateToModeStructure();

  if (result.errors.length > 0) {
    log.warn(`[MIGRATION] Completed with ${result.errors.length} errors:`);
    for (const err of result.errors) {
      log.warn(`  - ${err}`);
    }
  }

  if (result.migrated) {
    log.success(
      `[MIGRATION] Migration complete: ${result.created.length} items created, ` +
      `${result.backedUp.length} backed up.`
    );
  }

  return result.migrated;
}
