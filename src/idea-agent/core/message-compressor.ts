import type { ChatMessage } from "./types";
import type { LLMClient } from "./llm-client";

// ── Message Compressor Interface ───────────────────────────────────

export interface MessageCompressor {
  compress(messages: ChatMessage[], keepRecentN: number): Promise<ChatMessage[]>;
}

// ── LLM-based Message Compressor ───────────────────────────────────

export class LLMMessageCompressor implements MessageCompressor {
  constructor(
    private readonly llmClient: LLMClient,
    private readonly model: string = "gpt-4o-mini",
  ) {}

  async compress(messages: ChatMessage[], keepRecentN: number): Promise<ChatMessage[]> {
    if (messages.length <= keepRecentN) return messages;

    const older = messages.slice(0, -keepRecentN);
    const recent = messages.slice(-keepRecentN);

    const summary = await this.summarize(older);
    return [
      { role: "user", content: `[Previous conversation summary]\n${summary}` },
      ...recent,
    ];
  }

  private async summarize(messages: ChatMessage[]): Promise<string> {
    const rendered = messages
      .map((m) => {
        if (m.role === "system") return `[System] ${m.content}`;
        if (m.role === "user") {
          const text = typeof m.content === "string"
            ? m.content
            : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
          return `[User] ${text}`;
        }
        if (m.role === "assistant") {
          const parts: string[] = [];
          if (m.content) parts.push(m.content);
          if (m.tool_calls) {
            for (const tc of m.tool_calls) {
              parts.push(`[Called ${tc.function.name}(${tc.function.arguments})]`);
            }
          }
          return `[Assistant] ${parts.join(" ")}`;
        }
        if (m.role === "tool") {
          const preview = m.content.length > 500 ? m.content.slice(0, 500) + "..." : m.content;
          return `[Tool:${m.name}] ${preview}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");

    // Truncate if too long for the summarizer
    const truncated = rendered.length > 60_000 ? rendered.slice(0, 60_000) + "\n...(truncated)" : rendered;

    try {
      const response = await this.llmClient.chatCompletion({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a conversation summarizer. Summarize the following conversation history, " +
              "preserving all key facts, decisions, tool results, and user requirements. " +
              "Be concise but complete. Output plain text summary only.",
          },
          { role: "user", content: truncated },
        ],
        temperature: 0,
        maxTokens: 2000,
      });

      return response.message.content ?? "No summary available.";
    } catch (error) {
      // Fallback: simple truncation
      const fallback = rendered.slice(0, 3000);
      return `[Auto-summary failed, showing truncated history]\n${fallback}`;
    }
  }
}
