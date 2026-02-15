# IdeaAgent 架构蓝图

## 目标

本文档定义一套可扩展的 IdeaAgent 架构。

任务背景：一个科研Idea生成Agent，能够自动执行网络搜索、学术论文检索、论文解析和领域梳理、深度思考，并以同行评议的角度进行自我批判反思

设计目标：

- 保持循环内核稳定。
- 保持工具与子代理可插拔。
- 让主 Agent 在运行时动态决定流程。
- 让主 Agent 在信息不足时向用户提问并获取决策。

这是架构方案文档，不是实现细节文档。

## 设计原则

1. 先内核，后能力
2. 主 Agent 动态编排
3. 工具与子代理插件化
4. 高风险动作必须经过审批
5. 面向科研任务时坚持证据可追溯

## 范围

包含：

- Agent 循环架构
- 工具封装与调用体系（包含 MCP）
- 记忆模块设计
- 子代理封装与调用模型
- 接口契约
- 事件流与状态流
- 插件注册生命周期

不包含：

- 具体模型提示词
- 完整持久化迁移细节
- 前端 UI 细节

## 高层架构

```text
User
  |
  v
Main Agent Kernel
  |\
  | \----> User Bridge（提问、确认、回复）
  |
  +----> Tool Invoker ----> Tool Registry ----> Tool Plugins（MCP 与本地）
  |
  +----> SubAgent Invoker -> SubAgent Registry -> SubAgent Plugins
  |
  +----> Memory Manager --> 短期状态与长期记忆存储
  |
  +----> Event Bus 与可观测性模块
```

## 建议文件结构

```text
src/idea-agent/
  core/
    types.ts
    kernel.ts
    brain.ts
    decision.ts
    state-machine.ts
    event-bus.ts
    error.ts

  runtime/
    session-runner.ts
    user-bridge.ts
    approval-gate.ts
    config.ts

  memory/
    types.ts
    manager.ts
    store.ts
    retriever.ts
    writer.ts

  capabilities/
    tools/
      types.ts
      registry.ts
      invoker.ts
      policy.ts
      approval.ts
      search-result-level.ts
      adapters/
        mcp-adapter.ts
        local-adapter.ts
    subagents/
      types.ts
      registry.ts
      invoker.ts

  plugins/
    types.ts
    manifest.ts
    manager.ts
    loader.ts
    lifecycle.ts
    builtin/
      clients/
        arxiv-client.ts
        openalex-client.ts
        mineru-client.ts
      tools/
        web-search.ts
        web-fetch.ts
        arxiv-search.ts
        openalex-search.ts
        venue-search.ts
        mineru-parse.ts
        pdf-parse-basic.ts
        scientific-calculator.ts
        python-exec.ts
        local-cli.ts
      subagents/
        deep-search-agent.ts
        reviewer-agent.ts
        paper-summary-agent.ts

  data/
    venues/
      registry.json

  observability/
    logger.ts
    tracer.ts
    metrics.ts
    audit-log.ts
```

## 模块设计

## Core

职责：

- 管理循环状态与状态迁移。
- 向 brain 请求下一步动作。
- 分发动作到工具调用器、子代理调用器或用户桥。
- 不硬编码固定流水线。

内核只识别动作类型：

- 调用工具
- 调用子代理
- 向用户提问
- 向用户回复
- 结束

## Runtime

职责：

- 会话生命周期管理。
- 用户交互桥接。
- 敏感动作审批。

审批策略：

- `local-cli` 默认必须用户显式批准。
- 其他高风险工具可通过策略配置为需要审批。

## 工具体系

职责：

- 运行时注册和卸载工具。
- 通过 schema 校验输入。
- 提供超时、重试、结构化错误。
- 发出调用事件用于追踪。

适配器模型：

- MCP 适配器：对接远端能力服务。
- 本地适配器：对接本地二进制或本地服务。

首批必须内置工具：

给出几个必须包含的工具：
  1. 网络搜索
  2. arxiv搜索
  3. OpenAlex检索
  4. 各大顶会/顶刊检索（这里可以动态增改。添加新的会议/期刊）
  5. MinerU论文解析（通过Docker部署在本地，通过localhost端口访问，若没有部署则fallback到普通pdf解析工具）
  6. 科学计算器（可以通过Numpy作为后端）
  7. Python代码执行，用于搭建图谱、渲染图表等各个操作
  8. 本地命令行工具（如ls、mkdir、编辑、查看文件等，需要用户同意）

## 子代理体系

职责：

- 注册并调用子代理。
- 传入任务上下文与约束。
- 返回原始结果与可选产物。
- 不强制全局统一输出格式。

首批必须内置子代理：

  1. 深度搜索Agent：负责按照主Agent要求进行深度调研，然后总结海量结果为一份详尽的报告，返回给主Agent，当
  小范围搜索时，可以直接调用web search工具，需要大范围搜索时，调用这个sub agent
  2. Reviewer：负责以同行评审的角度来对Idea提出批评与建议，力求指出所有问题
  3. 论文总结Agent：按主Agent要求对论文关键信息进行总结，然后返回总结后的内容

控制规则：

- 由主 Agent 决定何时调用哪个子代理。
- 由主 Agent 决定如何解释和合并子代理结果。

## 记忆模块

职责：

- 维护当前任务的短期记忆。
- 维护可复用的长期记忆与证据。
- 提供 recall 与 append 能力。

