import type { ChatMessage, ToolCall, ToolDefinition } from "./types";
import type { ContextVariables, AgentDefinition } from "./context-variables";
import type { NativeTool } from "./native-tool";
import { toToolDefinition } from "./native-tool";
import type { LLMClient } from "./llm-client";
import type { MessageCompressor } from "./message-compressor";
import type { EventBus } from "./event-bus";

// ── Types ──────────────────────────────────────────────────────────

export interface ApprovalGate {
  shouldApprove(toolName: string, input: unknown): Promise<boolean>;
}

export interface AgentLoopOptions {
  agent: AgentDefinition;
  initialMessages: ChatMessage[];
  contextVariables: ContextVariables;
  toolRegistry: Map<string, NativeTool>;
  llmClient: LLMClient;
  maxTurns?: number;
  compressor?: MessageCompressor;
  contextWindowLimit?: number;
  keepRecentN?: number;
  eventBus?: EventBus;
  approvalGate?: ApprovalGate;
  sessionId?: string;
  runId?: string;
  onTurnEnd?: (messages: ChatMessage[]) => void | Promise<void>;
  /** When set, the loop waits for user input instead of breaking on no tool_calls (MainAgent mode). */
  waitForUserInput?: () => Promise<string | null>;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  contextVariables: ContextVariables;
  lastAgent: AgentDefinition;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function renderInstructions(
  instructions: string | ((ctx: ContextVariables) => string),
  ctx: ContextVariables,
): string {
  return typeof instructions === "function" ? instructions(ctx) : instructions;
}

function renderPhasePrompt(
  phasePrompt: string | ((ctx: ContextVariables) => string) | undefined,
  ctx: ContextVariables,
): string | undefined {
  if (!phasePrompt) return undefined;
  return typeof phasePrompt === "function" ? phasePrompt(ctx) : phasePrompt;
}

function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.role === "system" || m.role === "tool") {
      chars += m.content.length;
    } else if (m.role === "user") {
      chars += typeof m.content === "string"
        ? m.content.length
        : m.content.reduce((acc, p) => acc + (p.type === "text" ? p.text.length : 100), 0);
    } else if (m.role === "assistant") {
      chars += (m.content ?? "").length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          chars += tc.function.name.length + tc.function.arguments.length;
        }
      }
    }
  }
  // Rough estimate: ~4 chars per token
  return Math.ceil(chars / 4);
}

