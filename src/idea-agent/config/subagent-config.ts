import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SubAgentRuntimeProfile } from "../capabilities/subagents/types";

const profilePatchSchema = z
  .object({
    model: z.string().min(1).optional(),
    systemPrompt: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().positive().max(1000).optional(),
    summaryModel: z.string().min(1).optional(),
  })
  .partial();

const subAgentConfigFileSchema = z
  .object({
    subAgents: z.record(profilePatchSchema).optional(),
  })
  .partial();

interface SubAgentConfigFile {
  subAgents?: Record<string, z.infer<typeof profilePatchSchema>>;
}

function resolveConfigPath(explicitPath?: string): string {
  return (
    explicitPath
    ?? process.env.IDEA_AGENT_SUBAGENTS_CONFIG_PATH
    ?? path.resolve(process.cwd(), "subagents.config.json")
  );
}

function normalizeAllowedTools(input: string[] | undefined, fallback: string[]): string[] {
  const base = input ?? fallback;
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of base) {
    const item = raw.trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }

  return out;
}

function loadConfigFile(configPath?: string): SubAgentConfigFile {
  const resolved = resolveConfigPath(configPath);
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return subAgentConfigFileSchema.parse(parsed);
}

export function getSubAgentRuntimeProfile(
  subAgentId: string,
  defaults: SubAgentRuntimeProfile,
  options?: {
    configPath?: string;
    override?: Partial<SubAgentRuntimeProfile>;
  },
): SubAgentRuntimeProfile {
  const fromFile = loadConfigFile(options?.configPath).subAgents?.[subAgentId] ?? {};
  const merged = {
    ...defaults,
    ...fromFile,
    ...(options?.override ?? {}),
  };

  return {
    model: merged.model?.trim() || defaults.model,
    systemPrompt: merged.systemPrompt?.trim() || defaults.systemPrompt,
    allowedTools: normalizeAllowedTools(merged.allowedTools, defaults.allowedTools),
    maxTurns: typeof merged.maxTurns === "number"
      ? Math.max(1, Math.min(1000, Math.floor(merged.maxTurns)))
      : defaults.maxTurns,
    summaryModel: merged.summaryModel?.trim() || defaults.summaryModel,
  };
}
