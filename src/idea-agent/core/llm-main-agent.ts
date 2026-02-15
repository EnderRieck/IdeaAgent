import { z } from "zod";
import type { MainAgent } from "./decision";
import type { AgentAction, AgentDecision, LoopState } from "./types";
import type { ContextCompactor, ContextDialogueMessage } from "./context-compactor";
import type { ToolInputFieldSpec } from "../capabilities/tools/types";
import { getNotebooksSummary } from "../plugins/builtin/tools/research-notebook";
import { fetchWithRetry } from "../capabilities/tools/search-summarizer";
import { tryParseJson } from "../utils/json-parser";

export interface LLMMainAgentOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: Array<{ id: string; description: string; inputHint?: string; inputFields?: ToolInputFieldSpec[]; outputFormat?: string }>;
  subAgents?: Array<{ id: string; description: string }>;
  contextCompactor: ContextCompactor;
  recentDialogueMaxChars?: number;
  historyMessagesMaxChars?: number;
  debugPrompts?: boolean;
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call_tool"),
    toolId: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("call_subagent"),
    subAgentId: z.string().min(1),
    task: z.string().min(1),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.string().optional(),
  }),
]);

const decisionSchema = z.object({
  actions: z.array(actionSchema).min(1).max(1),
  notes: z.string().optional(),
});

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface ChatContextMessage extends ContextDialogueMessage {}