// ── Core Agent Loop ────────────────────────────────────────────────

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    llmClient,
    toolRegistry,
    compressor,
    contextWindowLimit = 120_000,
    keepRecentN = 10,
    maxTurns = 20,
    eventBus,
    approvalGate,
    sessionId = "default",
    runId = `run_${Date.now()}`,
    onTurnEnd,
    waitForUserInput,
  } = options;

  const history: ChatMessage[] = [...options.initialMessages];
  const contextVariables: ContextVariables = deepCopy(options.contextVariables);
  let activeAgent = options.agent;

  // Inject initial phase prompt (replaces old goal mechanism)
  const initialPhasePrompt = renderPhasePrompt(activeAgent.phasePrompt, contextVariables);
  if (initialPhasePrompt) {
    history.push({ role: "user", content: initialPhasePrompt });
  }

  try {
  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. Render system prompt
    const systemContent = renderInstructions(activeAgent.instructions, contextVariables);

    // 2. Resolve tools for current agent
    const agentTools: NativeTool[] = [];
    const toolDefs: ToolDefinition[] = [];
    for (const name of activeAgent.tools) {
      const tool = toolRegistry.get(name);
      if (tool) {
        agentTools.push(tool);
        toolDefs.push(toToolDefinition(tool));
      }
    }

    // 3. Compress if needed
    if (compressor && estimateTokens(history) > contextWindowLimit * 0.8) {
      const compressed = await compressor.compress(history, keepRecentN);
      history.length = 0;
      history.push(...compressed);
    }

    // 4. Build full message array
    const messages: ChatMessage[] = [
      { role: "system", content: systemContent },
      ...history,
    ];

    // 5. Call LLM
    await eventBus?.emit({
      name: "agent.llm.start",
      payload: { turn, agent: activeAgent.name, model: activeAgent.model },
      at: new Date().toISOString(),
      runId,
      sessionId,
      turn,
    });

    const response = await llmClient.chatCompletion({
      model: activeAgent.model ?? "gpt-5.2",
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      toolChoice: activeAgent.toolChoice,
      maxTokens: 16000,
      temperature: activeAgent.temperature,
    });

    const assistantMessage = response.message;

    // 6. Push assistant message to history
    const historyMsg: ChatMessage = {
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    };
    history.push(historyMsg);

    // 7. Emit text content to user
    if (assistantMessage.content) {
      await eventBus?.emit({
        name: "agent.message",
        payload: { content: assistantMessage.content, agent: activeAgent.name },
        at: new Date().toISOString(),
        runId,
        sessionId,
        turn,
      });
    }

    // 8. If no tool calls
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      if (waitForUserInput) {
        await onTurnEnd?.(history);
        const userInput = await waitForUserInput();
        if (userInput) {
          history.push({ role: "user", content: userInput });
          await eventBus?.emit({
            name: "user.message",
            payload: { content: userInput },
            at: new Date().toISOString(),
            runId,
            sessionId,
            turn,
          });
          continue;
        }
      }
      await eventBus?.emit({
        name: "agent.complete",
        payload: { turn, agent: activeAgent.name, reason: "no_tool_calls" },
        at: new Date().toISOString(),
        runId,
        sessionId,
        turn,
      });
      await onTurnEnd?.(history);
      break;
    }

    // 9. Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const tool = toolRegistry.get(toolName);

      if (!tool) {
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: `Error: Tool "${toolName}" not found.`,
        });
        continue;
      }

      // Parse arguments
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: `Error: Failed to parse tool arguments as JSON.`,
        });
        continue;
      }

      // Validate with Zod schema
      const validation = tool.inputSchema.safeParse(parsedArgs);
      if (!validation.success) {
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: `Error: Invalid input - ${validation.error.message}`,
        });
        continue;
      }

      // Check approval
      if (tool.requiresApproval) {
        const needsApproval = typeof tool.requiresApproval === "function"
          ? tool.requiresApproval(validation.data)
          : tool.requiresApproval;

        if (needsApproval && approvalGate) {
          const approved = await approvalGate.shouldApprove(toolName, validation.data);
          if (!approved) {
            history.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolName,
              content: `Error: Tool execution was rejected by approval gate.`,
            });
            continue;
          }
        }
      }

      // Execute tool
      await eventBus?.emit({
        name: "agent.tool.start",
        payload: { toolName, input: validation.data, turn },
        at: new Date().toISOString(),
        runId,
        sessionId,
        turn,
      });

      try {
        const result = await tool.execute(validation.data, contextVariables);

        // Push tool result
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: result.value,
        });

        // Handle image results
        if (result.image) {
          history.push({
            role: "user",
            content: [
              { type: "text", text: `[Tool ${toolName} returned an image]` },
              { type: "image_url", image_url: { url: `data:image/png;base64,${result.image}` } },
            ],
          });
        }

        // Merge context variables
        if (result.contextVariables) {
          Object.assign(contextVariables, result.contextVariables);
        }

        // Agent switch (phase transition)
        if (result.agent) {
          activeAgent = result.agent;
          // Inject new phase's workflow prompt (hidden from UI)
          const newPhasePrompt = renderPhasePrompt(activeAgent.phasePrompt, contextVariables);
          if (newPhasePrompt) {
            history.push({ role: "user", content: newPhasePrompt });
          }
        }

        if (result.ok === false) {
          await eventBus?.emit({
            name: "agent.tool.error",
            payload: { toolName, turn, error: result.value.slice(0, 500) },
            at: new Date().toISOString(),
            runId,
            sessionId,
            turn,
          });
        } else {
          await eventBus?.emit({
            name: "agent.tool.complete",
            payload: { toolName, turn, valuePreview: result.value.slice(0, 500) },
            at: new Date().toISOString(),
            runId,
            sessionId,
            turn,
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: `Error: ${errorMsg}`,
        });

        await eventBus?.emit({
          name: "agent.tool.error",
          payload: { toolName, turn, error: errorMsg },
          at: new Date().toISOString(),
          runId,
          sessionId,
          turn,
        });
      }
    }
    await onTurnEnd?.(history);
  }
  } catch (err) {
    return {
      messages: history,
      contextVariables,
      lastAgent: activeAgent,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    messages: history,
    contextVariables,
    lastAgent: activeAgent,
  };
}
