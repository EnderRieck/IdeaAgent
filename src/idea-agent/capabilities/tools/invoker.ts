/** @deprecated Legacy type kept for backward compatibility */
type LoopState = { sessionId: string; runId: string; turn: number; [key: string]: unknown };

import type { ApprovalGate } from "../../runtime/approval-gate";
import type { ToolContext, ToolResult } from "./types";
import { toolNeedsApproval } from "./approval";
import type { ToolPolicy } from "./policy";
import { defaultToolPolicy } from "./policy";
import type { ToolRegistry } from "./registry";

export interface ToolInvokeMeta {
  toolFound: boolean;
  inputValid: boolean;
  approvalRequested: boolean;
  approvalApproved: boolean;
}

export interface ToolInvokeOutcome<O = unknown> {
  result: ToolResult<O>;
  meta: ToolInvokeMeta;
}

export class ToolInvoker {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvalGate: ApprovalGate,
    private readonly policy: ToolPolicy = defaultToolPolicy,
    private readonly nowISO: () => string = () => new Date().toISOString(),
    private readonly policyOverrides?: Record<string, Partial<ToolPolicy>>,
  ) {}

  async invoke(toolId: string, input: unknown, state: LoopState): Promise<ToolInvokeOutcome<unknown>> {
    const notFoundMeta: ToolInvokeMeta = {
      toolFound: false,
      inputValid: false,
      approvalRequested: false,
      approvalApproved: false,
    };

    const tool = this.registry.get(toolId);
    if (!tool) {
      return { result: { ok: false, error: `Tool not found: ${toolId}` }, meta: notFoundMeta };
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        result: { ok: false, error: `Invalid input for tool ${toolId}: ${parsed.error.message}` },
        meta: {
          toolFound: true,
          inputValid: false,
          approvalRequested: false,
          approvalApproved: false,
        },
      };
    }

    const ctx: ToolContext = {
      sessionId: state.sessionId,
      runId: state.runId,
      turn: state.turn,
      state,
      nowISO: this.nowISO,
    };

    let approvalRequested = false;
    let approvalApproved = true;

    const action = { type: "call_tool", toolId, input: parsed.data } as const;
    const toolRequiresApproval = await toolNeedsApproval(tool, parsed.data, ctx);
    const policyRequiresApproval = await this.approvalGate.needsApproval(action, state);
    const needsApproval = toolRequiresApproval || policyRequiresApproval;

    if (needsApproval) {
      approvalRequested = true;
      const decision = await this.approvalGate.requestApproval(action, state);
      approvalApproved = decision.approved;
      if (!decision.approved) {
        return {
          result: { ok: false, error: decision.reason ?? `Tool ${toolId} rejected by approval gate` },
          meta: {
            toolFound: true,
            inputValid: true,
            approvalRequested,
            approvalApproved,
          },
        };
      }
    }

    const toolPolicy = {
      ...this.policy,
      ...(this.policyOverrides?.[toolId] ?? {}),
    };

    let result: ToolResult<unknown>;
    try {
      result = await this.withTimeout(tool.execute(parsed.data, ctx), toolPolicy.timeoutMs);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Tool invocation failed";
      result = { ok: false, error: msg };
    }

    return {
      result,
      meta: {
        toolFound: true,
        inputValid: true,
        approvalRequested,
        approvalApproved,
      },
    };
  }

  private async withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timeout after ${timeoutMs} ms`));
      }, timeoutMs);
    });

    return Promise.race([task, timeout]);
  }
}
