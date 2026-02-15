import fs from "node:fs/promises";
import path from "node:path";
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
    keyInfo: z.record(z.unknown()).optional(),
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
    keyInfo: z.record(z.unknown()).optional(),
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

interface FileCandidate {
  path: string;
  type: "pdf" | "md";
  modifiedAt: string;
  size: number;
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
  if (serialized.length <= 12_000) {
    return value;
  }

  return {
    preview: serialized.slice(0, 12_000),
    truncated: true,
    originalLength: serialized.length,
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

    return {
      type: "finish",
      summary: first.summary ?? first.reason ?? "paper-summary-agent finished",
      keyInfo: first.keyInfo,
    };
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error("paper-summary-agent decision is not an object");
  }

  const syscall = normalizeSyscallFromRaw(root);
  if (syscall) return syscall;

  const rootType = typeof root.type === "string" ? root.type : undefined;
  if (rootType === "call_tool" && typeof root.toolId === "string") {
    return {
      type: "call_tool",
      toolId: root.toolId,
      input: normalizeToolInput(root.input),
    };
  }

  if (rootType === "finish") {
    return {
      type: "finish",
      summary: typeof root.summary === "string" ? root.summary : "paper-summary-agent finished",
      keyInfo: asRecord(root.keyInfo),
    };
  }

  if (rootType && rootType in builtinToolCatalog) {
    return {
      type: "call_tool",
      toolId: rootType,
      input: normalizeToolInput(root),
    };
  }

  const rootAction = asRecord(root.action);
  if (rootAction) {
    const actionType = typeof rootAction.type === "string" ? rootAction.type : undefined;
    if (actionType === "call_tool" && typeof rootAction.toolId === "string") {
      return {
        type: "call_tool",
        toolId: rootAction.toolId,
        input: normalizeToolInput(rootAction.input),
      };
    }
    if (actionType === "finish") {
      return {
        type: "finish",
        summary:
          typeof rootAction.summary === "string" ? rootAction.summary
            : typeof rootAction.reason === "string" ? rootAction.reason
              : "paper-summary-agent finished",
        keyInfo: asRecord(rootAction.keyInfo),
      };
    }
  }

  const badType = rootType
    ?? (rootAction && typeof rootAction.type === "string" ? rootAction.type : undefined);
  const snippet = JSON.stringify(root).slice(0, 320);
  if (badType && badType !== "call_tool" && badType !== "finish" && badType !== "syscall") {
    throw new Error(
      `paper-summary-agent: action.type="${badType}" 不合法。` +
      `action.type 只能是 "call_tool" | "finish" | "syscall"。` +
      `若要调用工具 "${badType}"，正确格式为 ` +
      `{"action":{"type":"call_tool","toolId":"${badType}","input":{...}}}。` +
      `原始输出: ${snippet}`,
    );
  }
  throw new Error(
    `paper-summary-agent unrecognized decision schema: ${snippet}。` +
    `action.type 只能是 "call_tool" | "finish" | "syscall"`,
  );
}

async function collectFileCandidates(params: {
  sessionId: string;
  dataDir: string;
}): Promise<{ currentDialoguePapersDir: string; searchedDirs: string[]; candidates: FileCandidate[] }> {
  const cwd = process.cwd();
  const dataRoot = path.resolve(cwd, params.dataDir);

  const currentDialoguePapersDir = path.resolve(dataRoot, "Papers", params.sessionId);
  const searchedDirs = [
    currentDialoguePapersDir,
    path.resolve(dataRoot, "Papers"),
    path.resolve(cwd, "Papers", params.sessionId),
    path.resolve(cwd, "Papers"),
    path.resolve(dataRoot, "sessions", params.sessionId, "session_data", "parsed-markdown"),
    path.resolve(dataRoot, "sessions", params.sessionId, "session_data", "downloads"),
  ];

  const allCandidates: FileCandidate[] = [];

  for (const dir of searchedDirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== ".pdf" && ext !== ".md") {
          continue;
        }

        const fullPath = path.resolve(dir, entry.name);
        const stat = await fs.stat(fullPath);
        allCandidates.push({
          path: fullPath,
          type: ext === ".pdf" ? "pdf" : "md",
          modifiedAt: stat.mtime.toISOString(),
          size: stat.size,
        });
      }
    } catch {
      continue;
    }
  }

  allCandidates.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  return {
    currentDialoguePapersDir,
    searchedDirs,
    candidates: allCandidates.slice(0, 20),
  };
}