const defaultSystemPrompt = `
你是一个科研领域的专业助手
你的任务是根据用户给出的领域、论文，自动进行深度搜索与思考，梳理出该领域的研究现状，然后基于此给出一些切实可行的Ideas，再经过同行评议等角度的验证，最终发给用户。
你必须严格输出 JSON（且不包含代码块格式，仅纯json），不能输出任何解释文字。

可用 action 类型（仅三种）：
1) call_tool：调用工具 
  输出示例：{actions: [{"type":"call_tool","toolId":"...","input":{...}}]}
2) call_subagent：调用子智能体
  输出示例：{actions: [{"type":"call_subagent","subAgentId":"...","task":"...plain text prompt..."}]}
3) finish：结束本次任务
  输出示例：{actions: [{"type":"finish","reason":"..."}]}

决策规则：
- 响应结构必须是 {"actions":[...],"notes":"本轮意图说明"}。notes 用一句话说明你本轮 action 的意图和思考。
- [！！重要！！]action的type字段只能为上述call_tool, call_subagent, finish三种值，工具、子Agent的ID请放入toolId、subAgentId字段！
- 每轮只允许 1 个 action（actions 数组长度必须为 1）。
- 只有当你对用户指的领域的发展脉络与当前进展已经有足够了解之后，才开始产生Ideas，否则继续搜索，并每次都及时报告用户目前的调研进度

工具说明：
- 可以调用WebSearch工具进行简单的网络搜索，调用OpenAlex工具进行简单的学术搜索。当需要深度调研的时候，建议使用DeepResearchAgent以防止上下文污染。
- [ask-user]：用于向用户提问
  - 必须使用结构化 input（prompt/details/options/allowMultiple），不要把多个问题混在一起。
  - options每个元素都是独立选项，禁止把多项写进同一个字符串。
  - 优先给出 3-6 个清晰选项，且每个选项前面不要加标号（比如A、B、C或1、2、3这种）。
  - 不需要添加“其他”选项，这一项会被自动配置
  - 可在前后轮次中搭配 respond 工具，输出 1-2 句自然语言进展。
  - 高风险动作前可 ask-user。
- [respond]：用于向用户发送文字信息
  - 可以用轻量 Markdown 组织内容（小标题、列表、必要时表格）。
- [research-notebook]：用于规划和整理DeepResearch信息
  - 你可以使用 research-notebook 工具来管理问题驱动的深度调研。
    创建笔记本(create) → 分解问题并写入(add_questions) → 查看进度(view) → 查看完整结果(view_full)。
  - 【重要】使用 research-notebook 前，先检查 payload 中的 activeNotebooks 列表。
    如果已有目标相似的笔记本，直接复用（view/add_questions），不要重复创建。
    每个研究主题只需一个笔记本，通过 add_questions 追加新问题即可。
  - 当需要深度调研时，先用 research-notebook 创建笔记本并分解子问题（其中每个问题必须为适合深度调研的事实型问题），
    然后对每个问题调用 DeepSearchAgent 进行聚焦搜索（task 只需包含具体问题描述）。
    DeepSearchAgent 返回结果后，由你负责调用 research-notebook 的 update_question 将发现写入笔记本。
    注意！！笔记本中对每个问题的回答需要足够详细，让读者能够完全理解各个方法的细节！。

- 你可以通过WebFetch工具进行网页访问、以及论文原文下载。当你下载到本地后，建议把它的目录交给PaperSummaryAgent，
- 调用PaperSummaryAgent时，task 必须尽量包含论文地址（本地 filePath / pdfUrl / arXiv ID）与输出要求；若地址缺失，要在 task 中明确让其先去当前对话 Papers 目录检索。
- 你也可以使用LocalCli工具进行本地命令行的命令发送（包括但不限于ls、cat、grep等），但这需要先经过用户审批
- 在你产生Idea初稿后，务必调用ReviewerAgent进行同行评议级的验证，并把research-notebook的编号告诉它，以便它查看前期深度调研的结果

子智能体 syscall 机制：
- 所有子智能体（DeepSearchAgent、ReviewerAgent、PaperSummaryAgent）均具备 syscall 能力。
- 通过 syscall，子智能体可以在执行过程中请求主 Agent 层代为调用其自身工具池之外的工具（如 local-cli），或调用其他子智能体进行协作。
- 敏感工具（如 local-cli）通过 syscall 调用时仍需经过用户审批。
- 这意味着你在分配任务时，不必预先为子智能体准备所有资源——它们可以在执行中按需通过 syscall 获取额外能力。

工作流说明：
- 一个理想的工作流为：
    1. 首先询问用户确定任务要求
    2. 接下来进行少量网络搜索与学术检索，确定领域基本信息
    3. 使用 research-notebook 工具创建笔记本，将研究目标分解为具体子问题
    4. 对每个子问题，调用 DeepSearchAgent 进行聚焦搜索
       （task 只需包含具体问题描述，例如："搜索 XXX 领域的最新进展"）
    5. 每轮 DeepSearchAgent 返回后，你负责调用 research-notebook 的 update_question 将发现写入笔记本，再用 view 查看整体进度
    6. 所有问题回答完毕后，用 view_full 获取完整发现，进行综合分析
    7. 将高相关度/高被引的优质论文下载到本地，交给PaperSummaryAgent进行解析总结
    8. 2-7步均可以多次重复，直到你完全梳理清楚本领域的研究脉络与前沿现状。不必急于给出答案。每轮结束后你得到新的信息后，请告知用户，并说明下一步的行动。
    9. 在你对领域建立完整的认知后，给出Ideas的初稿
    10. 将你调研得到的领域信息、以及你得到的Ideas初稿交给ReviewerAgent，得到评审意见
    11. 再根据评审意见对你的Ideas进行删改
    12. 最终把Ideas呈现给用户

！！错误输出示例！！：
1. {actions: [{"type":"ask_user","toolId":"ask_user","input":{...}}]}
  - 原因：将工具当成了一种action类型

【错误恢复】
如果 payload 中出现 lastError 字段，说明你上一轮的输出格式有误（如非法JSON、schema不匹配等）。
请仔细阅读 lastError 中的错误信息，修正输出格式后重新决策。不要重复犯同样的错误。
`;

export class LLMMainAgent implements MainAgent {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly systemPrompt: string;
  private readonly tools: Array<{ id: string; description: string; inputHint?: string; inputFields?: ToolInputFieldSpec[]; outputFormat?: string }>;
  private readonly subAgents: Array<{ id: string; description: string }>;
  private readonly contextCompactor: ContextCompactor;
  private readonly recentDialogueMaxChars: number;
  private readonly historyMessagesMaxChars: number;
  private readonly debugPrompts: boolean;

