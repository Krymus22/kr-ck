/**
 * inboxOrganizer-extended.test.ts — Edge cases do inboxOrganizer (Sprint 10).
 *
 * Cobre situações que o teste básico não toca:
 *   - organizeInbox com inbox vazio (retorna vazio, não erro)
 *   - organizeInbox com arquivo README.md (ignora)
 *   - organizeInbox com arquivo oculto (.foo) (ignora)
 *   - organizeInbox quando arquivo já existe no destino (não sobrescreve)
 *   - organizeInbox com múltiplos arquivos do mesmo tipo
 *   - organizeInbox com arquivo .js ambíguo (default hook)
 *   - formatOrganizeResult com apenas organized
 *   - formatOrganizeResult com apenas errors
 *   - formatOrganizeResult com tudo vazio
 *   - classifyFile com .JSON (uppercase) → manifest
 *   - classifyFile com .JS (uppercase) → hook
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
  classifyFile,
  organizeInbox,
  formatOrganizeResult,
  listInboxFiles,
  type FileType,
  type OrganizeResult,
} from "../inboxOrganizer.js";

describe("inboxOrganizer — extended (edge cases)", () => {
  let tmpHome: string;
  let tmpInbox: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-inbox-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    tmpInbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
    fs.mkdirSync(tmpInbox, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  function writeInboxFile(name: string, content = ""): string {
    const f = path.join(tmpInbox, name);
    fs.writeFileSync(f, content, "utf8");
    return f;
  }

  // --- organizeInbox edge cases ----------------------------------------------

  it("inbox vazio retorna resultado vazio (não erro)", () => {
    const result = organizeInbox("roblox");
    expect(result.organized).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("ignora README.md no inbox", () => {
    writeInboxFile("README.md", "# inbox");
    const files = listInboxFiles("roblox");
    expect(files).not.toContain("README.md");
  });

  it("ignora arquivos ocultos (.foo)", () => {
    writeInboxFile(".secret", "hidden");
    const files = listInboxFiles("roblox");
    expect(files).not.toContain(".secret");
  });

  it("não sobrescreve arquivo já existente no destino", () => {
    // Pré-cria o arquivo destino
    const skillsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "doc.md"), "ORIGINAL", "utf8");

    // Coloca arquivo de mesmo nome no inbox
    writeInboxFile("doc.md", "NOVO CONTEÚDO");

    organizeInbox("roblox");

    // O destino continua com ORIGINAL (não foi sobrescrito)
    const content = fs.readFileSync(path.join(skillsDir, "doc.md"), "utf8");
    expect(content).toBe("ORIGINAL");
  });

  it("organiza múltiplos arquivos do mesmo tipo (vários .md → skills/)", () => {
    writeInboxFile("a.md", "A");
    writeInboxFile("b.md", "B");
    writeInboxFile("c.md", "C");

    const result = organizeInbox("roblox");
    expect(result.organized.length).toBe(3);
    expect(result.organized.every((o) => o.fileType === "skill")).toBe(true);
    // Todos devem ter sido movidos pra skills/
    const skillsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills");
    expect(fs.existsSync(path.join(skillsDir, "a.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "b.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "c.md"))).toBe(true);
  });

  it("arquivo .js ambíguo (sem module.exports/JSON-RPC) vira hook (default)", () => {
    const f = writeInboxFile("ambiguo.js", "console.log('hello');\n");
    expect(classifyFile(f)).toBe<FileType>("hook");
  });

  // --- formatOrganizeResult --------------------------------------------------

  it("formatOrganizeResult com apenas organized mostra ✓ Organizados", () => {
    const result: OrganizeResult = {
      organized: [{ fileName: "x.md", fileType: "skill", destination: "/skills/x.md" }],
      ignored: [],
      errors: [],
    };
    const text = formatOrganizeResult(result);
    expect(text).toMatch(/✓ Organizados/);
    expect(text).toContain("x.md");
    expect(text).toContain("skills/");
    expect(text).not.toMatch(/⚠ Ignorados/);
    expect(text).not.toMatch(/✗ Erros/);
  });

  it("formatOrganizeResult com apenas errors mostra ✗ Erros", () => {
    const result: OrganizeResult = {
      organized: [],
      ignored: [],
      errors: [{ fileName: "broken", error: "permission denied" }],
    };
    const text = formatOrganizeResult(result);
    expect(text).toMatch(/✗ Erros/);
    expect(text).toContain("broken");
    expect(text).toContain("permission denied");
    expect(text).not.toMatch(/✓ Organizados/);
  });

  it("formatOrganizeResult com tudo vazio mostra mensagem 'Inbox vazio'", () => {
    const result: OrganizeResult = { organized: [], ignored: [], errors: [] };
    const text = formatOrganizeResult(result);
    expect(text).toMatch(/Inbox vazio/);
  });

  // --- classifyFile uppercase ------------------------------------------------

  it("classifyFile com .JSON (uppercase) → manifest", () => {
    const f = writeInboxFile("TOOL.JSON", JSON.stringify({ name: "x", category: "action", command: "x", args: [] }));
    expect(classifyFile(f)).toBe<FileType>("manifest");
  });

  it("classifyFile com .JS (uppercase) → hook (default)", () => {
    const f = writeInboxFile("HOOK.JS", "console.log('hi')\n");
    expect(classifyFile(f)).toBe<FileType>("hook");
  });

  it("classifyFile com .MD (uppercase) → skill", () => {
    const f = writeInboxFile("DOC.MD", "# Title");
    expect(classifyFile(f)).toBe<FileType>("skill");
  });

  it("classifyFile com .ZIP (uppercase) → archive", () => {
    const f = writeInboxFile("BACKUP.ZIP", "fake");
    expect(classifyFile(f)).toBe<FileType>("archive");
  });
});
