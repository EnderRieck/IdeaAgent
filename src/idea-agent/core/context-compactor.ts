import { z } from "zod";
import { fetchWithRetry } from "../capabilities/tools/search-summarizer";
import { tryParseJson } from "../utils/json-parser";

const messageSchema = z.object({
  role: z.enum(["assistant", "user"]),
  content: z.string().min(1),
});

const textOutputSchema = z.object({
  text: z.string().min(1),
});

const dialogueOutputSchema = z.object({
  messages: z.array(messageSchema).min(1),
});

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

export interface ContextDialogueMessage {
  role: "assistant" | "user";
  content: string;
}

export interface CompactTextInput {
  text: string;
  maxChars: number;
  purpose: string;
}

export interface CompactDialogueInput {
  messages: ContextDialogueMessage[];
  maxChars: number;
  purpose: string;
}

export interface ContextCompactor {
  compactText(input: CompactTextInput): Promise<string>;
  compactDialogue(input: CompactDialogueInput): Promise<ContextDialogueMessage[]>;
}

export interface LLMContextCompactorOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class PassthroughContextCompactor implements ContextCompactor {
  async compactText(input: CompactTextInput): Promise<string> {
    return input.text;
  }

  async compactDialogue(input: CompactDialogueInput): Promise<ContextDialogueMessage[]> {
    return input.messages;
  }
}

export class LLMContextCompactor implements ContextCompactor {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: LLMContextCompactorOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.temperature = options.temperature ?? 0;
    const rawMaxTokens = options.maxTokens ?? 900;
    this.maxTokens = Math.max(128, Math.min(16_000, Math.floor(rawMaxTokens)));
  }

  async compactText(input: CompactTextInput): Promise<string> {
    const rawText = input.text.trim();
    if (rawText.length <= input.maxChars) {
      return rawText;
    }

    const compressed = await this.compactTextByLLM(rawText, input.maxChars, input.purpose);
    if (compressed.length <= input.maxChars) {
      return compressed;
    }

    const tightened = await this.compactTextByLLM(compressed, input.maxChars, `${input.purpose} (tighten)`);
    if (tightened.length <= input.maxChars) {
      return tightened;
    }

    throw new Error(`LLM compact failed: output still exceeds limit for ${input.purpose}`);
  }

  async compactDialogue(input: CompactDialogueInput): Promise<ContextDialogueMessage[]> {
    const normalized = this.normalizeDialogue(input.messages);
    if (this.dialogueChars(normalized) <= input.maxChars) {
      return normalized;
    }

    const packed = await this.compactDialogueByLLM(normalized, input.maxChars, input.purpose);
    if (this.dialogueChars(packed) <= input.maxChars) {
      return packed;
    }

    const fallbackText = this.renderDialogue(packed);
    const compactedSummary = await this.compactText({
      text: fallbackText,
      maxChars: input.maxChars,
      purpose: `${input.purpose} (summary)`,
    });

    return [{
      role: "assistant",
      content: `[COMPACTED_DIALOGUE] ${compactedSummary}`,
    }];
  }

  private async compactTextByLLM(text: string, maxChars: number, purpose: string): Promise<string> {
    const response = await this.requestJson(
      `你是上下文压缩器。\n` +
        `你必须输出严格 JSON：{"text":"..."}，不能输出其他字段。\n` +
        `目标：在不丢失关键信息的前提下压缩文本，适用于 ${purpose}。\n` +
        `必须保留：事实、用户偏好、约束、已回答结论、待解决问题。\n` +
        `禁止：编造信息、改写事实含义。\n` +
        `输出 text 必须 <= ${maxChars} 字符。`,
      {
        maxChars,
        purpose,
        text,
      },
    );

    const parsed = textOutputSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error(`LLM compact text schema invalid: ${parsed.error.message}`);
    }

    return parsed.data.text.trim();
  }

  private async compactDialogueByLLM(
    messages: ContextDialogueMessage[],
    maxChars: number,
    purpose: string,
  ): Promise<ContextDialogueMessage[]> {
    const response = await this.requestJson(
      `你是对话上下文压缩器。\n` +
        `你必须输出严格 JSON：{"messages":[{"role":"assistant|user","content":"..."}]}。\n` +
        `目标：压缩对话用于 ${purpose}。\n` +
        `必须保留：角色信息、关键事实、用户约束、已回答/未回答的问题。\n` +
        `顺序要求：messages 仍需按时间顺序。\n` +
        `长度要求：所有 content 字符总和必须 <= ${maxChars}。\n` +
        `禁止：编造信息、遗漏关键约束。`,
      {
        maxChars,
        purpose,
        messages,
      },
    );

    const parsed = dialogueOutputSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error(`LLM compact dialogue schema invalid: ${parsed.error.message}`);
    }

    return this.normalizeDialogue(parsed.data.messages);
  }

  private async requestJson(systemPrompt: string, payload: Record<string, unknown>): Promise<unknown> {
    const requestBody = {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
    };

    const response = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      "context-compactor",
    );

    if (!response.ok) {
      const detail = await response.text();
      const errorMsg = `LLM compact API error: ${response.status} ${detail.slice(0, 500)}`;
      console.error(`[context-compactor] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const rawContent = data.choices?.[0]?.message?.content;
    const content = this.normalizeMessageContent(rawContent);
    if (!content) {
      throw new Error("LLM compact returned empty content");
    }

    const parsedJson = tryParseJson(content);
    if (!parsedJson) {
      throw new Error("LLM compact returned non-JSON content");
    }

    return parsedJson;
  }

  private normalizeDialogue(messages: ContextDialogueMessage[]): ContextDialogueMessage[] {
    return messages
      .map((item) => ({
        role: item.role,
        content: item.content.trim(),
      }))
      .filter((item) => item.content.length > 0);
  }

  private dialogueChars(messages: ContextDialogueMessage[]): number {
    return messages.reduce((acc, item) => acc + item.content.length + 8, 0);
  }

  private renderDialogue(messages: ContextDialogueMessage[]): string {
    return messages.map((item) => `${item.role === "user" ? "U" : "A"}: ${item.content}`).join("\n");
  }

  private normalizeMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
    if (!content) {
      return "";
    }

    if (typeof content === "string") {
      return content;
    }

    return content
      .map((part) => {
        if (part.type === "text") {
          return part.text ?? "";
        }
        return "";
      })
      .join("\n");
  }

}
