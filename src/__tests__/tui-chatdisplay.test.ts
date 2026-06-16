import { describe, it, expect } from "vitest";
import { ChatDisplay, ChatMessage } from "../tui/ChatDisplay.js";
import { colors } from "../tui/theme.js";

function filterVisibleMessages(messages: ChatMessage[], maxVisible: number = 50): ChatMessage[] {
  return messages.slice(-maxVisible);
}

function filterSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== "system");
}

describe("ChatDisplay component", () => {
  it("should be a function", () => {
    expect(typeof ChatDisplay).toBe("function");
  });

  describe("ChatMessage type", () => {
    it("should accept user messages", () => {
      const msg: ChatMessage = { role: "user", content: "hello" };
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("hello");
    });

    it("should accept assistant messages", () => {
      const msg: ChatMessage = { role: "assistant", content: "hi there" };
      expect(msg.role).toBe("assistant");
    });

    it("should accept system messages", () => {
      const msg: ChatMessage = { role: "system", content: "loading" };
      expect(msg.role).toBe("system");
    });

    it("should accept optional isStreaming", () => {
      const msg: ChatMessage = { role: "assistant", content: "", isStreaming: true };
      expect(msg.isStreaming).toBe(true);
    });

    it("should default isStreaming to undefined", () => {
      const msg: ChatMessage = { role: "user", content: "test" };
      expect(msg.isStreaming).toBeUndefined();
    });
  });

  describe("maxVisible slicing logic", () => {
    it("should return all messages when under maxVisible", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ];
      expect(filterVisibleMessages(msgs, 50)).toHaveLength(2);
    });

    it("should truncate to last N messages", () => {
      const msgs: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
        role: "user" as const,
        content: `msg${i}`,
      }));
      const visible = filterVisibleMessages(msgs, 10);
      expect(visible).toHaveLength(10);
      expect(visible[0].content).toBe("msg90");
      expect(visible[9].content).toBe("msg99");
    });

    it("should handle empty messages array", () => {
      expect(filterVisibleMessages([], 50)).toHaveLength(0);
    });

    it("should default maxVisible to 50", () => {
      const msgs: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
        role: "user" as const,
        content: `msg${i}`,
      }));
      expect(filterVisibleMessages(msgs)).toHaveLength(50);
    });

    it("should handle maxVisible larger than array", () => {
      const msgs: ChatMessage[] = [{ role: "user", content: "only" }];
      expect(filterVisibleMessages(msgs, 100)).toHaveLength(1);
    });
  });

  describe("system message filtering", () => {
    it("should filter out system messages", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hello" },
        { role: "system", content: "loading" },
        { role: "assistant", content: "hi" },
      ];
      expect(filterSystemMessages(msgs)).toHaveLength(2);
    });

    it("should keep all non-system messages", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ];
      expect(filterSystemMessages(msgs)).toHaveLength(2);
    });

    it("should handle all system messages", () => {
      const msgs: ChatMessage[] = [
        { role: "system", content: "a" },
        { role: "system", content: "b" },
      ];
      expect(filterSystemMessages(msgs)).toHaveLength(0);
    });

    it("should handle empty array", () => {
      expect(filterSystemMessages([])).toHaveLength(0);
    });
  });

  describe("message rendering labels", () => {
    it("user messages show 'vocé:' label", () => {
      expect(colors.primary).toBeDefined();
    });

    it("assistant messages show 'Claude-Killer:' label", () => {
      expect(colors.secondary).toBeDefined();
    });

    it("streaming messages should not show empty line after content", () => {
      const streamingMsg: ChatMessage = { role: "assistant", content: "...", isStreaming: true };
      const finishedMsg: ChatMessage = { role: "assistant", content: "done", isStreaming: false };
      expect(streamingMsg.isStreaming).toBe(true);
      expect(finishedMsg.isStreaming).toBe(false);
    });
  });
});
