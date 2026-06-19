/**
 * toolInstaller-extended.test.ts - Expansão de cobertura de src/toolInstaller.ts.
 *
 * Cobre cenários não cobertos por toolInstaller.test.ts:
 *   - installTool() sucesso para rojo, selene, stylua, lune, wally (fluxo completo)
 *   - installTool() falha quando tool desconhecido (mais um caso)
 *   - installTool() falha quando GitHub API retorna erro (rate limit)
 *   - installTool() falha quando nenhum asset match plataforma
 *   - installTool() falha quando binary não encontrado no archive
 *   - installTool() retorna success=true quando binary existe após install
 *   - canInstall() true para wally-package-types, rokit (tools extras)
 *   - listInstallableTools() inclui todos os tools suportados
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

// Mock logger
vi.mock("./../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  setTuiMode: vi.fn(),
  isTuiMode: vi.fn(() => false),
}));

// Mock toolDetector.detectAndVerify (usado por installTool para verificação final)
const verifyState = vi.hoisted(() => ({
  // Por padrão, detectAndVerify retorna working (após install)
  status: "working" as "working" | "found" | "missing",
  reset() {
    this.status = "working";
  },
}));

vi.mock("./../toolDetector.js", () => ({
  detectAndVerify: vi.fn(async () => ({
    status: verifyState.status,
    binaryPath: verifyState.status === "missing" ? null : "/fake/path",
    version: verifyState.status === "missing" ? null : "1.0.0",
    error: null,
    searchedPaths: [],
    verified: verifyState.status === "working",
  })),
}));

// --- Mock node:https para controlar API + download ---
// Permite simular: API retorna release JSON, ou API falha, ou download falha
const httpsState = vi.hoisted(() => ({
  // Resposta da API do GitHub (release JSON)
  apiStatusCode: 200,
  apiBody: "{}",
  // Conteúdo do download (binary)
  downloadContent: Buffer.from("fake-binary-content"),
  // Se true, simula redirect 302 no download
  downloadRedirectUrl: null as string | null,
  // Se true, simula erro no req (emite "error")
  requestError: null as string | null,
  reset() {
    this.apiStatusCode = 200;
    this.apiBody = "{}";
    this.downloadContent = Buffer.from("fake-binary-content");
    this.downloadRedirectUrl = null;
    this.requestError = null;
  },
  // Configura uma resposta de release com assets
  setRelease(assets: Array<{ name: string; url: string }>, tagName = "v1.0.0") {
    this.apiBody = JSON.stringify({
      tag_name: tagName,
      assets: assets.map((a) => ({
        name: a.name,
        browser_download_url: a.url,
        size: 100,
      })),
    });
  },
}));

vi.mock("node:https", () => ({
  get: vi.fn((url: string, opts: any, cb?: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    const req = new EventEmitter() as any;
    req.on = vi.fn((event: string, handler: any) => {
      // Se há erro programado, emite no próximo tick
      if (event === "error" && httpsState.requestError) {
        setImmediate(() => handler(new Error(httpsState.requestError!)));
      }
      return req;
    });
    req.destroy = vi.fn();

    // API call (api.github.com)
    if (typeof url === "string" && url.includes("api.github.com")) {
      const res = new EventEmitter() as any;
      res.statusCode = httpsState.apiStatusCode;
      setImmediate(() => {
        callback(res);
        if (httpsState.apiStatusCode === 200) {
          res.emit("data", httpsState.apiBody);
          res.emit("end");
        }
      });
      return req;
    }

    // Download call
    const res = new EventEmitter() as any;
    if (httpsState.downloadRedirectUrl) {
      res.statusCode = 302;
      res.headers = { location: httpsState.downloadRedirectUrl };
    } else {
      res.statusCode = 200;
      res.pipe = (writable: any) => {
        // Escreve o conteúdo mockado no stream
        writable.write(httpsState.downloadContent);
        writable.end();
      };
    }
    setImmediate(() => callback(res));
    return req;
  }),
}));

// --- Mock node:child_process execSync ---
// Permite simular: unzip/tar escreve o binary no destDir (sucesso)
// Ou retorna erro (extractArchive falha)
const execState = vi.hoisted(() => ({
  // Se false, execSync throws (extraction falha)
  succeed: true,
  // binary name para escrever no destDir
  binaryName: "rojo",
  reset() {
    this.succeed = true;
    this.binaryName = "rojo";
  },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (!execState.succeed) {
      throw new Error("execSync failed (mocked)");
    }
    // Detecta comandos unzip/tar e escreve binary no destDir
    const dashD = cmd.match(/-d\s+"([^"]+)"/);
    const dashC = cmd.match(/-C\s+"([^"]+)"/);
    const destDir = dashD?.[1] ?? dashC?.[1];
    if (destDir) {
      const binaryPath = path.join(destDir, execState.binaryName);
      fs.writeFileSync(binaryPath, "#!/bin/sh\necho fake binary\n", {
        mode: 0o755,
      });
    }
    return "";
  }),
}));

describe("toolInstaller (extended)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ck-installer-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    httpsState.reset();
    execState.reset();
    verifyState.reset();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // --- installTool: sucesso para cada ferramenta ----------------------------

  describe("installTool - sucesso por tool", () => {
    function setupSuccessfulRelease(toolName: string) {
      const platform =
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux";
      // Asset nomeado com pattern da plataforma
      httpsState.setRelease(
        [{ name: `${toolName}-${platform}-x86_64.zip`, url: `https://example.com/${toolName}.zip` }],
        `v1.2.3`
      );
      execState.binaryName = toolName;
    }

    it("instala rojo com sucesso (GitHub Release + extração)", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("rojo");
      const result = await installTool("rojo");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("rojo");
      expect(result.version).toBe("1.2.3"); // "v1.2.3" -> "1.2.3"
      expect(result.binaryPath).toBeTruthy();
      // Binary deve estar em ~/.claude-killer/bin/rojo
      expect(result.binaryPath).toContain(".claude-killer");
      expect(result.binaryPath).toContain("bin");
      // Arquivo físico deve existir
      expect(fs.existsSync(result.binaryPath!)).toBe(true);
    });

    it("instala selene com sucesso", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("selene");
      const result = await installTool("selene");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("selene");
      expect(result.version).toBe("1.2.3");
    });

    it("instala stylua com sucesso", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("stylua");
      const result = await installTool("stylua");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("stylua");
    });

    it("instala lune com sucesso", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("lune");
      const result = await installTool("lune");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("lune");
    });

    it("instala wally com sucesso", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("wally");
      const result = await installTool("wally");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("wally");
    });

    it("instala rokit com sucesso", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("rokit");
      const result = await installTool("rokit");
      expect(result.success).toBe(true);
      expect(result.toolName).toBe("rokit");
    });

    it("binary existe fisicamente em ~/.claude-killer/bin após install", async () => {
      const { installTool, getInstallDir } = await import("./../toolInstaller.js");
      setupSuccessfulRelease("rojo");
      const result = await installTool("rojo");
      expect(result.success).toBe(true);
      const installDir = getInstallDir();
      const expectedPath = path.join(installDir, "rojo");
      expect(fs.existsSync(expectedPath)).toBe(true);
      // Em Unix, arquivo deve ser executável (chmod 0o755)
      if (process.platform !== "win32") {
        const stat = fs.statSync(expectedPath);
        expect(stat.mode & 0o111).not.toBe(0); // tem pelo menos um bit de exec
      }
    });
  });

  // --- installTool: casos de falha -----------------------------------------

  describe("installTool - casos de falha", () => {
    it("falha quando tool desconhecido (rokit-prefix não suportado)", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      const result = await installTool("rokit-something-weird");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
      expect(result.version).toBeNull();
      expect(result.binaryPath).toBeNull();
    });

    it("falha quando GitHub API retorna 403 (rate limit)", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      httpsState.apiStatusCode = 403;
      const result = await installTool("rojo");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to fetch|network|rate/i);
      expect(result.binaryPath).toBeNull();
    });

    it("falha quando GitHub API request emite erro de rede", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      httpsState.requestError = "ECONNREFUSED";
      const result = await installTool("rojo");
      expect(result.success).toBe(false);
      expect(result.binaryPath).toBeNull();
    });

    it("falha quando release não tem asset compatível com plataforma", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      // Release só com asset .deb (não .zip/.tar.gz)
      httpsState.setRelease([
        { name: "rojo-linux.deb", url: "https://example.com/rojo.deb" },
      ]);
      execState.binaryName = "rojo";
      const result = await installTool("rojo");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No binary found for platform/i);
    });

    it("falha quando binary não é encontrado no archive após extração", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      const platform =
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux";
      httpsState.setRelease([
        { name: `rojo-${platform}-x86_64.zip`, url: "https://example.com/rojo.zip" },
      ]);
      // execSync succeed mas NÃO escreve binary (binaryName diferente)
      execState.binaryName = "completely-different-name";
      const result = await installTool("rojo");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Binary .* not found in archive/i);
    });

    it("falha quando extractArchive (execSync) lança erro", async () => {
      const { installTool } = await import("./../toolInstaller.js");
      const platform =
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux";
      httpsState.setRelease([
        { name: `rojo-${platform}-x86_64.zip`, url: "https://example.com/rojo.zip" },
      ]);
      execState.succeed = false; // unzip/tar falha
      execState.binaryName = "rojo";
      const result = await installTool("rojo");
      expect(result.success).toBe(false);
      // Como unzip e python3 fallback ambos falham, extractArchive retorna null
      expect(result.error).toMatch(/Binary .* not found in archive/i);
    });
  });

  // --- canInstall: tools extras --------------------------------------------

  describe("canInstall - tools extras", () => {
    it("retorna true para wally-package-types", async () => {
      const { canInstall } = await import("./../toolInstaller.js");
      expect(canInstall("wally-package-types")).toBe(true);
    });

    it("retorna true para rokit", async () => {
      const { canInstall } = await import("./../toolInstaller.js");
      expect(canInstall("rokit")).toBe(true);
    });

    it("retorna false para 'cargo', 'rustc' (não auto-instaláveis)", async () => {
      const { canInstall } = await import("./../toolInstaller.js");
      expect(canInstall("cargo")).toBe(false);
      expect(canInstall("rustc")).toBe(false);
      expect(canInstall("python3")).toBe(false);
    });

    it("retorna false para nomes com typo", async () => {
      const { canInstall } = await import("./../toolInstaller.js");
      expect(canInstall("Rojo")).toBe(false); // case-sensitive
      expect(canInstall("SELENE")).toBe(false);
      expect(canInstall("rojo ")).toBe(false); // trailing space
    });
  });

  // --- listInstallableTools -------------------------------------------------

  describe("listInstallableTools - completo", () => {
    it("retorna lista com TODAS as tools suportadas (7+)", async () => {
      const { listInstallableTools } = await import("./../toolInstaller.js");
      const tools = listInstallableTools();
      expect(tools.length).toBeGreaterThanOrEqual(7);
      // Deve incluir todas as tools conhecidas
      expect(tools).toEqual(
        expect.arrayContaining([
          "rojo",
          "selene",
          "stylua",
          "lune",
          "wally",
          "wally-package-types",
          "rokit",
        ])
      );
    });

    it("lista é estável (não muda entre chamadas)", async () => {
      const { listInstallableTools } = await import("./../toolInstaller.js");
      const a = listInstallableTools();
      const b = listInstallableTools();
      expect(a).toEqual(b);
    });
  });

  // --- getToolRepo: tools extras -------------------------------------------

  describe("getToolRepo - tools extras", () => {
    it("retorna repo correto para lune (lune-org/lune)", async () => {
      const { getToolRepo } = await import("./../toolInstaller.js");
      const repo = getToolRepo("lune");
      expect(repo).not.toBeNull();
      expect(repo!.owner).toBe("lune-org");
      expect(repo!.repo).toBe("lune");
    });

    it("retorna repo correto para wally (UpliftGames/wally)", async () => {
      const { getToolRepo } = await import("./../toolInstaller.js");
      const repo = getToolRepo("wally");
      expect(repo).not.toBeNull();
      expect(repo!.owner).toBe("UpliftGames");
      expect(repo!.repo).toBe("wally");
    });

    it("retorna repo correto para wally-package-types", async () => {
      const { getToolRepo } = await import("./../toolInstaller.js");
      const repo = getToolRepo("wally-package-types");
      expect(repo).not.toBeNull();
      expect(repo!.owner).toBe("JohnnyMorganz");
      expect(repo!.repo).toBe("wally-package-types");
    });

    it("retorna repo correto para rokit (rojo-rbx/rokit)", async () => {
      const { getToolRepo } = await import("./../toolInstaller.js");
      const repo = getToolRepo("rokit");
      expect(repo).not.toBeNull();
      expect(repo!.owner).toBe("rojo-rbx");
      expect(repo!.repo).toBe("rokit");
    });
  });
});
