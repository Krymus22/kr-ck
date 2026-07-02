/**
 * Teste real do LLM-based compaction.
 * Cria uma conversa simulada e compacta usando a IA.
 */

// Carregar .env
import dotenv from "dotenv";
dotenv.config();

import { compactHistoryAsync } from "../src/history.js";

// Primeiro, vamos popular o histórico com uma conversa real
const { addUserMessage, addRawAssistantMessage, addToolResult, addSystemMessage, getHistory, resetHistory } = await import("../src/history.js");

// Reset para garantir estado limpo
resetHistory();

// Simular uma conversa sobre desenvolvimento Roblox
addSystemMessage("## TASK_STATE\nProject: Anime Fighters Simulator (Roblox)\nGoal: Implementar sistema de gacha com raridade\nMode: roblox");

addUserMessage("Crie um sistema de gacha para meu jogo Anime Fighters no Roblox. Quero que os fighters tenham raridades diferentes (comum, raro, épico, lendário).");

addRawAssistantMessage({
  role: "assistant",
  content: "Vou criar um sistema de gacha completo para o Anime Fighters. Primeiro, deixe-me explorar a estrutura do projeto para entender como organizar o código.",
  tool_calls: [{
    id: "call_1",
    type: "function",
    function: {
      name: "buscar_arquivos",
      arguments: JSON.stringify({ pattern: "**/*.lua" })
    }
  }]
});

addToolResult("call_1", "Encontrados 15 arquivos .lua:\n- src/main.lua\n- src/DataStoreService.lua\n- src/PlayerService.lua\n- src/GachaService.lua (existe mas vazio)");

addRawAssistantMessage({
  role: "assistant",
  content: "Encontrei o GachaService.lua que já existe mas está vazio. Vou ler o DataStoreService para entender como salvar dados dos jogadores, depois implementar o gacha.",
  tool_calls: [{
    id: "call_2",
    type: "function",
    function: {
      name: "ler_arquivo",
      arguments: JSON.stringify({ path: "src/DataStoreService.lua" })
    }
  }]
});

addToolResult("call_2", "src/DataStoreService.lua:\nlocal DataStoreService = {}\nlocal DataStoreService = game:GetService('DataStoreService')\n\nfunction DataStoreService:Save(playerId, data)\n  local store = DataStoreService:GetDataStore('PlayerData')\n  store:SetAsync(tostring(playerId), data)\nend\n\nfunction DataStoreService:Load(playerId)\n  local store = DataStoreService:GetDataStore('PlayerData')\n  return store:GetAsync(tostring(playerId))\nend");

addRawAssistantMessage({
  role: "assistant",
  content: "Notei que o DataStoreService não usa pcall (tratamento de erro). Isso é um bug — se o DataStore falhar, o jogo quebra. Vou corrigir isso enquanto implemento o gacha.\n\nDecisões:\n1. Vou usar WeightedRandom para o sistema de raridade\n2. Raridades: Comum (60%), Raro (25%), Épico (12%), Lendário (3%)\n3. Vou adicionar pcall no DataStoreService\n4. Vou criar um RarityService separado para reutilização",
  tool_calls: [{
    id: "call_3",
    type: "function",
    function: {
      name: "editar_arquivo",
      arguments: JSON.stringify({ path: "src/DataStoreService.lua", old_content: "store:SetAsync(tostring(playerId), data)", new_content: "local success, err = pcall(function()\\n  store:SetAsync(tostring(playerId), data)\\nend)\\nif not success then warn('DataStore save failed: ' .. tostring(err)) end" })
    }
  }]
});

addToolResult("call_3", "Arquivo src/DataStoreService.lua editado com sucesso. pcall adicionado.");

addRawAssistantMessage({
  role: "assistant",
  content: "Agora vou criar o GachaService com o sistema de raridade. Vou usar um módulo WeightedRandom para as probabilidades.",
  tool_calls: [{
    id: "call_4",
    type: "function",
    function: {
      name: "editar_arquivo",
      arguments: JSON.stringify({ path: "src/GachaService.lua", old_content: "", new_content: "local GachaService = {}\\n\\nlocal RARITIES = {\\n  Common = { weight = 60, multiplier = 1 },\\n  Rare = { weight = 25, multiplier = 1.5 },\\n  Epic = { weight = 12, multiplier = 2 },\\n  Legendary = { weight = 3, multiplier = 3 }\\n}\\n\\nfunction GachaService:roll()\\n  local totalWeight = 0\\n  for _, rarity in pairs(RARITIES) do\\n    totalWeight += rarity.weight\\n  end\\n  local roll = math.random(1, totalWeight)\\n  local current = 0\\n  for name, rarity in pairs(RARITIES) do\\n    current += rarity.weight\\n    if roll <= current then\\n      return name, rarity.multiplier\\n    end\\n  end\\n  return 'Common', 1\\nend\\n\\nreturn GachaService" })
    }
  }]
});

addToolResult("call_4", "Arquivo src/GachaService.lua criado com sucesso. Sistema de gacha implementado.");

addRawAssistantMessage({
  role: "assistant",
  content: "Sistema de gacha implementado! Resumo do que foi feito:\n\n1. **DataStoreService corrigido**: adicionei pcall para tratamento de erro no SetAsync\n2. **GachaService criado**: sistema de gacha com 4 raridades (Common 60%, Rare 25%, Epic 12%, Legendary 3%)\n3. **WeightedRandom**: implementação manual de rolagem ponderada\n\nPróximos passos recomendados:\n- Criar UI de invocação\n- Implementar sistema de fusão (combinar fighters iguais)\n- Adicionar DatabaseService para catalogar fighters disponíveis\n- Testar o gacha com jogadores reais",
});

addUserMessage("Perfeito! Agora me ajude a testar o gacha.");

// Agora vamos ver o tamanho do histórico antes da compactação
const beforeTokens = getHistory().reduce((sum, m) => {
  const c = typeof m.content === "string" ? m.content : "";
  return sum + c.length;
}, 0) / 4;

console.log(`=== Histórico antes da compactação ===`);
console.log(`Mensagens: ${getHistory().length}`);
console.log(`Tokens estimados: ${Math.round(beforeTokens)}`);
console.log("");

// Agora compactar usando LLM
console.log(`=== Compactando com LLM... ===`);
const result = await compactHistoryAsync("focus on code changes and decisions");

console.log(`\n=== Resultado ===`);
if (result) {
  console.log(`Método: ${result.method}`);
  console.log(`Mensagens removidas: ${result.removed}`);
  console.log(`Tokens: ${result.beforeTokens} -> ${result.afterTokens} (-${result.beforeTokens - result.afterTokens})`);
  console.log(`Economia: ${((1 - result.afterTokens / result.beforeTokens) * 100).toFixed(1)}%`);

  // Mostrar o resumo gerado
  console.log(`\n=== Resumo gerado pela IA ===`);
  const compactedMsg = getHistory().find(m =>
    m.role === "system" && typeof m.content === "string" && m.content.includes("CONVERSATION MEMORY")
  );
  if (compactedMsg) {
    console.log(compactedMsg.content);
  } else {
    console.log("(resumo não encontrado no histórico)");
  }
} else {
  console.log("Compactação falhou ou não havia nada para compactar");
}

process.exit(0);
