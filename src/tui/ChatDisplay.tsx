/**
 * ChatDisplay.tsx - Renders the conversation history with styled messages.
 *
 * All messages use a single leading space (" ") for consistent left margin
 * alignment. Without this, the assistant content starts at column 1 while
 * the user content starts at column 2, making the conversation look jagged.
 *
 * Message types:
 *   - user:      what the user typed (cyan label "você:")
 *   - assistant: what the model replied (violet label "Claude-Killer:")
 *   - tool:      tool calls + results (grey, indented, with icon)
 *                — shown in CHRONOLOGICAL ORDER mixed with user/assistant
 *   - system:    filtered out (internal context, not shown to user)
 *
 * ─── Static + Live split (limite-historico fix) ─────────────────────────
 *
 * BUG FIX: Previously ChatDisplay rendered ALL messages in a single <Box>,
 * which caused two problems:
 *   1. When the conversation grew longer than the terminal, the Ink frame
 *      exceeded the viewport height, pushing the input box and placeholder
 *      ("digite sua mensagem...") off-screen.
 *   2. Even if the user scrolled up, older messages weren't in the terminal
 *      scrollback because Ink overwrites frames (cursor-up + repaint), so
 *      only the last frame is ever in the buffer.
 *
 * Fix: Use Ink's <Static> component to "graduate" old messages to the
 * terminal scrollback. <Static> writes each item to stdout ONCE (above the
 * live view) and never re-renders it. This is exactly how Claude Code does
 * it — old messages become permanent scrollback, recent messages + the
 * streaming message stay in the "live" viewport that gets repainted.
 *
 * Split strategy:
 *   - Find the streaming message (isStreaming=true). If none, all messages
 *     are candidates for static.
 *   - Keep at least MIN_LIVE_MESSAGES in the live view (so the user sees
 *     recent context and their latest message).
 *   - Everything before that goes to <Static> — written once, stays in
 *     scrollback forever, user can scroll up to read it.
 *   - The streaming message and anything after it (shouldn't happen normally)
 *     stay live so they can update on each token.
 *
 * The optional maxVisible prop is kept for backwards compatibility (tests)
 * but is now only applied to the live portion, not the total. Production
 * usage (App.tsx) doesn't pass it.
 */

import React, { useMemo } from "react";
import { Box, Text, Static } from "ink";
import { colors, icons } from "./theme.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  isStreaming?: boolean;
  /** For tool messages: the tool name (e.g., "ler_arquivo"). */
  toolName?: string;
  /** For tool messages: whether this is the call (false) or the result (true). */
  isResult?: boolean;
  /** For tool messages: whether the tool succeeded (only for isResult=true). */
  ok?: boolean;
  /** For assistant messages: whether this is an error message (displayed in red). */
  isError?: boolean;
  /** For user messages: whether this is a sidequest (typed while IA was working).
   *  Rendered in dimmed/muted color to distinguish from normal messages. */
  isSidequest?: boolean;
}

interface ChatDisplayProps {
  messages: ChatMessage[];
  maxVisible?: number;
}

/** Minimum number of messages to keep in the live (re-rendered) view. */
const MIN_LIVE_MESSAGES = 4;

/**
 * Truncate a long string to fit in the terminal, preserving the start and end.
 * Examples:
 *   truncateMiddle("hello world this is a long string", 20) → "hello wor…ng string"
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1; // 1 char for the ellipsis
  const start = Math.ceil(keep * 0.6);
  const end = Math.floor(keep * 0.4);
  return s.slice(0, start) + "…" + s.slice(s.length - end);
}

/**
 * Format tool args for display. Shows the most relevant field (path, comando, query)
 * in a compact single-line format.
 */
