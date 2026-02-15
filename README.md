# IdeaAgent (TypeScript)

基于 `idea-agent-architecture.md` 实现的可运行版本，已打通：
- MainAgent（LLM-only）主循环
- Tool 调用体系（含审批）
- SubAgent 系统
- Memory 模块（文件持久化）
- 插件注册与事件总线

并已用 TypeScript 实现并接入：
- Arxiv
- OpenAlex
- MinerU（含 fallback 到 `pdf-parse-basic`）

## 1) 运行要求

- Node.js >= 20
- 配置文件中提供可用 OpenAI 兼容接口（`openai.apiKey`）

说明：
- 系统是 **LLM-only**，没有规则版 Agent。
- 若未提供 `openai.apiKey`，启动会直接报错。
- 若 LLM 请求失败，运行会进入 `run.failed`。

## 2) 安装与构建

```bash
npm install
npm run typecheck
npm run build
```

## 3) CLI 启动

### 单次运行

```bash
npm run start -- --goal "生成一个关于多模态检索的科研idea"
```

### 交互模式（允许 ask_user / 审批交互）

```bash
npm run start:interactive -- --goal "帮我做深度文献调研"
```

### 提示词调试模式
```bash
npm run start:interactive -- --debug-prompts
```

### 直接调用 CLI

```bash
node dist/idea-agent/cli.js --goal "你的任务目标"
```

可选参数：
- `--config <path>`：指定配置文件路径
- `--interactive`：开启交互问答/审批
- `--auto-approve-sensitive-tools`：自动批准敏感工具
- `--max-turns <n>`：覆盖最大循环轮数

运行时会自动生成纯文本日志（`.log`），默认路径：
- `<memory.dataDir>/logs/`（默认即 `.idea-agent-data/logs/`）
- CLI 启动后会打印具体日志文件路径

提问行为说明：
- MainAgent 在单个 turn 内如果选择 `ask_user`，只会下发 1 个问题（允许可选的 `respond` + `ask_user` 组合）。
- `ask_user` 使用结构化 JSON（`question.prompt/details/options/allowMultiple`）。
- 每个 `options` 元素是独立选项，不再按换行符自动切分为多个选项。
- 终端采用卡片化排版显示 Question/Choices/Agent 输出。
- MainAgent 每轮都可使用 `respond` 输出自然语言进展（普通文字说明）。
- 上下文 compact 使用 LLM（可配置），当 `constraints/dialogue/recall query` 超过预算时会自动触发压缩。

## 4) Demo

```bash
npm run demo:core
```

## 5) 主配置

默认读取：
- `./idea-agent.config.json`

也可通过环境变量指定：
- `IDEA_AGENT_CONFIG_PATH=/path/to/idea-agent.config.json`

支持配置项（见 `idea-agent.config.example.json`）：
- `openai.apiKey`
- `openai.baseUrl`
- `openai.model`
- `openai.temperature`
- `openai.maxTokens`
- `memory.dataDir`
- `runtime.interactive`
- `runtime.autoApproveSensitiveTools`
- `runtime.maxTurns`
- `runtime.toolDefaultTimeoutMs`
- `runtime.toolDefaultRetries`
- `runtime.debugPrompts`（调试模式：可视化显示每步完整提示词输入）
- `contextCompact.enabled`
- `contextCompact.baseUrl`
- `contextCompact.model`
- `contextCompact.temperature`
- `contextCompact.maxTokens`
- `contextCompact.constraintsMaxChars`
- `contextCompact.dialogueMaxChars`
- `contextCompact.recallQueryMaxChars`
- `contextCompact.recentDialogueMaxChars`
- `contextCompact.historyMessagesMaxChars`

