import { z } from "zod";
import { ConfigurableSubAgent } from "../../../capabilities/subagents/configurable-subagent";
import type { SubAgent, SubAgentContext, SubAgentResult, SubAgentRuntimeProfile } from "../../../capabilities/subagents/types";
import {
  syscallActionVariant,
  normalizeSyscallFromRaw,
  processSyscallAction,
  buildSyscallPromptSection,
} from "../../../capabilities/subagents/syscall-handler";
import type { ToolPromptSpec } from "../../../capabilities/tools/tool-prompt";
import { buildToolPromptLines } from "../../../capabilities/tools/tool-prompt";
import { setupTools } from "../../../capabilities/tools/tool-setup";
import { getIdeaAgentSettings } from "../../../config/settings";
import { builtinToolCatalog } from "../tool-catalog";
import { buildSubAgentResultText } from "./subagent-result";
import { fetchWithRetry } from "../../../capabilities/tools/search-summarizer";
import { tryParseJson } from "../../../utils/json-parser";
import { getNotebooksSummary } from "../../builtin/tools/research-notebook";

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call_tool"),
    toolId: z.string().min(1),
    input: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("finish"),
    summary: z.string().min(1),
    review: z
      .object({
        strengths: z.array(z.string()).default([]),
        weaknesses: z.array(z.string()).default([]),
        suggestions: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
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
    type: z.literal("finish"),
    reason: z.string().optional(),
    summary: z.string().optional(),
    review: z
      .object({
        strengths: z.array(z.string()).optional(),
        weaknesses: z.array(z.string()).optional(),
        suggestions: z.array(z.string()).optional(),
      })
      .optional(),
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

interface LlmPromptInputRecord {
  subTurn: number;
  endpoint: string;
  request: unknown;
}

const reviewerDefaultProfile: SubAgentRuntimeProfile = {
  model: "gpt-4o-mini",
  maxTurns: 6,
  systemPrompt: `你是 reviewer-agent（LLM 子代理）。
目标：给出顶会风格的结构化评审结论。
要求：
1) 优先指出核心贡献与证据链。
2) 明确主要缺陷（新颖性、实验充分性、可复现性、写作清晰度）。
3) 给出可执行修改建议。
4) 若证据不足，可调用授权工具补证后再 finish。
5) payload.activeNotebooks 列出了当前会话的调研笔记本摘要。你可以通过 research-notebook 工具的 view / view_full / view_question 操作查看前期深度调研的详细结果，以辅助评审。`,
  allowedTools: ["arxiv-search", "openalex-search", "web-search", "research-notebook"],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeToolInput(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
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


function compact(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= 10_000) {
    return value;
  }

  return {
    preview: serialized.slice(0, 10_000),
    truncated: true,
    originalLength: serialized.length,
  };
}

function normalizeActionFromParsed(parsed: unknown): z.infer<typeof actionSchema> {
  const direct = decisionSchema.safeParse(parsed);
  if (direct.success) {
    return {
      ...direct.data.action,
      ...(direct.data.action.type === "call_tool" ? { input: normalizeToolInput(direct.data.action.input) } : {}),
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("reviewer-agent decision is not an object");
  }

  const syscall = normalizeSyscallFromRaw(root);
  if (syscall) return syscall;

  const mainLike = mainAgentLikeDecisionSchema.safeParse(root);
  if (mainLike.success) {
    const first = mainLike.data.actions[0];
    if (first.type === "call_tool") {
      return {
        type: "call_tool",
        toolId: first.toolId,
        input: normalizeToolInput(first.input),
      };
    }

    return {
      type: "finish",
      summary: first.summary ?? first.reason ?? "reviewer-agent finished",
      review: first.review,
    };
  }

  if (root.type === "call_tool" || root.type === "finish") {
    const parsedAction = actionSchema.safeParse(root);
    if (parsedAction.success) {
      if (parsedAction.data.type === "call_tool") {
        return {
          type: "call_tool",
          toolId: parsedAction.data.toolId,
          input: normalizeToolInput(parsedAction.data.input),
        };
      }

      return parsedAction.data;
    }
  }

  const rootAction = asRecord(root.action);
  const badType = (typeof root.type === "string" ? root.type : undefined)
    ?? (rootAction && typeof rootAction.type === "string" ? rootAction.type : undefined);
  const snippet = JSON.stringify(root).slice(0, 320);
  if (badType && badType !== "call_tool" && badType !== "finish" && badType !== "syscall") {
    throw new Error(
      `reviewer-agent: action.type="${badType}" 不合法。` +
      `action.type 只能是 "call_tool" | "finish" | "syscall"。` +
      `若要调用工具 "${badType}"，正确格式为 ` +
      `{"action":{"type":"call_tool","toolId":"${badType}","input":{...}}}。` +
      `原始输出: ${snippet}`,
    );
  }
  throw new Error(
    `reviewer-agent unrecognized decision schema: ${snippet}。` +
    `action.type 只能是 "call_tool" | "finish" | "syscall"`,
  );
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
  trace: ToolTraceRecord[];
  sessionId: string;
  syscallHint?: string;
  onPromptInput?: (input: LlmPromptInputRecord) => void;
}): Promise<z.infer<typeof actionSchema>> {
  const payload = {
    subTurn: params.subTurn,
    maxTurns: params.maxTurns,
    taskPrompt: params.taskPrompt,
    activeNotebooks: getNotebooksSummary(params.sessionId),
    recentToolCalls: params.trace.slice(-6).map((item) => ({
      subTurn: item.subTurn,
      toolId: item.toolId,
      ok: item.ok,
      input: item.input,
      data: compact(item.data),
      error: item.error,
      at: item.at,
    })),
  };

  const messages = [
    {
      role: "system",
      content: `${params.systemPrompt}

可用工具（仅可使用下列 toolId；严格按 schema + inputHint 传参）：
${buildToolPromptLines(params.allowedTools)}
${params.syscallHint ?? ""}
你必须遵守输出协议：
- 每轮只能输出一个 JSON action。
- action 支持：call_tool / finish${params.syscallHint ? " / syscall" : ""}。
- finish 时应给出 summary，并尽量包含 review.strengths/weaknesses/suggestions。`,
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
    `reviewer-agent/decision/turn-${params.subTurn}`,
  );

  if (!response.ok) {
    const detail = await response.text();
    const errorMsg = `reviewer-agent LLM API error: ${response.status} ${detail.slice(0, 500)}`;
    console.error(`[reviewer-agent] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const rawContent = data.choices?.[0]?.message?.content;
  const content = normalizeMessageContent(rawContent);

  if (!content) {
    throw new Error("reviewer-agent LLM returned empty content");
  }

  const parsedJson = tryParseJson(content);
  if (!parsedJson) {
    throw new Error("reviewer-agent LLM returned non-JSON decision");
  }

  return normalizeActionFromParsed(parsedJson);
}

class ReviewerAgent extends ConfigurableSubAgent {
  readonly id = "reviewer-agent";
  readonly description = "LLM reviewer sub-agent. Input task is one plain-text prompt.";
  protected readonly defaultProfile = reviewerDefaultProfile;

  protected async runWithProfile(
    taskPrompt: string,
    ctx: SubAgentContext,
    profile: SubAgentRuntimeProfile,
  ): Promise<SubAgentResult> {
    const settings = getIdeaAgentSettings();
    const apiKey = settings.openai.apiKey;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for reviewer-agent");
    }

    const { resolvedToolIds: allowedToolIds, invoker: toolInvoker, promptSpecs: allowedTools } =
      setupTools({ catalog: builtinToolCatalog, allowedTools: profile.allowedTools, settings });

    const model = profile.model || settings.openai.model || "gpt-4o-mini";
    const baseUrl = (settings.openai.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const temperature = settings.openai.temperature ?? 0.2;
    const maxTokens = Math.max(1, Math.min(16000, Math.floor(settings.openai.maxTokens ?? 1200)));
    const maxTurns = Math.max(1, Math.min(1000, Math.floor(profile.maxTurns ?? 6)));

    const trace: ToolTraceRecord[] = [];
    const llmPromptInputs: LlmPromptInputRecord[] = [];
    const capturePromptInput = settings.runtime.debugPrompts === true
      ? (entry: LlmPromptInputRecord) => {
          llmPromptInputs.push(entry);
        }
      : undefined;
    let summary = "";
    let review: Record<string, unknown> | undefined;
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
      try {
        action = await decideNextAction({
          apiKey,
          baseUrl,
          model,
          temperature,
          maxTokens,
          systemPrompt: profile.systemPrompt,
          taskPrompt,
          subTurn,
          maxTurns,
          allowedTools,
          trace,
          sessionId: ctx.sessionId,
          syscallHint: buildSyscallPromptSection(ctx),
          onPromptInput: capturePromptInput,
        });

        await ctx.reportProgress?.({
          stage: "decision.produced",
          payload: {
            subTurn,
            actionType: action.type,
            toolId: action.type === "call_tool" ? action.toolId : undefined,
          },
        });
      } catch (error) {
        decisionErrorCount += 1;
        await ctx.reportProgress?.({
          stage: "decision.failed",
          payload: {
            subTurn,
            error: error instanceof Error ? error.message : "reviewer-agent decision failed",
          },
        });
        trace.push({
          subTurn,
          toolId: "__decision__",
          input: {},
          ok: false,
          error: error instanceof Error ? error.message : "reviewer-agent decision failed",
          at: new Date().toISOString(),
        });
        continue;
      }

      if (action.type === "finish") {
        summary = action.summary;
        review = action.review;
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
    }

    if (!summary) {
      await ctx.reportProgress?.({
        stage: "run.force_finish.start",
        payload: {
          reason: "max_turns",
          subTurn: maxTurns + 1,
        },
      });

      try {
        const forcedAction = await decideNextAction({
          apiKey,
          baseUrl,
          model,
          temperature,
          maxTokens,
          systemPrompt: `${profile.systemPrompt}\n\n[强制收尾模式]\n你已达到最大轮数。禁止再调用任何工具。你现在必须直接输出 finish action，给出审稿结论。`,
          taskPrompt: `${taskPrompt}\n\n[系统强制要求] 已达到 maxTurns=${maxTurns}，本轮禁止 call_tool，只能 finish。`,
          subTurn: maxTurns + 1,
          maxTurns,
          allowedTools: [],
          trace,
          sessionId: ctx.sessionId,
          onPromptInput: capturePromptInput,
        });

        if (forcedAction.type === "finish") {
          summary = forcedAction.summary;
          review = forcedAction.review;
          await ctx.reportProgress?.({
            stage: "run.force_finish.success",
            payload: {
              summaryPreview: summary.slice(0, 400),
            },
          });
        } else {
          throw new Error(`force finish returned non-finish action: ${forcedAction.type}`);
        }
      } catch (error) {
        await ctx.reportProgress?.({
          stage: "run.force_finish.failed",
          payload: {
            error: error instanceof Error ? error.message : "force finish failed",
          },
        });
      }

      if (!summary) {
        const okCount = trace.filter((item) => item.ok).length;
        if (okCount === 0 && decisionErrorCount > 0) {
          throw new Error(`reviewer-agent failed: ${decisionErrorCount} invalid LLM decisions and no successful tool call.`);
        }
        summary = `reviewer-agent reached max turns (${maxTurns}), collected ${trace.length} actions with ${okCount} successful calls.`;
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
      taskPrompt,
      summary,
      maxTurns,
      trace,
      decisionErrorCount,
      llmPromptInputCount: llmPromptInputs.length,
      extra: {
        review,
        allowedTools: allowedToolIds,
      },
    });

    return {
      subAgentResult,
    };
  }
}

export const reviewerAgent: SubAgent = new ReviewerAgent();
