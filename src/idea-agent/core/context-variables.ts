// ── Context Variables ───────────────────────────────────────────────
// Out-of-band state channel invisible to LLM. Tools can read/write.
// Used for rendering dynamic system prompts and passing state between tools.

export type ContextVariables = Record<string, unknown>;

// ── Tool Execution Result ──────────────────────────────────────────

export interface ToolExecutionResult {
  /** Whether the tool executed successfully (default: true) */
  ok?: boolean;
  /** Text returned to LLM as tool result */
  value: string;
  /** Optional: update context_variables (shallow merge) */
  contextVariables?: Partial<ContextVariables>;
  /** Optional: switch active agent (phase transition) */
  agent?: AgentDefinition;
  /** Optional: base64 encoded image returned by tool */
  image?: string;
}

// ── Agent Definition ───────────────────────────────────────────────
// Replaces the old MainAgent / LLMMainAgent interface.

export interface AgentDefinition {
  name: string;
  model?: string;
  /** Static string or dynamic function rendering system prompt from context */
  instructions: string | ((ctx: ContextVariables) => string);
  /** Tool name list — references tools registered in the global registry */
  tools: string[];
  toolChoice?: "auto" | "required" | "none";
  temperature?: number;
  /** Hidden user message injected into history when this phase starts.
   *  Not rendered in UI — only visible to LLM. Replaces the old "goal" mechanism. */
  phasePrompt?: string | ((ctx: ContextVariables) => string);
}
