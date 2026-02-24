import fs from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "../core/types";
import type { ContextVariables, AgentDefinition } from "../core/context-variables";
import type { NativeTool } from "../core/native-tool";
import type { LLMClient } from "../core/llm-client";
import type { MessageCompressor } from "../core/message-compressor";
import type { ApprovalGate } from "../core/agent-loop";
import { runAgentLoop } from "../core/agent-loop";
import type { EventBus } from "../core/event-bus";
import type { MemoryManager } from "../memory/manager";
import type { RuntimeConfig } from "./config";
import type { MemoryEvent, MemoryItem } from "../memory/types";

// ── Session State ─────────────────────────────────────────────────

export interface SessionState {
  sessionId: string;
  runId: string;
  goal?: string;
  status: "running" | "completed" | "failed" | "aborted";
  messages: ChatMessage[];
  contextVariables: ContextVariables;
  lastError?: string;
  turn: number;
}

// ── Session Runner Deps ───────────────────────────────────────────

export interface SessionRunnerDeps {
  agent: AgentDefinition;
  toolRegistry: Map<string, NativeTool>;
  llmClient: LLMClient;
  memory: MemoryManager;
  eventBus: EventBus;
  config: RuntimeConfig;
  dataDir?: string;
  compressor?: MessageCompressor;
  approvalGate?: ApprovalGate;
  waitForUserInput?: () => Promise<string | null>;
}

// ── Session Runner ────────────────────────────────────────────────

export class SessionRunner {
  constructor(private readonly deps: SessionRunnerDeps) {}

  async run(initial: {
    sessionId: string;
    runId: string;
    goal?: string;
  }): Promise<SessionState> {
    const { sessionId, runId, goal } = initial;
    const nowISO = () => new Date().toISOString();

    await this.deps.eventBus.emit({
      name: "run.started",
      payload: { sessionId, goal },
      at: nowISO(),
      runId,
      sessionId,
      turn: 0,
    });

    // phasePrompt injection is handled by agent-loop
    const initialMessages: ChatMessage[] = [];

    // Build initial context variables
    const contextVariables: ContextVariables = {
      sessionId,
      runId,
      goal,
    };

    try {
      // Build per-turn message persistence callback
      const dataDir = this.deps.dataDir ?? ".idea-agent-data";
      const messagesPath = path.join(dataDir, "sessions", sessionId, "messages.json");
      const onTurnEnd = async (messages: ChatMessage[]) => {
        try {
          await fs.mkdir(path.dirname(messagesPath), { recursive: true });
          await fs.writeFile(messagesPath, JSON.stringify(messages, null, 2), "utf-8");
        } catch {
          // best-effort, don't break the loop
        }
      };

      const result = await runAgentLoop({
        agent: this.deps.agent,
        initialMessages,
        contextVariables,
        toolRegistry: this.deps.toolRegistry,
        llmClient: this.deps.llmClient,
        maxTurns: this.deps.config.maxTurns,
        compressor: this.deps.compressor,
        eventBus: this.deps.eventBus,
        approvalGate: this.deps.approvalGate,
        sessionId,
        runId,
        onTurnEnd,
        waitForUserInput: this.deps.waitForUserInput,
      });

      // Count turns from messages (assistant messages = turns)
      const turnCount = result.messages.filter((m) => m.role === "assistant").length;

      // Agent loop caught an internal error — return failed with partial history
      if (result.error) {
        await this.deps.eventBus.emit({
          name: "run.failed",
          payload: { status: "failed", error: result.error },
          at: nowISO(),
          runId,
          sessionId,
          turn: turnCount,
        });

        return {
          sessionId,
          runId,
          goal,
          status: "failed",
          messages: result.messages,
          contextVariables: result.contextVariables,
          lastError: result.error,
          turn: turnCount,
        };
      }

      // Store final summary in memory
      const lastAssistant = result.messages
        .filter((m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant")
        .pop();

      if (lastAssistant?.content) {
        const memItem: MemoryItem = {
          id: `mem_finish_${Math.random().toString(36).slice(2, 8)}`,
          type: "durable",
          content: `Run finished. Goal: ${goal ?? "unknown"}. Final output: ${lastAssistant.content.slice(0, 2000)}`,
          source: "agent",
          createdAt: nowISO(),
          tags: ["finish", "durable"],
        };
        const memEvent: MemoryEvent = {
          sessionId,
          type: "append",
          item: memItem,
        };
        await this.deps.memory.append(memEvent);
      }

      const state: SessionState = {
        sessionId,
        runId,
        goal,
        status: "completed",
        messages: result.messages,
        contextVariables: result.contextVariables,
        turn: turnCount,
      };

      await this.deps.eventBus.emit({
        name: "run.completed",
        payload: { status: "completed", turns: turnCount },
        at: nowISO(),
        runId,
        sessionId,
        turn: turnCount,
      });

      return state;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "unknown runner error";

      await this.deps.eventBus.emit({
        name: "run.failed",
        payload: { status: "failed", error: errorMsg },
        at: nowISO(),
        runId,
        sessionId,
        turn: 0,
      });

      return {
        sessionId,
        runId,
        goal,
        status: "failed",
        messages: [],
        contextVariables: { sessionId, runId, goal },
        lastError: errorMsg,
        turn: 0,
      };
    }
  }
}