环境变量覆盖同名能力：
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`
- `IDEA_AGENT_DATA_DIR`
- `IDEA_AGENT_INTERACTIVE`, `IDEA_AGENT_AUTO_APPROVE_SENSITIVE_TOOLS`, `IDEA_AGENT_DEBUG_PROMPTS`
- `IDEA_AGENT_CONTEXT_COMPACT_ENABLED`
- `IDEA_AGENT_CONTEXT_COMPACT_BASE_URL`
- `IDEA_AGENT_CONTEXT_COMPACT_MODEL`
- `IDEA_AGENT_CONTEXT_COMPACT_TEMPERATURE`
- `IDEA_AGENT_CONTEXT_COMPACT_MAX_TOKENS`
- `IDEA_AGENT_CONTEXT_COMPACT_CONSTRAINTS_MAX_CHARS`
- `IDEA_AGENT_CONTEXT_COMPACT_DIALOGUE_MAX_CHARS`
- `IDEA_AGENT_CONTEXT_COMPACT_RECALL_MAX_CHARS`
- `IDEA_AGENT_CONTEXT_COMPACT_RECENT_DIALOGUE_MAX_CHARS`
- `IDEA_AGENT_CONTEXT_COMPACT_HISTORY_MAX_CHARS`
- `IDEA_AGENT_TOOLS_CONFIG_PATH`（工具配置文件路径）

## 6) SubAgent 统一配置（新增）

现在所有内置子代理统一使用同一套三字段配置：
- `model`（模型型号）
- `systemPrompt`（系统提示词）
- `allowedTools`（工具权限表）

默认读取：
- `./subagents.config.json`

示例文件：
- `subagents.config.example.json`

可用环境变量指定路径：
- `IDEA_AGENT_SUBAGENTS_CONFIG_PATH=/path/to/subagents.config.json`

配置结构：
- 顶层为 `subAgents`
- 每个键是 `subAgentId`（如 `deep-search-agent` / `paper-summary-agent` / `reviewer-agent`）
- 每个子代理只包含 `model/systemPrompt/allowedTools` 三项

工具配置文件（`tools.config.json`）：
- 默认读取 `./tools.config.json`，示例见 `tools.config.example.json`
- 可通过 `IDEA_AGENT_TOOLS_CONFIG_PATH` 指定路径
- 每个工具可配置：`description`、`inputHint`、`inputFields`、`outputFormat`
- 如需工具私有扩展参数（例如 API Key / email / provider / apiUrl），使用 `extraConfigs` 字段
- `extraConfigs` 不会注入给模型，仅供工具运行时读取

搜索工具参数约定（`web-search` / `arxiv-search` / `openalex-search`）：
- 若需要解析论文全文，可先用 `arxiv-search` 拿到 `pdfUrl`，再用 `web-fetch` 下载到本地，最后调用 `mineru-parse` 的 `filePath` 参数
- `mineru-parse` 支持 `outputMarkdownPath`，可将解析后的 Markdown 落盘到 `<memory.dataDir>/parsed-markdown/`（相对路径）
- 支持 `resultLevel`: `less` / `mid` / `more` / `extreme`
- 对应系数：`20%` / `50%` / `100%` / `300%`（相对于各工具基准条数）
- 当前采用纯 `resultLevel` 模式：不再接收显式数量参数
- 主Agent与 `deep-search-agent` 的工具提示会动态展示当前配置下四档对应的具体条数

## 7) 当前内置能力

### Tools
- `web-search` — 联网搜索（Brave / DuckDuckGo / Bing 自动降级）
- `web-fetch` — 网页抓取与文件下载
- `arxiv-search` — arXiv 论文搜索 / 按 ID 获取 / 多查询检索
- `openalex-search` — OpenAlex 论文检索 / 引用网络扩展
- `venue-search` — 本地顶会/期刊注册表搜索
- `mineru-parse` — MinerU PDF 解析（含 fallback 到 `pdf-parse-basic`）
- `pdf-parse-basic` — 基础 PDF 文本提取
- `scientific-calculator` — 科学计算表达式求值
- `python-exec` — Python 代码片段执行
- `research-notebook` — 问题驱动的调研笔记本
- `read-session-files` — 读取当前会话数据目录中的文件
- `local-cli`（敏感工具，默认需要审批）

### SubAgents
- `deep-search-agent`（LLM循环 + 工具权限控制，task 为纯文本 prompt）
- `reviewer-agent`（task 为纯文本 prompt）
- `paper-summary-agent`（task 为纯文本 prompt）

## 8) 插件分层（当前版本）

- 框架抽象层：`src/idea-agent/capabilities/`
  - `tools/types.ts`：工具协议（`Tool` / `ToolContext` / `ToolResult`）
  - `tools/registry.ts`：工具注册中心
  - `tools/invoker.ts`：工具调用编排（schema 校验、审批、重试、超时）
  - `subagents/*`：子代理协议、注册与调用器
- 插件实现层：`src/idea-agent/plugins/`
  - `builtin/tools/*`：可被 MainAgent/SubAgent 调用的具体工具
  - `builtin/subagents/*`：具体子代理实现
  - `builtin/clients/*`：外部 API 客户端（Arxiv/OpenAlex/MinerU），仅由工具层调用
- 注册装配入口：`src/idea-agent/plugins/builtin/plugin.ts`
  - 统一声明并注册内置 tools/subagents

说明：`clients` 已从 `capabilities` 迁移到 `plugins/builtin/clients`，用于将“框架内核”与“具体外部能力实现”解耦。

## 9) 新增工具扩展指南

新增一个工具需要 **3 步**：编写工具 → 注册到 catalog → 配置运行时参数。

### 9.1 编写工具

工具文件放在 `src/idea-agent/plugins/builtin/tools/`。有两种方式：

#### 方式 A：直接实现 `Tool` 接口（适合简单工具）

```typescript
// src/idea-agent/plugins/builtin/tools/my-tool.ts
import { z } from "zod";
import type { Tool } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(10).optional(),
});

export const myTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "my-tool",
  description: "一句话描述工具用途",
  inputSchema,

  async execute(input, ctx) {
    // input 已经过 zod 校验
    // ctx 包含 sessionId, runId, turn, state 等上下文
    try {
      const result = await doSomething(input.query, input.limit);
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "failed" };
    }
  },
};
```

`Tool` 接口的完整字段（`src/idea-agent/capabilities/tools/types.ts`）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 唯一标识，kebab-case |
| `description` | `string` | 是 | 工具描述，会注入 LLM prompt |
| `inputSchema` | `ZodSchema` | 是 | 输入校验 schema |
| `inputHint` | `string` | 否 | JSON 示例，帮助 LLM 构造输入 |
| `inputFields` | `ToolInputFieldSpec[]` | 否 | 字段级文档 |
| `outputFormat` | `string` | 否 | 输出格式描述 |
| `execute()` | `(input, ctx) => Promise<ToolResult>` | 是 | 执行逻辑 |
| `requiresApproval()` | `(input, ctx) => boolean` | 否 | 是否需要用户审批 |

#### 方式 B：继承 `ConfigurableTool`（适合需要外部配置的工具）

当工具需要从 `tools.config.json` 读取运行时配置（API Key、描述覆盖、超时等）时，推荐继承 `ConfigurableTool`：

```typescript
// src/idea-agent/plugins/builtin/tools/my-api-tool.ts
import { z } from "zod";
import { ConfigurableTool } from "../../../capabilities/tools/configurable-tool";
import type { ToolRuntimeProfile, ToolResult, ToolContext } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  query: z.string().min(1),
});

type Input = z.infer<typeof inputSchema>;

export class MyApiTool extends ConfigurableTool<Input, unknown> {
  readonly id = "my-api-tool";
  readonly inputSchema = inputSchema;

  protected readonly defaultProfile: ToolRuntimeProfile = {
    description: "调用外部 API 的工具",
    inputHint: '{"query":"example"}',
    outputFormat: "{ ok, data: ... }",
  };

  async execute(input: Input, ctx: ToolContext): Promise<ToolResult<unknown>> {
    // 通过 getProfile().extraConfigs 读取 tools.config.json 中的私有配置
    const { apiKey, baseUrl } = this.getProfile().extraConfigs ?? {};
    // ...
  }
}

export const myApiTool = new MyApiTool();
```

`ConfigurableTool` 会自动从 `tools.config.json` 合并 `description`、`inputHint`、`inputFields`、`outputFormat`、`extraConfigs`、`timeoutMs`，无需手动读取。

#### 架构约定

- 外部 API 请求细节放在 `src/idea-agent/plugins/builtin/clients/`，工具层只做参数映射与错误转译。
- `src/idea-agent/capabilities/tools/` 仅放框架抽象（协议、注册、调用器），不放具体业务代码。

### 9.2 注册工具

两个文件需要修改：

**① `src/idea-agent/plugins/builtin/tool-catalog.ts`** — 添加 import 和 catalog 条目：

```typescript
import { myTool } from "./tools/my-tool";

export const builtinToolCatalog: ToolCatalog = {
  // ... 已有工具
  "my-tool": myTool,
};
```

**② `src/idea-agent/plugins/builtin/plugin.ts`** — manifest 会自动从 `builtinToolCatalog` 的 keys 生成，无需额外修改。

### 9.3 配置运行时参数（可选）

在 `tools.config.json` 中添加工具条目，可覆盖描述、超时、私有配置等：

```json
{
  "tools": {
    "my-tool": {
      "timeoutMs": 60000,
      "description": "覆盖默认描述（可选）",
      "inputHint": "{\"query\":\"example\"}",
      "inputFields": [
        { "name": "query", "type": "string", "required": true, "description": "搜索关键词" }
      ],
      "outputFormat": "{ ok, data: [...] }",
      "extraConfigs": {
        "apiKey": "sk-xxx",
        "baseUrl": "https://api.example.com"
      }
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `timeoutMs` | 工具级超时（ms），覆盖全局 `toolDefaultTimeoutMs`，上限 600000 |
| `description` / `inputHint` / `inputFields` / `outputFormat` | 覆盖代码中的默认值，注入 LLM prompt |
| `extraConfigs` | 工具私有配置（API Key / URL 等），**不会**注入 LLM，仅供工具运行时通过 `getProfile().extraConfigs` 读取 |

### 9.4 检查清单

- [ ] 工具文件放在 `plugins/builtin/tools/`
- [ ] 在 `tool-catalog.ts` 注册
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] 如有私有配置，在 `tools.config.json` 添加 `extraConfigs`

## 10) 新增子代理扩展指南

新增一个子代理需要 **3 步**：编写子代理 → 注册到 plugin → 配置运行时参数。

### 10.1 编写子代理

子代理文件放在 `src/idea-agent/plugins/builtin/subagents/`，继承 `ConfigurableSubAgent`：

```typescript
// src/idea-agent/plugins/builtin/subagents/my-agent.ts
import { ConfigurableSubAgent } from "../../../capabilities/subagents/configurable-subagent";
import type {
  SubAgentContext,
  SubAgentResult,
  SubAgentRuntimeProfile,
} from "../../../capabilities/subagents/types";
import { setupTools } from "../../../capabilities/tools/tool-setup";
import { builtinToolCatalog } from "../tool-catalog";
import { getIdeaAgentSettings } from "../../../config/settings";

class MyAgent extends ConfigurableSubAgent {
  readonly id = "my-agent";
  readonly description = "一句话描述子代理用途";

  // 代码内的默认配置，可被 subagents.config.json 覆盖
  protected readonly defaultProfile: SubAgentRuntimeProfile = {
    model: "gpt-4o-mini",
    maxTurns: 8,
    systemPrompt: "你是……",
    allowedTools: ["web-search", "arxiv-search"],
  };

  protected async runWithProfile(
    taskPrompt: string,
    ctx: SubAgentContext,
    profile: SubAgentRuntimeProfile,
  ): Promise<SubAgentResult> {
    const settings = getIdeaAgentSettings();

    // 按 profile.allowedTools 过滤，构建工具调用器
    const { invoker: toolInvoker, promptSpecs } = setupTools({
      catalog: builtinToolCatalog,
      allowedTools: profile.allowedTools,
      settings,
    });

    // 实现多轮 LLM 循环 ...
    // 调用 toolInvoker.invoke(toolId, input, state) 执行工具
    // 通过 ctx.reportProgress({ stage: "searching" }) 上报进度

    return { subAgentResult: "最终结果文本" };
  }
}

export const myAgent = new MyAgent();
```

`SubAgentRuntimeProfile` 字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | `string` | 是 | LLM 模型标识 |
| `systemPrompt` | `string` | 是 | 系统提示词 |
| `allowedTools` | `string[]` | 是 | 允许调用的工具 ID 列表 |
| `maxTurns` | `number` | 否 | 最大循环轮数 |
| `summaryModel` | `string` | 否 | 用于摘要的模型（如有） |

### 10.2 注册子代理

修改 `src/idea-agent/plugins/builtin/plugin.ts`：

```typescript
import { myAgent } from "./subagents/my-agent";

export const builtinPlugin: PluginModule = {
  manifest: {
    // ...
    capabilities: {
      tools: Object.keys(builtinToolCatalog),
      subagents: [/* 已有 */, myAgent.id],
    },
  },
  tools: builtinToolList,
  subAgents: [/* 已有 */, myAgent],
};
```

### 10.3 配置运行时参数（可选）

在 `subagents.config.json` 中添加条目，可覆盖代码中的默认 profile：

```json
{
  "subAgents": {
    "my-agent": {
      "model": "claude-opus-4-6-thinking",
      "maxTurns": 16,
      "systemPrompt": "覆盖默认系统提示词……",
      "allowedTools": ["web-search", "arxiv-search", "openalex-search"]
    }
  }
}
```

配置文件中的值会覆盖代码中 `defaultProfile` 的同名字段；未指定的字段保持代码默认值。

### 10.4 检查清单

- [ ] 子代理文件放在 `plugins/builtin/subagents/`
- [ ] 继承 `ConfigurableSubAgent`，实现 `runWithProfile()`
- [ ] 在 `plugin.ts` 注册到 `manifest.capabilities.subagents` 和 `subAgents` 数组
- [ ] 工具权限从 `profile.allowedTools` 过滤，通过 `setupTools()` 构建
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过

## 11) 关键入口

- `src/idea-agent/index.ts`
  - `createIdeaAgentRuntime()`
  - `createInitialState()`
- `src/idea-agent/cli.ts`
- `src/idea-agent/runtime/session-runner.ts`
- `src/idea-agent/core/llm-main-agent.ts`
- `src/idea-agent/plugins/builtin/subagents/deep-search-agent.ts`
- `src/idea-agent/config/subagent-config.ts`
- `src/idea-agent/config/tool-config.ts`
