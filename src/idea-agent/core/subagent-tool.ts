import { z } from "zod";
import type { NativeTool } from "./native-tool";
import type { ContextVariables, AgentDefinition } from "./context-variables";
import type { LLMClient } from "./llm-client";
import type { MessageCompressor } from "./message-compressor";
import { runAgentLoop } from "./agent-loop";
import type { ChatMessage } from "./types";
import type { EventBus } from "./event-bus";

// ── SubAgent Tool Config ───────────────────────────────────────────

export interface SubAgentToolConfig {
  name: string;
  description: string;
  agentDefinition: AgentDefinition;
  toolRegistry: Map<string, NativeTool>;
  llmClient: LLMClient;
  maxTurns?: number;
  compressor?: MessageCompressor;
  eventBus?: EventBus;
}

// ── Create SubAgent as NativeTool ──────────────────────────────────

export function createSubAgentTool(config: SubAgentToolConfig): NativeTool {
  return {
    name: config.name,
    description: config.description,
    inputSchema: z.object({
      task: z.string().min(1).describe("The task description for the sub-agent to execute"),
    }),
    async execute(input: { task: string }, contextVariables) {
      // SubAgent owns independent messages (isolation!)
      const subMessages: ChatMessage[] = [
        { role: "user", content: input.task },
      ];

      // Deep-copy context_variables to prevent pollution
      const subCtx: ContextVariables = JSON.parse(JSON.stringify(contextVariables));

      const result = await runAgentLoop({
        agent: config.agentDefinition,
        initialMessages: subMessages,
        contextVariables: subCtx,
        toolRegistry: config.toolRegistry,
        llmClient: config.llmClient,
        maxTurns: config.maxTurns ?? 10,
        compressor: config.compressor,
        eventBus: config.eventBus,
      });

      // If the agent loop returned an error, surface it
      if (result.error) {
        return { value: `SubAgent error: ${result.error}` };
      }

      // Extract final output: last assistant message with real content
      const lastContent = result.messages
        .filter((m): m is Extract<ChatMessage, { role: "assistant" }> =>
          m.role === "assistant" && !!m.content && m.content !== "<empty>",
        )
        .pop()?.content ?? "SubAgent completed without output.";

      return {
        value: typeof lastContent === "string" ? lastContent : "SubAgent completed.",
      };
    },
  };
}