function formatToolArgs(args: Record<string, unknown>): string {
  // Tool "pensar" — não mostrar o pensamento no chat (é interno)
  // BUG FIX (always-true-condition): The previous condition
  //   `args.pensamento !== undefined || args.pensamento !== null`
  // was ALWAYS true (for any value X, at least one of `X !== undefined`
  // or `X !== null` holds — undefined !== null is true, null !== undefined
  // is true, anything else makes both true). The inner `typeof === "string"`
  // check happened to prevent incorrect output, so behavior was unchanged,
  // but the outer guard was logically broken. Switch to `!= null` which
  // correctly means "is neither undefined nor null".
  if (args.pensamento != null) {
    if (typeof args.pensamento === "string") {
      const cat = args.categoria ?? args.category;
      return cat ? `(${cat}, ${args.pensamento.length} chars)` : `(${args.pensamento.length} chars)`;
    }
  }
  const path = args.path ?? args.caminho ?? args.filePath;
  if (typeof path === "string") return truncateMiddle(path, 50);
  const cmd = args.comando ?? args.command;
  if (typeof cmd === "string") return truncateMiddle(cmd, 50);
  const query = args.query ?? args.consulta ?? args.questao;
  if (typeof query === "string") return truncateMiddle(query, 50);
  const json = JSON.stringify(args);
  return truncateMiddle(json, 50);
}

/**
 * Format tool result for display. Truncates long outputs to keep the chat readable.
 */
function formatToolResult(resultStr: string): string {
  // Take only the first 3 lines and truncate to 200 chars total
  const lines = resultStr.split("\n").slice(0, 3);
  const joined = lines.join("\n");
  return truncateMiddle(joined, 200);
}

/**
 * Render a single message as a React element. Used by both <Static> (old
 * messages) and the live view (recent messages).
 *
 * Extracted into a standalone function so the rendering logic is identical
 * in both contexts — no drift between static and live message appearance.
 *
 * @param prevMsg  The message before this one in the array (or null if first).
 *                 Used to decide whether to show the "Claude-Killer:" header:
 *                 only shown at the START of an assistant turn (i.e., when the
 *                 previous message was from the user, or there is no previous
 *                 message). This prevents the header from appearing multiple
 *                 times in a single turn where the assistant makes tool calls
 *                 and then responds with text.
 */
function renderMessage(msg: ChatMessage, keyPrefix: string, prevMsg: ChatMessage | null = null): React.ReactElement | null {
  if (msg.role === "system") return null;

  // Tool messages: render with icon, indented, grey
  if (msg.role === "tool") {
    // Tool "pensar" / "think" — esconder resultado (é interno, não deve
    // aparecer no chat). "think" é um alias para "pensar" (ver TOOL_ALIASES
    // em agent.ts). Ambos devem ser filtrados para evitar que o pensamento
    // da IA vaze para o chat visível.
    // BUG FIX (thinking-vazando): o filtro anterior só checava "pensar",
    // então se a IA chamasse "think()" em vez de "pensar()", o resultado
    // vazava. Agora cobre ambos.
    const isThinkTool = msg.toolName === "pensar" || msg.toolName === "think";
    if (isThinkTool && msg.isResult) {
      return null; // não renderizar resultado do pensar/think
    }
    const label = msg.isResult
      ? (msg.ok ? `${icons.check} ${msg.toolName ?? "tool"}` : `${icons.cross} ${msg.toolName ?? "tool"}`)
      : `${icons.arrow} ${msg.toolName ?? "tool"}(${formatToolArgs(parseArgsSafe(msg.content))})`;
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={msg.isResult ? (msg.ok ? colors.success : colors.error) : colors.muted}>
          {"  "}{label}
        </Text>
        {msg.isResult && (
          <Text color={colors.muted}>{"    "}{formatToolResult(msg.content)}</Text>
        )}
      </Box>
    );
  }

  if (msg.role === "user") {
    // Sidequest messages (typed while IA was working) are rendered in dimmed color
    if (msg.isSidequest) {
      return (
        <Box key={keyPrefix} flexDirection="column">
          <Text color={colors.muted} bold> ⚡ sidequest:</Text>
          <Text color={colors.muted}> {msg.content}</Text>
          <Text></Text>
        </Box>
      );
    }
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={colors.primary} bold> you:</Text>
        <Text color={colors.white}> {msg.content}</Text>
        <Text></Text>
      </Box>
    );
  }

  // assistant - note the leading space in content for alignment
  //
  // §17.4.21 VIOLATION FIX (error-as-markdown): previously, error messages
  // (isError=true) were rendered through MarkdownRenderer along with normal
  // assistant messages. This violated §17.4.21 ("MarkdownRenderer só em
  // assistant messages — user/tool/error = texto puro"). Error messages
  // MUST be plain text per the business rules.
  //
  // The previous "fix" (error-markdown-raw) made App.tsx put markdown
  // syntax (`**Erro na execução:**` and ``` code fences) into the error
  // content and then routed it through MarkdownRenderer to format it.
  // That was the wrong direction — the right fix is to keep error content
  // as plain text (no `**`, no ```) AND render it as plain <Text>.
  //
  // App.tsx has been updated to produce plain-text error content. Error
  // messages here now render as plain <Text> with the red error color,
  // matching §17.4.21.
  //
  // Streaming messages still go through MarkdownRenderer — parseBlocks is
  // tolerant of partial/unclosed markdown (e.g. an unfinished ``` code
  // fence during streaming is treated as a code block containing the
  // remaining lines), so the live view stays correct as tokens arrive.
  if (msg.isError) {
    return (
      <Box key={keyPrefix} flexDirection="column">
        <Text color={colors.error} bold> ❌ Erro:</Text>
        <Box marginLeft={1}>
          <Text color={colors.error}>{msg.content}</Text>
        </Box>
        {msg.isStreaming ? null : <Text></Text>}
      </Box>
    );
  }

  // Normal assistant message — render through MarkdownRenderer (bold,
  // tables, code, headers, lists, etc.).
  //
  // HEADER DEDUP: only show the "Claude-Killer:" header at the START of an
  // assistant turn — i.e., when the previous message was a user message (or
  // there is no previous message). If the previous message was a tool result
  // or another assistant message, we're in the MIDDLE of a turn (the assistant
  // made tool calls and is now continuing), so we skip the header to avoid
  // visual pollution (multiple "Claude-Killer:" lines in a single turn).
  const showAssistantHeader = !prevMsg || prevMsg.role === "user";
  return (
    <Box key={keyPrefix} flexDirection="column">
      {showAssistantHeader && <Text color={colors.secondary} bold> Claude-Killer:</Text>}
      <Box marginLeft={1}>
        <MarkdownRenderer text={msg.content} />
      </Box>
      {msg.isStreaming ? null : <Text></Text>}
    </Box>
  );
}

