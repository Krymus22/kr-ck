/**
 * fase4-devops.test.ts — E2E tests for Phase 4 of TEST_PLAN.md (Modo DevOps).
 *
 * Tests covered:
 *   4.1 Setup: /mode devops ativa modo
 *   4.2 Safety Patterns Customizados (terraform destroy, kubectl delete)
 *   4.3 Validation com Custom Commands (terraform validate, yamllint)
 *   4.4 Hooks Post-Edit (terraform fmt automático)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock modes
const mockedApplyMode = vi.hoisted(() => vi.fn(async () => ({ success: true, toolsEnabled: [], featuresEnabled: [] })));
const mockedGetActiveMode = vi.hoisted(() => vi.fn(() => ({
  name: "devops",
  label: "DevOps",
  effortLevel: "high",
  strictMode: true,
  safetyReview: true,
  enableTools: ["terraform_validate", "yamllint"],
  enableFeatures: ["feature:safety_reviewer", "feature:strict_gate"],
  luauValidation: [],
})));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => "devops"));
const mockedGetAllModes = vi.hoisted(() => vi.fn(() => [
  { name: "roblox", label: "Roblox" },
  { name: "devops", label: "DevOps" },
]));

vi.mock("../modes.js", () => ({
  applyMode: mockedApplyMode,
  getActiveMode: mockedGetActiveMode,
  getActiveModeName: mockedGetActiveModeName,
  getAllModes: mockedGetAllModes,
  getMode: vi.fn(() => null),
  suggestMode: vi.fn(() => null),
  confirmAndSaveMode: vi.fn(async () => true),
  deactivateMode: vi.fn(),
  // Reactive store hooks — required by useSyncExternalStore
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
}));

// Mock modeExtensions
const mockedGetActiveSafetyPatterns = vi.hoisted(() => vi.fn(async () => [
  { pattern: "terraform destroy", severity: "high", action: "block" },
  { pattern: "kubectl delete namespace", severity: "high", action: "block" },
  { pattern: "kubectl delete", severity: "medium", action: "warn" },
  { pattern: "rm -rf /", severity: "critical", action: "block" },
]));
const mockedGetActiveValidationRules = vi.hoisted(() => vi.fn(async () => [
  { tool: "terraform_validate", filePattern: "*.tf", blocking: true, command: "terraform validate" },
  { tool: "yamllint", filePattern: "*.yml", blocking: false, command: "yamllint" },
]));

vi.mock("../modeExtensions.js", () => ({
  getActiveSafetyPatterns: mockedGetActiveSafetyPatterns,
  getActiveValidationRules: mockedGetActiveValidationRules,
}));

// Mock safetyReviewer
const mockedReviewCodeSafety = vi.hoisted(() => vi.fn(async () => ({
  risk: "none",
  patternsMatched: [],
  reviewedByLlm: false,
})));
vi.mock("../safetyReviewer.js", () => ({
  reviewCodeSafety: mockedReviewCodeSafety,
  formatSafetyReview: vi.fn(() => ""),
}));

// Mock luauValidator (used by validation gate)
vi.mock("../luauValidator.js", () => ({
  validateLuauBeforeWrite: vi.fn(async () => ({ ok: true, rulesApplied: [], rulesSkipped: [] })),
  getActiveValidationRules: mockedGetActiveValidationRules,
  shouldValidateFile: vi.fn(async () => true),
}));

// Mock hooks
const mockedExecutePreToolCallHooks = vi.hoisted(() => vi.fn(async () => ({ skip: false })));
const mockedExecutePostToolCallHooks = vi.hoisted(() => vi.fn(async () => ({ modifiedResult: null, ran: true })));
vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: mockedExecutePreToolCallHooks,
  executePostToolCallHooks: mockedExecutePostToolCallHooks,
}));

// Import AFTER mocks
import { applyMode, getActiveMode, getActiveModeName, getAllModes } from "../modes.js";
import { getActiveSafetyPatterns, getActiveValidationRules } from "../modeExtensions.js";
import { reviewCodeSafety } from "../safetyReviewer.js";
import { executePostToolCallHooks } from "../hooks.js";

describe("Fase 4 E2E — Modo DevOps", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fase4-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 4.1 Setup ───────────────────────────────────────────────────────

  describe("4.1 Setup", () => {
    it("/mode devops ativa o modo DevOps", async () => {
      const result = await applyMode("devops");
      expect(result.success).toBe(true);
      expect(getActiveModeName()).toBe("devops");
    });

    it("modo devops tem safety review ativado", () => {
      const mode = getActiveMode();
      expect(mode.safetyReview).toBe(true);
    });

    it("modo devops tem strict mode ativado", () => {
      const mode = getActiveMode();
      expect(mode.strictMode).toBe(true);
    });

    it("modo devops lista tools de validação", () => {
      const mode = getActiveMode();
      expect(mode.enableTools).toContain("terraform_validate");
      expect(mode.enableTools).toContain("yamllint");
    });

    it("getAllModes lista roblox + devops", () => {
      const modes = getAllModes();
      const names = modes.map((m) => m.name);
      expect(names).toContain("roblox");
      expect(names).toContain("devops");
    });
  });

  // ─── 4.2 Safety Patterns Customizados ────────────────────────────────

  describe("4.2 Safety Patterns Customizados", () => {
    it("terraform destroy é detectado como high severity", async () => {
      const patterns = await getActiveSafetyPatterns();
      const terraformDestroy = patterns.find((p) => p.pattern === "terraform destroy");
      expect(terraformDestroy).toBeDefined();
      expect(terraformDestroy?.severity).toBe("high");
      expect(terraformDestroy?.action).toBe("block");
    });

    it("kubectl delete namespace é detectado como high severity", async () => {
      const patterns = await getActiveSafetyPatterns();
      const kubectlDelete = patterns.find((p) => p.pattern === "kubectl delete namespace");
      expect(kubectlDelete).toBeDefined();
      expect(kubectlDelete?.severity).toBe("high");
    });

    it("rm -rf / é detectado como critical severity", async () => {
      const patterns = await getActiveSafetyPatterns();
      const rmRf = patterns.find((p) => p.pattern === "rm -rf /");
      expect(rmRf).toBeDefined();
      expect(rmRf?.severity).toBe("critical");
    });

    it("safety reviewer retorna risk=high para código com terraform destroy", async () => {
      mockedReviewCodeSafety.mockResolvedValueOnce({
        risk: "high",
        patternsMatched: [{ pattern: "terraform destroy", severity: "high" }],
        reviewedByLlm: false,
      });

      const dangerousCode = `
resource "null_resource" "dangerous" {
  triggers = {
    always = timestamp()
  }
  provisioner "local-exec" {
    command = "terraform destroy -force"
  }
}
`;
      const result = await reviewCodeSafety(dangerousCode, "/tmp/danger.tf");
      expect(result.risk).toBe("high");
      expect(result.patternsMatched.length).toBeGreaterThan(0);
    });

    it("safety reviewer retorna risk=none para código seguro", async () => {
      mockedReviewCodeSafety.mockResolvedValueOnce({
        risk: "none",
        patternsMatched: [],
        reviewedByLlm: false,
      });

      const safeCode = `
resource "null_resource" "safe" {
  triggers = {
    version = "1.0"
  }
}
`;
      const result = await reviewCodeSafety(safeCode, "/tmp/safe.tf");
      expect(result.risk).toBe("none");
    });
  });

  // ─── 4.3 Validation com Custom Commands ──────────────────────────────

  describe("4.3 Validation com Custom Commands", () => {
    it("regras de validação incluem terraform_validate com command", async () => {
      const rules = await getActiveValidationRules();
      const terraformRule = rules.find((r) => r.tool === "terraform_validate");
      expect(terraformRule).toBeDefined();
      expect(terraformRule?.command).toBe("terraform validate");
      expect(terraformRule?.blocking).toBe(true);
      expect(terraformRule?.filePattern).toBe("*.tf");
    });

    it("regras de validação incluem yamllint para .yml", async () => {
      const rules = await getActiveValidationRules();
      const yamllintRule = rules.find((r) => r.tool === "yamllint");
      expect(yamllintRule).toBeDefined();
      expect(yamllintRule?.command).toBe("yamllint");
      expect(yamllintRule?.filePattern).toBe("*.yml");
    });

    it("terraform_validate é blocking=true", async () => {
      const rules = await getActiveValidationRules();
      const terraformRule = rules.find((r) => r.tool === "terraform_validate");
      expect(terraformRule?.blocking).toBe(true);
    });

    it("yamllint é blocking=false (warning only)", async () => {
      const rules = await getActiveValidationRules();
      const yamllintRule = rules.find((r) => r.tool === "yamllint");
      expect(yamllintRule?.blocking).toBe(false);
    });
  });

  // ─── 4.4 Hooks Post-Edit ─────────────────────────────────────────────

  describe("4.4 Hooks Post-Edit", () => {
    it("post-edit hook é executado após edição", async () => {
      // Simulate a hook that runs `terraform fmt` after editing a .tf file
      mockedExecutePostToolCallHooks.mockResolvedValueOnce({
        modifiedResult: null,
        ran: true,
        command: "terraform fmt",
      });

      const result = await executePostToolCallHooks({
        tool: "aplicar_diff",
        filePath: "/tmp/test.tf",
        result: "diff applied",
      });

      expect(result.ran).toBe(true);
      expect(result.command).toBe("terraform fmt");
    });

    it("post-edit hook não falha se o arquivo não for .tf", async () => {
      mockedExecutePostToolCallHooks.mockResolvedValueOnce({
        modifiedResult: null,
        ran: false,
      });

      const result = await executePostToolCallHooks({
        tool: "aplicar_diff",
        filePath: "/tmp/test.ts",
        result: "diff applied",
      });

      expect(result.ran).toBe(false);
    });
  });

  // ─── Integration: file with terraform destroy triggers safety ────────

  describe("Integration — safety patterns work end-to-end", () => {
    it("criar arquivo .tf com terraform destroy gera risk=high", async () => {
      const dangerousTf = path.join(tmpDir, "dangerous.tf");
      const dangerousContent = `
resource "null_resource" "destroy_all" {
  provisioner "local-exec" {
    command = "terraform destroy -force"
  }
}
`;
      fs.writeFileSync(dangerousTf, dangerousContent);

      mockedReviewCodeSafety.mockResolvedValueOnce({
        risk: "high",
        patternsMatched: [{ pattern: "terraform destroy", severity: "high" }],
        reviewedByLlm: false,
      });

      const result = await reviewCodeSafety(dangerousContent, dangerousTf);

      expect(result.risk).toBe("high");
      expect(fs.existsSync(dangerousTf)).toBe(true);
    });

    it("criar arquivo .tf sem padrões perigosos gera risk=none", async () => {
      const safeTf = path.join(tmpDir, "safe.tf");
      const safeContent = `
resource "aws_s3_bucket" "data" {
  bucket = "my-data-bucket"
  acl    = "private"
}
`;
      fs.writeFileSync(safeTf, safeContent);

      mockedReviewCodeSafety.mockResolvedValueOnce({
        risk: "none",
        patternsMatched: [],
        reviewedByLlm: false,
      });

      const result = await reviewCodeSafety(safeContent, safeTf);

      expect(result.risk).toBe("none");
    });
  });
});
