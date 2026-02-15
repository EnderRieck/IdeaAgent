import type { PluginModule } from "../types";
import { builtinToolCatalog, builtinToolList } from "./tool-catalog";
import { deepSearchAgent } from "./subagents/deep-search-agent";
import { reviewerAgent } from "./subagents/reviewer-agent";
import { paperSummaryAgent } from "./subagents/paper-summary-agent";

export const builtinPlugin: PluginModule = {
  manifest: {
    id: "builtin-capabilities",
    version: "0.1.0",
    name: "Builtin capabilities",
    capabilities: {
      tools: Object.keys(builtinToolCatalog),
      subagents: [deepSearchAgent.id, reviewerAgent.id, paperSummaryAgent.id],
    },
  },
  tools: builtinToolList,
  subAgents: [deepSearchAgent, reviewerAgent, paperSummaryAgent],
};
