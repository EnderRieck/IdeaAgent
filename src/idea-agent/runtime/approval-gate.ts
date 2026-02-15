import type { AgentAction, LoopState } from "../core/types";
import type { UserBridge } from "./user-bridge";

export interface ApprovalGate {
  needsApproval(action: AgentAction, state: LoopState): Promise<boolean>;
  requestApproval(action: AgentAction, state: LoopState): Promise<{ approved: boolean; reason?: string }>;
}

export class RejectingApprovalGate implements ApprovalGate {
  constructor(private readonly sensitiveTools: Set<string> = new Set(["local-cli"])) {}

  async needsApproval(action: AgentAction): Promise<boolean> {
    return action.type === "call_tool" && this.sensitiveTools.has(action.toolId);
  }

  async requestApproval(action: AgentAction): Promise<{ approved: boolean; reason?: string }> {
    if (action.type !== "call_tool") {
      return { approved: true };
    }
    return { approved: false, reason: `Tool ${action.toolId} requires explicit user approval.` };
  }
}

export class InteractiveApprovalGate implements ApprovalGate {
  constructor(
    private readonly userBridge: UserBridge,
    private readonly sensitiveTools: Set<string> = new Set(["local-cli"]),
    private readonly autoApprove: boolean = false,
  ) {}

  async needsApproval(action: AgentAction): Promise<boolean> {
    return action.type === "call_tool" && this.sensitiveTools.has(action.toolId);
  }

  async requestApproval(action: AgentAction): Promise<{ approved: boolean; reason?: string }> {
    if (action.type !== "call_tool") {
      return { approved: true };
    }

    if (this.autoApprove) {
      return { approved: true };
    }

    const answer = await this.userBridge.ask({
      prompt: `批准执行敏感工具 ${action.toolId} 吗？`,
      allowMultiple: false,
      options: [
        { id: "Y", text: "yes" },
        { id: "N", text: "no" },
      ],
    });

    const normalized = answer.toLowerCase();
    const approved = normalized.includes("yes") || normalized.startsWith("y:") || normalized === "y";

    if (approved) {
      return { approved: true };
    }
    return {
      approved: false,
      reason: `User rejected approval for tool ${action.toolId}`,
    };
  }
}

export class DefaultApprovalGate extends RejectingApprovalGate {}
