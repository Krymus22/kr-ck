/**
 * Teste mais robusto do LLM compaction — conversa mais longa.
 */
import dotenv from "dotenv";
dotenv.config();

const { addUserMessage, addRawAssistantMessage, addToolResult, addSystemMessage, getHistory, resetHistory } = await import("../src/history.js");
const { compactHistoryAsync } = await import("../src/history.js");

resetHistory();

// Criar uma conversa MAIS longa para ter mais conteúdo para compactar
addSystemMessage("## TASK_STATE\nProject: Anime Fighters Simulator (Roblox)\nGoal: Sistema de gacha completo\nMode: roblox");

// Turn 1
addUserMessage("Crie um sistema de gacha para meu jogo Anime Fighters no Roblox. Quero raridades: comum, raro, épico, lendário.");

addRawAssistantMessage({
  role: "assistant",
  content: "Vou criar o sistema de gacha. Primeiro, vou ver a estrutura do projeto e o DataStoreService existente.",
  tool_calls: [{ id: "c1", type: "function", function: { name: "ler_arquivo", arguments: JSON.stringify({ path: "src/DataStoreService.lua" }) } }]
});

addToolResult("c1", "DataStoreService.lua existe com Save() e Load() mas SEM pcall. Bug potencial.");

addRawAssistantMessage({
  role: "assistant",
  content: "Encontrei um bug no DataStoreService — não usa pcall. Vou corrigir E criar o GachaService.\n\nDecisões:\n1. WeightedRandom para raridade\n2. Raridades: Comum (60%), Raro (25%), Épico (12%), Lendário (3%)\n3. Adicionar pcall no DataStore\n4. Criar RarityService separado",
  tool_calls: [{ id: "c2", type: "function", function: { name: "editar_arquivo", arguments: JSON.stringify({ path: "src/DataStoreService.lua", old_content: "SetAsync", new_content: "pcall(SetAsync)" }) } }]
});

addToolResult("c2", "DataStoreService corrigido com pcall.");

// Turn 2
addUserMessage("Boa! Agora implementa o sistema de fusão também.");

addRawAssistantMessage({
  role: "assistant",
  content: "Vou implementar o sistema de fusão. Decisão: usar tabela de receitas — 3 fighters iguais = 1 de raridade superior.",
  tool_calls: [{ id: "c3", type: "function", function: { name: "editar_arquivo", arguments: JSON.stringify({ path: "src/FusionService.lua", old_content: "", new_content: "local FusionService = {}\nfunction FusionService:fusion(fighters)\n  -- 3 iguais = 1 superior\nend\nreturn FusionService" }) } }]
});

addToolResult("c3", "FusionService.lua criado.");

addRawAssistantMessage({
  role: "assistant",
  content: "FusionService criado. Próximos passos: UI de invocação, testar gacha, adicionar fighters ao catálogo.",
});

// Turn 3
addUserMessage("Testa o gacha rodando o jogo.");

addRawAssistantMessage({
  role: "assistant",
  content: "Vou rodar os testes do gacha.",
  tool_calls: [{ id: "c4", type: "function", function: { name: "executar_comando", arguments: JSON.stringify({ comando: "lune run tests/gacha.test.lua" }) } }]
});

addToolResult("c4", "[ERROR] Teste falhou: tentativa de indexar nil (global 'RarityService')\nGachaService.lua:45");

addRawAssistantMessage({
  role: "assistant",
  content: "Erro encontrado! GachaService referencia RarityService que não foi criado. Vou criar o RarityService.",
  tool_calls: [{ id: "c5", type: "function", function: { name: "editar_arquivo", arguments: JSON.stringify({ path: "src/RarityService.lua", old_content: "", new_content: "local RarityService = {}\nRarityService.RARITIES = {Common=60, Rare=25, Epic=12, Legendary=3}\nreturn RarityService" }) } }]
});

addToolResult("c5", "RarityService.lua criado.");

addRawAssistantMessage({
  role: "assistant",
  content: "RarityService criado. Bug corrigido. Vou rodar os testes novamente.",
  tool_calls: [{ id: "c6", type: "function", function: { name: "executar_comando", arguments: JSON.stringify({ comando: "lune run tests/gacha.test.lua" }) } }]
});

addToolResult("c6", "Todos os 5 testes passaram!");

addRawAssistantMessage({
  role: "assistant",
  content: "Todos os testes passaram! Resumo do que foi feito:\n1. DataStoreService corrigido (pcall)\n2. GachaService implementado (WeightedRandom)\n3. RarityService criado\n4. FusionService criado\n5. Testes passando\n\nPróximos passos: UI, catálogo de fighters, sistema de inventory.",
});

addUserMessage("Perfeito! O que falta para o sistema estar completo?");

addRawAssistantMessage({
  role: "assistant",
  content: "Falta: UI de invocação, catálogo de fighters, sistema de inventory, animações de gacha, sons. Quer que eu implemente algum?",
});

const beforeTokens = Math.round(getHistory().reduce((s, m) => s + (typeof m.content === "string" ? m.content : "").length, 0) / 4);
console.log(`=== ANTES ===`);
console.log(`Mensagens: ${getHistory().length}, Tokens: ${beforeTokens}`);

console.log(`\n=== Compactando com LLM... ===`);
const result = await compactHistoryAsync("focus on code changes, decisions, and bugs");

console.log(`\n=== RESULTADO ===`);
if (result) {
  console.log(`Metodo: ${result.method}`);
  console.log(`Mensagens removidas: ${result.removed}`);
  console.log(`Tokens: ${result.beforeTokens} -> ${result.afterTokens} (-${result.beforeTokens - result.afterTokens})`);
  console.log(`Economia: ${((1 - result.afterTokens / result.beforeTokens) * 100).toFixed(1)}%`);

  console.log(`\n=== RESUMO GERADO PELA IA ===\n`);
  const compacted = getHistory().find(m =>
    m.role === "system" && typeof m.content === "string" && m.content.includes("CONVERSATION MEMORY")
  );
  if (compacted) {
    console.log(compacted.content);
  }
}

console.log(`\n=== DEPOIS ===`);
console.log(`Mensagens: ${getHistory().length}`);

process.exit(0);
