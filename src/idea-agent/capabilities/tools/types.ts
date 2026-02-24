import { z } from "zod";

export type JsonSchema = z.ZodTypeAny;

/** @deprecated Use ContextVariables from core/context-variables.ts instead */
export interface ToolContext {
  sessionId: string;
  runId: string;
  turn: number;
  state: Record<string, unknown>;
  nowISO(): string;
}

export type ToolResult<O> =
  | { ok: true; data: O; raw?: unknown }
  | { ok: false; error: string; raw?: unknown };

export interface ToolInputFieldSpec {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface ToolRuntimeProfile {
  description: string;
  inputHint?: string;
  inputFields?: ToolInputFieldSpec[];
  outputFormat?: string;
  extraConfigs?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface Tool<I = unknown, O = unknown> {
  id: string;
  description: string;
  inputHint?: string;
  inputFields?: ToolInputFieldSpec[];
  outputFormat?: string;
  inputSchema: JsonSchema;
  requiresApproval?(input: I, ctx: ToolContext): Promise<boolean> | boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
