import { describe, expect, it } from "vitest";
import { messageText, textFromRawContent, thinkingFromRawContent } from "../src/messages/content.js";

describe("message content helpers", () => {
  it("keeps thinking out of text bubbles and extracts it for thinking cards", () => {
    const content = [
      { type: "thinking", thinking: "  consider the options  " },
      { type: "text", text: "Final answer" },
      { type: "thinking", text: "alternative thinking" },
      { type: "toolCall", toolName: "read" },
    ];

    expect(textFromRawContent(content)).toBe("Final answer");
    expect(thinkingFromRawContent(content)).toEqual(["consider the options", "alternative thinking"]);
  });

  it("shows friendly stop-reason text for truncated assistant messages", () => {
    expect(messageText({ role: "assistant", raw: { content: "Partial", stopReason: "length" } })).toBe(
      "Partial\n\nResponse stopped because the model hit its output length limit.",
    );
  });

  it("prefers assistant errors over stop-reason text", () => {
    expect(messageText({ role: "assistant", raw: { content: "Partial", stopReason: "length", errorMessage: "Provider exploded" } })).toBe(
      "Provider exploded",
    );
  });
});
