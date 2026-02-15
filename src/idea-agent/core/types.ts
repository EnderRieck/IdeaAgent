import type { SubAgentTask } from "../capabilities/subagents/types";

export type LoopStatus =
  | "init"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "completed"
  | "failed"
  | "aborted";

export interface AskUserOption {
  id: string;
  text: string;
}

export interface AskUserQuestion {
  prompt: string;
  details?: string;
  options?: AskUserOption[];
  allowMultiple?: boolean;
}

export type AgentAction =
  | { type: "call_tool"; toolId: string; input: unknown }
  | { type: "call_subagent"; subAgentId: string; task: SubAgentTask }
  | { type: "ask_user"; question: AskUserQuestion }
  | { type: "respond"; message: string }
  | { type: "finish"; reason?: string };

export interface AgentDecision {
  actions: AgentAction[];
  metadata?: Record<string, unknown>;
  notes?: string;
}

export interface ToolExecutionRecord {
  toolId: string;
  input: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
  approvalRequested?: boolean;
  approvalApproved?: boolean;
  attempts?: number;
  at: string;
}

export interface SubAgentExecutionRecord {
  ok: boolean;
  subAgentResult?: string;
  error?: string;
}

export interface PendingApproval {
  action: AgentAction;
  reason: string;
  requestedAt: string;
}

export interface PendingQuestion {
  question: AskUserQuestion;
  askedAt: string;
}

export interface LoopState {
  sessionId: string;
  runId: string;
  turn: number;
  status: LoopStatus;
  goal?: string;
  constraints?: string[];
  pendingApproval?: PendingApproval;
  pendingQuestion?: PendingQuestion;
  toolResults: ToolExecutionRecord[];
  subAgentResults: SubAgentExecutionRecord[];
  memorySnapshot: Record<string, unknown>;
  evidenceRefs: string[];
  metadata?: Record<string, unknown>;
  lastError?: string;
}

export interface RuntimeDeps {
  nowISO(): string;
  randomId(prefix: string): string;
}

export interface KernelContext {
  maxTurns: number;
}
