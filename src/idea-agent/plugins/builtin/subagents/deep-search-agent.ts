import { z } from "zod";
import type { SubAgent, SubAgentContext, SubAgentResult, SubAgentRuntimeProfile } from "../../../capabilities/subagents/types";
import {
  syscallActionVariant,
  normalizeSyscallFromRaw,
  processSyscallAction,
  buildSyscallPromptSection,
} from "../../../capabilities/subagents/syscall-handler";
import { ConfigurableSubAgent } from "../../../capabilities/subagents/configurable-subagent";
import type { ToolPromptSpec } from "../../../capabilities/tools/tool-prompt";
import { buildToolPromptLines } from "../../../capabilities/tools/tool-prompt";
import { setupTools } from "../../../capabilities/tools/tool-setup";
import { getIdeaAgentSettings } from "../../../config/settings";
import { builtinToolCatalog } from "../tool-catalog";
import { buildSubAgentResultText } from "./subagent-result";
import { fetchWithRetry } from "../../../capabilities/tools/search-summarizer";
import { tryParseJson } from "../../../utils/json-parser";

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call_tool"),
    toolId: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("finish"),
    summary: z.string().min(1),
  }),
  syscallActionVariant,
]);

const decisionSchema = z.object({
  action: actionSchema,
  notes: z.string().optional(),
});

const mainAgentLikeActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call_tool"),
    toolId: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("respond"),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.string().optional(),
  }),
]);

const mainAgentLikeDecisionSchema = z.object({
  actions: z.array(mainAgentLikeActionSchema).min(1),
});

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}


interface ToolTraceRecord {
  subTurn: number;
  toolId: string;
  input: unknown;
  ok: boolean;
  data?: unknown;
  error?: string;
  at: string;
}

interface ToolHistoryEntry {
  subTurn: number;
  toolId: string;
  ok: boolean;
  input: unknown;
  result?: string;
  error?: string;
  at: string;
}

interface LlmPromptInputRecord {
  subTurn: number;
  endpoint: string;
  request: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function resolveToolIdField(value: Record<string, unknown>): string | undefined {
  if (typeof value.toolId === "string" && value.toolId.length > 0) {
    return value.toolId;
  }
  if (typeof value.tool === "string" && value.tool.length > 0) {
    return value.tool;
  }
  return undefined;
}


const knownToolIds = new Set<string>(Object.keys(builtinToolCatalog));

const actionReservedKeys = new Set<string>([
  "type",
  "tool",
  "toolId",
  "input",
  "notes",
  "summary",
  "reason",
  "message",
]);

function normalizeShorthandInput(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !actionReservedKeys.has(key)),
  );
}

function buildToolAction(toolId: string, source: Record<string, unknown>): z.infer<typeof actionSchema> {
  const explicitInput = asRecord(source.input);
  return {
    type: "call_tool",
    toolId,
    input: normalizeToolInput(explicitInput ?? normalizeShorthandInput(source)),
  };
}

