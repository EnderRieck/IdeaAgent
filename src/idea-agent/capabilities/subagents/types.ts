import type { LoopState } from "../../core/types";
import type { SyscallRequest, SyscallResponse } from "./syscall";

export type SubAgentTask = string;

export interface SubAgentProgressUpdate {
  stage: string;
  payload?: Record<string, unknown>;
}

export interface SubAgentErrorDetail {
  source: string;
  error: string;
  request?: unknown;
  response?: unknown;
  context?: Record<string, unknown>;
}

export interface SubAgentContext {
  sessionId: string;
  runId: string;
  turn: number;
  state: LoopState;
  reportProgress?(update: SubAgentProgressUpdate): Promise<void> | void;
  reportError?(detail: SubAgentErrorDetail): Promise<void> | void;
  syscall?(request: SyscallRequest): Promise<SyscallResponse>;
}

export interface SubAgentResult {
  subAgentResult: string;
}

export interface SubAgentRuntimeProfile {
  model: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTurns?: number;
  summaryModel?: string;
}

export interface SubAgent {
  id: string;
  description: string;
  run(task: SubAgentTask, ctx: SubAgentContext): Promise<SubAgentResult>;
}