async function decideNextAction(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  taskPrompt: string;
  currentDialoguePapersDir: string;
  searchedDirs: string[];
  candidates: FileCandidate[];
  subTurn: number;
  maxTurns: number;
  trace: ToolTraceRecord[];
  systemPrompt: string;
  allowedTools: ToolPromptSpec[];
  syscallHint?: string;
  onPromptInput?: (input: LlmPromptInputRecord) => void;
}): Promise<z.infer<typeof actionSchema>> {
  const payload = {
    subTurn: params.subTurn,
    maxTurns: params.maxTurns,
    taskPrompt: params.taskPrompt,
    guidance: {
      preferredFlow:
        "MainAgent should pass paper address and output requirements in task. If missing, use currentDialoguePapersDir and candidate files.",
      currentDialoguePapersDir: params.currentDialoguePapersDir,
      searchedDirs: params.searchedDirs,
    },
    fileCandidates: params.candidates,
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
      content: `${params.systemPrompt}\n\n可用工具（仅可使用下列 toolId；严格按 schema + inputHint 传参）：\n${buildToolPromptLines(params.allowedTools)}\n${params.syscallHint ?? ""}\n你必须遵守输出协议：\n- 每轮只能输出一个JSON action，不要输出解释文字。\n- action 支持：call_tool / finish${params.syscallHint ? " / syscall" : ""}。\n- 推荐格式1：{"action":{"type":"call_tool","toolId":"...","input":{...}},"notes":"..."}\n- 推荐格式2：{"action":{"type":"finish","summary":"...","keyInfo":{"problem":"...","method":"...","findings":"...","limitations":"...","evidence":[...]}}}\n- 若 task 未提供论文地址，优先在 currentDialoguePapersDir 与 fileCandidates 中选择论文。`,
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
    `paper-summary-agent/decision/turn-${params.subTurn}`,
  );

  if (!response.ok) {
    const detail = await response.text();
    const errorMsg = `paper-summary-agent LLM API error: ${response.status} ${detail.slice(0, 500)}`;
    console.error(`[paper-summary-agent] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  const data = (await response.json()) as ChatCompletionResponse;
  const rawContent = data.choices?.[0]?.message?.content;
  const content = normalizeMessageContent(rawContent);

  if (!content) {
    throw new Error("paper-summary-agent LLM returned empty content");
  }

  const parsedJson = tryParseJson(content);
  if (!parsedJson) {
    throw new Error("paper-summary-agent LLM returned non-JSON decision");
  }

  return normalizeActionFromParsed(parsedJson);
}

const paperSummaryDefaultProfile: SubAgentRuntimeProfile = {
  model: "gpt-4o-mini",
  maxTurns: 8,
  allowedTools: ["arxiv-search", "web-fetch", "mineru-parse", "read-session-files"],
  systemPrompt: `你是 paper-summary-agent（LLM子代理循环执行器）。
你的职责：
- 主Agent通常会在task里传入论文地址（本地filePath/pdfUrl/arXiv ID）与输出要求。
- 如果task未提供论文地址，你要优先在 currentDialoguePapersDir 与 fileCandidates 中选择合适论文继续。
- 你可以调用 arxiv-search / web-fetch / mineru-parse / read-session-files 获取与解析论文。
- 当证据足够时，输出结构化关键信息并 finish。
要求：
- 优先使用 task 中的论文地址；若缺失则回退到 currentDialoguePapersDir/fileCandidates。
- 若拿到 PDF，应调用 mineru-parse 做解析（markdown 自动存储到 session 目录，可通过 outputMarkdownFileName 覆盖文件名）。
- keyInfo 需包含证据要点与局限，不要空泛。`,
};

class PaperSummaryAgent extends ConfigurableSubAgent {
  readonly id = "paper-summary-agent";
  readonly description =
    "LLM paper analysis sub-agent. MainAgent should pass paper address + output requirements in task; if missing, it searches current dialogue Papers dir, then uses MinerU parse and returns key findings.";
  protected readonly defaultProfile = paperSummaryDefaultProfile;

  protected async runWithProfile(
    prompt: string,
    ctx: SubAgentContext,
    profile: SubAgentRuntimeProfile,
  ): Promise<SubAgentResult> {
    const settings = getIdeaAgentSettings();

    const apiKey = settings.openai.apiKey;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for paper-summary-agent");
    }

    const { resolvedToolIds: allowedToolIds, invoker: toolInvoker, promptSpecs: allowedTools } =
      setupTools({ catalog: builtinToolCatalog, allowedTools: profile.allowedTools, settings });

    if (allowedToolIds.length === 0) {
      throw new Error("paper-summary-agent has no allowed tools. Check subagents.config.json");
    }

    const model = profile.model || settings.openai.model || "gpt-4o-mini";
    const baseUrl = (settings.openai.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const temperature = settings.openai.temperature ?? 0.2;
    const maxTokens = Math.max(1, Math.min(16000, Math.floor(settings.openai.maxTokens ?? 1200)));
    const maxTurns = Math.max(1, Math.min(1000, Math.floor(profile.maxTurns ?? 8)));

    const discovered = await collectFileCandidates({
      sessionId: ctx.sessionId,
      dataDir: settings.memory.dataDir ?? ".idea-agent-data",
    });

    const trace: ToolTraceRecord[] = [];

    const llmPromptInputs: LlmPromptInputRecord[] = [];
    const capturePromptInput = settings.runtime.debugPrompts === true
      ? (entry: LlmPromptInputRecord) => {
          llmPromptInputs.push(entry);
        }
      : undefined;
    let summary = "";
    let keyInfo: Record<string, unknown> | undefined;
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
          taskPrompt: prompt,
          currentDialoguePapersDir: discovered.currentDialoguePapersDir,
          searchedDirs: discovered.searchedDirs,
          candidates: discovered.candidates,
          subTurn,
          maxTurns,
          trace,
          systemPrompt: profile.systemPrompt,
          allowedTools,
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
            error: error instanceof Error ? error.message : "paper-summary-agent decision failed",
          },
        });
        trace.push({
          subTurn,
          toolId: "__decision__",
          input: {},
          ok: false,
          error: error instanceof Error ? error.message : "paper-summary-agent decision failed",
          at: new Date().toISOString(),
        });
        continue;
      }

      if (action.type === "finish") {
        summary = action.summary;
        keyInfo = action.keyInfo;
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
        data: outcome.result.ok ? outcome.result.data : undefined,
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
          taskPrompt: `${prompt}\n\n[系统强制要求] 已达到 maxTurns=${maxTurns}，本轮禁止 call_tool，只能 finish。`,
          currentDialoguePapersDir: discovered.currentDialoguePapersDir,
          searchedDirs: discovered.searchedDirs,
          candidates: discovered.candidates,
          subTurn: maxTurns + 1,
          maxTurns,
          trace,
          systemPrompt: `${profile.systemPrompt}\n\n[强制收尾模式]\n你已达到最大轮数。禁止再调用任何工具。你现在必须直接输出 finish action，给出结构化总结。`,
          allowedTools: [],
          onPromptInput: capturePromptInput,
        });

        if (forcedAction.type === "finish") {
          summary = forcedAction.summary;
          keyInfo = forcedAction.keyInfo;
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
          throw new Error(`paper-summary-agent failed: ${decisionErrorCount} invalid LLM decisions and no successful tool call.`);
        }
        summary = `paper-summary-agent reached max turns (${maxTurns}), collected ${trace.length} actions with ${okCount} successful calls.`;
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
      taskPrompt: prompt,
      summary,
      maxTurns,
      trace,
      decisionErrorCount,
      llmPromptInputCount: llmPromptInputs.length,
      extra: {
        keyInfo,
        currentDialoguePapersDir: discovered.currentDialoguePapersDir,
      },
    });

    return {
      subAgentResult,
    };
  }
}

export const paperSummaryAgent: SubAgent = new PaperSummaryAgent();
