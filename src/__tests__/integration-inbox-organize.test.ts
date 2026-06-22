/**
 * integration-inbox-organize.test.ts — E2E inbox → organize → resultado.
 *
 * Testa o fluxo completo do inboxOrganizer:
 *   - Usuário joga arquivos no inbox/ de um modo ativo
 *   - Roda organizeInbox(modeName)
 *   - Sistema classifica (classifyFile) por extensão + conteúdo
 *   - Move para a pasta correta (tools/skills/hooks/manifests)
 *   - Arquivos desconhecidos (.zip, .txt) são ignorados, não movidos
 *   - Inbox vazio retorna resultado vazio sem erro
 *   - organize sem modo ativo retorna erro
 *
 * Filesystem real (HOME temporário). Só logger é mockado.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// --- Imports ----------------------------------------------------------------

import {
  classifyFile,
  organizeInbox,
  type FileType,
  type OrganizeResult,
} from "../inboxOrganizer.js";

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;
let tmpInbox: string;
let tmpModeDir: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-inbox-e2e-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  tmpModeDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
  tmpInbox = path.join(tmpModeDir, "inbox");
  fs.mkdirSync(tmpInbox, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

// --- Helpers ----------------------------------------------------------------

/** Escreve um arquivo no inbox/. Retorna o caminho completo. */
function writeInboxFile(name: string, content: string | Buffer = ""): string {
  const filePath = path.join(tmpInbox, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

// --- Testes E2E -------------------------------------------------------------

describe("E2E: Inbox → Organize", () => {
  it("joga .exe no inbox → organize → move pra tools/", () => {
    writeInboxFile("my-tool.exe", "fake exe content");

    const result: OrganizeResult = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("my-tool.exe");
    expect(result.organized[0].fileType).toBe<FileType>("tool");

    // Arquivo movido pra tools/
    const toolsDir = path.join(tmpModeDir, "tools", "my-tool.exe");
    expect(fs.existsSync(toolsDir)).toBe(true);
    // Não está mais no inbox
    expect(fs.existsSync(path.join(tmpInbox, "my-tool.exe"))).toBe(false);
  });

  it("joga .md no inbox → organize → move pra skills/", () => {
    writeInboxFile("my-skill.md", "# My Skill\n\nSkill content");

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("my-skill.md");
    expect(result.organized[0].fileType).toBe<FileType>("skill");

    // Movido pra skills/
    const skillsPath = path.join(tmpModeDir, "skills", "my-skill.md");
    expect(fs.existsSync(skillsPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpInbox, "my-skill.md"))).toBe(false);
  });

  it("joga .js (hook) no inbox → organize → move pra hooks/", () => {
    // Conteúdo com module.exports + trigger → classificado como hook
    writeInboxFile(
      "auto-build.js",
      "module.exports = { trigger: 'post_build', run: () => {} }",
    );

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("auto-build.js");
    expect(result.organized[0].fileType).toBe<FileType>("hook");

    // Movido pra hooks/
    const hooksPath = path.join(tmpModeDir, "hooks", "auto-build.js");
    expect(fs.existsSync(hooksPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpInbox, "auto-build.js"))).toBe(false);
  });

  it("joga .json (manifest) no inbox → organize → move pra manifests/", () => {
    // .json com category → manifest
    writeInboxFile(
      "darklua.json",
      JSON.stringify({
        name: "darklua_process",
        description: "Process with darklua",
        category: "action",
        command: "darklua",
        args: ["process"],
      }),
    );

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("darklua.json");
    expect(result.organized[0].fileType).toBe<FileType>("manifest");

    // Movido pra manifests/
    const manifestsPath = path.join(tmpModeDir, "manifests", "darklua.json");
    expect(fs.existsSync(manifestsPath)).toBe(true);
    expect(fs.existsSync(path.join(tmpInbox, "darklua.json"))).toBe(false);
  });

  it("joga .zip no inbox → organize → ignora (archive)", () => {
    writeInboxFile("backup.zip", "fake zip bytes");

    const result = organizeInbox("roblox");

    // Arquivo ignorado, não movido
    expect(result.organized.length).toBe(0);
    expect(result.ignored.length).toBe(1);
    expect(result.ignored[0].fileName).toBe("backup.zip");
    expect(result.ignored[0].reason).toMatch(/archive|extract/i);

    // Arquivo continua no inbox (não foi movido)
    expect(fs.existsSync(path.join(tmpInbox, "backup.zip"))).toBe(true);
    // Pasta tools/ não foi criada (nada movido)
    expect(fs.existsSync(path.join(tmpModeDir, "tools"))).toBe(false);
  });

  it("joga .txt no inbox → organize → ignora (docs)", () => {
    writeInboxFile("notes.txt", "algumas anotações");

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(0);
    expect(result.ignored.length).toBe(1);
    expect(result.ignored[0].fileName).toBe("notes.txt");
    expect(result.ignored[0].reason).toMatch(/documentation|docs/i);

    // Arquivo continua no inbox
    expect(fs.existsSync(path.join(tmpInbox, "notes.txt"))).toBe(true);
  });

  it("inbox vazio → organize → retorna vazio sem erro", () => {
    // Inbox existe mas está vazio
    const result = organizeInbox("roblox");

    expect(result.organized).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("organize sem modo ativo → erro", () => {
    // Antes de chamar organize, cria um arquivo no inbox (não deve ser tocado)
    writeInboxFile("rojo.exe", "fake");

    // modeName null → retorna erro
    const result = organizeInbox(null);

    expect(result.organized).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toMatch(/no active mode|sem modo/i);
    // Arquivo não foi movido (continua no inbox)
    expect(fs.existsSync(path.join(tmpInbox, "rojo.exe"))).toBe(true);
  });
});

// --- Sanity check: classifyFile consistency --------------------------------

describe("E2E: Inbox → Organize — classifyFile sanity", () => {
  it("classifyFile classifica corretamente os tipos esperados pelo fluxo", () => {
    // Sanity: garante que as extensões esperadas pelos testes acima
    // produzem os tipos corretos quando classificadas isoladamente.
    const tool = path.join(tmpInbox, "x.exe");
    fs.writeFileSync(tool, "fake");
    expect(classifyFile(tool)).toBe<FileType>("tool");

    const skill = path.join(tmpInbox, "x.md");
    fs.writeFileSync(skill, "# x");
    expect(classifyFile(skill)).toBe<FileType>("skill");

    const hook = path.join(tmpInbox, "x.js");
    fs.writeFileSync(hook, "module.exports = { trigger: 'x', run: () => {} }");
    expect(classifyFile(hook)).toBe<FileType>("hook");

    const manifest = path.join(tmpInbox, "x.json");
    fs.writeFileSync(manifest, JSON.stringify({ name: "x", category: "action" }));
    expect(classifyFile(manifest)).toBe<FileType>("manifest");

    const zip = path.join(tmpInbox, "x.zip");
    fs.writeFileSync(zip, "fake");
    expect(classifyFile(zip)).toBe<FileType>("archive");

    const txt = path.join(tmpInbox, "x.txt");
    fs.writeFileSync(txt, "docs");
    expect(classifyFile(txt)).toBe<FileType>("docs");
  });
});
