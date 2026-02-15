interface SubAgentTraceRecord {
  subTurn: number;
  toolId: string;
  input: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface BuildSubAgentResultOptions {
  agentId: string;
  taskPrompt: string;
  summary: string;
  maxTurns: number;
  trace: SubAgentTraceRecord[];
  decisionErrorCount: number;
  llmPromptInputCount?: number;
  extra?: Record<string, unknown>;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...(truncated)`;
}

function toCompactString(value: unknown, limit: number): string {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return truncateText(value, limit);
  }

  try {
    return truncateText(JSON.stringify(value), limit);
  } catch {
    return "[unserializable]";
  }
}

function renderTrace(trace: SubAgentTraceRecord[]): string {
  if (trace.length === 0) {
    return "- (none)";
  }

  const rows = trace.slice(-12).map((item) => {
    const status = item.ok ? "ok" : "failed";
    const input = toCompactString(item.input, 220);
    if (item.ok) {
      const data = toCompactString(item.data, 260);
      return `- [T${item.subTurn}] ${item.toolId} (${status}) input=${input} data=${data}`;
    }

    const error = truncateText(item.error ?? "unknown error", 260);
    return `- [T${item.subTurn}] ${item.toolId} (${status}) input=${input} error=${error}`;
  });

  return rows.join("\n");
}

export function buildSubAgentResultText(options: BuildSubAgentResultOptions): string {
  const okCount = options.trace.filter((item) => item.ok).length;
  const failedCount = options.trace.length - okCount;
  const status = options.summary.trim().length > 0 ? "finished" : "max_turns";
  const normalizedSummary = options.summary.trim().length > 0
    ? options.summary.trim()
    : `${options.agentId} reached max turns (${options.maxTurns}), collected ${options.trace.length} actions with ${okCount} successful calls.`;

  const blocks: string[] = [];
  blocks.push(`[SubAgent] ${options.agentId}`);
  blocks.push(`status: ${status}`);
  blocks.push(`task: ${truncateText(options.taskPrompt.trim(), 360)}`);
  blocks.push(`summary: ${truncateText(normalizedSummary, 2400)}`);
  blocks.push(
    `stats: maxTurns=${options.maxTurns}, actions=${options.trace.length}, ok=${okCount}, failed=${failedCount}, decisionErrors=${options.decisionErrorCount}, llmPromptCalls=${options.llmPromptInputCount ?? 0}`,
  );
  blocks.push("toolTrace:");
  blocks.push(renderTrace(options.trace));

  if (options.extra && Object.keys(options.extra).length > 0) {
    blocks.push(`extra: ${toCompactString(options.extra, 3200)}`);
  }

  return truncateText(blocks.join("\n"), 12_000);
}

