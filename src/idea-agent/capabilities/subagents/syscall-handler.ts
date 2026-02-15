import { z } from "zod";
import type { SubAgentContext } from "./types";

// ─── 1a. Zod schema fragment for syscall action ───

export const syscallActionVariant = z.object({
  type: z.literal("syscall"),
  syscallType: z.enum(["call_tool", "call_subagent"]),
  toolId: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  subAgentId: z.string().optional(),
  task: z.string().optional(),
});

export type SyscallAction = z.infer<typeof syscallActionVariant>;

// ─── 1b. Normalize syscall from raw parsed JSON ───

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function tryParseSyscall(obj: Record<string, unknown>): SyscallAction | undefined {
  if (typeof obj.type !== "string" || obj.type !== "syscall") {
    return undefined;
  }
  const syscallType = typeof obj.syscallType === "string" ? obj.syscallType : undefined;
  if (syscallType !== "call_tool" && syscallType !== "call_subagent") {
    return undefined;
  }
  return {
    type: "syscall",
    syscallType,
    toolId: typeof obj.toolId === "string" ? obj.toolId : undefined,
    input: asRecord(obj.input) ?? undefined,
    subAgentId: typeof obj.subAgentId === "string" ? obj.subAgentId : undefined,
    task: typeof obj.task === "string" ? obj.task : undefined,
  };
}

export function normalizeSyscallFromRaw(
  root: Record<string, unknown>,
): SyscallAction | undefined {
  // Try root level
  const fromRoot = tryParseSyscall(root);
  if (fromRoot) return fromRoot;

  // Try nested in root.action
  const rootAction = asRecord(root.action);
  if (rootAction) {
    return tryParseSyscall(rootAction);
  }

  return undefined;
}

// ─── 1c. Process a syscall action and return trace + history entries ───

export interface SyscallTraceEntry {
  subTurn: number;
  toolId: string;
  input: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
  at: string;
}

export interface SyscallHistoryEntry {
  subTurn: number;
  toolId: string;
  ok: boolean;
  input: unknown;
  result?: string;
  error?: string;
  at: string;
}

export interface SyscallProcessResult {
  trace: SyscallTraceEntry;
  history: SyscallHistoryEntry;
}

function compact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= 10_000) return value;
  return { preview: s.slice(0, 10_000), truncated: true, originalLength: s.length };
}

export async function processSyscallAction(params: {
  action: SyscallAction;
  ctx: SubAgentContext;
  subTurn: number;
}): Promise<SyscallProcessResult> {
  const { action, ctx, subTurn } = params;
  const now = () => new Date().toISOString();

  // syscall not available — graceful degradation
  if (!ctx.syscall) {
    const entry = {
      subTurn,
      toolId: "__syscall__",
      ok: false,
      input: action,
      error: "syscall not available",
      at: now(),
    };
    return {
      trace: { ...entry, data: undefined },
      history: { ...entry, result: undefined },
    };
  }

  await ctx.reportProgress?.({
    stage: "syscall.requested",
    payload: {
      subTurn,
      syscallType: action.syscallType,
      toolId: action.toolId,
      subAgentId: action.subAgentId,
    },
  });

  try {
    const request =
      action.syscallType === "call_tool"
        ? { type: "call_tool" as const, toolId: action.toolId!, input: action.input ?? {} }
        : { type: "call_subagent" as const, subAgentId: action.subAgentId!, task: action.task! };

    const response = await ctx.syscall(request);

    let trace: SyscallTraceEntry;
    let history: SyscallHistoryEntry;

    if (response.type === "tool_result") {
      const ok = response.outcome.result.ok;
      const resultContent = ok
        ? (typeof response.outcome.result.data === "string"
            ? response.outcome.result.data
            : JSON.stringify(response.outcome.result.data))
        : undefined;

      trace = {
        subTurn,
        toolId: `syscall:${response.toolId}`,
        input: action.input ?? {},
        ok,
        data: ok ? compact(response.outcome.result.data) : undefined,
        error: ok ? undefined : response.outcome.result.error,
        at: now(),
      };
      history = {
        subTurn,
        toolId: `syscall:${response.toolId}`,
        ok,
        input: action.input ?? {},
        result: resultContent,
        error: ok ? undefined : response.outcome.result.error,
        at: now(),
      };
    } else {
      // subagent_result
      const ok = response.outcome.ok;
      trace = {
        subTurn,
        toolId: `syscall:subagent:${response.subAgentId}`,
        input: { task: action.task },
        ok,
        data: ok ? compact(response.outcome.result?.subAgentResult) : undefined,
        error: ok ? undefined : response.outcome.error,
        at: now(),
      };
      history = {
        subTurn,
        toolId: `syscall:subagent:${response.subAgentId}`,
        ok,
        input: { task: action.task },
        result: ok ? response.outcome.result?.subAgentResult : undefined,
        error: ok ? undefined : response.outcome.error,
        at: now(),
      };
    }

    await ctx.reportProgress?.({
      stage: "syscall.completed",
      payload: { subTurn, syscallType: action.syscallType },
    });

    return { trace, history };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "syscall failed";
    const entry = {
      subTurn,
      toolId: "__syscall__",
      ok: false,
      input: action,
      error: msg,
      at: now(),
    };
    return {
      trace: { ...entry, data: undefined },
      history: { ...entry, result: undefined },
    };
  }
}

// ─── 1d. Build syscall prompt section ───

export function buildSyscallPromptSection(
  ctx: SubAgentContext,
): string {
  if (!ctx.syscall) return "";

  return `
可用系统调用（通过 syscall action 触发）：
- call_tool: 可调用任意已注册工具（包括需要审批的 local-cli 等）
- call_subagent: 可调用其他子代理（如 paper-summary-agent, reviewer-agent, deep-search-agent）
syscall 会陷入主 Agent 层执行，敏感工具会征求用户同意。仅在确实需要时使用。

syscall 示例：
{"action":{"type":"syscall","syscallType":"call_tool","toolId":"local-cli","input":{"command":"ls","args":["-la"]}},"notes":"..."}
{"action":{"type":"syscall","syscallType":"call_subagent","subAgentId":"paper-summary-agent","task":"总结这篇论文..."},"notes":"..."}`;
}