function normalizeActionFromParsed(parsed: unknown): z.infer<typeof actionSchema> {
  const direct = decisionSchema.safeParse(parsed);
  if (direct.success) {
    return direct.data.action;
  }

  const alt = mainAgentLikeDecisionSchema.safeParse(parsed);
  if (alt.success) {
    const first = alt.data.actions[0];
    if (first.type === "call_tool") {
      return {
        type: "call_tool",
        toolId: first.toolId,
        input: normalizeToolInput(first.input),
      };
    }
    if (first.type === "respond") {
      return {
        type: "finish",
        summary: first.message,
      };
    }
    return {
      type: "finish",
      summary: first.reason ?? "DeepResearchAgent finished.",
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("DeepResearchAgent decision is not an object");
  }

  const rootType = typeof root.type === "string" ? root.type : undefined;
  const rootToolId = resolveToolIdField(root);

  if (rootType === "call_tool" && rootToolId) {
    return buildToolAction(rootToolId, root);
  }

  const syscall = normalizeSyscallFromRaw(root);
  if (syscall) return syscall;

  if (rootType && knownToolIds.has(rootType)) {
    return buildToolAction(rootType, root);
  }

  if (rootType === "finish") {
    const summary =
      typeof root.summary === "string" ? root.summary
        : typeof root.reason === "string" ? root.reason
          : "DeepResearchAgent finished.";
    return {
      type: "finish",
      summary,
    };
  }

  const rootAction = asRecord(root.action);
  if (rootAction) {
    const actionType = typeof rootAction.type === "string" ? rootAction.type : undefined;
    const actionToolId = resolveToolIdField(rootAction);

    if (actionType === "call_tool" && actionToolId) {
      return buildToolAction(actionToolId, rootAction);
    }

    if (actionType && knownToolIds.has(actionType)) {
      return buildToolAction(actionType, rootAction);
    }

    if (actionType === "finish") {
      const summary =
        typeof rootAction.summary === "string" ? rootAction.summary
          : typeof rootAction.reason === "string" ? rootAction.reason
            : "DeepResearchAgent finished.";
      return {
        type: "finish",
        summary,
      };
    }

    if (!actionType && actionToolId) {
      return buildToolAction(actionToolId, rootAction);
    }
  }

  const actionsMaybe = Array.isArray(root.actions) ? root.actions : undefined;
  if (actionsMaybe && actionsMaybe.length > 0) {
    const first = asRecord(actionsMaybe[0]);
    if (first) {
      const firstType = typeof first.type === "string" ? first.type : undefined;
      const firstToolId = resolveToolIdField(first);

      if (firstType === "call_tool" && firstToolId) {
        return buildToolAction(firstToolId, first);
      }

      if (firstType && knownToolIds.has(firstType)) {
        return buildToolAction(firstType, first);
      }

      if (firstToolId) {
        return buildToolAction(firstToolId, first);
      }

      const message =
        typeof first.message === "string" ? first.message
          : typeof first.summary === "string" ? first.summary
            : typeof first.reason === "string" ? first.reason
              : undefined;

      if (message) {
        return {
          type: "finish",
          summary: message,
        };
      }
    }
  }

  if (rootToolId) {
    return buildToolAction(rootToolId, root);
  }

  const rootActionRecord = asRecord(root.action);
  const badType = rootType
    ?? (rootActionRecord && typeof rootActionRecord.type === "string" ? rootActionRecord.type : undefined);
  const snippet = JSON.stringify(root).slice(0, 320);
  if (badType && badType !== "call_tool" && badType !== "finish" && badType !== "syscall") {
    throw new Error(
      `DeepResearchAgent: action.type="${badType}" 不合法。` +
      `action.type 只能是 "call_tool" | "finish" | "syscall"。` +
      `若要调用工具 "${badType}"，正确格式为 ` +
      `{"action":{"type":"call_tool","toolId":"${badType}","input":{...}}}。` +
      `原始输出: ${snippet}`,
    );
  }
  throw new Error(
    `DeepResearchAgent unrecognized decision schema: ${snippet}。` +
    `action.type 只能是 "call_tool" | "finish" | "syscall"`,
  );
}

function diagnoseNonJsonOutput(raw: string): string {
  const trimmed = raw.trim();

  if (/^```/.test(trimmed)) {
    return "输出被 Markdown 代码块包裹（以 ``` 开头）。请直接输出纯 JSON，不要使用 Markdown 代码块标记。";
  }

  if (/^#\s/.test(trimmed) || /^\*\*/.test(trimmed) || /^-\s/.test(trimmed)) {
    return "输出是 Markdown 格式的文本（标题/列表/加粗）。请直接输出纯 JSON 对象，不要输出任何 Markdown 内容。";
  }

  if (/^<[a-zA-Z]/.test(trimmed)) {
    return "输出包含 HTML/XML 标签。请直接输出纯 JSON 对象。";
  }

  if (/^[a-zA-Z\u4e00-\u9fff]/.test(trimmed) && !trimmed.startsWith("{")) {
    const firstLine = trimmed.split("\n")[0].slice(0, 120);
    return `输出以自然语言文本开头而非 JSON："${firstLine}"。请直接输出以 { 开头的 JSON 对象，不要在 JSON 前后添加任何文字说明。`;
  }

  if (trimmed.startsWith("[")) {
    return "输出是 JSON 数组而非 JSON 对象。请输出 {\"action\":{...}} 格式的单个 JSON 对象，不要用数组包裹。";
  }

  return `输出无法解析为 JSON。前 200 字符："${trimmed.slice(0, 200)}"。请确保输出是且仅是一个合法的 JSON 对象。`;
}

function buildDecisionCorrectionHint(errorMessage: string): string {
  return `[系统纠错提示] 你上一轮的输出格式不正确：${errorMessage}\n` +
    "请严格遵守输出格式要求：输出必须是且仅是一个合法 JSON 对象，格式为 " +
    '{"action":{"type":"call_tool","toolId":"<工具ID>","input":{...}},"notes":"..."} 或 ' +
    '{"action":{"type":"finish","summary":"<结论>"},"notes":"..."}。' +
    "禁止在 JSON 前后添加任何文字、Markdown 标记或代码块。";
}

async function decideNextAction(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  taskPrompt: string;
  subTurn: number;
  maxTurns: number;
  allowedTools: ToolPromptSpec[];
  toolHistory: ToolHistoryEntry[];
  syscallHint?: string;
  onPromptInput?: (input: LlmPromptInputRecord) => void;
}): Promise<{ action: z.infer<typeof actionSchema>; notes?: string }> {
  const payload: Record<string, unknown> = {
    subTurn: params.subTurn,
    maxTurns: params.maxTurns,
    taskPrompt: params.taskPrompt,
    toolHistory: params.toolHistory,
  };

  const messages = [
    {
      role: "system",
      content: `${params.systemPrompt}

【运行时约束 — 必须严格遵守】
你是 DeepResearchAgent 的执行器。你的输出必须是且仅是一个合法 JSON 对象，不得包含任何非 JSON 文本。

允许的输出格式：
{"action":{"type":"call_tool","toolId":"<toolId>","input":{<参数>}},"notes":"<思考>"}
{"action":{"type":"finish","summary":"<结论>"},"notes":"<思考>"}${params.syscallHint ? `
{"action":{"type":"syscall","syscallType":"call_tool","toolId":"<toolId>","input":{<参数>}},"notes":"<思考>"}
{"action":{"type":"syscall","syscallType":"call_subagent","subAgentId":"<子代理ID>","task":"<任务描述>"},"notes":"<思考>"}` : ""}

禁止的输出（会导致解析失败）：
- 在 JSON 前后添加任何文字说明或 Markdown 标记
- type 字段填写工具名（如 "web-search"），type 只能是 "call_tool"、"finish"${params.syscallHint ? " 或 \"syscall\"" : ""}
- 把工具参数放在 action 对象之外
- 使用 actions 数组包裹（不要用 {"actions":[...]}）

可用工具（仅可使用下列 toolId；严格按 schema + inputHint 传参）：
${buildToolPromptLines(params.allowedTools)}
${params.syscallHint ?? ""}
【调研历史说明】
payload.toolHistory 是一个数组，按时间顺序记录了你之前每一轮的工具调用。每条记录包含：
- subTurn / toolId / ok / input / error / at：调用元数据
- result：调用结果内容（搜索类工具为结构化总结，其他工具为原始返回）
仔细阅读 toolHistory 中的 result 字段，利用已有发现推进调研，避免重复搜索相同内容。`,
    },
    {
      role: "user",
      content: JSON.stringify(payload),
    },
  ];

  const requestBody = {
    model: params.model,
    temperature: params.temperature,
    max_tokens: params.maxTokens,
    response_format: { type: "json_object" as const },
    messages,
  };

  params.onPromptInput?.({
    subTurn: params.subTurn,
    endpoint: `${params.baseUrl}/chat/completions`,
    request: requestBody,
  });

  const response = await fetchWithRetry(
    `${params.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    `deep-search-agent/decision/turn-${params.subTurn}`,
  );

  if (!response.ok) {
    const detail = await response.text();
    const errorMsg = `DeepResearchAgent LLM API error: ${response.status} ${detail.slice(0, 500)}`;
    console.error(`[deep-search-agent] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const rawContent = data.choices?.[0]?.message?.content;
  const content = normalizeMessageContent(rawContent);

  if (!content) {
    throw new Error("DeepResearchAgent LLM returned empty content");
  }

  const parsedJson = tryParseJson(content);
  if (!parsedJson) {
    const diagnosis = diagnoseNonJsonOutput(content);
    throw new Error(`DeepResearchAgent LLM 输出格式错误：${diagnosis}`);
  }

  try {
    const action = normalizeActionFromParsed(parsedJson);
    const root = asRecord(parsedJson);
    const notes = root && typeof root.notes === "string" ? root.notes : undefined;
    return { action, notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${msg} | Raw output: ${content.slice(0, 500)}`);
  }
}



function normalizeMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}


function extractWebFetchContent(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (content.length === 0) {
    return undefined;
  }
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const url = typeof record.finalUrl === "string" ? record.finalUrl : (typeof record.url === "string" ? record.url : "");
  const header = [
    title ? `# ${title}` : "",
    url ? `Source: ${url}` : "",
  ].filter(Boolean).join("\n");
  return header ? `${header}\n\n${content}` : content;
}

function compact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= 800) {
    return value;
  }

  return {
    preview: serialized.slice(0, 800),
    truncated: true,
    originalLength: serialized.length,
  };
}

