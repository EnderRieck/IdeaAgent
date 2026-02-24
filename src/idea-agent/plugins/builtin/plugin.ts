import type { NativeTool } from "../../core/native-tool";
import type { AgentDefinition } from "../../core/context-variables";
import { builtinToolCatalog, builtinToolList } from "./tool-catalog";
import {
  deepSearchAgentDefinition,
  deepSearchAgentId,
  deepSearchAgentDescription,
} from "./subagents/deep-search-agent";
import {
  reviewerAgentDefinition,
  reviewerAgentId,
  reviewerAgentDescription,
} from "./subagents/reviewer-agent";
import {
  paperSummaryAgentDefinition,
  paperSummaryAgentId,
  paperSummaryAgentDescription,
} from "./subagents/paper-summary-agent";

// ── SubAgent descriptor (for registration) ────────────────────────

export interface SubAgentDescriptor {
  id: string;
  description: string;
  definition: AgentDefinition;
  maxTurns?: number;
}

// ── Builtin Plugin ────────────────────────────────────────────────

export interface BuiltinPluginExport {
  tools: NativeTool[];
  toolCatalog: Record<string, NativeTool>;
  subAgentDescriptors: SubAgentDescriptor[];
}

export const builtinPlugin: BuiltinPluginExport = {
  tools: builtinToolList,
  toolCatalog: builtinToolCatalog,
  subAgentDescriptors: [
    {
      id: deepSearchAgentId,
      description: deepSearchAgentDescription,
      definition: deepSearchAgentDefinition,
      maxTurns: 6,
    },
    {
      id: reviewerAgentId,
      description: reviewerAgentDescription,
      definition: reviewerAgentDefinition,
      maxTurns: 6,
    },
    {
      id: paperSummaryAgentId,
      description: paperSummaryAgentDescription,
      definition: paperSummaryAgentDefinition,
      maxTurns: 8,
    },
  ],
};
