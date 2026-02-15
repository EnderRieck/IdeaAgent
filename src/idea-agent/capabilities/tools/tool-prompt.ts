import path from "node:path";
import type { IdeaAgentSettings } from "../../config/settings";
import {
  SEARCH_TOOL_PROFILES,
  appendResultLevelHint,
  buildResultLevelCounts,
  resolveBaseResults,
} from "./search-result-level";

/**
 * Shared interface for tool prompt specifications used by all sub-agents.
 */
export interface ToolPromptSpec {
  id: string;
  inputHint: string;
  inputFields?: Array<{
    name: string;
    type: string;
    required?: boolean;
  }>;
}

/**
 * Format inputFields into a compact schema string for LLM prompts.
 */
export function formatToolSchema(
  fields: Array<{ name: string; type: string; required?: boolean }> | undefined,
): string {
  if (!fields || fields.length === 0) {
    return "{}";
  }

  const entries = fields
    .map((field) => `${field.name}:${field.type}(${field.required === false ? "optional" : "required"})`)
    .join(", ");
  return entries.length > 0 ? `{${entries}}` : "{}";
}

/**
 * Build LLM prompt lines listing available tools with schema and inputHint.
 */
export function buildToolPromptLines(tools: ToolPromptSpec[]): string {
  if (tools.length === 0) {
    return "- (none)";
  }

  return tools
    .map((tool) => {
      const schema = formatToolSchema(tool.inputFields);
      const inputHint = tool.inputHint?.trim().length ? tool.inputHint : "{}";
      return `- ${tool.id}: schema=${schema}; inputHint=${inputHint}`;
    })
    .join("\n");
}

/**
 * Enrich a tool's inputHint with runtime settings (search result levels, web-fetch storage dir, etc.).
 * Originally only in deep-search-agent; now available to all agents.
 */
export function buildToolInputHint(
  toolId: string,
  fallbackHint: string | undefined,
  settings: IdeaAgentSettings,
): string {
  const baseHint = fallbackHint?.trim().length ? fallbackHint : "{}";

  switch (toolId) {
    case "web-search": {
      const profile = SEARCH_TOOL_PROFILES.web;
      const base = resolveBaseResults(settings.web.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(baseHint, counts);
    }

    case "arxiv-search": {
      const profile = SEARCH_TOOL_PROFILES.arxiv;
      const base = resolveBaseResults(settings.arxiv.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(baseHint, counts);
    }

    case "openalex-search": {
      const profile = SEARCH_TOOL_PROFILES.openalex;
      const base = resolveBaseResults(settings.openalex.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(baseHint, counts);
    }

    case "web-fetch": {
      const storageDir = path.resolve(process.cwd(), settings.memory.dataDir ?? ".idea-agent-data", "session_data", "downloads");
      return `${baseHint}; defaultStorageDir=${storageDir}; download后请将返回的filePath传给mineru-parse.filePath`;
    }

    default:
      return baseHint;
  }
}
