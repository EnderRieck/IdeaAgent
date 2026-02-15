import type { ToolInvokeOutcome } from "../tools/invoker";
import type { SubAgentInvokeOutcome } from "./invoker";

// SubAgent 发起的系统调用请求
export type SyscallRequest =
  | { type: "call_tool"; toolId: string; input: Record<string, unknown> }
  | { type: "call_subagent"; subAgentId: string; task: string };

// 系统调用返回
export type SyscallResponse =
  | { type: "tool_result"; toolId: string; outcome: ToolInvokeOutcome }
  | { type: "subagent_result"; subAgentId: string; outcome: SubAgentInvokeOutcome };

// 注入到 SubAgentContext 的回调签名
export type SyscallHandler = (request: SyscallRequest) => Promise<SyscallResponse>;
