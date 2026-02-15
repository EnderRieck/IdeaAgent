import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ToolRuntimeProfile } from "../capabilities/tools/types";

export type ToolExtraConfigs = Record<string, unknown>;

const inputFieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().optional(),
  description: z.string().min(1).optional(),
});

const extraConfigsSchema = z.record(z.unknown());

const profilePatchSchema = z
  .object({
    description: z.string().min(1).optional(),
    inputHint: z.string().min(1).optional(),
    inputFields: z.array(inputFieldSchema).optional(),
    outputFormat: z.string().min(1).optional(),
    extraConfigs: extraConfigsSchema.optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .partial();

const toolConfigFileSchema = z
  .object({
    tools: z.record(profilePatchSchema).optional(),
  })
  .partial();

type ToolProfilePatch = z.infer<typeof profilePatchSchema>;

interface ToolConfigFile {
  tools?: Record<string, ToolProfilePatch>;
}

function resolveConfigPath(explicitPath?: string): string {
  return (
    explicitPath
    ?? process.env.IDEA_AGENT_TOOLS_CONFIG_PATH
    ?? path.resolve(process.cwd(), "tools.config.json")
  );
}

function normalizeInputFields(input: ToolRuntimeProfile["inputFields"]): ToolRuntimeProfile["inputFields"] {
  if (!input || input.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const out: NonNullable<ToolRuntimeProfile["inputFields"]> = [];
  for (const item of input) {
    const key = item.name.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      name: key,
      type: item.type.trim(),
      required: item.required,
      description: item.description?.trim() || undefined,
    });
  }

  return out.length > 0 ? out : undefined;
}

function normalizeExtraConfigs(raw?: ToolExtraConfigs): ToolExtraConfigs | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw;
}

function loadConfigFile(configPath?: string): ToolConfigFile {
  const resolved = resolveConfigPath(configPath);
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  return toolConfigFileSchema.parse(parsed);
}

function normalizePatch(patch: ToolProfilePatch): {
  description?: string;
  inputHint?: string;
  inputFields?: ToolRuntimeProfile["inputFields"];
  outputFormat?: string;
  extraConfigs?: ToolExtraConfigs;
  timeoutMs?: number;
} {
  return {
    description: patch.description,
    inputHint: patch.inputHint,
    inputFields: patch.inputFields,
    outputFormat: patch.outputFormat,
    extraConfigs: normalizeExtraConfigs(patch.extraConfigs as ToolExtraConfigs | undefined),
    timeoutMs: patch.timeoutMs,
  };
}

export function getToolRuntimeProfile(
  toolId: string,
  defaults: ToolRuntimeProfile,
  options?: {
    configPath?: string;
    override?: Partial<ToolRuntimeProfile>;
  },
): ToolRuntimeProfile {
  const rawPatch = loadConfigFile(options?.configPath).tools?.[toolId] ?? {};
  const fromFile = normalizePatch(rawPatch);
  const merged = {
    ...defaults,
    ...fromFile,
    ...(options?.override ?? {}),
  };

  return {
    description: merged.description?.trim() || defaults.description,
    inputHint: merged.inputHint?.trim() || defaults.inputHint,
    inputFields: normalizeInputFields(merged.inputFields) ?? defaults.inputFields,
    outputFormat: merged.outputFormat?.trim() || defaults.outputFormat,
    extraConfigs: normalizeExtraConfigs(merged.extraConfigs) ?? defaults.extraConfigs,
    timeoutMs: merged.timeoutMs,
  };
}

export function getToolExtraConfigs(toolId: string, options?: { configPath?: string }): ToolExtraConfigs {
  const rawPatch = loadConfigFile(options?.configPath).tools?.[toolId];
  if (!rawPatch) {
    return {};
  }

  const normalized = normalizePatch(rawPatch);
  return normalized.extraConfigs ?? {};
}
