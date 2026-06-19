/**
 * streaming-extended.test.ts — Cobertura adicional do módulo streaming.
 *
 * Foca em:
 *   - processStreamChunk (BufferedStreamProcessor): 3 casos novos
 *   - parseSSE (estimateTokenCount / StreamingMetrics): 2 casos novos
 *   - handleUsage (TokenCounter): 2 casos novos
 *   - edge cases: 1 caso
 *
 * Não duplica testes do arquivo streaming.test.ts básico.
 *
 * NOTA: o módulo streaming.ts não expõe funções literais `processStreamChunk`,
 * `parseSSE` ou `handleUsage`. Mapeamos esses conceitos para as APIs existentes:
 *   - processStreamChunk → BufferedStreamProcessor.push/flush
 *   - parseSSE          → estimateTokenCount (cálculo de tokens a partir de texto bruto)
 *   - handleUsage       → TokenCounter.addPrompt/addCompletion/getStats
 */

import { describe, it, expect } from "vitest";
import {
  TokenCounter,
  BufferedStreamProcessor,
  StreamThrottle,
  estimateTokenCount,
  truncateToTokenLimit,
  StreamingMetrics,
} from "../streaming.js";

describe("streaming-extended: processStreamChunk (BufferedStreamProcessor)", () => {
  it("um único push maior que o threshold dispara flush automático", () => {
    const flushed: string[] = [];
    const processor = new BufferedStreamProcessor((chunk) => flushed.push(chunk), 5);
    // Push único com 10 chars: deve disparar flush imediatamente
    processor.push("0123456789");
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toBe("0123456789");
    // Buffer ficou vazio após flush
    expect(processor.forceFlush()).toBe("");
  });

  it("após flush, novos pushes recomeçam o buffer do zero", () => {
    const flushed: string[] = [];
    const processor = new BufferedStreamProcessor((chunk) => flushed.push(chunk), 4);
    processor.push("ab"); // 2 chars
    processor.push("cd"); // 4 chars -> flush
    expect(flushed).toEqual(["abcd"]);

    // Novo push não deve acumular com o anterior
    processor.push("ef");
    expect(flushed).toEqual(["abcd"]); // ainda só 1 flush
    expect(processor.forceFlush()).toBe("ef");
  });

  it("múltiplos flushes preservam a ordem dos chunks enviados ao callback", () => {
    const flushed: string[] = [];
    const processor = new BufferedStreamProcessor((chunk) => flushed.push(chunk), 3);
    processor.push("abc"); // flush 1 -> "abc"
    processor.push("def"); // flush 2 -> "def"
    processor.push("ghi"); // flush 3 -> "ghi"
    processor.flush(); // nada a fazer (buffer vazio)
    expect(flushed).toEqual(["abc", "def", "ghi"]);
  });
});

describe("streaming-extended: parseSSE (estimateTokenCount / StreamingMetrics)", () => {
  it("texto com caracteres CJK (Chinês/Japonês) produz estimativa maior que texto ASCII do mesmo comprimento", () => {
    const ascii = "abcdefghij"; // 10 chars ASCII
    const cjk = "你好世界你好世界"; // 10 chars CJK
    const asciiTokens = estimateTokenCount(ascii);
    const cjkTokens = estimateTokenCount(cjk);
    // CJK usa ~1.5 char/token (≈7 tokens); ASCII usa ~4 char/token (≈3 tokens)
    expect(cjkTokens).toBeGreaterThan(asciiTokens);
  });

  it("StreamingMetrics calcula TTFT corretamente quando start() e onFirstToken() têm intervalo", async () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    await new Promise((r) => setTimeout(r, 20));
    metrics.onFirstToken();
    const ttft = metrics.getTTFT();
    // TTFT deve ser >= 20ms (com tolerância de timer)
    expect(ttft).toBeGreaterThanOrEqual(15);
  });
});

describe("streaming-extended: handleUsage (TokenCounter)", () => {
  it("addPrompt e addCompletion acumulam de forma independente (não se misturam)", () => {
    const counter = new TokenCounter();
    counter.addPrompt(100);
    counter.addPrompt(50);
    counter.addCompletion(200);
    counter.addCompletion(25);
    expect(counter.getPromptTokens()).toBe(150);
    expect(counter.getCompletionTokens()).toBe(225);
    expect(counter.getTotalTokens()).toBe(375);
  });

  it("getStats retorna objeto fresco (snapshot) que não é afetado por mutações externas", () => {
    const counter = new TokenCounter();
    counter.addPrompt(10);
    const stats1 = counter.getStats();
    counter.addPrompt(20);
    const stats2 = counter.getStats();
    // Snapshot 1 deve estar congelado no tempo
    expect(stats1.prompt).toBe(10);
    expect(stats1.total).toBe(10);
    // Snapshot 2 reflete o estado atualizado
    expect(stats2.prompt).toBe(30);
    expect(stats2.total).toBe(30);
  });
});

describe("streaming-extended: edge cases", () => {
  it("truncateToTokenLimit preserva o INÍCIO do texto (não o final) ao truncar", () => {
    const text = "PREFIX_CONTENT_HERE_" + "a".repeat(2000);
    const result = truncateToTokenLimit(text, 10);
    expect(result).toContain("PREFIX_CONTENT_HERE_");
    expect(result).toContain("TRUNCATED");
    // O final original (com 2000 'a's) não deve estar totalmente presente
    expect(result.length).toBeLessThan(text.length);
  });
});
