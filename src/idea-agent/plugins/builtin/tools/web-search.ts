import { z } from "zod";
import {
  SEARCH_TOOL_PROFILES,
  resolveBaseResults,
  resolveResultCount,
  resultLevelSchema,
} from "../../../capabilities/tools/search-result-level";
import type { NativeTool } from "../../../core/native-tool";
import { getIdeaAgentSettings } from "../../../config/settings";
import { getToolExtraConfigs } from "../../../config/tool-config";
import { resolveSummaryLLMOptions, summarizeSearchResults } from "../../../capabilities/tools/search-summarizer";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

function readExtraString(extra: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = extra[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readExtraNumber(extra: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = extra[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function getWebSearchExtraConfig(): { provider?: "brave" | "duckduckgo" | "bing"; apiKey?: string; timeoutSeconds?: number } {
  const extra = getToolExtraConfigs("web-search");
  const providerRaw = readExtraString(extra, ["provider", "searchProvider", "search_provider"]);
  const provider = providerRaw === "brave" || providerRaw === "duckduckgo" || providerRaw === "bing"
    ? providerRaw
    : undefined;

  return {
    provider,
    apiKey: readExtraString(extra, ["apiKey", "api_key", "braveApiKey", "brave_api_key"]),
    timeoutSeconds: readExtraNumber(extra, ["timeoutSeconds", "timeout_seconds"]),
  };
}

const inputSchema = z.object({
  query: z.string().min(1),
  resultLevel: resultLevelSchema.optional(),
  freshness: z.string().optional(),
  raw: z.boolean().default(false).optional(),
});

interface WebResultItem {
  title: string;
  url: string;
  snippet?: string;
  age?: string;
}

function normalizeResultUrl(rawUrl: string): string {
  const decoded = decodeHtmlEntities(rawUrl).trim();
  if (!decoded.startsWith("http")) {
    return decoded;
  }

  try {
    const parsed = new URL(decoded);
    if (parsed.hostname.endsWith("bing.com") && parsed.pathname.startsWith("/ck/")) {
      const target = parsed.searchParams.get("u");
      if (target && target.startsWith("http")) {
        return target;
      }
    }
    return parsed.toString();
  } catch {
    return decoded;
  }
}

function isLowQualityResult(item: WebResultItem): boolean {
  const title = item.title.trim();
  const snippet = (item.snippet ?? "").trim();
  const text = `${title} ${snippet}`.toLowerCase();

  if (title.length < 4) {
    return true;
  }

  const lowQualityMarkers = [
    "没有找到站点",
    "无法访问此网站",
    "找不到该网页",
    "this site can't be reached",
    "this site can't be reached",
    "site can't be reached",
    "site can't be reached",
    "404 not found",
    "page not found",
  ];

  if (lowQualityMarkers.some((marker) => text.includes(marker))) {
    return true;
  }

  const url = item.url.toLowerCase();
  if (url.includes("duckduckgo.com/i/") || url.includes("duckduckgo.com/y.js")) {
    return true;
  }

  return false;
}

function finalizeResults(items: WebResultItem[], limit: number): WebResultItem[] {
  const out: WebResultItem[] = [];
  const seen = new Set<string>();

  for (const row of items) {
    const url = normalizeResultUrl(row.url);
    const title = row.title.trim();
    const snippet = row.snippet?.trim();
    if (!title || !url.startsWith("http")) {
      continue;
    }

    const normalized: WebResultItem = {
      title,
      url,
      snippet: snippet && snippet.length > 0 ? snippet : undefined,
      age: row.age,
    };

    if (isLowQualityResult(normalized)) {
      continue;
    }

    const dedupKey = `${normalized.url}::${normalized.title.toLowerCase()}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    out.push(normalized);

    if (out.length >= limit) {
      break;
    }
  }

  return out;
}

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number(code);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : _;
    });
}

function stripHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function searchByBrave(params: {
  query: string;
  limit: number;
  freshness?: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<WebResultItem[]> {
  const perPage = Math.min(params.limit, 20);
  const maxPages = Math.max(1, Math.ceil(params.limit / perPage));

  const all: WebResultItem[] = [];
  const seen = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const searchUrl = new URL(BRAVE_ENDPOINT);
    searchUrl.searchParams.set("q", params.query);
    searchUrl.searchParams.set("count", String(perPage));
    searchUrl.searchParams.set("offset", String(page * perPage));
    if (params.freshness) {
      searchUrl.searchParams.set("freshness", params.freshness);
    }

    const response = await fetchWithTimeout(
      searchUrl.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": params.apiKey,
        },
      },
      params.timeoutMs,
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Brave search failed: ${response.status} ${detail.slice(0, 500)}`);
    }

    const data = (await response.json()) as BraveResponse;
    const rows = (data.web?.results ?? [])
      .map((row) => ({
        title: row.title?.trim() ?? "",
        url: row.url?.trim() ?? "",
        snippet: row.description?.trim(),
        age: row.age?.trim(),
      }))
      .filter((row) => row.title.length > 0 && row.url.length > 0);

    if (rows.length === 0) {
      break;
    }

    let newCount = 0;
    for (const row of rows) {
      if (seen.has(row.url)) {
        continue;
      }
      seen.add(row.url);
      all.push(row);
      newCount += 1;
      if (all.length >= params.limit) {
        return all.slice(0, params.limit);
      }
    }

    if (rows.length < perPage || newCount === 0) {
      break;
    }
  }

  return all.slice(0, params.limit);
}

function parseBingResults(html: string, limit: number): WebResultItem[] {
  const list: WebResultItem[] = [];
  const blocks = html.match(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<\/li>/gi) ?? [];

  for (const block of blocks) {
    const anchorMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    if (!anchorMatch) {
      continue;
    }

    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const url = normalizeResultUrl(anchorMatch[1]);
    const title = stripHtml(anchorMatch[2]);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : undefined;

    if (!title || !url.startsWith("http")) {
      continue;
    }

    list.push({ title, url, snippet });
    if (list.length >= limit) {
      break;
    }
  }

  return finalizeResults(list, limit);
}

async function searchByBing(query: string, limit: number, timeoutMs: number): Promise<WebResultItem[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("setlang", "en-US");
  url.searchParams.set("mkt", "en-US");

  const response = await fetchWithTimeout(
    url.toString(),
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (IdeaAgent)",
        Accept: "text/html,application/xhtml+xml",
      },
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Bing search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const results = parseBingResults(html, limit);
  if (results.length === 0) {
    throw new Error("Bing parser returned empty results");
  }
  return results;
}

function parseDuckMarkdown(markdown: string, limit: number): WebResultItem[] {
  const lines = markdown.split("\n");
  const output: WebResultItem[] = [];

  for (const line of lines) {
    const match = line.match(/^\d+\.\s+\[(.+?)\]\((https?:\/\/[^\s)]+)\)(.*)$/);
    if (!match) {
      continue;
    }

    const title = stripHtml(match[1]);
    const url = normalizeResultUrl(match[2]);
    const suffix = stripHtml(match[3]).trim();

    if (!title || !url) {
      continue;
    }

    output.push({
      title,
      url,
      snippet: suffix.length > 0 ? suffix : undefined,
    });

    if (output.length >= limit * 3) {
      break;
    }
  }

  return finalizeResults(output, limit);
}

async function searchByDuckDuckGo(query: string, limit: number, timeoutMs: number): Promise<WebResultItem[]> {
  const url = `https://r.jina.ai/http://duckduckgo.com/?q=${encodeURIComponent(query)}`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "text/plain",
      },
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`DuckDuckGo proxy failed: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  const parsed = parseDuckMarkdown(markdown, limit);

  const cleaned = parsed
    .filter((item) => item.title.length >= 12)
    .filter((item) => !/^!\[image/i.test(item.title));

  if (cleaned.length < 2) {
    throw new Error("DuckDuckGo returned no stable parseable results");
  }

  return cleaned.slice(0, limit);
}

function resolveLimit(input: z.infer<typeof inputSchema>): number {
  const settings = getIdeaAgentSettings();
  const profile = SEARCH_TOOL_PROFILES.web;
  const baseCount = resolveBaseResults(settings.web.maxResults, profile.defaultBaseResults, profile.maxResults);

  return resolveResultCount({
    explicitCount: undefined,
    resultLevel: input.resultLevel,
    baseCount,
    maxCount: profile.maxResults,
  });
}

export const webSearchTool: NativeTool = {
  name: "web-search",
  description: "网页搜索，优先使用 Brave API，自动回退到 DuckDuckGo 或 Bing。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    const settings = getIdeaAgentSettings();
    const extra = getWebSearchExtraConfig();
    const provider = extra.provider ?? settings.web.provider ?? "brave";
    const limit = resolveLimit(input);
    const timeoutSeconds = extra.timeoutSeconds ?? settings.web.timeoutSeconds ?? 20;
    const timeoutMs = Math.max(1, timeoutSeconds) * 1000;

    const braveKey = extra.apiKey ?? settings.web.apiKey ?? process.env.BRAVE_API_KEY;

    console.error(`[web-search] engine=${provider}${provider === "brave" && !braveKey ? " (no API key, will fallback)" : ""} query="${input.query}"`);

    let rawData: unknown;

    if (provider === "brave") {
      if (braveKey) {
        try {
          const results = await searchByBrave({
            query: input.query,
            limit,
            freshness: input.freshness,
            apiKey: braveKey,
            timeoutMs,
          });

          rawData = {
            provider: "brave",
            query: input.query,
            requestedLimit: limit,
            resultLevel: input.resultLevel ?? "more",
            results,
          };
        } catch (error) {
          const fallbackErrorPrefix = error instanceof Error ? error.message : "brave failed";

          try {
            const results = await searchByDuckDuckGo(input.query, limit, timeoutMs);
            rawData = {
              provider: "duckduckgo",
              fallbackUsed: true,
              fallbackReason: fallbackErrorPrefix,
              query: input.query,
              requestedLimit: limit,
              resultLevel: input.resultLevel ?? "more",
              results,
            };
          } catch {
            const bingResults = await searchByBing(input.query, limit, timeoutMs);
            rawData = {
              provider: "bing",
              fallbackUsed: true,
              fallbackReason: fallbackErrorPrefix,
              query: input.query,
              requestedLimit: limit,
              resultLevel: input.resultLevel ?? "more",
              results: bingResults,
            };
          }
        }
      }

      if (!rawData) {
        try {
          const results = await searchByDuckDuckGo(input.query, limit, timeoutMs);
          rawData = {
            provider: "duckduckgo",
            fallbackUsed: true,
            fallbackReason: "missing_brave_api_key",
            query: input.query,
            requestedLimit: limit,
            resultLevel: input.resultLevel ?? "more",
            results,
          };
        } catch {
          const bingResults = await searchByBing(input.query, limit, timeoutMs);
          rawData = {
            provider: "bing",
            fallbackUsed: true,
            fallbackReason: "missing_brave_api_key",
            query: input.query,
            requestedLimit: limit,
            resultLevel: input.resultLevel ?? "more",
            results: bingResults,
          };
        }
      }
    } else if (provider === "bing") {
      try {
        const results = await searchByBing(input.query, limit, timeoutMs);
        rawData = {
          provider: "bing",
          query: input.query,
          requestedLimit: limit,
          resultLevel: input.resultLevel ?? "more",
          results,
        };
      } catch (error) {
        const fallbackErrorPrefix = error instanceof Error ? error.message : "bing failed";
        const results = await searchByDuckDuckGo(input.query, limit, timeoutMs);
        rawData = {
          provider: "duckduckgo",
          fallbackUsed: true,
          fallbackReason: fallbackErrorPrefix,
          query: input.query,
          requestedLimit: limit,
          resultLevel: input.resultLevel ?? "more",
          results,
        };
      }
    } else {
      try {
        const results = await searchByDuckDuckGo(input.query, limit, timeoutMs);
        rawData = {
          provider: "duckduckgo",
          query: input.query,
          requestedLimit: limit,
          resultLevel: input.resultLevel ?? "more",
          results,
        };
      } catch {
        const results = await searchByBing(input.query, limit, timeoutMs);
        rawData = {
          provider: "bing",
          fallbackUsed: true,
          fallbackReason: "duckduckgo_unavailable",
          query: input.query,
          requestedLimit: limit,
          resultLevel: input.resultLevel ?? "more",
          results,
        };
      }
    }

    if (input.raw) {
      return { value: JSON.stringify(rawData) };
    }

    const llmOptions = resolveSummaryLLMOptions("web-search");
    if (!llmOptions) {
      return { value: JSON.stringify(rawData) };
    }

    const summaryResult = await summarizeSearchResults(
      { toolId: "web-search", input, data: rawData },
      llmOptions,
    );

    if (summaryResult.ok && summaryResult.summary) {
      const record = rawData as Record<string, unknown> | undefined;
      const results = record && Array.isArray(record.results) ? record.results : undefined;
      const count = results ? results.length : undefined;
      const prefix = count !== undefined ? `[共 ${count} 条结果]\n\n` : "";
      return { value: `${prefix}${summaryResult.summary}` };
    }

    return { value: JSON.stringify(rawData) };
  },
};
