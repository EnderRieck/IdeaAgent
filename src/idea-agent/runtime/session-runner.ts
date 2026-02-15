import { AgentKernel } from "../core/kernel";
import type { AgentAction, LoopState } from "../core/types";
import type { EventBus } from "../core/event-bus";
import type { MemoryManager } from "../memory/manager";
import type { RuntimeConfig } from "./config";
import type { MemoryEvent, MemoryItem } from "../memory/types";
import type { ContextCompactor } from "../core/context-compactor";

export interface SessionRunnerDeps {
  kernel: AgentKernel;
  memory: MemoryManager;
  eventBus: EventBus;
  config: RuntimeConfig;
  contextCompactor: ContextCompactor;
  recallQueryMaxChars: number;
  nowISO(): string;
}

export class SessionRunner {
  constructor(private readonly deps: SessionRunnerDeps) {}

  async run(initialState: LoopState): Promise<LoopState> {
    let state: LoopState = { ...initialState, status: "running" };

    await this.emit("run.started", state, { sessionId: state.sessionId });

    const maxConsecutiveDecisionErrors = 3;
    let consecutiveDecisionErrors = 0;

    try {
      while (state.turn <= this.deps.config.maxTurns && state.status === "running") {
        await this.emit("turn.started", state, { turn: state.turn });

        const recallQuery = await this.buildRecallQuery(state);
        await this.emit("memory.recall.requested", state, { query: recallQuery });
        const recalled = await this.deps.memory.recall(recallQuery, {
          sessionId: state.sessionId,
          runId: state.runId,
        });
        await this.emit("memory.recall.completed", state, {
          recalledCount: recalled.length,
        });

        const snapshot = await this.deps.memory.snapshot(state.sessionId);
        state = {
          ...state,
          memorySnapshot: snapshot,
          metadata: {
            ...(state.metadata ?? {}),
            recalledMemoryCount: recalled.length,
          },
        };

        let decision;
        try {
          decision = await this.deps.kernel.decide(state);
        } catch (decideError) {
          consecutiveDecisionErrors += 1;
          const errorMsg = decideError instanceof Error ? decideError.message : "unknown decision error";

          await this.emit("decision.failed", state, {
            turn: state.turn,
            error: errorMsg,
            consecutiveErrors: consecutiveDecisionErrors,
          });

          if (consecutiveDecisionErrors >= maxConsecutiveDecisionErrors) {
            state = {
              ...state,
              status: "failed",
              lastError: `Main agent decision failed ${consecutiveDecisionErrors} consecutive times. Last error: ${errorMsg}`,
            };
            break;
          }

          state = {
            ...state,
            lastError: errorMsg,
            turn: state.turn + 1,
          };
          continue;
        }

        consecutiveDecisionErrors = 0;
        state = {
          ...state,
          lastError: undefined,
          metadata: {
            ...(state.metadata ?? {}),
            ...(decision.metadata ?? {}),
          },
        };

        await this.emit("decision.produced", state, {
          actions: decision.actions.map((action) => action.type),
          metadata: decision.metadata,
          notes: decision.notes,
        });

        const decisionMetadata = decision.metadata as Record<string, unknown> | undefined;
        const mainPromptInput = decisionMetadata?.llmPromptInput;
        if (mainPromptInput) {
          await this.emit("llm.prompt.input", state, {
            source: "main-agent",
            input: mainPromptInput,
          });
        }

        for (const action of decision.actions) {
          await this.emit("action.dispatched", state, {
            actionType: action.type,
            action,
          });

          await this.emitActionRequested(action, state);
          state = await this.deps.kernel.dispatchAction(state, action);
          await this.emitActionCompleted(action, state);
          await this.appendActionMemory(action, state);

          if (state.status !== "running") {
            break;
          }
        }

        const postTurnSnapshot = await this.deps.memory.snapshot(state.sessionId);
        state = {
          ...state,
          memorySnapshot: postTurnSnapshot,
        };

        await this.emit("turn.completed", state, {
          turn: state.turn,
          status: state.status,
        });

        if (state.status === "running") {
          state = { ...state, turn: state.turn + 1 };
        }
      }

      if (state.status === "running") {
        state = {
          ...state,
          status: "aborted",
          lastError: `max turns (${this.deps.config.maxTurns}) reached`,
        };
      }

      if (state.status === "completed") {
        await this.emit("run.completed", state, { status: state.status });
      } else if (state.status === "aborted") {
        await this.emit("run.aborted", state, { status: state.status, error: state.lastError });
      } else {
        await this.emit("run.failed", state, { status: state.status, error: state.lastError });
      }

      return state;
    } catch (error) {
      state = {
        ...state,
        status: "failed",
        lastError: error instanceof Error ? error.message : "unknown runner error",
      };
      await this.emit("run.failed", state, { status: state.status, error: state.lastError });
      return state;
    }
  }


  private async buildRecallQuery(state: LoopState): Promise<string> {
    const chunks: string[] = [];

    if (state.goal && state.goal.trim().length > 0) {
      chunks.push(state.goal.trim());
    }

    if (state.constraints && state.constraints.length > 0) {
      chunks.push(...state.constraints.map((item) => item.trim()).filter((item) => item.length > 0));
    }

    const metadata = state.metadata as Record<string, unknown> | undefined;
    const lastAnswer = metadata?.lastUserAnswer;
    if (typeof lastAnswer === "string" && lastAnswer.trim().length > 0) {
      chunks.push(lastAnswer.trim());
    }

    const query = chunks.join("\n").trim();
    if (!query) {
      return "recall session goal and latest user answer";
    }

    return this.deps.contextCompactor.compactText({
      text: query,
      maxChars: this.deps.recallQueryMaxChars,
      purpose: "memory recall query",
    });
  }

