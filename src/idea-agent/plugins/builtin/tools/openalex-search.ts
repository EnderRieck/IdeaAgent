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
import { OpenAlexClient } from "../clients/openalex-client";

const supportedActions = [
  "get_paper",
  "get_paper_by_id",
  "get_references",
  "get_citations",
  "search_papers",
  "search_multi_query",
  "get_citations_by_oa_id",
  "expand_citation_network",
] as const;

type OpenAlexAction = (typeof supportedActions)[number];

const actionSet = new Set<string>(supportedActions);

const inputSchema = z.object({
  action: z.string().optional(),
  arxivId: z.string().optional(),
  title: z.string().optional(),
  openalexId: z.string().optional(),
  keywords: z.string().optional(),
  query: z.string().optional(),
  queries: z.array(z.string()).optional(),
  resultLevel: resultLevelSchema.optional(),
  minYear: z.number().int().optional(),
  minCitations: z.number().int().nonnegative().default(10).optional(),
  seedPapers: z
    .array(
      z.object({
        openalexId: z.string(),
        arxivId: z.string().optional(),
        doi: z.string().optional(),
        title: z.string().default(""),
        abstract: z.string().optional(),
        year: z.number().optional(),
        citationCount: z.number().default(0),
        authors: z.array(z.string()).default([]),
        venue: z.string().optional(),
        referencedWorks: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  maxRefsPerPaper: z.number().int().positive().max(100).default(10).optional(),
  maxCitationsPerPaper: z.number().int().positive().max(50).default(5).optional(),
  raw: z.boolean().default(false).optional(),
});

const DEFAULT_REFERENCED_WORKS_LIMIT = 10;

function readExtraString(extra: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = extra[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readExtraPositiveInt(
  extra: Record<string, unknown>,
  keys: string[],
  fallback: number,
  max: number = 1000,
): number {
  for (const key of keys) {
    const value = extra[key];
    const parsed = typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

    if (Number.isFinite(parsed)) {
      const normalized = Math.floor(parsed);
      if (normalized > 0) {
        return Math.min(normalized, max);
      }
    }
  }

  return fallback;
}

function getOpenAlexExtraConfig(): { apiKey?: string; email?: string; referencedWorksLimit: number } {
  const extra = getToolExtraConfigs("openalex-search");
  return {
    apiKey: readExtraString(extra, ["apiKey", "api_key", "openalexApiKey", "openalex_api_key"]),
    email: readExtraString(extra, ["email", "mailTo", "mailto"]),
    referencedWorksLimit: readExtraPositiveInt(
      extra,
      ["referencedWorksLimit", "referenced_works_limit"],
      DEFAULT_REFERENCED_WORKS_LIMIT,
      1000,
    ),
  };
}

function createClient(): OpenAlexClient {
  const settings = getIdeaAgentSettings();
  const extra = getOpenAlexExtraConfig();
  return new OpenAlexClient({
    apiKey: extra.apiKey ?? settings.openalex.apiKey,
    email: extra.email ?? settings.openalex.email,
  });
}

function resolveBaseCount(): number {
  const settings = getIdeaAgentSettings();
  const profile = SEARCH_TOOL_PROFILES.openalex;
  return resolveBaseResults(settings.openalex.maxResults, profile.defaultBaseResults, profile.maxResults);
}

function resolveAction(rawInput: z.infer<typeof inputSchema>): OpenAlexAction | undefined {
  const normalized = normalizeAction(rawInput.action);
  return normalized ?? inferAction(rawInput);
}

function normalizeAction(raw?: string): OpenAlexAction | undefined {
  if (!raw) {
    return undefined;
  }

  const lower = raw.trim().toLowerCase();
  if (actionSet.has(lower)) {
    return lower as OpenAlexAction;
  }

  const aliases: Record<string, OpenAlexAction> = {
    search: "search_papers",
    search_paper: "search_papers",
    searchpapers: "search_papers",
    paper: "get_paper",
    getpaper: "get_paper",
    paper_by_id: "get_paper_by_id",
    get_by_id: "get_paper_by_id",
    references: "get_references",
    citations: "get_citations",
    citations_by_oa_id: "get_citations_by_oa_id",
    expand_network: "expand_citation_network",
    expand: "expand_citation_network",
    multi_query: "search_multi_query",
    search_multi: "search_multi_query",
  };

  return aliases[lower];
}

function inferAction(input: z.infer<typeof inputSchema>): OpenAlexAction | undefined {
  if (input.seedPapers && input.seedPapers.length > 0) {
    return "expand_citation_network";
  }

  if (input.queries && input.queries.length > 0) {
    return "search_multi_query";
  }

  if (input.keywords || input.query) {
    return "search_papers";
  }

  if (input.arxivId) {
    return "get_paper";
  }

  if (input.openalexId) {
    return "get_paper_by_id";
  }

  return undefined;
}

function resolveKeywords(input: z.infer<typeof inputSchema>): string | undefined {
  return input.keywords ?? input.query;
}

function resolveQueryList(input: z.infer<typeof inputSchema>): string[] {
  if (input.queries && input.queries.length > 0) {
    return input.queries;
  }

  const keywordLike = resolveKeywords(input);
  if (!keywordLike) {
    return [];
  }

  const split = keywordLike
    .split(/[\n,;|]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (split.length > 1) {
    return split;
  }

  return [keywordLike.trim()];
}

function resolveResultWindow(params: {
  explicitCount?: number;
  resultLevel?: z.infer<typeof resultLevelSchema>;
  baseCount?: number;
}): number {
  const profile = SEARCH_TOOL_PROFILES.openalex;
  return resolveResultCount({
    explicitCount: params.explicitCount,
    resultLevel: params.resultLevel,
    baseCount: params.baseCount ?? resolveBaseCount(),
    maxCount: profile.maxResults,
  });
}

function truncateReferencedWorks(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => truncateReferencedWorks(item, limit));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(record)) {
    if (key === "referencedWorks" && Array.isArray(item)) {
      next[key] = item.slice(0, limit);
      continue;
    }

    next[key] = truncateReferencedWorks(item, limit);
  }

  return next;
}

export const openAlexSearchTool: NativeTool = {
  name: "openalex-search",
  description: "OpenAlex 学术搜索与引用网络操作。适合传统领域的论文，AI、计算机等新兴领域可能无法及时涵盖",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    const openAlexExtra = getOpenAlexExtraConfig();
    const referencedWorksLimit = openAlexExtra.referencedWorksLimit;
    const client = createClient();

    try {
      const action = resolveAction(input);
      if (!action) {
        return {
          ok: false,
          value: `Error: action is required. Supported actions: ${supportedActions.join(", ")}. For semantic search, use {"action":"search_papers","keywords":"..."}.`,
        };
      }

      let rawData: unknown;

      switch (action) {
        case "get_paper": {
          if (!input.arxivId) {
            return { ok: false, value: "Error: arxivId is required for get_paper" };
          }
          const paper = await client.getPaper(input.arxivId, input.title);
          rawData = truncateReferencedWorks(paper ?? null, referencedWorksLimit);
          break;
        }

        case "get_paper_by_id": {
          if (!input.openalexId) {
            return { ok: false, value: "Error: openalexId is required for get_paper_by_id" };
          }
          rawData = truncateReferencedWorks(await client.getPaperById(input.openalexId), referencedWorksLimit);
          break;
        }

        case "get_references": {
          if (!input.arxivId) {
            return { ok: false, value: "Error: arxivId is required for get_references" };
          }
          const limit = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: input.resultLevel,
          });
          rawData = await client.getReferences(input.arxivId, limit);
          break;
        }

        case "get_citations": {
          if (!input.arxivId) {
            return { ok: false, value: "Error: arxivId is required for get_citations" };
          }
          const limit = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: input.resultLevel,
          });
          rawData = await client.getCitations(input.arxivId, limit);
          break;
        }

        case "search_papers": {
          const keywords = resolveKeywords(input);
          if (!keywords) {
            return { ok: false, value: "Error: keywords or query is required for search_papers" };
          }
          const maxResults = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: input.resultLevel,
          });
          const papers = await client.searchPapers(
            keywords,
            input.minCitations ?? 10,
            input.minYear ?? 2018,
            maxResults,
          );
          rawData = truncateReferencedWorks(papers, referencedWorksLimit);
          break;
        }

        case "search_multi_query": {
          const queries = resolveQueryList(input);
          if (queries.length === 0) {
            return { ok: false, value: "Error: queries is required for search_multi_query" };
          }
          const maxTotal = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: input.resultLevel,
          });
          const resultsPerQuery = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: undefined,
            baseCount: Math.max(1, Math.ceil(maxTotal / Math.max(1, queries.length))),
          });
          const papers = await client.searchPapersMultiQuery(
            queries,
            input.minCitations ?? 10,
            input.minYear ?? 2018,
            resultsPerQuery,
            maxTotal,
          );
          rawData = truncateReferencedWorks(papers, referencedWorksLimit);
          break;
        }

        case "get_citations_by_oa_id": {
          if (!input.openalexId) {
            return { ok: false, value: "Error: openalexId is required for get_citations_by_oa_id" };
          }
          const limit = resolveResultWindow({
            explicitCount: undefined,
            resultLevel: input.resultLevel,
          });
          rawData = await client.getCitationsByOaId(input.openalexId, limit, input.minYear);
          break;
        }

        case "expand_citation_network": {
          if (!input.seedPapers || input.seedPapers.length === 0) {
            return { ok: false, value: "Error: seedPapers is required for expand_citation_network" };
          }
          rawData = truncateReferencedWorks(
            await client.expandCitationNetwork(
              input.seedPapers,
              input.maxRefsPerPaper ?? 10,
              input.maxCitationsPerPaper ?? 5,
              input.minCitations ?? 5,
            ),
            referencedWorksLimit,
          );
          break;
        }
      }

      if (input.raw) {
        return { value: JSON.stringify(rawData) };
      }

      const llmOptions = resolveSummaryLLMOptions("openalex-search");
      if (!llmOptions) {
        return { value: JSON.stringify(rawData) };
      }

      const summaryResult = await summarizeSearchResults(
        { toolId: "openalex-search", input, data: rawData },
        llmOptions,
      );

      if (summaryResult.ok && summaryResult.summary) {
        const count = Array.isArray(rawData) ? rawData.length : undefined;
        const prefix = count !== undefined ? `[共 ${count} 条结果]\n\n` : "";
        return { value: `${prefix}${summaryResult.summary}` };
      }

      return { value: JSON.stringify(rawData) };
    } catch (error) {
      return {
        ok: false,
        value: `Error: ${error instanceof Error ? error.message : "OpenAlex tool failed"}`,
      };
    }
  },
};