const deepSearchDefaultProfile: SubAgentRuntimeProfile = {
  model: "gpt-4o-mini",
  maxTurns: 6,
  allowedTools: ["web-search", "web-fetch", "arxiv-search", "openalex-search", "venue-search", "mineru-parse", "read-session-files"],
  systemPrompt: `你是 DeepResearchAgent。你需要围绕用户给定研究目标开展多轮自主调研。

【输出格式 — 严格遵守】
你的输出必须是且仅是一个合法 JSON 对象，禁止在 JSON 前后添加任何文字、Markdown 代码块标记或注释。
每轮只能输出 1 个 action，结构固定为：
{"action":{"type":"<ACTION_TYPE>", ...},"notes":"<可选的简短思考>"}

ACTION_TYPE 包括：

1) call_tool — 调用一个工具：
{"action":{"type":"call_tool","toolId":"<工具ID>","input":{<工具参数>}},"notes":"..."}

2) finish — 结束调研并输出结论：
{"action":{"type":"finish","summary":"<结论全文>"},"notes":"..."}

完整示例（call_tool）：
{"action":{"type":"call_tool","toolId":"web-search","input":{"query":"transformer attention mechanism survey"}},"notes":"先搜索综述"}

完整示例（finish）：
{"action":{"type":"finish","summary":"经过调研发现：1) ... 2) ... 结论：..."},"notes":"证据充分，可以总结"}

【调研规则】
1) 优先通过工具获取证据，再总结。
2) 当证据足够时，使用 finish 输出结论，summary 中应包含关键发现与引用来源。
3) 不允许调用未授权工具。
4) 禁止输出纯文本解释、Markdown 或任何非 JSON 内容。`,
};