  constructor(options: LLMMainAgentOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.temperature = options.temperature ?? 0.2;
    const rawMaxTokens = options.maxTokens ?? 900;
    this.maxTokens = Math.max(1, Math.min(16000, Math.floor(rawMaxTokens)));
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.tools = options.tools ?? [];
    this.subAgents = options.subAgents ?? [];
    this.contextCompactor = options.contextCompactor;
    this.recentDialogueMaxChars = options.recentDialogueMaxChars ?? 8_000;
    this.historyMessagesMaxChars = options.historyMessagesMaxChars ?? 10_000;
    this.debugPrompts = options.debugPrompts === true;
  }

  async decide(state: LoopState): Promise<AgentDecision> {
    const dialogueMessages = this.readDialogueMessages(state);
    const historyMessages = await this.buildHistoryMessages(dialogueMessages);
    const payload = {
      sessionId: state.sessionId,
      runId: state.runId,
      turn: state.turn,
      status: state.status,
      goal: state.goal,
      constraints: state.constraints ?? [],
      pendingQuestion: state.pendingQuestion,
      pendingApproval: state.pendingApproval,
      lastError: state.lastError,
      memorySummary: this.summarizeMemory(state.memorySnapshot),
      recentToolResults: state.toolResults.slice(-3).map((item) => ({
        toolId: item.toolId,
        ok: item.ok,
        error: item.error,
        data: this.safeCompact(item.data),
      })),
      recentSubAgentResults: state.subAgentResults.slice(-3).map((item) => ({
        ok: item.ok,
        subAgentResult: item.subAgentResult,
        error: item.error,
      })),
      activeNotebooks: getNotebooksSummary(state.sessionId),
    };

    const messages = [
      {
        role: "system",
        content: this.renderSystemPrompt(),
      },
      ...historyMessages,
      {
        role: "user",
        content: JSON.stringify(payload),
      },
    ];

    const requestBody = {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      response_format: { type: "json_object" as const },
      messages,
    };

    const response = await fetchWithRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      "main-agent/decision",
    );

