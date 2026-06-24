/**
 * promiseDetector.test.ts — tests for the false-promise detector.
 *
 * Bug being fixed: the agent sometimes says "vou investigar mais" and then
 * emits `finish_reason=stop` WITHOUT calling any tool. The agent loop
 * terminates and the user is left staring at a message that promises action
 * but performs none — looking like the agent just "stopped" without
 * explanation.
 *
 * The fix detects this pattern and injects a rejection message forcing the
 * model to either call a tool or explain why it can't act.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  detectFalsePromise,
  buildFalsePromiseRejectionMessage,
  shouldBlockForFalsePromise,
  resetFalsePromiseCounter,
  getFalsePromiseCount,
  MAX_FALSE_PROMISE_RETRIES,
} from "../promiseDetector.js";

describe("promiseDetector", () => {
  beforeEach(() => {
    resetFalsePromiseCounter();
  });

  describe("detectFalsePromise", () => {
    it("detects 'vou investigar' (Portuguese)", () => {
      const result = detectFalsePromise("Achei algo concreto. Vou investigar mais.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("vou investigar");
    });

    it("detects 'vou verificar' (Portuguese)", () => {
      const result = detectFalsePromise("Vou verificar isso para you.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("vou verificar");
    });

    it("detects 'deixa eu ver' (Portuguese)", () => {
      const result = detectFalsePromise("Deixa eu ver o que tem aqui.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("deixa eu ver");
    });

    it("detects 'I'll check' (English)", () => {
      const result = detectFalsePromise("I'll check that for you.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("i'll check");
    });

    it("detects 'let me look' (English)", () => {
      const result = detectFalsePromise("Let me look into this.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("let me look");
    });

    it("does NOT flag if a tool was called this turn", () => {
      const result = detectFalsePromise("Vou investigar mais.", 1, 0);
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("actions were taken");
    });

    it("does NOT flag if a file was touched this turn", () => {
      const result = detectFalsePromise("Vou investigar mais.", 0, 1);
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("actions were taken");
    });

    it("does NOT flag a normal factual response", () => {
      const result = detectFalsePromise("O arquivo tem 42 linhas e usa TypeScript.", 0, 0);
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("no promise phrase detected");
    });

    it("does NOT flag a refusal (explicit 'cannot do')", () => {
      const result = detectFalsePromise(
        "Infelizmente não consigo acessar esse arquivo porque ele não existe.",
        0, 0
      );
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("refusal phrase");
    });

    it("does NOT flag an English refusal", () => {
      const result = detectFalsePromise(
        "I can't run that command because the binary is not installed.",
        0, 0
      );
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("refusal phrase");
    });

    it("does NOT flag an empty message", () => {
      const result = detectFalsePromise("", 0, 0);
      expect(result.detected).toBe(false);
      expect(result.reason).toContain("empty message");
    });

    it("is case-insensitive", () => {
      const result = detectFalsePromise("VOU INVESTIGAR MAIS.", 0, 0);
      expect(result.detected).toBe(true);
      expect(result.matchedPhrase).toBe("vou investigar");
    });

    it("detects 'aguarde enquanto' (wait while)", () => {
      const result = detectFalsePromise("Aguarde enquanto verifico isso.", 0, 0);
      expect(result.detected).toBe(true);
    });
  });

  describe("buildFalsePromiseRejectionMessage", () => {
    it("produces a non-empty rejection message", () => {
      const msg = buildFalsePromiseRejectionMessage("vou investigar", 1);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(100);
    });

    it("includes the matched phrase", () => {
      const msg = buildFalsePromiseRejectionMessage("vou investigar", 1);
      expect(msg).toContain("vou investigar");
    });

    it("includes a list of tool suggestions", () => {
      const msg = buildFalsePromiseRejectionMessage("i'll check", 1);
      expect(msg).toContain("ler_arquivo");
      expect(msg).toContain("buscar_texto");
      expect(msg).toContain("explorar_subagente");
      expect(msg).toContain("executar_comando");
    });

    it("includes the attempt number on retry", () => {
      const msg = buildFalsePromiseRejectionMessage("vou verificar", 2);
      expect(msg).toContain("attempt 2");
    });

    it("does NOT include attempt suffix on first try", () => {
      const msg = buildFalsePromiseRejectionMessage("vou verificar", 1);
      expect(msg).not.toContain("tentativa 1");
    });
  });

  describe("shouldBlockForFalsePromise", () => {
    it("blocks on first false promise", () => {
      const result = shouldBlockForFalsePromise("Vou investigar mais.", 0, 0);
      expect(result.block).toBe(true);
      expect(result.rejectionMessage).toBeTruthy();
      expect(result.rejectionMessage).toContain("FALSE_PROMISE_DETECTED");
      expect(getFalsePromiseCount()).toBe(1);
    });

    it("blocks on second false promise (retry)", () => {
      shouldBlockForFalsePromise("Vou investigar mais.", 0, 0);
      const result = shouldBlockForFalsePromise("Vou verificar isso.", 0, 0);
      expect(result.block).toBe(true);
      expect(getFalsePromiseCount()).toBe(2);
    });

    it("does NOT block after MAX_FALSE_PROMISE_RETRIES (lets turn finish)", () => {
      // First two attempts block
      shouldBlockForFalsePromise("Vou investigar.", 0, 0);
      shouldBlockForFalsePromise("Vou verificar.", 0, 0);
      // Third attempt should not block
      const result = shouldBlockForFalsePromise("Vou olhar.", 0, 0);
      expect(result.block).toBe(false);
      expect(result.reason).toContain("max false-promise retries");
    });

    it("does not increment counter when no false promise is detected", () => {
      shouldBlockForFalsePromise("O arquivo tem 42 linhas.", 0, 0);
      expect(getFalsePromiseCount()).toBe(0);
    });

    it("does not block if a tool was called", () => {
      const result = shouldBlockForFalsePromise("Vou investigar mais.", 1, 0);
      expect(result.block).toBe(false);
      expect(getFalsePromiseCount()).toBe(0);
    });
  });

  describe("resetFalsePromiseCounter", () => {
    it("resets the counter to 0", () => {
      shouldBlockForFalsePromise("Vou investigar.", 0, 0);
      shouldBlockForFalsePromise("Vou verificar.", 0, 0);
      expect(getFalsePromiseCount()).toBe(2);

      resetFalsePromiseCounter();
      expect(getFalsePromiseCount()).toBe(0);

      // After reset, the next false promise is treated as attempt 1
      const result = shouldBlockForFalsePromise("Vou olhar.", 0, 0);
      expect(result.block).toBe(true);
    });
  });

  describe("MAX_FALSE_PROMISE_RETRIES", () => {
    it("is set to a reasonable value (2-3)", () => {
      expect(MAX_FALSE_PROMISE_RETRIES).toBeGreaterThanOrEqual(2);
      expect(MAX_FALSE_PROMISE_RETRIES).toBeLessThanOrEqual(3);
    });
  });

  describe("regression: agent must not silently stop after 'vou investigar'", () => {
    // The original bug: agent says "vou investigar" and stop_reason fires
    // without any tool call. The loop terminates silently.
    //
    // After the fix: the false-promise detector intercepts the stop, injects
    // a rejection message, and forces the agent to recurse — which gives it
    // another chance to actually call a tool.
    it("forces a recursion when agent promises without acting", () => {
      // Simulate the exact scenario from the bug report:
      //   Claude-Killer: "Achei algo concreto. ... Vou investigar mais."
      //   (no tool calls, no files touched)
      const agentMessage = "Achei algo concreto. O aftman está instalado, e o shim de rojo.exe existe mas exige declaração em aftman.toml. Vou investigar mais.";
      const result = shouldBlockForFalsePromise(agentMessage, 0, 0);

      expect(result.block).toBe(true);
      expect(result.rejectionMessage).toContain("FALSE_PROMISE_DETECTED");
      expect(result.rejectionMessage).toContain("ler_arquivo");
      expect(result.rejectionMessage).toContain("buscar_texto");
    });

    it("does not infinite-loop: eventually lets the turn finish after retries", () => {
      // Simulate 4 consecutive false promises
      const msg = "Vou investigar mais.";
      const results = [
        shouldBlockForFalsePromise(msg, 0, 0),
        shouldBlockForFalsePromise(msg, 0, 0),
        shouldBlockForFalsePromise(msg, 0, 0),
        shouldBlockForFalsePromise(msg, 0, 0),
      ];
      // First 2 should block (MAX_FALSE_PROMISE_RETRIES = 2)
      expect(results[0].block).toBe(true);
      expect(results[1].block).toBe(true);
      // 3rd and 4th should NOT block (let turn finish)
      expect(results[2].block).toBe(false);
      expect(results[3].block).toBe(false);
    });
  });
});
