/**
 * ConfiguratorChat.tsx — Mini chat para configuração de tools
 *
 * Sprint 11: Interface de chat dedicada pra configurador.
 * Mostra mensagens do configurador + permite input do usuário.
 * Aberto via tecla 'C' no Hub ou comando /configurar.
 */

import React, { useState, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { colors } from "./theme.js";
import { configureTool, detectToolsWithoutManifest, type ConfiguratorResult } from "../toolConfigurator.js";
import { getActiveMode } from "../modes.js";

interface ConfiguratorChatProps {
  onClose: () => void;
  onMessage?: (msg: string) => void;
  /** Tool name to configure (if specific). If null, shows tools without manifest. */
  toolName?: string | null;
}

interface ChatMessage {
  role: "configurator" | "user" | "system";
  content: string;
}

export function ConfiguratorChat({ onClose, onMessage, toolName }: Readonly<ConfiguratorChatProps>) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const scrollRef = useRef(0);

  const mode = getActiveMode();
  const modeName = mode?.name ?? null;

  useInput((inputChar, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (running) return; // don't accept input while running

    if (key.return && input.trim()) {
      const userMsg = input.trim();
      setInput("");

      // Handle user input
      if (userMsg.toLowerCase() === "sair" || userMsg.toLowerCase() === "exit") {
        onClose();
        return;
      }

      // If user typed a tool name, configure it
      setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
      setRunning(true);

      configureTool(userMsg, modeName, undefined, (msg) => {
        setMessages((prev) => [...prev, { role: msg.includes("[Tool:") ? "system" : "configurator", content: msg }]);
      })
        .then((result: ConfiguratorResult) => {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: result.message },
          ]);
          setRunning(false);
          setFinished(true);
          onMessage?.(result.message);
        })
        .catch((err) => {
          setMessages((prev) => [
            ...prev,
            { role: "system", content: `Erro: ${(err as Error).message}` },
          ]);
          setRunning(false);
        });
      return;
    }

    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }

    if (inputChar && !key.ctrl && !key.meta && inputChar !== "") {
      setInput((prev) => prev + inputChar);
      return;
    }
  });

  // Auto-start if toolName was provided
  React.useEffect(() => {
    if (toolName && !running && messages.length === 0) {
      setMessages([{ role: "system", content: `Configurando "${toolName}"...` }]);
      setRunning(true);
      configureTool(toolName, modeName, undefined, (msg) => {
        setMessages((prev) => [...prev, { role: msg.includes("[Tool:") ? "system" : "configurator", content: msg }]);
      })
        .then((result) => {
          setMessages((prev) => [...prev, { role: "system", content: result.message }]);
          setRunning(false);
          setFinished(true);
          onMessage?.(result.message);
        })
        .catch((err) => {
          setMessages((prev) => [...prev, { role: "system", content: `Erro: ${(err as Error).message}` }]);
          setRunning(false);
        });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Show tools without manifest on first render
  React.useEffect(() => {
    if (!toolName && messages.length === 0) {
      const toolsWithoutManifest = detectToolsWithoutManifest(modeName);
      if (toolsWithoutManifest.length > 0) {
        setMessages([{
          role: "system",
          content: `Tools sem manifest encontradas:\n${toolsWithoutManifest.map((t) => `  - ${t}`).join("\n")}\n\nDigite o nome de uma tool para configurar, ou "sair" para fechar.`,
        }]);
      } else {
        setMessages([{
          role: "system",
          content: `Nenhuma tool sem manifest encontrada no modo "${modeName ?? "nenhum"}".\nDigite o nome de uma tool para configurar, ou "sair" para fechar.`,
        }]);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.secondary} paddingX={1} marginY={1}>
      {/* Header */}
      <Box justifyContent="center" marginBottom={0}>
        <Text color={colors.secondary} bold>
          {" "}🔧 Configurador de Tools {modeName ? `(${modeName})` : ""}
        </Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" marginBottom={1}>
        {messages.slice(-10).map((msg, i) => (
          <Box key={`cfg-${i}`}>
            <Text color={
              msg.role === "configurator" ? colors.primary :
              msg.role === "user" ? colors.success :
              colors.muted
            } wrap="truncate">
              {" "}{msg.role === "configurator" ? "🤖" : msg.role === "user" ? "👤" : "ℹ️"} {msg.content.slice(0, 200)}
              {msg.content.length > 200 ? "..." : ""}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Input or status */}
      {running ? (
        <Text color={colors.warning}>{" "}⏳ Trabalhando...</Text>
      ) : finished ? (
        <Text color={colors.muted}>{" "}Concluído. [Esc] para fechar.</Text>
      ) : (
        <Box>
          <Text color={colors.muted}>{" "}{">"} </Text>
          <Text color={colors.white} bold>{input}</Text>
          <Text color={colors.primary}>_</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={0}>
        <Text color={colors.muted} dimColor>
          {" "}[Enter] configurar tool | [Esc] fechar
        </Text>
      </Box>
    </Box>
  );
}
