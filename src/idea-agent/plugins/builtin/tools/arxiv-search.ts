import { z } from "zod";
import { ArxivClient } from "../clients/arxiv-client";
import {
  SEARCH_TOOL_PROFILES,
  resolveBaseResults,
  resolveResultCount,
  resultLevelSchema,
} from "../../../capabilities/tools/search-result-level";
import type { NativeTool } from "../../../core/native-tool";
import { getIdeaAgentSettings } from "../../../config/settings";
import { resolveSummaryLLMOptions, summarizeSearchResults } from "../../../capabilities/tools/search-summarizer";

const inputSchema = z.object({
  keywords: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  categories: z.array(z.string()).optional(),
  resultLevel: resultLevelSchema.optional(),
  arxivId: z.string().min(1).optional(),
  queries: z.array(z.string().min(1)).optional(),
  raw: z.boolean().default(false).optional(),
});

const client = new ArxivClient();

function resolveKeywords(input: z.infer<typeof inputSchema>): string | undefined {
  return input.keywords ?? input.query;
}

function resolveBaseCount(): number {
  const settings = getIdeaAgentSettings();
  const profile = SEARCH_TOOL_PROFILES.arxiv;
  return resolveBaseResults(settings.arxiv.maxResults, profile.defaultBaseResults, profile.maxResults);
}

function resolveSingleQueryMaxResults(input: z.infer<typeof inputSchema>): number {
  const profile = SEARCH_TOOL_PROFILES.arxiv;
  return resolveResultCount({
    explicitCount: undefined,
    resultLevel: input.resultLevel,
    baseCount: resolveBaseCount(),
    maxCount: profile.maxResults,
  });
}

function resolveMultiQueryCounts(input: z.infer<typeof inputSchema>, queryCount: number): { resultsPerQuery: number; maxTotal: number } {
  const profile = SEARCH_TOOL_PROFILES.arxiv;
  const baseCount = resolveBaseCount();

  const maxTotal = resolveResultCount({
    explicitCount: undefined,
    resultLevel: input.resultLevel,
    baseCount,
    maxCount: profile.maxResults,
  });

  const resultsPerQuery = resolveResultCount({
    explicitCount: undefined,
    resultLevel: undefined,
    baseCount: Math.max(1, Math.ceil(maxTotal / Math.max(1, queryCount))),
    maxCount: profile.maxResults,
  });

  return {
    resultsPerQuery,
    maxTotal,
  };
}

export const arxivSearchTool: NativeTool = {
  name: "arxiv-search",
  description: "搜索 arXiv 论文，支持关键词检索和按 arXiv ID 获取元数据。适合搜索计算机/AI领域的论文",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    try {
      let rawData: unknown;

      if (input.arxivId) {
        rawData = await client.getPaper(input.arxivId);
      } else if (input.queries && input.queries.length > 0) {
        const counts = resolveMultiQueryCounts(input, input.queries.length);
        rawData = await client.searchMultipleQueries(
          input.queries,
          counts.resultsPerQuery,
          counts.maxTotal,
        );
      } else {
        const keywords = resolveKeywords(input);
        if (!keywords) {
          return { ok: false, value: "Error: Either arxivId, queries, keywords, or query must be provided." };
        }
        const maxResults = resolveSingleQueryMaxResults(input);
        rawData = await client.search({
          keywords,
          categories: input.categories,
          maxResults,
        });
      }

      if (input.raw) {
        return { value: JSON.stringify(rawData) };
      }

      const llmOptions = resolveSummaryLLMOptions("arxiv-search");
      if (!llmOptions) {
        return { value: JSON.stringify(rawData) };
      }

      const summaryResult = await summarizeSearchResults(
        { toolId: "arxiv-search", input, data: rawData },
        llmOptions,
      );

      if (summaryResult.ok && summaryResult.summary) {
        const count = Array.isArray(rawData) ? rawData.length : undefined;
        const prefix = count !== undefined ? `[共 ${count} 条结果]\n\n` : "";
        return { value: `${prefix}${summaryResult.summary}` };
      }

      return { value: JSON.stringify(rawData) };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "arXiv tool failed"}` };
    }
  },
};
