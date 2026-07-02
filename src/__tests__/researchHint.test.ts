/**
 * researchHint.test.ts — Testes do sistema de research hints
 *
 * Verifica que:
 *   1. Queries sobre produtos/jogos específicos triggeram hint
 *   2. Queries sobre versões/lancamentos triggeram hint
 *   3. Queries sobre notícias recentes triggeram hint
 *   4. Queries de programação básica NÃO triggeram (print, loops)
 *   5. Queries de conceitos atemporais NÃO triggeram (OOP, HTTP)
 *   6. Comandos (escreve, cria) NÃO triggeram
 *   7. Hints são geradas corretamente para cada tipo
 */

import { describe, it, expect } from "vitest";
import { detectResearchTrigger, generateResearchHint } from "../researchHint.js";

describe("researchHint — trigger detection", () => {
  describe("DEVE triggerar (informações que mudam)", () => {
    it("trigga para 'o que é Anime Fighters Simulator'", () => {
      const result = detectResearchTrigger("o que é Anime Fighters Simulator?");
      expect(result).not.toBeNull();
    });

    it("trigga para 'what is the latest version of React'", () => {
      const result = detectResearchTrigger("what is the latest version of React?");
      expect(result).toBe("version_info");
    });

    it("trigga para 'qual a versão atual do Roblox Studio'", () => {
      const result = detectResearchTrigger("qual a versão atual do Roblox Studio?");
      expect(result).toBe("version_info");
    });

    it("trigga para 'what happened in AI this week'", () => {
      const result = detectResearchTrigger("what happened in AI this week?");
      expect(result).toBe("recent_news");
    });

    it("trigga para 'notícias sobre OpenAI'", () => {
      const result = detectResearchTrigger("notícias sobre OpenAI");
      expect(result).toBe("recent_news");
    });

    it("trigga para 'como funciona o jogo Blox Fruits'", () => {
      const result = detectResearchTrigger("como funciona o jogo Blox Fruits?");
      expect(result).toBe("current_state");
    });

    it("trigga para 'what is the current pricing of Claude API'", () => {
      const result = detectResearchTrigger("what is the current pricing of Claude API?");
      expect(result).toBe("current_state");
    });

    it("trigga para 'Anime Fighters' com aspas (entidade específica)", () => {
      const result = detectResearchTrigger('me fale sobre "Anime Fighters"');
      expect(result).not.toBeNull();
    });

    it("trigga para 'X simulator' pattern", () => {
      const result = detectResearchTrigger("Anime Fighters simulator roblox");
      expect(result).not.toBeNull();
    });
  });

  describe("NÃO deve triggerar (trivialidades/comandos)", () => {
    it("não trigga para 'como fazer print em python'", () => {
      const result = detectResearchTrigger("como fazer print em python?");
      expect(result).toBeNull();
    });

    it("não trigga para 'how to write a for loop'", () => {
      const result = detectResearchTrigger("how to write a for loop in JavaScript?");
      expect(result).toBeNull();
    });

    it("não trigga para 'what is object-oriented programming'", () => {
      const result = detectResearchTrigger("what is object-oriented programming?");
      expect(result).toBeNull();
    });

    it("não trigga para 'explique recursão'", () => {
      const result = detectResearchTrigger("explique recursão para mim");
      expect(result).toBeNull();
    });

    it("não trigga para 'o que é HTTP'", () => {
      const result = detectResearchTrigger("o que é HTTP?");
      expect(result).toBeNull();
    });

    it("não trigga para comando 'escreve uma função'", () => {
      const result = detectResearchTrigger("escreve uma função que calcula fibonacci");
      expect(result).toBeNull();
    });

    it("não trigga para comando 'create a file'", () => {
      const result = detectResearchTrigger("create a file called test.lua");
      expect(result).toBeNull();
    });

    it("não trigga para comando 'corrige o bug no arquivo'", () => {
      const result = detectResearchTrigger("corrige o bug no arquivo main.lua");
      expect(result).toBeNull();
    });

    it("não trigga para 'what is a closure'", () => {
      const result = detectResearchTrigger("what is a closure in JavaScript?");
      expect(result).toBeNull();
    });

    it("não trigga para 'explique Big O notation'", () => {
      const result = detectResearchTrigger("explique Big O notation");
      expect(result).toBeNull();
    });

    it("não trigga para query muito curta", () => {
      const result = detectResearchTrigger("oi");
      expect(result).toBeNull();
    });

    it("não trigga para 'how to use async await'", () => {
      const result = detectResearchTrigger("how to use async await in JavaScript?");
      expect(result).toBeNull();
    });
  });

  describe("Casos edge", () => {
    it("não trigga para string vazia", () => {
      const result = detectResearchTrigger("");
      expect(result).toBeNull();
    });

    it("não trigga para só espaços", () => {
      const result = detectResearchTrigger("   ");
      expect(result).toBeNull();
    });

    it("trigga para 'latest npm package version'", () => {
      const result = detectResearchTrigger("what is the latest npm package version of express?");
      expect(result).toBe("version_info");
    });
  });
});

describe("researchHint — hint generation", () => {
  it("gera hint para specific_product", () => {
    const hint = generateResearchHint("specific_product", "Anime Fighters");
    expect(hint).not.toBeNull();
    expect(hint).toContain("RESEARCH HINT");
    expect(hint).toContain("OUTDATED");
    expect(hint).toContain("buscar_web");
  });

  it("gera hint para current_state", () => {
    const hint = generateResearchHint("current_state", "como funciona o jogo X");
    expect(hint).not.toBeNull();
    expect(hint).toContain("CURRENT STATE");
    expect(hint).toContain("cutoff date");
  });

  it("gera hint para version_info", () => {
    const hint = generateResearchHint("version_info", "latest version");
    expect(hint).not.toBeNull();
    expect(hint).toContain("VERSIONS");
    expect(hint).toContain("DEFINITELY outdated");
  });

  it("gera hint para recent_news", () => {
    const hint = generateResearchHint("recent_news", "notícias");
    expect(hint).not.toBeNull();
    expect(hint).toContain("RECENT EVENTS");
    expect(hint).toContain("MUST use buscar_web");
  });

  it("retorna null para trigger null", () => {
    const hint = generateResearchHint(null, "anything");
    expect(hint).toBeNull();
  });
});