记忆分层：

- session memory：当前循环上下文
- working memory：当前任务中间产物
- durable memory：长期沉淀的知识与引用

写入原则：

- 只沉淀高价值、可复用信息。
- 临时草稿优先停留在短期记忆。

## 可观测性

职责：

- 按 run 与 turn 记录结构化日志。
- 为工具与子代理调用记录 trace。
- 为审批与敏感动作记录审计日志。

## 接口列表

## Core 接口

```ts
type AgentAction =
  | { type: "call_tool"; toolId: string; input: unknown }
  | { type: "call_subagent"; subAgentId: string; task: SubAgentTask }
  | { type: "ask_user"; question: string; options?: string[] }
  | { type: "respond"; message: string }
  | { type: "finish"; reason?: string };

interface AgentDecision {
  actions: AgentAction[];
  metadata?: Record<string, unknown>;
}

interface AgentBrain {
  decide(state: LoopState): Promise<AgentDecision>;
}
```

## Tool 接口

```ts
interface Tool<I = unknown, O = unknown> {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval?(input: I, ctx: ToolContext): Promise<boolean> | boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

type ToolResult<O> =
  | { ok: true; data: O; raw?: unknown }
  | { ok: false; error: string; raw?: unknown };
```

## SubAgent 接口

```ts
interface SubAgentTask {
  goal: string;
  context?: Record<string, unknown>;
  constraints?: string[];
}

interface SubAgent {
  id: string;
  description: string;
  run(task: SubAgentTask, ctx: SubAgentContext): Promise<SubAgentResult>;
}

interface SubAgentResult {
  summary?: string;
  raw: unknown;
  artifacts?: Array<{ type: string; uri?: string; data?: unknown }>;
}
```

## Memory 接口

```ts
interface MemoryStore {
  recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]>;
  append(event: MemoryEvent): Promise<void>;
  snapshot(sessionId: string): Promise<Record<string, unknown>>;
}
```

## Registry 接口

```ts
interface Registry<T extends { id: string }> {
  register(item: T): void;
  unregister(id: string): void;
  get(id: string): T | undefined;
  list(): T[];
}
```

## 事件流

主循环核心事件：

1. `run.started`
2. `turn.started`
3. `memory.recall.requested`
4. `memory.recall.completed`
5. `decision.produced`
6. `action.dispatched`
7. `tool.call.requested`
8. `tool.approval.requested` 与审批结果事件
9. `tool.call.completed` 或 `tool.call.failed`
10. `subagent.call.requested`
11. `subagent.call.completed` 或 `subagent.call.failed`
12. `user.question.requested`
13. `user.question.answered`
14. `memory.append.requested`
15. `memory.append.completed`
16. `turn.completed`
17. `run.completed` 或 `run.failed` 或 `run.aborted`

## 状态流

主状态：

- `init`
- `running`
- `waiting_approval`
- `waiting_user`
- `completed`
- `failed`
- `aborted`

示例迁移：

- `running -> waiting_approval`：遇到敏感工具调用
- `waiting_approval -> running`：审批结果返回
- `running -> waiting_user`：主 Agent 主动提问
- `waiting_user -> running`：收到用户回答
- `running -> completed`：主 Agent 发出 finish

状态对象建议包含：

- 会话标识
- 当前目标与约束
- 累积工具结果与子代理结果
- 待审批动作
- 待用户回答问题
- 记忆快照与引用

## 插件注册生命周期

生命周期阶段：

1. Discover：发现插件候选
2. Validate：校验 manifest 与能力契约
3. Load：加载插件模块
4. Register：注册工具与子代理
5. Activate：进入可调用状态
6. Invoke：运行时调用
7. Deactivate：停用（更新或故障）
8. Unload：卸载并释放资源

生命周期钩子：

- `onLoad`
- `onRegister`
- `onActivate`
- `onDeactivate`
- `onUnload`

故障隔离：

- 插件失败不应导致内核崩溃。
- 注册中心支持按插件粒度禁用。

## 动态扩展流程

新增工具：

1. 实现 `Tool` 接口。
2. 在插件 manifest 声明能力。
3. 通过插件管理器注册。
4. 校验 schema 并执行健康检查。

新增子代理：

1. 实现 `SubAgent` 接口。
2. 在子代理插件中注册。
3. 暴露元数据供主 Agent 发现与调用。

新增会议或期刊源：

1. 更新 `data/venues/registry.json`。
2. 重载 `venue_search` 插件或热刷新缓存。

## 主 Agent 向用户提问规则

以下场景主 Agent 必须提问：

- 目标含糊
- 决策标准不清
- 存在多条权衡路线
- 需要执行高风险动作

该规则通过内核策略保障，同时保留主 Agent 的动态编排能力。

## 里程碑规划

Phase 1：

- 完成核心循环、注册中心、事件总线、审批网关

Phase 2：

- 以插件形式交付必需工具与必需子代理

Phase 3：

- 加入记忆管理与长期证据存储

Phase 4：

- 完善可观测性、生命周期控制与热更新

## 验收清单

- 内核不包含固定硬编码工作流
- 工具可在不改内核代码的情况下增删
- 子代理可在不改内核代码的情况下增删
- MCP 工具调用遵循统一调用契约
- MinerU 支持 localhost 优先与 fallback 解析
- 本地 CLI 调用必须显式审批
- 主 Agent 可在循环中向用户提问并继续执行
