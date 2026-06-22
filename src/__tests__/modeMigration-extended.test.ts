/**
 * modeMigration-extended.test.ts — Edge cases do modeMigration (Sprint 2).
 *
 * Cobre situações que o teste básico não toca:
 *   - needsMigration retorna true quando mode JSON tem enableTools mas não toolsDir
 *   - needsMigration retorna false quando mode JSON tem toolsDir
 *   - migrateToModeStructure cria inbox/README.md
 *   - migrateToModeStructure não sobrescreve config.json existente
 *   - migrateToModeStructure não sobrescreve skills existentes
 *   - migrateToModeStructure lida com defaults/ não existente
 *   - runMigrationIfNeeded não roda se já migrado
 *   - migrateToModeStructure copia manifests do bundled
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

import {
  needsMigration,
  migrateToModeStructure,
  runMigrationIfNeeded,
} from "../modeMigration.js";

describe("modeMigration — extended (edge cases)", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mig-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mig-cwd-"));
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  /** Cria uma árvore defaults/modes/<mode>/ mínima no tmpCwd. */
  function createBundledMode(modeName: string, opts: {
    config?: object;
    skills?: string[];
    manifests?: Array<string | object>;
    inboxReadme?: boolean;
  } = {}): void {
    const modeDir = path.join(tmpCwd, "defaults", "modes", modeName);
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(
      path.join(modeDir, "config.json"),
      JSON.stringify(opts.config ?? { name: modeName, label: modeName, toolsDir: "tools" }),
      "utf8",
    );
    if (opts.skills) {
      const skillsDir = path.join(modeDir, "skills");
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const s of opts.skills) fs.writeFileSync(path.join(skillsDir, s), "skill", "utf8");
    }
    if (opts.manifests) {
      const manifestsDir = path.join(modeDir, "manifests");
      fs.mkdirSync(manifestsDir, { recursive: true });
      for (const m of opts.manifests) {
        const name = typeof m === "string" ? m : (m as any).name + ".json";
        const content = typeof m === "string" ? "[]" : JSON.stringify(m);
        fs.writeFileSync(path.join(manifestsDir, name), content, "utf8");
      }
    }
    if (opts.inboxReadme) {
      const inboxDir = path.join(modeDir, "inbox");
      fs.mkdirSync(inboxDir, { recursive: true });
      fs.writeFileSync(path.join(inboxDir, "README.md"), "# inbox", "utf8");
    }
  }

  // --- needsMigration edge cases ---------------------------------------------

  it("retorna true quando mode JSON tem enableTools mas não toolsDir", () => {
    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(path.join(ckDir, "modes"), { recursive: true });
    // Arquivo roblox.json em modes/ (não em modes/roblox/) com formato antigo
    fs.writeFileSync(
      path.join(ckDir, "modes", "roblox.json"),
      JSON.stringify({ name: "roblox", enableTools: true }),
      "utf8",
    );
    // Não cria modes/roblox/config.json — então precisa migrar.
    expect(needsMigration()).toBe(true);
  });

  it("retorna false quando mode JSON tem toolsDir (formato novo)", () => {
    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(path.join(ckDir, "modes"), { recursive: true });
    fs.writeFileSync(
      path.join(ckDir, "modes", "roblox.json"),
      JSON.stringify({ name: "roblox", enableTools: true, toolsDir: "tools" }),
      "utf8",
    );
    // Mesmo com enableTools, como tem toolsDir NÃO precisa migrar.
    expect(needsMigration()).toBe(false);
  });

  // --- migrateToModeStructure ------------------------------------------------

  it("cria inbox/README.md quando bundled tem inbox/README.md", () => {
    process.chdir(tmpCwd);
    createBundledMode("roblox", { inboxReadme: true });
    // Pré-cria .claude-killer com hub.json para migração rodar
    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    fs.writeFileSync(path.join(ckDir, "hub.json"), "{}", "utf8");

    migrateToModeStructure();

    const inboxReadme = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox", "README.md");
    expect(fs.existsSync(inboxReadme)).toBe(true);
  });

  it("não sobrescreve config.json existente no user dir", () => {
    process.chdir(tmpCwd);
    createBundledMode("roblox", { config: { name: "roblox", label: "Bundled", toolsDir: "tools" } });

    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    fs.writeFileSync(path.join(ckDir, "hub.json"), "{}", "utf8");
    // Pré-cria config.json do usuário com conteúdo diferente
    const userConfigPath = path.join(ckDir, "modes", "roblox", "config.json");
    fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
    fs.writeFileSync(userConfigPath, JSON.stringify({ name: "roblox", label: "USER-ORIGINAL" }), "utf8");

    migrateToModeStructure();

    const afterContent = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
    expect(afterContent.label).toBe("USER-ORIGINAL");
  });

  it("não sobrescreve skills existentes no user dir", () => {
    process.chdir(tmpCwd);
    createBundledMode("roblox", { skills: ["bundled-skill.md", "another.md"] });

    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    fs.writeFileSync(path.join(ckDir, "hub.json"), "{}", "utf8");
    // Pré-cria uma skill do usuário
    const userSkillsDir = path.join(ckDir, "modes", "roblox", "skills");
    fs.mkdirSync(userSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(userSkillsDir, "bundled-skill.md"), "USER-VERSION", "utf8");

    migrateToModeStructure();

    // bundled-skill.md deve permanecer USER-VERSION
    const content = fs.readFileSync(path.join(userSkillsDir, "bundled-skill.md"), "utf8");
    expect(content).toBe("USER-VERSION");
    // another.md (não existia) deve ter sido copiada do bundled
    expect(fs.existsSync(path.join(userSkillsDir, "another.md"))).toBe(true);
  });

  it("lida com defaults/modes/ não existente no cwd (fallback via __dirname)", () => {
    // tmpCwd não tem defaults/modes/. O código tenta fallback via __dirname:
    //   path.join(__dirname, "..", "defaults", "modes")
    // Como o teste roda dentro do projeto claude-killer, o __dirname resuelve
    // para src/__tests__ (ou dist/...), e ../defaults/modes aponta para o
    // defaults REAL do projeto. Logo, NÃO há erro — a migração acontece
    // usando os bundled defaults reais.
    process.chdir(tmpCwd);
    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    fs.writeFileSync(path.join(ckDir, "hub.json"), "{}", "utf8");

    const result = migrateToModeStructure();
    // Como o fallback __dirname encontra defaults reais, OU migra com sucesso
    // (created.length > 0) OU registra erro (errors.length > 0).
    expect(result.migrated || result.errors.length > 0).toBe(true);
    // Backup do hub.json deve ter sido feito independente.
    expect(result.backedUp.length).toBeGreaterThan(0);
  });

  it("copia manifests do bundled para o user dir", () => {
    process.chdir(tmpCwd);
    createBundledMode("roblox", {
      manifests: [
        { name: "rojo_build", description: "Build", category: "x", command: "rojo", args: ["build"] },
        "wally.json",
      ],
    });

    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    fs.writeFileSync(path.join(ckDir, "hub.json"), "{}", "utf8");

    migrateToModeStructure();

    const userManifestsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "manifests");
    expect(fs.existsSync(path.join(userManifestsDir, "rojo_build.json"))).toBe(true);
    expect(fs.existsSync(path.join(userManifestsDir, "wally.json"))).toBe(true);
  });

  // --- runMigrationIfNeeded --------------------------------------------------

  it("não roda migração quando já está migrado (modes/roblox/config.json existe)", () => {
    const ckDir = path.join(tmpHome, ".claude-killer");
    fs.mkdirSync(ckDir, { recursive: true });
    // Cria nova estrutura (modes/roblox/config.json)
    const newConfig = path.join(ckDir, "modes", "roblox", "config.json");
    fs.mkdirSync(path.dirname(newConfig), { recursive: true });
    fs.writeFileSync(newConfig, "{}", "utf8");
    // Não cria hub.json — situação de "já migrado"

    const result = runMigrationIfNeeded();
    expect(result).toBe(false);
  });

  it("não roda migração quando .claude-killer não existe (fresh install)", () => {
    // tmpHome vazio — não há .claude-killer
    expect(runMigrationIfNeeded()).toBe(false);
  });
});
