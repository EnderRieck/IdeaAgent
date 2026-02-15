import { z } from "zod";

export const resultLevelValues = ["less", "mid", "more", "extreme"] as const;

export const resultLevelSchema = z.enum(resultLevelValues);

export type ResultLevel = (typeof resultLevelValues)[number];

export interface ResultLevelCounts {
  less: number;
  mid: number;
  more: number;
  extreme: number;
}

const resultLevelFactor: Record<ResultLevel, number> = {
  less: 0.2,
  mid: 0.5,
  more: 1,
  extreme: 3,
};

export const SEARCH_TOOL_PROFILES = {
  web: {
    defaultBaseResults: 5,
    maxResults: 3000,
  },
  arxiv: {
    defaultBaseResults: 30,
    maxResults: 3000,
  },
  openalex: {
    defaultBaseResults: 100,
    maxResults: 3000,
  },
} as const;

function floorPositiveInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.floor(value));
}

export function clampCount(value: number, maxCount: number, minCount: number = 1): number {
  const normalizedMax = floorPositiveInt(maxCount);
  const normalizedMin = Math.max(1, floorPositiveInt(minCount));
  return Math.max(normalizedMin, Math.min(normalizedMax, floorPositiveInt(value)));
}

export function resolveBaseResults(configuredBase: number | undefined, fallbackBase: number, maxCount: number): number {
  if (typeof configuredBase !== "number") {
    return clampCount(fallbackBase, maxCount);
  }

  return clampCount(configuredBase, maxCount);
}

export function buildResultLevelCounts(baseCount: number, maxCount: number, minCount: number = 1): ResultLevelCounts {
  const base = clampCount(baseCount, maxCount, minCount);

  return {
    less: clampCount(Math.ceil(base * resultLevelFactor.less), maxCount, minCount),
    mid: clampCount(Math.ceil(base * resultLevelFactor.mid), maxCount, minCount),
    more: clampCount(Math.ceil(base * resultLevelFactor.more), maxCount, minCount),
    extreme: clampCount(Math.ceil(base * resultLevelFactor.extreme), maxCount, minCount),
  };
}

export function resolveResultCount(params: {
  explicitCount?: number;
  resultLevel?: ResultLevel;
  baseCount: number;
  maxCount: number;
  minCount?: number;
}): number {
  if (typeof params.explicitCount === "number") {
    return clampCount(params.explicitCount, params.maxCount, params.minCount);
  }

  const counts = buildResultLevelCounts(params.baseCount, params.maxCount, params.minCount);
  const level = params.resultLevel ?? "more";
  return counts[level];
}

export function formatResultLevelCounts(counts: ResultLevelCounts): string {
  return `less=${counts.less}, mid=${counts.mid}, more=${counts.more}, extreme=${counts.extreme}`;
}

export function appendResultLevelHint(inputHint: string | undefined, counts: ResultLevelCounts): string {
  const hint = inputHint?.trim() ?? "{}";
  return `${hint}; resultLevel=less|mid|more|extreme（当前配置条数: ${formatResultLevelCounts(counts)}）`;
}