/**
 * Split messages into "static" (old, written once to scrollback) and "live"
 * (recent, re-rendered on each update).
 *
 * Strategy:
 *   1. Find the streaming message (isStreaming=true). It MUST be live.
 *   2. Keep at least MIN_LIVE_MESSAGES before the split point so the user
 *      sees recent context.
 *   3. Everything before the split point is static.
 */
function splitStaticLive(messages: ChatMessage[]): { staticMsgs: ChatMessage[]; liveMsgs: ChatMessage[] } {
  if (messages.length <= MIN_LIVE_MESSAGES) {
    return { staticMsgs: [], liveMsgs: messages };
  }

  // Find the streaming message — it and everything after it must be live.
  const streamingIdx = messages.findIndex((m) => m.isStreaming);
  // If no streaming message, the split point is (length - MIN_LIVE_MESSAGES).
  // If there IS a streaming message, the split point is at most streamingIdx
  // (so the streaming message is always live).
  const maxStaticEnd = streamingIdx === -1 ? messages.length : streamingIdx;
  const staticEnd = Math.min(maxStaticEnd, messages.length - MIN_LIVE_MESSAGES);

  // Guard against negative (when messages.length < MIN_LIVE_MESSAGES, but
  // we already handled that above — this is just defensive).
  const safeStaticEnd = Math.max(0, staticEnd);

  return {
    staticMsgs: messages.slice(0, safeStaticEnd),
    liveMsgs: messages.slice(safeStaticEnd),
  };
}

