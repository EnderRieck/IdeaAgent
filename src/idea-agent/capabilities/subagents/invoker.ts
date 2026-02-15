import type { LoopState } from "../../core/types";
import type { ToolInvoker } from "../tools/invoker";
import type { SubAgentRegistry } from "./registry";
import type { SyscallHandler, SyscallRequest, SyscallResponse } from "./syscall";
import type { SubAgentErrorDetail, SubAgentResult, SubAgentTask } from "./types";

export interface SubAgentInvokeOutcome {
  ok: boolean;
  result?: SubAgentResult;
  error?: string;
}

export interface SubAgentProgressEvent {
  subAgentId: string;
  sessionId: string;
  runId: string;
  turn: number;
  stage: string;
  payload?: Record<string, unknown>;
}

export interface SubAgentErrorEvent {
  subAgentId: string;
  sessionId: string;
  runId: string;
  turn: number;
  detail: SubAgentErrorDetail;
}

export interface SubAgentInvokerOptions {
  onProgress?: (event: SubAgentProgressEvent) => Promise<void> | void;
  onError?: (event: SubAgentErrorEvent) => Promise<void> | void;
}

export class SubAgentInvoker {
  constructor(
    private readonly registry: SubAgentRegistry,
    private readonly options?: SubAgentInvokerOptions,
    private readonly mainToolInvoker?: ToolInvoker,
  ) {}

  private buildSyscallHandler(state: LoopState, subAgentId: string): SyscallHandler | undefined {
    if (!this.mainToolInvoker) return undefined;

    return async (request: SyscallRequest): Promise<SyscallResponse> => {
      await this.options?.onProgress?.({
        subAgentId,
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        stage: "syscall.start",
        payload: { requestType: request.type, ...request },
      });

      if (request.type === "call_tool") {
        const outcome = await this.mainToolInvoker!.invoke(
          request.toolId, request.input, state,
        );
        await this.options?.onProgress?.({
          subAgentId,
          sessionId: state.sessionId,
          runId: state.runId,
          turn: state.turn,
          stage: "syscall.tool.done",
          payload: { toolId: request.toolId, ok: outcome.result.ok },
        });
        return { type: "tool_result", toolId: request.toolId, outcome };
      }

      if (request.type === "call_subagent") {
        const outcome = await this.invoke(
          request.subAgentId, request.task, state,
        );
        await this.options?.onProgress?.({
          subAgentId,
          sessionId: state.sessionId,
          runId: state.runId,
          turn: state.turn,
          stage: "syscall.subagent.done",
          payload: { targetSubAgentId: request.subAgentId, ok: outcome.ok },
        });
        return { type: "subagent_result", subAgentId: request.subAgentId, outcome };
      }

      throw new Error(`Unknown syscall type: ${(request as { type: string }).type}`);
    };
  }

  async invoke(subAgentId: string, task: SubAgentTask, state: LoopState): Promise<SubAgentInvokeOutcome> {
    const subAgent = this.registry.get(subAgentId);
    if (!subAgent) {
      await this.options?.onProgress?.({
        subAgentId,
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        stage: "invoke.error",
        payload: {
          ok: false,
          error: `SubAgent not found: ${subAgentId}`,
        },
      });

      return {
        ok: false,
        error: `SubAgent not found: ${subAgentId}`,
      };
    }

    try {
      await this.options?.onProgress?.({
        subAgentId,
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        stage: "invoke.start",
        payload: {
          taskPreview: task.slice(0, 280),
        },
      });

      const result = await subAgent.run(task, {
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        state,
        reportProgress: async (update) => {
          await this.options?.onProgress?.({
            subAgentId,
            sessionId: state.sessionId,
            runId: state.runId,
            turn: state.turn,
            stage: update.stage,
            payload: update.payload,
          });
        },
        reportError: async (detail) => {
          await this.options?.onError?.({
            subAgentId,
            sessionId: state.sessionId,
            runId: state.runId,
            turn: state.turn,
            detail,
          });
        },
        syscall: this.buildSyscallHandler(state, subAgentId),
      });

      await this.options?.onProgress?.({
        subAgentId,
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        stage: "invoke.finish",
        payload: {
          ok: true,
          subAgentResultPreview: result.subAgentResult.slice(0, 500),
        },
      });

      return { ok: true, result };
    } catch (error) {
      await this.options?.onProgress?.({
        subAgentId,
        sessionId: state.sessionId,
        runId: state.runId,
        turn: state.turn,
        stage: "invoke.error",
        payload: {
          ok: false,
          error: error instanceof Error ? error.message : `SubAgent ${subAgentId} failed`,
        },
      });

      return {
        ok: false,
        error: error instanceof Error ? error.message : `SubAgent ${subAgentId} failed`,
      };
    }
  }
}