class DeepSearchAgent extends ConfigurableSubAgent {
  readonly id = "deep-search-agent";
  readonly description = "LLM-driven autonomous deep research sub-agent (input task is one plain-text prompt) with configurable tool permissions";
  protected readonly defaultProfile = deepSearchDefaultProfile;

  protected async runWithProfile(
    normalizedTaskPrompt: string,
    ctx: SubAgentContext,
    profile: SubAgentRuntimeProfile,
  ): Promise<SubAgentResult> {
    const settings = getIdeaAgentSettings();

    const apiKey = settings.openai.apiKey;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for deep-search-agent");
    }

    const { resolvedToolIds: allowedToolIds, invoker: toolInvoker, promptSpecs: allowedTools } =
      setupTools({ catalog: builtinToolCatalog, allowedTools: profile.allowedTools ?? [], settings });

    if (allowedToolIds.length === 0) {
      throw new Error("deep-search-agent has no allowed tools. Check subagents.config.json");
    }

    const model = profile.model || settings.openai.model || "gpt-4o-mini";
    const baseUrl = (settings.openai.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const temperature = settings.openai.temperature ?? 0.2;
    const maxTokens = Math.max(1, Math.min(16000, Math.floor(settings.openai.maxTokens ?? 1200)));
    const maxTurns = Math.max(1, Math.min(1000, Math.floor(profile.maxTurns ?? 6)));

    const trace: ToolTraceRecord[] = [];
    const toolHistory: ToolHistoryEntry[] = [];
    const llmPromptInputs: LlmPromptInputRecord[] = [];
    const capturePromptInput = settings.runtime.debugPrompts === true
      ? (entry: LlmPromptInputRecord) => {
          llmPromptInputs.push(entry);
        }
      : undefined;
    let summary = "";
    let decisionErrorCount = 0;

    await ctx.reportProgress?.({
      stage: "run.start",
      payload: {
        maxTurns,
        model,
        allowedTools: allowedToolIds,
      },
    });

    for (let subTurn = 1; subTurn <= maxTurns; subTurn += 1) {
      await ctx.reportProgress?.({
        stage: "turn.start",
        payload: {
          subTurn,
          maxTurns,
        },
      });

      let action: z.infer<typeof actionSchema>;
      let notes: string | undefined;
      try {
        const decision = await decideNextAction({
          apiKey,
          baseUrl,
          model,
          temperature,
          maxTokens,
          systemPrompt: profile.systemPrompt,
          taskPrompt: normalizedTaskPrompt,
          subTurn,
          maxTurns,
          allowedTools,
          toolHistory,
          syscallHint: buildSyscallPromptSection(ctx),
          onPromptInput: capturePromptInput,
        });
        action = decision.action;
        notes = decision.notes;

        await ctx.reportProgress?.({
          stage: "decision.produced",
          payload: {
            subTurn,
            actionType: action.type,
            toolId: action.type === "call_tool" ? action.toolId : (action.type === "syscall" ? action.toolId : undefined),
            syscallType: action.type === "syscall" ? action.syscallType : undefined,
            subAgentId: action.type === "syscall" ? action.subAgentId : undefined,
            notes,
          },
        });
      } catch (error) {
        decisionErrorCount += 1;
        const errorMsg = error instanceof Error ? error.message : "DeepResearchAgent decision failed";
        const correctionHint = buildDecisionCorrectionHint(errorMsg);
        await ctx.reportProgress?.({
          stage: "decision.failed",
          payload: {
            subTurn,
            error: errorMsg,
          },
        });
        trace.push({
          subTurn,
          toolId: "__decision__",
          input: {},
          ok: false,
          error: errorMsg,
          at: new Date().toISOString(),
        });
        toolHistory.push({
          subTurn,
          toolId: "__decision__",
          ok: false,
          input: {},
          error: correctionHint,
          at: new Date().toISOString(),
        });
        continue;
      }

      if (action.type === "finish") {
        summary = action.summary;
        await ctx.reportProgress?.({
          stage: "run.finish",
          payload: {
            subTurn,
            reason: "llm_finish",
            summaryPreview: summary.slice(0, 400),
          },
        });
        break;
      }

      if (action.type === "syscall") {
        const result = await processSyscallAction({ action, ctx, subTurn });
        toolHistory.push(result.history);
        trace.push(result.trace);
        continue;
      }

      if (!allowedToolIds.includes(action.toolId)) {
        await ctx.reportProgress?.({
          stage: "tool.rejected",
          payload: {
            subTurn,
            toolId: action.toolId,
            error: `Tool not allowed: ${action.toolId}`,
          },
        });
        trace.push({
          subTurn,
          toolId: action.toolId,
          input: action.input,
          ok: false,
          error: `Tool not allowed: ${action.toolId}`,
          at: new Date().toISOString(),
        });
        toolHistory.push({
          subTurn,
          toolId: action.toolId,
          ok: false,
          input: action.input,
          error: `Tool not allowed: ${action.toolId}`,
          at: new Date().toISOString(),
        });
        continue;
      }

      await ctx.reportProgress?.({
        stage: "tool.call.start",
        payload: {
          subTurn,
          toolId: action.toolId,
          input: compact(action.input),
        },
      });

      const outcome = await toolInvoker.invoke(action.toolId, action.input, ctx.state);
      await ctx.reportProgress?.({
        stage: outcome.result.ok ? "tool.call.success" : "tool.call.failed",
        payload: {
          subTurn,
          toolId: action.toolId,
          ok: outcome.result.ok,
          data: outcome.result.ok ? compact(outcome.result.data) : undefined,
          error: outcome.result.ok ? undefined : outcome.result.error,
        },
      });
      trace.push({
        subTurn,
        toolId: action.toolId,
        input: action.input,
        ok: outcome.result.ok,
        data: outcome.result.ok ? compact(outcome.result.data) : undefined,
        error: outcome.result.ok ? undefined : outcome.result.error,
        at: new Date().toISOString(),
      });

      if (!outcome.result.ok) {
        toolHistory.push({
          subTurn,
          toolId: action.toolId,
          ok: false,
          input: action.input,
          error: outcome.result.error,
          at: new Date().toISOString(),
        });
        continue;
      }

      // Build result content for toolHistory
      let resultContent: string;

      const webFetchContent = action.toolId === "web-fetch" && extractWebFetchContent(outcome.result.data);

      if (webFetchContent) {
        // web-fetch: use readability-extracted markdown directly
        resultContent = webFetchContent;
      } else {
        // All other tools: string data used directly, object data JSON.stringified
        // (arxiv-search / openalex-search already return summarized text by default)
        resultContent = typeof outcome.result.data === "string"
          ? outcome.result.data
          : JSON.stringify(outcome.result.data);
      }

      toolHistory.push({
        subTurn,
        toolId: action.toolId,
        ok: true,
        input: action.input,
        result: resultContent,
        at: new Date().toISOString(),
      });
      await ctx.reportProgress?.({
        stage: "tool.history.updated",
        payload: {
          subTurn,
          toolId: action.toolId,
          resultPreview: resultContent.slice(0, 1000),
          resultLength: resultContent.length,
          directContent: !!webFetchContent,
        },
      });

    }

    if (!summary) {
      await ctx.reportProgress?.({
        stage: "run.force_finish.start",
        payload: {
          reason: "max_turns",
          subTurn: maxTurns + 1,
        },
      });

      const forceFinishMaxRetries = 3;
      for (let attempt = 1; attempt <= forceFinishMaxRetries; attempt += 1) {
        try {
          const forcedDecision = await decideNextAction({
            apiKey,
            baseUrl,
            model,
            temperature,
            maxTokens,
            systemPrompt: `${profile.systemPrompt}\n\n[强制收尾模式]\n你已达到最大轮数。禁止再调用任何工具。你现在必须直接输出 finish action，总结已获得证据、给出结论与后续建议。`,
            taskPrompt: `${normalizedTaskPrompt}\n\n[系统强制要求] 已达到 maxTurns=${maxTurns}，本轮禁止 call_tool，只能 finish。`,
            subTurn: maxTurns + attempt,
            maxTurns,
            allowedTools: [],
            toolHistory,
            onPromptInput: capturePromptInput,
          });

          if (forcedDecision.action.type === "finish") {
            summary = forcedDecision.action.summary;
            await ctx.reportProgress?.({
              stage: "run.force_finish.success",
              payload: {
                attempt,
                summaryPreview: summary.slice(0, 400),
              },
            });
            break;
          } else {
            throw new Error(`force finish returned non-finish action: ${forcedDecision.action.type}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "force finish failed";
          await ctx.reportProgress?.({
            stage: "run.force_finish.failed",
            payload: {
              attempt,
              maxRetries: forceFinishMaxRetries,
              error: errorMsg,
            },
          });

          if (attempt < forceFinishMaxRetries) {
            const correctionHint = buildDecisionCorrectionHint(errorMsg);
            toolHistory.push({
              subTurn: maxTurns + attempt,
              toolId: "__decision__",
              ok: false,
              input: {},
              error: correctionHint,
              at: new Date().toISOString(),
            });
          }
        }
      }

      if (!summary) {
        const okCount = trace.filter((item) => item.ok).length;
        if (okCount === 0 && decisionErrorCount > 0) {
          throw new Error(`DeepResearchAgent failed: ${decisionErrorCount} invalid LLM decisions and no successful tool call.`);
        }
        summary = `Deep research reached max turns (${maxTurns}), collected ${trace.length} tool calls with ${okCount} successful calls.`;
      }

      await ctx.reportProgress?.({
        stage: "run.finish",
        payload: {
          reason: "max_turns",
          summaryPreview: summary.slice(0, 400),
        },
      });
    }

    const subAgentResult = buildSubAgentResultText({
      agentId: this.id,
      taskPrompt: normalizedTaskPrompt,
      summary,
      maxTurns,
      trace,
      decisionErrorCount,
      llmPromptInputCount: llmPromptInputs.length,
      extra: {
        allowedTools: allowedToolIds,
      },
    });

    return {
      subAgentResult,
    };
  }
}

export const deepSearchAgent: SubAgent = new DeepSearchAgent();