export const ChatDisplay = React.memo(function ChatDisplay({ messages, maxVisible }: Readonly<ChatDisplayProps>) {
  // Apply maxVisible to the total message list if provided (backwards compat
  // for tests). Production usage (App.tsx) does NOT pass this prop, so all
  // messages are considered.
  const candidateMsgs = maxVisible !== undefined ? messages.slice(-maxVisible) : messages;

  // BUG FIX (scroll-steal-during-typing): splitStaticLive was called WITHOUT
  // useMemo, creating new array references (staticMsgs/liveMsgs) on every
  // render. Even though `messages` keeps the same reference during typing
  // (handleChange only calls setInput, not setMessages), the new array refs
  // from splitStaticLive caused the <Static> children to be re-evaluated
  // and the live frame to be repainted on every keystroke — causing the
  // terminal to briefly scroll up (scroll-steal).
  //
  // Fix: useMemo with [candidateMsgs] deps. Since candidateMsgs IS messages
  // (when maxVisible is undefined) and messages is reference-stable during
  // typing, the memo skips recalculation on keystrokes — no new arrays,
  // no <Static> re-evaluation, no live frame repaint.
  const { staticMsgs, liveMsgs } = useMemo(() => splitStaticLive(candidateMsgs), [candidateMsgs]);

  // BUG FIX (indexOf-on2): previously the <Static> and live render loops
  // called `messages.indexOf(msg)` for each item to compute a stable key.
  // That is O(n) per item, making the whole render O(n²) — for a 1000-msg
  // conversation, that's ~500K reference comparisons on every re-render
  // (every 80ms throttle flush during streaming).
  //
  // Since static items live at the BEGINNING of `candidateMsgs` and live
  // items follow them, the index in `candidateMsgs` (and therefore in
  // `messages`, when maxVisible is undefined) is just:
  //   static[i] → i
  //   live[i]   → staticMsgs.length + i
  // When maxVisible IS defined, candidateMsgs is a tail slice of messages,
  // so we add `candidateStart = messages.length - candidateMsgs.length`.
  // Both lookups are now O(1) per item → O(n) total.
  const candidateStart = messages.length - candidateMsgs.length;
  const staticKeyBase = candidateStart;
  const liveKeyBase = candidateStart + staticMsgs.length;

  return (
    <Box flexDirection="column">
      {/*
        <Static> writes each item to stdout ONCE, above the live view. Once
        written, items are never re-rendered — they become permanent
        scrollback. This is how we keep old messages accessible without
        growing the live frame beyond the terminal viewport.

        Items graduate from live → static as new messages arrive. Ink
        detects new items in the `items` array (by reference/key) and
        writes only the new ones.

        IMPORTANT: keys must be stable across renders. We compute the key
        from the index in the FULL messages array (not the staticMsgs
        slice) so that a message's key doesn't change when it moves from
        live to static. The index is computed in O(1) via the
        staticKeyBase / liveKeyBase offsets (see the comment above).
      */}
      <Static items={staticMsgs}>
        {(_, i) => {
          const key = `msg-${staticKeyBase + i}`;
          // Compute previous message for header-dedup logic:
          // - If i > 0, previous is staticMsgs[i-1]
          // - If i === 0, previous is candidateMsgs[staticKeyBase-1] (could
          //   be undefined if staticKeyBase === 0, i.e., first message overall)
          const prevMsg = i > 0
            ? staticMsgs[i - 1] ?? null
            : (staticKeyBase > 0 ? candidateMsgs[staticKeyBase - 1] ?? null : null);
          return renderMessage(staticMsgs[i]!, key, prevMsg);
        }}
      </Static>

      {/* Live view: recent messages + the streaming message. These are
          re-rendered on every state update (each token, throttle flush,
          tool call, etc.). Kept small (MIN_LIVE_MESSAGES + streaming) so
          the frame never exceeds the terminal viewport. */}
      {liveMsgs.map((msg, i) => {
        const key = `msg-${liveKeyBase + i}`;
        // Compute previous message for header-dedup logic:
        // - If i > 0, previous is liveMsgs[i-1]
        // - If i === 0, previous is the last static message (if any)
        const prevMsg = i > 0
          ? liveMsgs[i - 1] ?? null
          : (staticMsgs.length > 0 ? staticMsgs[staticMsgs.length - 1] ?? null : null);
        return renderMessage(msg, key, prevMsg);
      })}
    </Box>
  );
});

/** Safely parse args stored as JSON string in msg.content (for tool call messages). */
function parseArgsSafe(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
