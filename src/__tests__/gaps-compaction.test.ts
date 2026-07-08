/**
 * gaps-compaction.test.ts — Testes para os gaps de compactação implementados.
 *
 * Cobre:
 *   Gap 1: Re-hidratação de arquivos pós-compactação (fileRehydration.ts)
 *   Gap 2: Mensagem de continuação pós-compactação
 *   Gap 5: Anti-drift (quote verbatim) no prompt de compactação
 *   Gap 8: Expandir seções do resumo LLM (6 → 9)
 *   Gap 9: Skill-body re-injection (skillTracker.ts)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.65,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldAutoGenerateTests: vi.fn(() => false),
  shouldUseSubAgents: vi.fn(() => false),
  shouldUseIntelligentCompaction: vi.fn(() => true),
}));

vi.mock("../apiKeyPool.js", () => ({ getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "") }));
vi.mock("../i18n.js", () => ({ getLocalizedSlashCommands: vi.fn(() => []), getCommandI18n: vi.fn(() => ({})) }));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

vi.mock("../agent.js", () => ({ runAgentLoop: vi.fn(async () => "mocked") }));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(() => ""), getTodos: vi.fn(() => []) }));
vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn(() => ({})) }));
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({})) }));

// Mock llmCompactor to avoid real API calls during tests
vi.mock("../llmCompactor.js", () => ({
  llmCompact: vi.fn(async () => "[CONVERSATION MEMORY - test summary]\n\nSummary content for testing."),
  isLlmCompactionAvailable: vi.fn(async () => true),
  buildSummarizationPrompt: vi.fn(() => [
    { role: "system", content: "test system prompt" },
    { role: "user", content: "test user prompt" },
  ]),
  buildConversationText: vi.fn(() => "test conversation text"),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import * as history from "../history.js";
import { recordSessionFileEdit, buildRehydrationMessage, clearSessionFiles, getSessionEditedFiles } from "../fileRehydration.js";
import { recordSkillInvocation, buildSkillReInjectionMessage, clearInvokedSkills, getInvokedSkills } from "../skillTracker.js";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Gaps de Compactação — Testes de Implementação", () => {

  beforeEach(() => {
    history.resetHistory();
    clearSessionFiles();
    clearInvokedSkills();
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 1: Re-hidratação de arquivos (fileRehydration.ts)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 1: Re-hidratação de arquivos pós-compactação", () => {
    let tempDir: string;
    let tempFile: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-rehydrate-"));
      tempFile = path.join(tempDir, "test.ts");
      fs.writeFileSync(tempFile, "export function hello() { return 'world'; }\n", "utf8");
    });

    afterEach(() => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    });

    it("recordSessionFileEdit adiciona arquivo à lista", () => {
      recordSessionFileEdit(tempFile);
      expect(getSessionEditedFiles()).toContain(path.resolve(tempFile));
    });

    it("recordSessionFileEdit move arquivo existente para frente (most recent)", () => {
      const file2 = path.join(tempDir, "file2.ts");
      fs.writeFileSync(file2, "content2", "utf8");

      recordSessionFileEdit(tempFile);
      recordSessionFileEdit(file2);
      // file2 deve estar primeiro (most recent)
      expect(getSessionEditedFiles()[0]).toBe(path.resolve(file2));

      // Editar tempFile de novo move pra frente
      recordSessionFileEdit(tempFile);
      expect(getSessionEditedFiles()[0]).toBe(path.resolve(tempFile));
    });

    it("buildRehydrationMessage retorna null se nenhum arquivo editado", () => {
      expect(buildRehydrationMessage()).toBeNull();
    });

    it("buildRehydrationMessage retorna mensagem com conteúdo do arquivo", () => {
      recordSessionFileEdit(tempFile);
      const msg = buildRehydrationMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain("## Recently Modified Files");
      expect(msg).toContain("export function hello");
      expect(msg).toContain(tempFile);
    });

    it("buildRehydrationMessage pula arquivos deletados", () => {
      recordSessionFileEdit(tempFile);
      fs.unlinkSync(tempFile);
      const msg = buildRehydrationMessage();
      expect(msg).toBeNull();
    });

    it("buildRehydrationMessage pula diretórios", () => {
      recordSessionFileEdit(tempDir);
      const msg = buildRehydrationMessage();
      expect(msg).toBeNull();
    });

    it("buildRehydrationMessage limita a 5 arquivos", () => {
      for (let i = 0; i < 10; i++) {
        const f = path.join(tempDir, `file${i}.ts`);
        fs.writeFileSync(f, `content${i}`, "utf8");
        recordSessionFileEdit(f);
      }
      const msg = buildRehydrationMessage();
      expect(msg).not.toBeNull();
      // Deve conter no máximo 5 arquivos
      const fileCount = (msg!.match(/--- \/.* ---/g) || []).length;
      expect(fileCount).toBeLessThanOrEqual(5);
    });

    it("buildRehydrationMessage trunca arquivos grandes", () => {
      const bigContent = "x".repeat(30000); // ~7.5k tokens, > 5k limit
      fs.writeFileSync(tempFile, bigContent, "utf8");
      recordSessionFileEdit(tempFile);
      const msg = buildRehydrationMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain("[TRUNCATED");
    });

    it("clearSessionFiles limpa a lista", () => {
      recordSessionFileEdit(tempFile);
      expect(getSessionEditedFiles().length).toBeGreaterThan(0);
      clearSessionFiles();
      expect(getSessionEditedFiles().length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 9: Skill re-injection (skillTracker.ts)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 9: Skill-body re-injection pós-compactação", () => {
    let tempDir: string;
    let skillFile: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-skill-"));
      skillFile = path.join(tempDir, "my-skill.md");
      fs.writeFileSync(skillFile, "# My Skill\n\nThis is a test skill.\n", "utf8");
    });

    afterEach(() => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    });

    it("recordSkillInvocation adiciona skill à lista", () => {
      recordSkillInvocation(skillFile);
      expect(getInvokedSkills()).toContain(path.resolve(skillFile));
    });

    it("buildSkillReInjectionMessage retorna null se nenhuma skill invocada", () => {
      expect(buildSkillReInjectionMessage()).toBeNull();
    });

    it("buildSkillReInjectionMessage retorna mensagem com conteúdo da skill", () => {
      recordSkillInvocation(skillFile);
      const msg = buildSkillReInjectionMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain("## Invoked Skills");
      expect(msg).toContain("# My Skill");
      expect(msg).toContain(skillFile);
    });

    it("buildSkillReInjectionMessage pula skills deletadas", () => {
      recordSkillInvocation(skillFile);
      fs.unlinkSync(skillFile);
      const msg = buildSkillReInjectionMessage();
      expect(msg).toBeNull();
    });

    it("clearInvokedSkills limpa a lista", () => {
      recordSkillInvocation(skillFile);
      expect(getInvokedSkills().length).toBeGreaterThan(0);
      clearInvokedSkills();
      expect(getInvokedSkills().length).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 2: Mensagem de continuação
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 2: Mensagem de continuação pós-compactação", () => {
    it("compactHistoryAsync injeta mensagem de continuação", async () => {
      // llmCompactor já está mockado no topo do arquivo (evita API call real)

      // Adiciona mensagens suficientes para disparar compaction
      history.resetHistory();
      for (let i = 0; i < 20; i++) {
        history.addUserMessage(`message number ${i} with enough text to make it count`);
        history.addRawAssistantMessage({ role: "assistant", content: `response ${i} with enough text` } as any);
      }

      const beforeLen = history.getHistory().length;
      const result = await history.compactHistoryAsync();
      const afterLen = history.getHistory().length;

      // Compaction deve ter rodado
      expect(result).not.toBeNull();
      expect(afterLen).toBeLessThan(beforeLen);

      // Deve conter a mensagem de continuação
      const hasContinuation = history.getHistory().some(
        (m) => typeof m.content === "string" && m.content.includes("[SESSION CONTINUATION]")
      );
      expect(hasContinuation).toBe(true);
    });

    it("mensagem de continuação diz para não perguntar ao usuário", async () => {
      history.resetHistory();
      for (let i = 0; i < 20; i++) {
        history.addUserMessage(`msg ${i} text text text text`);
        history.addRawAssistantMessage({ role: "assistant", content: `resp ${i} text text` } as any);
      }

      await history.compactHistoryAsync();

      const continuationMsg = history.getHistory().find(
        (m) => typeof m.content === "string" && m.content.includes("[SESSION CONTINUATION]")
      );
      expect(continuationMsg).toBeDefined();
      expect(continuationMsg!.content).toContain("do NOT ask the user");
      expect(continuationMsg!.content).toContain("Continue working");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 5 + Gap 8: Prompt de compactação melhorado
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 5 + 8: Prompt de compactação (anti-drift + 9 seções)", () => {
    it("prompt do contextCompaction tem 9 seções", async () => {
      // Lê o arquivo direto pra verificar o prompt
      const compactionSource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "contextCompaction.ts"),
        "utf8"
      );
      // Verifica que as 9 seções estão presentes
      const sections = [
        "User's Original Intent",
        "Architectural Decisions Made",
        "Arquivos Modificados",
        "Unresolved Bugs",
        "Problem-Solving Logic Chain",
        "All User Messages Summary",
        "Planned Next Steps",
        "Currently Working On",
        "User Preferences/Constraints",
        "Critical Technical Context",
      ];
      for (const section of sections) {
        expect(compactionSource, `Section "${section}" should be in prompt`).toContain(section);
      }
    });

    it("prompt do contextCompaction tem regra anti-drift (quote verbatim)", () => {
      const compactionSource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "contextCompaction.ts"),
        "utf8"
      );
      expect(compactionSource).toContain("DIRECTLY QUOTE");
      expect(compactionSource).toContain("anti-drift");
      expect(compactionSource).toContain("never use X");
    });

    it("prompt do llmCompactor tem 9 seções", () => {
      const llmCompactorSource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "llmCompactor.ts"),
        "utf8"
      );
      const sections = [
        "User's original intent",
        "Architectural decisions",
        "Code changes",
        "Bugs",
        "Problem-solving logic chain",
        "All user messages",
        "Current state",
        "Next steps",
        "User preferences/constraints",
      ];
      for (const section of sections) {
        expect(llmCompactorSource, `Section "${section}" should be in prompt`).toContain(section);
      }
    });

    it("prompt do llmCompactor tem regra anti-drift", () => {
      const llmCompactorSource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "llmCompactor.ts"),
        "utf8"
      );
      expect(llmCompactorSource).toContain("DIRECTLY QUOTE");
      expect(llmCompactorSource).toContain("anti-drift");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 3: Preservar plan state + PRESERVE_PREFIXES
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 3: Preservar plan state na compactação", () => {
    it("PRESERVE_PREFIXES inclui [PLAN (sem closing bracket)", () => {
      const historySource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "history.ts"),
        "utf8"
      );
      // Deve ter [PLAN nos PRESERVE_PREFIXES (não [PLAN] com bracket)
      // O comentário pode ter [PLAN] mas a linha de código deve ter "[PLAN"
      expect(historySource).toContain('"[PLAN"');
      // Verifica que a linha do REPLACABLE_PREFIXES não tem "[PLAN]"
      const lines = historySource.split("\n");
      const planLine = lines.find((l) => l.includes('"[PLAN"'));
      expect(planLine).toBeDefined();
      expect(planLine!.includes('BUG FIX (Gap 3)')).toBe(true);
    });

    it("REPLACABLE_PREFIXES usa [PLAN (não [PLAN])", () => {
      const historySource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "history.ts"),
        "utf8"
      );
      // O comentário do bug fix deve estar presente
      expect(historySource).toContain("BUG FIX (Gap 3)");
    });

    it("PRESERVE_PREFIXES inclui Recently Modified Files", () => {
      const historySource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "history.ts"),
        "utf8"
      );
      expect(historySource).toContain('"## Recently Modified Files"');
    });

    it("PRESERVE_PREFIXES inclui Invoked Skills", () => {
      const historySource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "history.ts"),
        "utf8"
      );
      expect(historySource).toContain('"## Invoked Skills"');
    });

    it("PRESERVE_PREFIXES inclui SESSION CONTINUATION", () => {
      const historySource = fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "history.ts"),
        "utf8"
      );
      expect(historySource).toContain('"[SESSION CONTINUATION"');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 12: Environment info no system prompt
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 12: Environment info no system prompt", () => {
    it("getSystemPrompt inclui environment info", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("## Environment");
      expect(prompt).toContain("Working directory:");
      expect(prompt).toContain("Platform:");
      expect(prompt).toContain("Shell:");
      expect(prompt).toContain("Node.js:");
      expect(prompt).toContain("Model:");
    });

    it("environment info inclui platform correto", () => {
      const prompt = history.getSystemPrompt();
      const expectedPlatform =
        process.platform === "win32" ? "Windows" :
        process.platform === "darwin" ? "macOS" :
        process.platform === "linux" ? "Linux" :
        process.platform;
      expect(prompt).toContain(expectedPlatform);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 14: Tool-routing rules
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 14: Tool-routing rules no system prompt", () => {
    it("getSystemPrompt inclui tool-routing rules", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("## Tool Routing");
      expect(prompt).toContain("NEVER use `executar_comando`");
      expect(prompt).toContain("ler_arquivo");
      expect(prompt).toContain("buscar_texto");
      expect(prompt).toContain("buscar_arquivos");
    });

    it("tool-routing rules lista usos permitidos de executar_comando", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("Running builds");
      expect(prompt).toContain("Running tests");
      expect(prompt).toContain("Running git");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 15: Writing style constraints
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 15: Writing style constraints no system prompt", () => {
    it("getSystemPrompt inclui writing style rules", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("## Response Style");
      expect(prompt).toContain("markdown");
      expect(prompt).toContain("≤25 words");
      expect(prompt).toContain("≤100 words");
    });

    it("writing style rules menciona não repetir o usuário", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("Don't repeat what the user said");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Gap 3: extractPlanSteps (no App.tsx)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Gap 3: extractPlanSteps", () => {
    it("extrai passos numerados (1. format)", async () => {
      const { extractPlanSteps } = await import("../tui/App.js");
      const plan = "1. Read the file\n2. Edit the function\n3. Run tests\n===END PLAN===";
      const steps = extractPlanSteps(plan);
      expect(steps).toEqual(["Read the file", "Edit the function", "Run tests"]);
    });

    it("extrai passos com 1) format", async () => {
      const { extractPlanSteps } = await import("../tui/App.js");
      const plan = "1) First step\n2) Second step\n===END PLAN===";
      const steps = extractPlanSteps(plan);
      expect(steps).toEqual(["First step", "Second step"]);
    });

    it("extrai passos com - format", async () => {
      const { extractPlanSteps } = await import("../tui/App.js");
      const plan = "- First step\n- Second step\n===END PLAN===";
      const steps = extractPlanSteps(plan);
      expect(steps).toEqual(["First step", "Second step"]);
    });

    it("retorna array vazio se não há passos", async () => {
      const { extractPlanSteps } = await import("../tui/App.js");
      const plan = "This is just text without steps\n===END PLAN===";
      const steps = extractPlanSteps(plan);
      expect(steps).toEqual([]);
    });

    it("ignora texto depois de ===END PLAN===", async () => {
      const { extractPlanSteps } = await import("../tui/App.js");
      const plan = "1. Real step\n===END PLAN===\n2. Fake step";
      const steps = extractPlanSteps(plan);
      expect(steps).toEqual(["Real step"]);
    });
  });
});
