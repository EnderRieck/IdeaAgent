import type { ChatMessage, ToolCall, ToolDefinition } from "./types";
import { toToolDefinition, type NativeTool } from "./native-tool";
import {
  convertToNonFnCallMessages,
  parseXmlFunctionCalls,
  interleaveUserMessages,
} from "./fn-call-converter";

// ── Types ──────────────────────────────────────────────────────────

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResponse {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
}

export interface LLMClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Model names that do NOT support native function calling */
  nonNativeFcModels?: string[];
}

// ── Raw API response shape ─────────────────────────────────────────

interface RawChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }> | null;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}

// ── Fetch with retry ───────────────────────────────────────────────

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  maxRetries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }
      const detail = await response.text().catch(() => "");
      lastError = new Error(`HTTP ${response.status}: ${detail.slice(0, 500)}`);
      console.error(`[${label}] fetch error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[${label}] fetch error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`);
    }
    if (attempt < maxRetries) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error(`${label}: all ${maxRetries + 1} attempts failed`);
}

// ── Normalize content from API response ────────────────────────────

function normalizeContent(
  content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  const text = content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
  return text || null;
}

// ── Default non-native FC model patterns ───────────────────────────

const DEFAULT_NON_NATIVE_FC_PATTERNS = [
  "deepseek",
  "llama",
  "mistral",
  "mixtral",
  "qwen",
  "yi-",
];

// ── LLM Client ─────────────────────────────────────────────────────

export class LLMClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly nonNativeFcPatterns: string[];

  constructor(options: LLMClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.nonNativeFcPatterns = options.nonNativeFcModels ?? DEFAULT_NON_NATIVE_FC_PATTERNS;
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    if (this.supportsNativeFnCall(params.model)) {
      return this.callNative(params);
    }
    return this.callWithXmlFallback(params);
  }

  supportsNativeFnCall(model: string): boolean {
    const lower = model.toLowerCase();
    return !this.nonNativeFcPatterns.some((pattern) => lower.includes(pattern));
  }

  // ── Native function calling ────────────────────────────────────

  private async callNative(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    // Sanitize: ensure assistant messages with tool_calls always have non-empty content.
    // Some OpenAI-to-Anthropic proxies fail on null/empty/missing content:
    //   "" or null  → malformed text block → "text: Field required"
    //   missing     → content: null        → "content: Input should be a valid list"
    const sanitizedMessages = params.messages.map((m) => {
      if (m.role === "assistant" && (m as Record<string, unknown>).tool_calls && !m.content) {
        return { ...m, content: "<empty>" };
      }
      return m;
    });

    const requestBody: Record<string, unknown> = {
      model: params.model,
      messages: sanitizedMessages,
      temperature: params.temperature ?? 0.2,
    };

    if (params.maxTokens) {
      requestBody.max_tokens = params.maxTokens;
    }

    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
      if (params.toolChoice) {
        requestBody.tool_choice = params.toolChoice;
      }
    }

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
      `llm-client/native/${params.model}`,
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LLM API error: ${response.status} ${detail.slice(0, 500)}`);
    }

    const data = (await response.json()) as RawChatCompletionResponse;
    const choice = data.choices?.[0]?.message;

    if (!choice) {
      throw new Error("LLM returned no choices");
    }

    const content = normalizeContent(choice.content);
    const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      },
    };
  }

  // ── XML fallback for non-native FC models ──────────────────────

  private async callWithXmlFallback(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
    const tools = params.tools ?? [];

    // Convert messages: inject tool descriptions into system prompt,
    // convert tool_calls to XML, convert tool results to user messages
    let convertedMessages = convertToNonFnCallMessages(params.messages, tools);

    // Interleave user messages between consecutive assistant messages
    convertedMessages = interleaveUserMessages(convertedMessages);

    const requestBody: Record<string, unknown> = {
      model: params.model,
      messages: convertedMessages,
      temperature: params.temperature ?? 0.2,
      stop: ["</function"],
    };

    if (params.maxTokens) {
      requestBody.max_tokens = params.maxTokens;
    }

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
      `llm-client/xml-fallback/${params.model}`,
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LLM API error: ${response.status} ${detail.slice(0, 500)}`);
    }

    const data = (await response.json()) as RawChatCompletionResponse;
    const choice = data.choices?.[0]?.message;

    if (!choice) {
      throw new Error("LLM returned no choices");
    }

    const rawContent = normalizeContent(choice.content) ?? "";

    // Parse XML function calls from the response
    const { text, toolCalls } = parseXmlFunctionCalls(rawContent, tools);

    return {
      message: {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
    };
  }
}
