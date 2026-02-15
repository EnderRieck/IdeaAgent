import type { IdeaAgentSettings } from "../../config/settings";
import { getIdeaAgentSettings } from "../../config/settings";
import { getToolRuntimeProfile } from "../../config/tool-config";
import { RejectingApprovalGate } from "../../runtime/approval-gate";
import { ToolInvoker } from "./invoker";
import type { ToolPolicy } from "./policy";
import { ToolRegistry } from "./registry";
import type { ToolPromptSpec } from "./tool-prompt";
import { buildToolInputHint } from "./tool-prompt";
import type { Tool } from "./types";

export type ToolCatalog = Record<string, Tool>;

export interface ToolSetupResult {
  resolvedToolIds: string[];
  registry: ToolRegistry;
  invoker: ToolInvoker;
  promptSpecs: ToolPromptSpec[];
  toolIdSet: Set<string>;
}

export function setupTools(options: {
  catalog: ToolCatalog;
  allowedTools: string[];
  settings?: IdeaAgentSettings;
  sensitiveToolIds?: string[];
}): ToolSetupResult {
  const settings = options.settings ?? getIdeaAgentSettings();
  const sensitiveToolIds = options.sensitiveToolIds ?? ["local-cli"];

  // 1. Filter allowedTools ∩ catalog
  const resolvedToolIds = options.allowedTools
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => item in options.catalog);

  // 2. Create registry and register matched tools
  const registry = new ToolRegistry();
  for (const toolId of resolvedToolIds) {
    registry.register(options.catalog[toolId]);
  }

  // 3. Collect per-tool timeout overrides
  const policyOverrides: Record<string, Partial<ToolPolicy>> = {};
  for (const toolId of resolvedToolIds) {
    const tool = registry.get(toolId);
    if (!tool) continue;

    const runtimeProfile = getToolRuntimeProfile(toolId, {
      description: tool.description,
      inputHint: tool.inputHint,
      inputFields: tool.inputFields,
      outputFormat: tool.outputFormat,
    });

    if (typeof runtimeProfile.timeoutMs === "number") {
      policyOverrides[toolId] = { timeoutMs: runtimeProfile.timeoutMs };
    }
  }

  // 4. Create invoker with approval gate + policy + overrides
  const defaultPolicy: ToolPolicy = {
    timeoutMs: settings.runtime.toolDefaultTimeoutMs ?? 30_000,
  };

  const invoker = new ToolInvoker(
    registry,
    new RejectingApprovalGate(new Set(sensitiveToolIds)),
    defaultPolicy,
    () => new Date().toISOString(),
    Object.keys(policyOverrides).length > 0 ? policyOverrides : undefined,
  );

  // 5. Build prompt specs with runtime hints
  const promptSpecs: ToolPromptSpec[] = resolvedToolIds.map((toolId) => {
    const tool = registry.get(toolId);
    if (!tool) {
      return {
        id: toolId,
        inputHint: buildToolInputHint(toolId, undefined, settings),
        inputFields: undefined,
      };
    }

    const runtimeProfile = getToolRuntimeProfile(toolId, {
      description: tool.description,
      inputHint: tool.inputHint,
      inputFields: tool.inputFields,
      outputFormat: tool.outputFormat,
    });

    return {
      id: toolId,
      inputHint: buildToolInputHint(toolId, runtimeProfile.inputHint, settings),
      inputFields: runtimeProfile.inputFields,
    };
  });

  return {
    resolvedToolIds,
    registry,
    invoker,
    promptSpecs,
    toolIdSet: new Set(resolvedToolIds),
  };
}