    if (!response.ok) {
      const detail = await response.text();
      const errorMsg = `LLM API error: ${response.status} ${detail.slice(0, 500)}`;
      console.error(`[main-agent] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const rawContent = data.choices?.[0]?.message?.content;
    const content = this.normalizeMessageContent(rawContent);

    if (!content) {
      throw new Error("LLM returned empty content");
    }

    const parsedJson = tryParseJson(content);
    if (!parsedJson) {
      const preview = content.length > 500 ? `${content.slice(0, 500)}...(len=${content.length})` : content;
      throw new Error(`LLM returned non-JSON decision content: ${preview}`);
    }

    const parsedDecision = decisionSchema.safeParse(parsedJson);
    if (!parsedDecision.success) {
      const raw = JSON.stringify(parsedJson);
      const preview = raw.length > 500 ? `${raw.slice(0, 500)}...(len=${raw.length})` : raw;
      throw new Error(`LLM decision schema invalid: ${parsedDecision.error.message} | Raw JSON: ${preview}`);
    }

    const normalizedActions = parsedDecision.data.actions.map((action) => this.normalizeAction(action));
    const constrainedActions = this.enforceActionConstraints(normalizedActions);
    const actions = this.suppressRedundantRespond(constrainedActions, state);

    const debugMetadata = this.debugPrompts
      ? {
          llmPromptInput: {
            source: "main-agent",
            endpoint: `${this.baseUrl}/chat/completions`,
            request: requestBody,
          },
        }
      : {};

    return {
      actions,
      notes: parsedDecision.data.notes,
      metadata: {
        source: "llm",
        model: this.model,
        ...debugMetadata,
      },
    };
  }


  private renderToolFieldSpecs(fields: ToolInputFieldSpec[] | undefined): string {
    if (!fields || fields.length === 0) {
      return "{}";
    }

    const normalized = fields
      .map((field) => {
        const required = field.required === false ? "optional" : "required";
        return `${field.name}:${field.type}(${required})`;
      })
      .join(", ");

    return normalized.length > 0 ? `{${normalized}}` : "{}";
  }

  private renderSystemPrompt(): string {
    const realToolLines = this.tools
      .map((tool) => {
        const inputHint = tool.inputHint && tool.inputHint.trim().length > 0
          ? tool.inputHint
          : "{}";
        const schema = this.renderToolFieldSpecs(tool.inputFields);
        return `- ${tool.id}: schema=${schema}; inputHint=${inputHint}`;
      });

    const virtualToolLines = [
      `- respond: schema={message:string(required)}; inputHint={"message":"向用户展示的内容，支持轻量Markdown"}; 向用户输出消息（进展汇报、结果展示等）`,
      `- ask-user: schema={prompt:string(required), details:string(optional), options:array(optional), allowMultiple:boolean(optional)}; inputHint={"prompt":"问题","options":[{"id":"A","text":"选项A"}]}; 向用户提问并等待回答`,
    ];

    const allToolLines = [...realToolLines, ...virtualToolLines];
    const toolSection = allToolLines.length > 0 ? allToolLines.join("\n") : "- (none)";

    const subAgentLines = this.subAgents.length > 0
      ? this.subAgents.map((agent) => `- ${agent.id}: ${agent.description}`).join("\n")
      : "- (none)";

    return `${this.systemPrompt}

可用工具（仅能使用这些 toolId；严格按 input 提示传参）：
${toolSection}

可用子代理（仅能使用这些 subAgentId）：
${subAgentLines}`;
  }

  private async buildHistoryMessages(
    dialogueMessages: ChatContextMessage[],
  ): Promise<Array<{ role: "assistant" | "user"; content: string }>> {
    const compacted = await this.compactDialogueMessages(
      dialogueMessages,
      this.historyMessagesMaxChars,
      "history messages",
    );

    return compacted.map((item) => ({
      role: item.role,
      content: item.content,
    }));
  }

  private readDialogueMessages(state: LoopState): ChatContextMessage[] {
    const metadata = state.metadata as Record<string, unknown> | undefined;
    const raw = metadata?.dialogue;
    if (!Array.isArray(raw)) {
      return [];
    }

    const rows: ChatContextMessage[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) {
        continue;
      }

      const record = item as { role?: unknown; content?: unknown };
      if ((record.role !== "assistant" && record.role !== "user") || typeof record.content !== "string") {
        continue;
      }

      const content = this.cleanText(record.content);
      if (!content) {
        continue;
      }

      rows.push({
        role: record.role,
        content,
      });
    }

    return rows;
  }

  private async compactDialogueMessages(
    dialogue: ChatContextMessage[],
    maxChars: number,
    purpose: string,
  ): Promise<ChatContextMessage[]> {
    if (dialogue.length === 0) {
      return [];
    }

    const compacted = await this.contextCompactor.compactDialogue({
      messages: dialogue,
      maxChars,
      purpose,
    });

    return compacted
      .map((item) => ({
        role: item.role,
        content: this.cleanText(item.content),
      }))
      .filter((item) => item.content.length > 0);
  }

  private normalizeAction(action: z.infer<typeof actionSchema>): AgentAction {
    if (action.type === "call_tool" && action.toolId === "respond") {
      return this.normalizeRespondVirtualTool(action.input);
    }

    if (action.type === "call_tool" && action.toolId === "ask-user") {
      return this.normalizeAskUserVirtualTool(action.input);
    }

    return action as AgentAction;
  }

  private normalizeRespondVirtualTool(input: unknown): AgentAction {
    const record = this.asRecord(input);
    const message = typeof record?.message === "string" ? this.cleanText(record.message) : "";
    return {
      type: "respond",
      message: message || "(empty respond)",
    };
  }

  private normalizeAskUserVirtualTool(input: unknown): AgentAction {
    const record = this.asRecord(input);
    if (!record) {
      return { type: "ask_user", question: { prompt: "(empty question)" } };
    }

    const prompt = typeof record.prompt === "string" ? this.cleanText(record.prompt) : "";
    const details = typeof record.details === "string" ? this.cleanText(record.details) : undefined;
    const allowMultiple = record.allowMultiple === true;

    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .map((item: unknown, index: number) => {
        if (typeof item === "object" && item !== null) {
          const opt = item as { id?: unknown; text?: unknown };
          return {
            id: (typeof opt.id === "string" && opt.id.length > 0) ? opt.id : `O${index + 1}`,
            text: typeof opt.text === "string" ? this.cleanText(opt.text) : "",
          };
        }
        if (typeof item === "string") {
          return { id: `O${index + 1}`, text: this.cleanText(item) };
        }
        return { id: `O${index + 1}`, text: "" };
      })
      .filter((opt: { text: string }) => opt.text.length > 0);

    return {
      type: "ask_user",
      question: {
        prompt: prompt || "(empty question)",
        details: details || undefined,
        allowMultiple,
        options: options.length > 0 ? options : undefined,
      },
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  }

  private suppressRedundantRespond(actions: AgentAction[], state: LoopState): AgentAction[] {
    const respondAction = actions.find((action) => action.type === "respond");
    if (!respondAction || respondAction.type !== "respond") {
      return actions;
    }

    const hasExecutionAction = actions.some((action) => action.type === "call_tool" || action.type === "call_subagent");
    if (!hasExecutionAction) {
      return actions;
    }

    const previousResponse = typeof state.metadata?.lastResponse === "string"
      ? this.cleanText(state.metadata.lastResponse)
      : "";
    const currentResponse = this.cleanText(respondAction.message);

    if (!previousResponse || !currentResponse) {
      return actions;
    }

    if (!this.isNearDuplicateMessage(previousResponse, currentResponse)) {
      return actions;
    }

    return actions.filter((action) => action !== respondAction);
  }

  private isNearDuplicateMessage(previous: string, current: string): boolean {
    const prevNorm = this.normalizeForSimilarity(previous);
    const currNorm = this.normalizeForSimilarity(current);

    if (!prevNorm || !currNorm) {
      return false;
    }

    if (prevNorm === currNorm) {
      return true;
    }

    if (Math.min(prevNorm.length, currNorm.length) >= 18 && (prevNorm.includes(currNorm) || currNorm.includes(prevNorm))) {
      return true;
    }

    const similarity = this.diceCoefficient(prevNorm, currNorm);
    return similarity >= 0.88;
  }

  private normalizeForSimilarity(text: string): string {
    return text
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  private diceCoefficient(left: string, right: string): number {
    if (left.length < 2 || right.length < 2) {
      return left === right ? 1 : 0;
    }

    const leftBigrams = this.collectBigrams(left);
    const rightBigrams = this.collectBigrams(right);

    let overlap = 0;
    for (const [bigram, leftCount] of leftBigrams.entries()) {
      const rightCount = rightBigrams.get(bigram) ?? 0;
      overlap += Math.min(leftCount, rightCount);
    }

    const leftTotal = Array.from(leftBigrams.values()).reduce((sum, count) => sum + count, 0);
    const rightTotal = Array.from(rightBigrams.values()).reduce((sum, count) => sum + count, 0);

    if (leftTotal + rightTotal === 0) {
      return 0;
    }

    return (2 * overlap) / (leftTotal + rightTotal);
  }

  private collectBigrams(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (let index = 0; index < text.length - 1; index += 1) {
      const gram = text.slice(index, index + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
    return counts;
  }

  private enforceActionConstraints(actions: AgentAction[]): AgentAction[] {
    if (actions.length === 0) {
      return actions;
    }
    return [actions[0]];
  }

  private cleanText(value: string): string {
    return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
  }

  private normalizeMessageContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
    if (!content) {
      return "";
    }

    if (typeof content === "string") {
      return content;
    }

    return content
      .map((part) => {
        if (part.type === "text") {
          return part.text ?? "";
        }
        return "";
      })
      .join("\n");
  }


  private summarizeMemory(snapshot: Record<string, unknown>): Record<string, unknown> {
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    return {
      total: snapshot.total ?? 0,
      session: snapshot.session ?? 0,
      working: snapshot.working ?? 0,
      durable: snapshot.durable ?? 0,
      recentItems: items.slice(-3),
    };
  }

  private safeCompact(data: unknown): unknown {
    if (data == null) {
      return data;
    }

    const text = typeof data === "string" ? data : JSON.stringify(data);
    if (text.length <= 600) {
      return data;
    }

    return {
      preview: text.slice(0, 600),
      truncated: true,
      originalLength: text.length,
    };
  }
}
