/**
 * regression-bug-hunter-r4-tools.test.ts — Round 4 deep audit regression tests.
 *
 * Bug fixed:
 *   tools.ts listarBackups — did not validate args before touching args.caminho.
 *   When called with null/undefined args (or a non-string `caminho`), the
 *   function threw TypeError synchronously:
 *     - listarBackups(null)            → TypeError: Cannot read properties of
 *                                        null (reading 'caminho')
 *     - listarBackups(undefined)       → TypeError: Cannot read properties of
 *                                        undefined (reading 'caminho')
 *     - listarBackups({ caminho: 123 }) → TypeError from path.resolve(123)
 *
 *   listarBackups is exported (public surface), imported by agent.ts, and
 *   exercised by tests; if it is ever re-wired as a tool handler (which is
 *   how `desfazer_edicao` already works — also exported from tools.ts), the
 *   IA could trigger the crash by sending `listar_backups` with no args,
 *   aborting the agent loop.
 *
 *   caminho is OPTIONAL in ListarBackupsArgs — the correct behavior is to
 *   treat a missing/invalid caminho as "list ALL backups" (the same as
 *   calling listarBackups({})). This matches the documented contract on
 *   line 416-417 of tools.ts: "Optional: filter by file path. If omitted,
 *   lists all backups."
 *
 * Fix: validate args before reading args.caminho; coerce null/undefined/
 *   non-string/empty-string caminho to undefined (no filter).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// rollbackStore is the only side-effecting dependency of listarBackups.
// Use the REAL implementation against a temp dir so we can pre-populate
// backups and verify that listarBackups actually returns them.
vi.mock("../rollbackStore.js", async () => {
  return await vi.importActual<typeof import("../rollbackStore.js")>("../rollbackStore.js");
});

import { listarBackups } from "../tools.js";
import { saveBackup, clearAllBackups } from "../rollbackStore.js";

describe("Round 4 — listarBackups handles null/undefined/non-string args gracefully", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-r4-listar-"));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Start each test with a clean rollback store.
    clearAllBackups();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    clearAllBackups();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("listarBackups(null) does NOT throw — returns 'No backup available' (no filter)", () => {
    // Before the fix: TypeError on `args.caminho` (null deref).
    expect(() => listarBackups(null as unknown as Parameters<typeof listarBackups>[0])).not.toThrow();
    const result = listarBackups(null as unknown as Parameters<typeof listarBackups>[0]);
    expect(result).toContain("[INFO]");
    expect(result).toContain("No backup available");
  });

  it("listarBackups(undefined) does NOT throw — returns 'No backup available'", () => {
    // Before the fix: TypeError on `args.caminho` (undefined deref).
    expect(() => listarBackups(undefined as unknown as Parameters<typeof listarBackups>[0])).not.toThrow();
    const result = listarBackups(undefined as unknown as Parameters<typeof listarBackups>[0]);
    expect(result).toContain("[INFO]");
    expect(result).toContain("No backup available");
  });

  it("listarBackups({ caminho: 123 }) does NOT throw — non-string caminho treated as no filter", () => {
    // Before the fix: path.resolve(123) threw TypeError synchronously
    // because path.resolve only accepts strings/URLs.
    expect(() => listarBackups({ caminho: 123 as unknown as string })).not.toThrow();
    const result = listarBackups({ caminho: 123 as unknown as string });
    expect(result).toContain("[INFO]");
    expect(result).toContain("No backup available");
  });

  it("listarBackups({ caminho: { obj: true } }) does NOT throw — object caminho treated as no filter", () => {
    expect(() =>
      listarBackups({ caminho: { obj: true } as unknown as string }),
    ).not.toThrow();
    const result = listarBackups({ caminho: { obj: true } as unknown as string });
    expect(result).toContain("[INFO]");
  });

  it("listarBackups({ caminho: '' }) treats empty string as no filter (lists ALL backups)", () => {
    // Pre-populate a backup so we can distinguish "no filter" (returns it)
    // from "filter by ''" (would resolve to cwd and find nothing).
    const filePath = path.join(tmpHome, "some_file.ts");
    fs.writeFileSync(filePath, "v1");
    saveBackup(filePath, "v1", "aplicar_diff");

    const result = listarBackups({ caminho: "" });
    expect(result).toContain("1 backup");
    expect(result).toContain(filePath);
  });

  it("listarBackups({ caminho: '   ' }) — whitespace-only caminho resolves but finds no match", () => {
    // Whitespace is a valid (non-empty) string, so it goes through
    // path.resolve and filters. No backup at that resolved path, so it
    // returns the "No backup available for <path>" message.
    const result = listarBackups({ caminho: "   " });
    expect(result).toContain("[INFO]");
    // The filter is applied (path was resolved), so we get the suffix form.
    expect(result).toMatch(/No backup available for /);
  });

  it("listarBackups(null) lists ALL backups when backups exist (no filter is applied)", () => {
    // This is the critical case: null args must NOT crash, AND must return
    // ALL backups (the caminho is optional, so a missing/null args object
    // is equivalent to "list everything").
    const f1 = path.join(tmpHome, "file1.ts");
    const f2 = path.join(tmpHome, "file2.ts");
    fs.writeFileSync(f1, "v1");
    fs.writeFileSync(f2, "v2");
    saveBackup(f1, "v1", "aplicar_diff");
    saveBackup(f2, "v2", "aplicar_diff");

    const result = listarBackups(null as unknown as Parameters<typeof listarBackups>[0]);
    expect(result).toContain("2 backup");
    expect(result).toContain(f1);
    expect(result).toContain(f2);
  });

  it("listarBackups({ caminho: '/real/file.ts' }) still works (backward compat)", () => {
    const filePath = path.join(tmpHome, "real_file.ts");
    fs.writeFileSync(filePath, "v1");
    saveBackup(filePath, "v1", "aplicar_diff");

    const result = listarBackups({ caminho: filePath });
    expect(result).toContain("1 backup");
    expect(result).toContain(filePath);
  });
});
