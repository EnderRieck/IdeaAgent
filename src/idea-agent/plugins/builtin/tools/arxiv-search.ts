import { z } from "zod";
import { ArxivClient } from "../clients/arxiv-client";
import {
  SEARCH_TOOL_PROFILES,
  resolveBaseResults,
  resolveResultCount,
  resultLevelSchema,
} from "../../../capabilities/tools/search-result-level";
import type { Tool } from "../../../capabilities/tools/types";
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

export const arxivSearchTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "arxiv-search",
  description: "Search arXiv papers and fetch metadata by arXiv ID.",
  inputHint:
    '{"keywords":"llm agent memory","resultLevel":"less|mid|more|extreme"} | {"arxivId":"2401.12345"} | {"queries":["agent memory","rag"],"resultLevel":"mid"}',
  inputSchema,
  async execute(input) {
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
          return { ok: false, error: "Either arxivId, queries, keywords, or query must be provided." };
        }
        const maxResults = resolveSingleQueryMaxResults(input);
        rawData = await client.search({
          keywords,
          categories: input.categories,
          maxResults,
        });
      }

      if (input.raw) {
        return { ok: true, data: rawData };
      }

      const llmOptions = resolveSummaryLLMOptions("arxiv-search");
      if (!llmOptions) {
        return { ok: true, data: rawData };
      }

      const summaryResult = await summarizeSearchResults(
        { toolId: "arxiv-search", input, data: rawData },
        llmOptions,
      );

      if (summaryResult.ok && summaryResult.summary) {
        const count = Array.isArray(rawData) ? rawData.length : undefined;
        const prefix = count !== undefined ? `[共 ${count} 条结果]\n\n` : "";
        return { ok: true, data: `${prefix}${summaryResult.summary}` };
      }

      // silent fallback to raw data
      return { ok: true, data: rawData };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "arXiv tool failed" };
    }
  },
};