  private async emitActionRequested(action: AgentAction, state: LoopState): Promise<void> {
    if (action.type === "call_tool") {
      await this.emit("tool.call.requested", state, {
        toolId: action.toolId,
        input: action.input,
      });
      return;
    }

    if (action.type === "call_subagent") {
      await this.emit("subagent.call.requested", state, {
        subAgentId: action.subAgentId,
        task: action.task,
      });
      return;
    }

    if (action.type === "ask_user") {
      await this.emit("user.question.requested", state, {
        question: action.question,
      });
      return;
    }

    if (action.type === "respond") {
      await this.emit("agent.respond.requested", state, {
        message: action.message,
      });
    }
  }

  private async emitActionCompleted(action: AgentAction, state: LoopState): Promise<void> {
    if (action.type === "call_tool") {
      const latest = state.toolResults[state.toolResults.length - 1];
      const invokeMeta = state.metadata?.lastToolInvokeMeta as
        | {
            approvalRequested?: boolean;
            approvalApproved?: boolean;
          }
        | undefined;

      if (invokeMeta?.approvalRequested) {
        await this.emit("tool.approval.requested", state, {
          toolId: action.toolId,
        });
        await this.emit("tool.approval.completed", state, {
          toolId: action.toolId,
          approved: invokeMeta.approvalApproved,
        });
      }

      if (latest?.ok) {
        await this.emit("tool.call.completed", state, {
          toolId: action.toolId,
          data: latest.data,
        });
      } else {
        await this.emit("tool.call.failed", state, {
          toolId: action.toolId,
          error: latest?.error ?? "tool failed",
        });
      }
      return;
    }

    if (action.type === "call_subagent") {
      const latest = state.subAgentResults[state.subAgentResults.length - 1];
      if (latest?.ok) {
        await this.emit("subagent.call.completed", state, {
          subAgentId: action.subAgentId,
          subAgentResult: latest.subAgentResult,
        });
      } else {
        await this.emit("subagent.call.failed", state, {
          subAgentId: action.subAgentId,
          error: latest?.error ?? "subagent failed",
        });
      }
      return;
    }

    if (action.type === "ask_user") {
      await this.emit("user.question.answered", state, {
        question: action.question,
        answer: state.metadata?.lastUserAnswer,
      });
      return;
    }

    if (action.type === "respond") {
      await this.emit("agent.respond.completed", state, {
        message: action.message,
      });
    }
  }

  private async appendActionMemory(action: AgentAction, state: LoopState): Promise<void> {
    let item: MemoryItem | undefined;

    if (action.type === "call_tool") {
      const latest = state.toolResults[state.toolResults.length - 1];
      item = {
        id: this.makeId("mem_tool"),
        type: "working",
        content: JSON.stringify({
          toolId: action.toolId,
          ok: latest?.ok,
          error: latest?.error,
          data: latest?.data,
        }),
        source: "tool",
        createdAt: this.deps.nowISO(),
        tags: ["tool", action.toolId],
      };
    } else if (action.type === "call_subagent") {
      const latest = state.subAgentResults[state.subAgentResults.length - 1];
      item = {
        id: this.makeId("mem_subagent"),
        type: "working",
        content: JSON.stringify({
          subAgentId: action.subAgentId,
          ok: latest?.ok,
          subAgentResult: latest?.subAgentResult,
          error: latest?.error,
        }),
        source: "subagent",
        createdAt: this.deps.nowISO(),
        tags: ["subagent", action.subAgentId],
      };
    } else if (action.type === "ask_user") {
      item = {
        id: this.makeId("mem_user"),
        type: "session",
        content: JSON.stringify({
          question: action.question,
          answer: state.metadata?.lastUserAnswer,
        }),
        source: "user",
        createdAt: this.deps.nowISO(),
        tags: ["user", "qa"],
      };
    } else if (action.type === "respond") {
      item = {
        id: this.makeId("mem_agent"),
        type: "session",
        content: JSON.stringify({
          message: action.message,
        }),
        source: "agent",
        createdAt: this.deps.nowISO(),
        tags: ["agent", "response"],
      };
    } else if (action.type === "finish") {
      item = {
        id: this.makeId("mem_finish"),
        type: "durable",
        content: `Run finished: ${action.reason ?? "no reason"}; goal=${state.goal ?? "unknown"}`,
        source: "agent",
        createdAt: this.deps.nowISO(),
        tags: ["finish", "durable"],
      };
    }

    if (!item) {
      return;
    }

    const event: MemoryEvent = {
      sessionId: state.sessionId,
      type: "append",
      item,
    };

    await this.emit("memory.append.requested", state, {
      itemType: item.type,
      itemId: item.id,
      tags: item.tags,
    });
    await this.deps.memory.append(event);
    await this.emit("memory.append.completed", state, {
      itemType: item.type,
      itemId: item.id,
    });
  }

  private makeId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private async emit(name: string, state: LoopState, payload: Record<string, unknown>): Promise<void> {
    await this.deps.eventBus.emit({
      name,
      payload,
      at: this.deps.nowISO(),
      runId: state.runId,
      sessionId: state.sessionId,
      turn: state.turn,
    });
  }
}
