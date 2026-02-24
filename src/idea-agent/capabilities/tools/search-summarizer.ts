import { getIdeaAgentSettings } from "../../config/settings";
import { getToolExtraConfigs } from "../../config/tool-config";

export interface SearchSummaryResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

function normalizeMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

export function resolveSummaryLLMOptions(
  toolId: string,
): { apiKey: string; baseUrl: string; model: string } | undefined {
  const settings = getIdeaAgentSettings();
  const extra = getToolExtraConfigs(toolId);

  const apiKey = settings.openai.apiKey;
  if (!apiKey) return undefined;

  const baseUrl = (settings.openai.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

  const model =
    (typeof extra.summaryModel === "string" && extra.summaryModel.trim().length > 0
      ? extra.summaryModel.trim()
      : undefined) ??
    settings.openai.model ??
    "gpt-4o-mini";

  return { apiKey, baseUrl, model };
}

const MAX_DATA_CHARS = 96_000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch with exponential backoff retry. Exported so deep-search-agent can reuse.
 * Retries on network errors and 429/5xx responses.
 */
export async function fetchWithRetry(
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
      // Retryable HTTP status
      const detail = await response.text().catch(() => "");
      lastError = new Error(`HTTP ${response.status}: ${detail.slice(0, 500)}`);
      console.error(
        `[${label}] fetch error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[${label}] fetch error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`,
      );
    }
    if (attempt < maxRetries) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error(`${label}: all ${maxRetries + 1} attempts failed`);
}

export async function summarizeSearchResults(
  params: { toolId: string; input: unknown; data: unknown },
  options: { apiKey: string; baseUrl: string; model: string },
): Promise<SearchSummaryResult> {
  const dataStr =
    typeof params.data === "string"
      ? params.data
      : JSON.stringify(params.data);
  const truncatedData = dataStr.slice(0, MAX_DATA_CHARS);

  const messages = [
    {
      role: "system",
      content: `你是一个学术搜索结果总结助手。你的任务是对搜索工具返回的论文列表做简明扼要的总结。

要求：
- 输出纯文本摘要（不要 JSON）
- 保留每条相关结果的元信息：标题、URL 或 ArxivID
- 过滤掉与用户查询明显无关的结果
- 对相关结果分条做简明扼要的内容概述，不需要进一步归纳总结
- 如果搜索结果为空或全部无关，如实说明`,
    },
    {
      role: "user",
      content: `工具：${params.toolId}
查询输入：${JSON.stringify(params.input)}

搜索结果数据：
${truncatedData}`,
    },
  ];

  const requestBody = {
    model: options.model,
    temperature: 0.1,
    messages,
  };

  try {
    const response = await fetchWithRetry(
      `${options.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      `search-summarizer/${params.toolId}`,
    );

    if (!response.ok) {
      const detail = await response.text();
      const errorMsg = `Summary LLM API error: ${response.status} ${detail.slice(0, 500)}`;
      console.error(`[search-summarizer/${params.toolId}] ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const rawContent = data.choices?.[0]?.message?.content;
    const content = normalizeMessageContent(rawContent);

    if (!content) {
      return { ok: false, error: "Summary LLM returned empty content" };
    }

    return { ok: true, summary: content.trim() };
  } catch (err) {
    const errorMsg = `Summary LLM fetch error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[search-summarizer/${params.toolId}] ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}
