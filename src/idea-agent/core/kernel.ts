import type { MainAgent } from "./decision";
import type { AgentAction, AgentDecision, LoopState } from "./types";
import { StateMachine } from "./state-machine";
import { ActionDispatchError } from "./error";
import type { ToolInvoker } from "../capabilities/tools/invoker";
import type { SubAgentInvoker } from "../capabilities/subagents/invoker";
import type { UserBridge } from "../runtime/user-bridge";
import type { ContextCompactor, ContextDialogueMessage } from "./context-compactor";

interface DialogueEntry extends ContextDialogueMessage {}

export interface KernelDeps {
  mainAgent: MainAgent;
  toolInvoker: ToolInvoker;
  subAgentInvoker: SubAgentInvoker;
  userBridge: UserBridge;
  contextCompactor: ContextCompactor;
  constraintsMaxChars: number;
  dialogueMaxChars: number;
  nowISO(): string;
}

export class AgentKernel {
  private readonly stateMachine = new StateMachine();

  constructor(private readonly deps: KernelDeps) {}

  async decide(state: LoopState): Promise<AgentDecision> {
    return this.deps.mainAgent.decide(state);
  }

  async dispatchAction(state: LoopState, action: AgentAction): Promise<LoopState> {
    switch (action.type) {
      case "call_tool": {
        const outcome = await this.deps.toolInvoker.invoke(action.toolId, action.input, state);

        let status = state.status;
        let pendingApproval = state.pendingApproval;

        if (outcome.meta.approvalRequested) {
          status = this.stateMachine.transition(status, "waiting_approval");
          pendingApproval = {
            action,
            reason: outcome.result.ok
              ? `Tool ${action.toolId} approved`
              : outcome.result.error ?? `Tool ${action.toolId} requires approval`,
            requestedAt: this.deps.nowISO(),
          };

          status = this.stateMachine.transition(status, "running");
          pendingApproval = undefined;
        }

        return {
          ...state,
          status,
          pendingApproval,
          toolResults: [
            ...state.toolResults,
            {
              toolId: action.toolId,
              input: action.input,
              ok: outcome.result.ok,
              data: outcome.result.ok ? outcome.result.data : undefined,
              error: outcome.result.ok ? undefined : outcome.result.error,
              approvalRequested: outcome.meta.approvalRequested,
              approvalApproved: outcome.meta.approvalApproved,
              at: this.deps.nowISO(),
            },
          ],
          metadata: {
            ...(state.metadata ?? {}),
            lastToolInvokeMeta: {
              toolId: action.toolId,
              ...outcome.meta,
            },
          },
        };
      }
      case "call_subagent": {
        const outcome = await this.deps.subAgentInvoker.invoke(action.subAgentId, action.task, state);
        return {
          ...state,
          subAgentResults: [
            ...state.subAgentResults,
            {
              ok: outcome.ok,
              subAgentResult: outcome.result?.subAgentResult,
              error: outcome.error,
            },
          ],
          metadata: {
            ...(state.metadata ?? {}),
            lastSubAgentInvokeMeta: {
              subAgentId: action.subAgentId,
              ok: outcome.ok,
              error: outcome.error,
            },
          },
        };
      }
      case "ask_user": {
        const waitingState: LoopState = {
          ...state,
          status: this.stateMachine.transition(state.status, "waiting_user"),
          pendingQuestion: {
            question: action.question,
            askedAt: this.deps.nowISO(),
          },
        };

        const answer = await this.deps.userBridge.ask(action.question);

        const questionOptions = (action.question.options ?? [])
          .map((item) => `${item.id}: ${item.text}`)
          .join(" | ");

        const assistantQuestion = questionOptions.length > 0
          ? `${action.question.prompt}\nOptions: ${questionOptions}`
          : action.question.prompt;

        const nextConstraints = await this.appendConstraint(
          state.constraints,
          `Q: ${action.question.prompt}\nA: ${answer}`,
        );

        const metadataWithDialogue = await this.appendDialogueEntries(state.metadata, [
          { role: "assistant", content: assistantQuestion },
          { role: "user", content: answer },
        ]);

        return {
          ...waitingState,
          status: this.stateMachine.transition(waitingState.status, "running"),
          pendingQuestion: undefined,
          constraints: nextConstraints,
          goal: waitingState.goal ?? answer,
          metadata: {
            ...metadataWithDialogue,
            lastUserQuestion: action.question.prompt,
            lastUserAnswer: answer,
          },
        };
      }
      case "respond": {
        await this.deps.userBridge.respond(action.message);

        const metadataWithDialogue = await this.appendDialogueEntries(state.metadata, [
          { role: "assistant", content: action.message },
        ]);

        return {
          ...state,
          metadata: {
            ...metadataWithDialogue,
            lastResponse: action.message,
          },
        };
      }
      case "finish": {
        return {
          ...state,
          status: this.stateMachine.transition(state.status, "completed"),
          metadata: {
            ...(state.metadata ?? {}),
            finishReason: action.reason,
          },
        };
      }
      default: {
        throw new ActionDispatchError(`Unsupported action ${(action as { type: string }).type}`);
      }
    }
  }

  private async appendConstraint(existing: string[] | undefined, line: string): Promise<string[]> {
    const trimmed = line.trim();
    const current = [...(existing ?? [])]
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (trimmed && !current.includes(trimmed)) {
      current.push(trimmed);
    }

    if (current.length === 0) {
      return current;
    }

    const compacted = await this.deps.contextCompactor.compactText({
      text: current.join("\n"),
      maxChars: this.deps.constraintsMaxChars,
      purpose: "constraints memory",
    });

    return compacted
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private async appendDialogueEntries(
    metadata: Record<string, unknown> | undefined,
    entries: DialogueEntry[],
  ): Promise<Record<string, unknown>> {
    const currentMetadata = { ...(metadata ?? {}) };
    const existingDialogue = this.readDialogue(currentMetadata.dialogue);

    const merged = [...existingDialogue, ...entries]
      .map((entry) => ({
        role: entry.role,
        content: entry.content.trim(),
      }))
      .filter((entry) => entry.content.length > 0);

    const compacted = await this.deps.contextCompactor.compactDialogue({
      messages: merged,
      maxChars: this.deps.dialogueMaxChars,
      purpose: "dialogue memory",
    });

    return {
      ...currentMetadata,
      dialogue: compacted,
    };
  }

  private readDialogue(value: unknown): DialogueEntry[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const rows: DialogueEntry[] = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) {
        continue;
      }

      const record = item as { role?: unknown; content?: unknown };
      if ((record.role !== "assistant" && record.role !== "user") || typeof record.content !== "string") {
        continue;
      }

      rows.push({
        role: record.role,
        content: record.content,
      });
    }

    return rows;
  }
}
