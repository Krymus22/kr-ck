/**
 * ConfiguratorChat.tsx — Mini chat for configuração de tools
 *
 * Sprint 11: Interface de chat dedicada pra configurador.
 * Mostra mensagens do configurador + permite input do usuário.
 * Aberto via tecla 'C' no Hub ou comando /configurar.
 */

import React, { useState, useRef, useEffect } from "react";
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

  // Ref mirror of `running` so the useInput callback (which closes over state
  // at registration time) can read the LATEST value synchronously. Without
  // this, a rapid double-Enter can pass the `if (running) return` guard
  // because the closure still sees the stale `running = false` from the
  // previous render — firing `configureTool` twice (FIX-TUI Bug 2).
  const runningRef = useRef(false);

  // BUG FIX (BH25 MEDIUM 2): configureTool returns a Promise whose .then /
  // .catch callbacks call setMessages / setRunning / setFinished. If the
  // user closes the chat (Esc) while a configure is in flight, the
  // component unmounts, but the Promise callbacks still fire later and
  // call setState on an unmounted component — which React warns about
  // ("Can't perform a React state update on an unmounted component") and,
  // worse, can cause subtle bugs in concurrent mode.
  //
  // mountedRef is set to true on mount and false on unmount; the promise
  // callbacks guard their setState calls with `if (mountedRef.current)`.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mode = getActiveMode();
  const modeName = mode?.name ?? null;

  useInput((inputChar, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    // Guard: ignore ALL input while a configureTool call is in flight.
    // Uses the ref (not the state) so the check always sees the latest
    // value, even when the useInput closure is stale.
    if (runningRef.current) return;

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
      // Set the ref SYNCHRONOUSLY (before any await / re-render) so a
      // second Enter pressed before the next paint is also rejected.
      runningRef.current = true;
      setRunning(true);
      // BUG FIX (BH25 MEDIUM 1): reset `finished` when starting a NEW
      // configuration. Without this, after the first configure completes
      // (finished=true → input field hidden, "Done" shown), the user
      // could still type a new tool name and press Enter — but the input
      // was hidden by the `finished` branch of the ternary, so the user
      // had to close + reopen the chat to configure another tool.
      // Resetting here re-shows the input field and clears the "Done"
      // status while the new configure is running.
      setFinished(false);

      configureTool(userMsg, modeName, undefined, (msg) => {
        // BH25 MEDIUM 2: guard setState — the configurator emits these
        // messages synchronously during its work; if the user has closed
        // the chat in the meantime, the component is unmounted and we
        // must skip the update.
        if (!mountedRef.current) return;
        setMessages((prev) => [...prev, { role: msg.includes("[Tool:") ? "system" : "configurator", content: msg }]);
      })
        .then((result: ConfiguratorResult) => {
          // BH25 MEDIUM 2: promise may resolve after unmount — guard.
          if (!mountedRef.current) return;
          setMessages((prev) => [
            ...prev,
            { role: "system", content: result.message },
          ]);
          runningRef.current = false;
          setRunning(false);
          setFinished(true);
          onMessage?.(result.message);
        })
        .catch((err) => {
          // BH25 MEDIUM 2: promise may reject after unmount — guard.
          if (!mountedRef.current) return;
          setMessages((prev) => [
            ...prev,
            { role: "system", content: `Error: ${(err as Error).message}` },
          ]);
          runningRef.current = false;
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
      runningRef.current = true;
      setRunning(true);
      // BH25 MEDIUM 1: reset finished in case the component is re-used.
      setFinished(false);
      configureTool(toolName, modeName, undefined, (msg) => {
        // BH25 MEDIUM 2: guard setState against post-unmount calls.
        if (!mountedRef.current) return;
        setMessages((prev) => [...prev, { role: msg.includes("[Tool:") ? "system" : "configurator", content: msg }]);
      })
        .then((result) => {
          // BH25 MEDIUM 2: promise may resolve after unmount — guard.
          if (!mountedRef.current) return;
          setMessages((prev) => [...prev, { role: "system", content: result.message }]);
          runningRef.current = false;
          setRunning(false);
          setFinished(true);
          onMessage?.(result.message);
        })
        .catch((err) => {
          // BH25 MEDIUM 2: promise may reject after unmount — guard.
          if (!mountedRef.current) return;
          setMessages((prev) => [...prev, { role: "system", content: `Error: ${(err as Error).message}` }]);
          runningRef.current = false;
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
          content: `Tools sem manifest encontradas:\n${toolsWithoutManifest.map((t) => `  - ${t}`).join("\n")}\n\nDigite o nome de uma tool for configurar, ou "sair" for fechar.`,
        }]);
      } else {
        setMessages([{
          role: "system",
          content: `Nenhuma tool sem manifest encontrada no modo "${modeName ?? "nenhum"}".\nDigite o nome de uma tool for configurar, ou "sair" for fechar.`,
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
        <Text color={colors.muted}>{" "}Done. [Esc] to close.</Text>
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
