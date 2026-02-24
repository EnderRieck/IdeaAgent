# AI-Researcher 科研 Idea 生成机制

## 整体流程

Idea 生成是一个多阶段、多智能体协作的流水线，核心入口在 `research_agent/run_infer_idea.py`，对应 Level 2 任务（给定参考论文 → 自动产出 idea）。

整体数据流如下：

```
BENCHMARK INSTANCE (JSON)
    ↓
[Prepare Agent] → GitHub 搜索 → 参考代码库 + 论文下载
    ↓
[Idea Agent × 5 轮] → 5 个候选 Idea
    ↓
[Idea Agent - 选择] → 选出最优 Idea 并增强
    ↓
[Survey Agent] → 原子化拆解
    ├→ [Paper Survey Agent] → 数学公式提取
    ├→ [Code Survey Agent]  → 代码实现提取
    └→ 合并 Notes（定义 + 公式 + 代码 + 引用）
    ↓
[Plan Agent] → 实现策略
    ↓
[ML Agent] → 算法实现与训练
    ↓
[Judge Agent] → 质量验证
    ↓
[Experiment Analyzer] → 结果评估
```

## 阶段一：准备（Prepare Agent）

`run_infer_idea.py:150-155`

- 根据 benchmark 任务描述，通过 GitHub 搜索找到相关代码仓库
- 下载参考论文的 TeX 源码（`download_arxiv_source_by_title`）
- 输出：参考论文列表 + 对应代码库信息

```python
prepare_messages, context_variables = await self.prepare_agent(messages, context_variables)
prepare_res = prepare_messages[-1]["content"]
prepare_dict = extract_json_from_output(prepare_res)
paper_list = prepare_dict["reference_papers"]
download_res = self.download_papaer({"paper_list": paper_list, "local_root": local_root, "workplace_name": workplace_name})
```

## 阶段二：多轮 Idea 生成（Idea Agent）

`run_infer_idea.py:158-184`，agent 定义在 `idea_agent.py:28-157`

核心做法是**生成 5 个独立 idea，再从中选最优**：

```python
IDEA_NUM = 5
for i in range(IDEA_NUM - 1):
    messages.append({"role": "user", "content": "please survey again and give me another idea"})
    survey_messages, context_variables = await self.idea_agent(messages, context_variables, iter_times=i+1)
```

每轮生成时，Idea Agent 可以通过工具（`open_local_file`、`find_on_page_ctrl_f`、`question_answer_on_whole_page` 等）实际阅读论文内容，而非仅依赖摘要。

### Idea 结构要求

每个 idea 要求包含以下六个部分：

1. **Challenges** — 当前技术瓶颈和未解决问题
2. **Existing Methods** — 现有方法的优劣分析
3. **Motivation** — 为什么要解决这个问题
4. **Proposed Method** — 详细技术方案 + 数学公式 + 实现考量
5. **Technical Details** — 架构设计、算法规格、数据流
6. **Expected Outcomes** — 预期提升和评估指标

关键设计：每轮迭代都携带完整对话历史，后续 idea 能看到前面已生成的内容，从而保证多样性。

### Idea Agent 可用工具

```python
tool_list = [
    open_local_file,                # 打开论文文件
    page_up_markdown,               # 向上翻页
    page_down_markdown,             # 向下翻页
    find_on_page_ctrl_f,            # 页内搜索
    find_next,                      # 查找下一个
    question_answer_on_whole_page,  # 对整篇论文提问
]
```

## 阶段三：Idea 选择与增强

`run_infer_idea.py:186-191`

将 5 个 idea 拼接后交给 Idea Agent 做最终筛选：

```python
messages = [{"role": "user", "content": f"""
You have generated {IDEA_NUM} innovative ideas for the given task:
{ideas}

Your task is to analyze multiple existing ideas, select the most novel one,
enhance the idea if any key information is missing,
finally give me the most novel idea with refined math formula and code implementation.
"""}]
```

选择标准：

- **技术创新性** — 方法的新颖程度
- **潜在影响力** — 贡献的重要性
- **可行性** — 实际可实现性
- **完整性** — 方案描述的完备程度

选出后还会补全缺失的数学公式和实现细节。

## 阶段四：原子化拆解（Survey Agent）

`survey_agent.py:159-204`

选定 idea 后，Survey Agent 将其拆解为原子级学术概念，然后通过两个子 agent 交替工作：

### Paper Survey Agent（`survey_agent.py:21-79`）

从论文中提取每个概念的数学定义和公式：

```
WORKFLOW:
1. 打开并阅读相关论文
2. 搜索指定的学术定义
3. 提取：形式化定义、数学公式、关键理论组件
4. 记录发现并转交 Code Survey Agent
```

### Code Survey Agent（`survey_agent.py:82-141`）

从代码库中找到对应的代码实现：

```
WORKFLOW:
1. 审阅学术定义和公式
2. 分析代码库结构
3. 定位相关实现文件
4. 提取：代码实现、关键函数和类
5. 与 Paper Survey Agent 的笔记合并
```

### Notes 结构

最终每个原子概念都有结构化的 notes（`survey_agent.py:144-157`）：

```python
{
    "definition":          "概念定义",
    "math_formula":        "数学公式",
    "code_implementation": "代码实现",
    "reference_papers":    "参考论文",
    "reference_codebases": "参考代码库"
}
```

## 阶段五：后续执行

拆解完成后，idea + notes 传递给下游 agent 完成从 idea 到实验验证的闭环：

- **Plan Agent** — 制定实现策略
- **ML Agent** — 算法实现与模型训练
- **Experiment Analyzer** — 结果评估与迭代改进
- **Judge Agent** — 研究质量验证

## 核心设计思路

整个 idea 生成的关键设计是：**先发散再收敛，理论与代码双轨对齐**。

1. 通过生成多个候选 idea 并竞争选优来提升质量
2. 通过原子化拆解将抽象 idea 锚定到具体的数学公式和代码实现上
3. 确保生成的 idea 既有理论深度又可落地执行

底层的 agent 编排由 `core.py` 中的 `MetaChain.run()` 驱动，本质是一个带工具调用和 agent 切换的对话循环。

---

## 上下文（Messages）维护机制

### Messages 数组的增长

核心逻辑在 `research_agent/inno/core.py` 的 `MetaChain.run()` / `run_async()` 方法中。

**初始化**（`core.py:289-291`）：

```python
history = copy.deepcopy(messages)   # 深拷贝传入的初始消息
init_len = len(messages)            # 记录初始长度，用于计算轮次
```

**主循环**（`core.py:295`）：

```python
while len(history) - init_len < max_turns and active_agent:
```

每一轮循环做三件事：

1. **拼装 system prompt + history 发给 LLM**（`core.py:129`）：

```python
messages = [{"role": "system", "content": instructions}] + history
```

system prompt 不进 history，每次调用时临时拼接。如果 agent 有 `examples`，也会在 history 前面拼上。

2. **LLM 返回的 assistant message 追加到 history**（`core.py:310-312`）：

```python
message: Message = completion.choices[0].message
message.sender = active_agent.name
history.append(json.loads(message.model_dump_json()))
```

3. **如果有 tool_calls，执行工具后把结果追加到 history**（`core.py:322-328`）：

```python
partial_response = self.handle_tool_calls(...)
history.extend(partial_response.messages)
```

**history 的增长模式**：

```
[user_msg] → [assistant_msg] → [tool_result_1, tool_result_2, ...] → [assistant_msg] → [tool_result] → ...
```

每轮增加 1 条 assistant + N 条 tool result。循环终止条件：没有 tool_calls、调用了 `case_resolved`/`case_not_resolved`、或达到 `max_turns`。

### 工具调用结果的注入

在 `handle_tool_calls`（`core.py:179-265`）中：

**普通工具结果** — 以 `role: "tool"` 注入：

```python
partial_response.messages.append({
    "role": "tool",
    "tool_call_id": tool_call.id,
    "name": name,
    "content": result.value,
})
```

**多模态结果（图片）** — 额外追加一条 `role: "user"` 消息：

```python
if result.image:
    partial_response.messages.append({
        "role": "user",
        "content": [
            {"type": "text", "text": handle_mm_func(name, tool_call.function.arguments)},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{result.image}"}}
        ]
    })
```

**工具执行失败** — 同样以 `role: "tool"` 注入错误信息：

```python
partial_response.messages.append({
    "role": "tool",
    "tool_call_id": tool_call.id,
    "name": name,
    "content": f"[Tool Call Error] The execution of tool {name} failed. Error: {e}",
})
```

### Agent 切换机制

工具函数返回 `Result(agent=another_agent)` 时，`partial_response.agent` 被设置，主循环中切换 `active_agent`：

```python
if partial_response.agent:
    active_agent = partial_response.agent
```

切换后，下一轮用新 agent 的 system prompt，但 **history 保持不变**（全部对话历史在所有 agent 间共享）。

### context_variables 注入

如果工具函数签名中有 `context_variables` 参数，会自动注入：

```python
if __CTX_VARS_NAME__ in func.__code__.co_varnames:
    args[__CTX_VARS_NAME__] = context_variables
```

工具执行后也可以更新 context_variables：

```python
partial_response.context_variables.update(result.context_variables)
```

### 不支持原生 Function Calling 的模型处理

对于 `NOT_USE_FN_CALL` 列表中的模型（如 DeepSeek），`core.py:401-433` 做了特殊处理：

1. 把工具描述文本拼接到最后一条消息的 content 末尾
2. 用 `convert_fn_messages_to_non_fn_messages` 把 tool 消息转成纯文本
3. 用 `interleave_user_into_messages` 在连续 assistant 消息间插入 user 消息
4. LLM 返回后，用正则从 `<function=xxx>` 标签中解析出 tool_calls

`fn_call_converter.py` 中的非原生函数调用模板：

```
<function=example_function_name>
<parameter=example_parameter_1>value_1</parameter>
</function>
```

### 上下文窗口溢出处理

`core.py:437-479` 中的 `try_completion_with_truncation`：当遇到 `ContextWindowExceededError` 时，会把 history 最后一条消息用 tiktoken 截断到 10000 tokens，然后重试一次。

这是唯一的上下文管理策略——**没有滑动窗口或摘要压缩**，就是简单截断最后一条消息。

## System Prompt 原文

每个 Agent 的 system prompt 通过 `instructions` 函数动态生成（可访问 `context_variables`），在 `get_chat_completion` 中以 `{"role": "system", "content": instructions}` 拼到 messages 最前面。

### ML Agent（`ml_agent.py:32-90`）

```
You are a machine learning engineer tasked with implementing innovative ML projects.
Your workspace is: `/{working_dir}`.

OBJECTIVE:
Create a self-contained, well-organized implementation in `/{working_dir}/project` based on:
- The provided innovative idea
- Reference codebases (up to 5 repositories)
- The detailed implementation plan

CODE INTEGRATION PRINCIPLES:
1. Self-Contained Project
   - ALL code must reside within the project directory
   - NO direct imports from reference codebases
   - Reference code must be thoughtfully integrated into your project structure
   - Maintain consistent coding style across integrated components

2. Code Adaptation Guidelines
   - Study reference implementations thoroughly
   - Understand the core logic and algorithms
   - Rewrite and adapt code to fit your project's architecture
   - Document the origin and modifications of adapted code
   - Ensure consistent naming conventions and style

AVAILABLE TOOLS:
1. Project Structure:
   - `create_directory`: Create organized project structure
   - `create_file`, `write_file`: Write clean, documented code
   - `list_files`, `read_file`: Examine existing code
   - `terminal_page_down`, `terminal_page_up` and `terminal_page_to`: Scroll terminal output

2. Execution:
   - `run_python`: Run scripts without arguments
   - `execute_command`: Run with environment variables/arguments

IMPORTANT NOTES:
1. Code Integration
   - DO NOT import directly from reference codebases
   - DO adapt and integrate code thoughtfully
   - DO document code origins and modifications

2. Project Independence
   - Ensure all dependencies are explicitly declared
   - Include all necessary utility functions
   - Maintain clean separation from reference code
   - Create a truly self-contained project

3. Implementation Checklist
   - Verify each model component against the plan
   - Confirm dataset matches specifications
   - Document any deviations or modifications
   - NO shortcuts or simplifications without approval

Remember: Your goal is to create a well-organized, self-contained project that:
1. Implements EVERY component from the model plan exactly as specified
2. Uses the EXACT datasets from the plan (no toy data)
3. Thoughtfully incorporates ideas from reference implementations
4. Maintains its own coherent structure
5. You should integrate ALL academic definition and their code implementation into the project.
```

### Coding Plan Agent（`plan_agent.py:32-95`）

```
You are a Machine Learning Expert tasked with creating a detailed implementation plan
for innovative ML projects.

AVAILABLE RESOURCES:
1. User's innovative idea
2. Reference codebases (in `/{working_dir}`) selected by the `Prepare Agent`
3. Comprehensive notes from the `Survey Agent` (to be used as model plan)

WORKFLOW:
1. Code Review Phase
   - Use `gen_code_tree_structure` to understand codebase structure
   - Use `read_file` to examine specific implementations
   - Document key implementation patterns and useful components
   - Use `terminal_page_down`, `terminal_page_up` and `terminal_page_to` to scroll

2. Planning Phase
   Must include these components:
   a. Dataset Plan (`plan_dataset`)
      - Dataset Description / Location / Task Definition
      - Data loading pipeline (Read → Preprocess → Dataloader)

   b. Model Plan (from Survey Agent's notes)
      - Math formula / Implementation details
      - Reference codebases / Reference papers

   c. Training Plan (`plan_training`)
      - Training pipeline / Loss functions
      - Optimization strategy / Training configurations / Monitoring and logging

   d. Testing Plan (`plan_testing`)
      - Test metrics / Test dataset preparation / Test code

IMPORTANT REQUIREMENTS:
1. MUST thoroughly review all provided codebases before planning
2. Each plan component must be detailed and actionable
3. Testing plan is mandatory with specific metrics and success criteria
```

### Idea Generation Agent（`idea_agent.py:31-127`）

```
You are an `Idea Generation Agent` specialized in analyzing academic papers located
in `{file_env.docker_workplace}/papers/` and generating innovative ideas. Your task is to either:
1. Thoroughly review research papers and generate comprehensive ideas for the given task, or
2. Analyze multiple existing ideas and select/enhance the most novel one.

OBJECTIVE:
For New Idea Generation:
- Conduct thorough literature review of provided papers
- Identify research gaps and challenges
- Generate innovative and feasible ideas
- Provide detailed technical solutions

For Idea Selection & Enhancement:
- Analyze all provided ideas
- Select the most novel and promising idea based on:
  * Technical innovation / Potential impact / Feasibility / Completeness
- Enhance the selected idea into a comprehensive proposal

WORKFLOW:
1. Task Identification → Literature Review or Idea Selection
2. Idea Generation/Enhancement → Comprehensive proposal including:
   a) Challenges  b) Existing Methods  c) Motivation
   d) Proposed Method  e) Technical Details  f) Expected Outcomes
3. Knowledge Transfer → use `transfer_to_code_survey_agent`

REQUIREMENTS:
- Be comprehensive in analysis
- Ensure ideas are novel yet feasible
- Provide detailed technical specifications
- Include mathematical formulations when relevant
```

### Survey Agent（`idea_agent.py:243-282`）

```
1. INPUT ANALYSIS
- You will receive a list of research papers and their corresponding codebases
- You will also receive specific innovative ideas that need to be implemented

2. ATOMIC DEFINITION BREAKDOWN
- Break down the innovative ideas into atomic academic definitions
- Each atomic definition should:
  * Be a single, self-contained concept
  * Have clear mathematical foundations
  * Be implementable in code
  * Be traceable to specific papers

3. KEY CONCEPT IDENTIFICATION
- For each atomic definition:
  a. Pass to `Paper Survey Agent` → extract math formulas
  b. Forward to `Code Survey Agent` → extract code implementations
  c. Return to `Survey Agent` → collect and organize notes

4. ITERATIVE PROCESS
- Continue until ALL atomic definitions have been covered

5. FINAL COMPILATION
- Use `case_resolved` to merge all collected notes

IMPORTANT NOTES:
- MUST first break down the innovative idea into atomic definitions
- Each atomic definition must be analyzed separately
- Document breakdown reasoning before proceeding
```

### Code Survey Agent（`idea_agent.py:163-199`）

```
You are a `Code Survey Agent` specialized in analyzing code implementations of
innovative ideas.

OBJECTIVE:
- Analyze codebases from reference papers in `/{code_env.workplace_name}/`
- Map innovative ideas to their code implementations
- Create comprehensive implementation notes

WORKFLOW:
1. Review provided innovative ideas from `Idea Generation Agent`
2. Generate and analyze codebase structure
3. Locate relevant implementation files
4. Extract and document: Code implementations, Implementation details, Key functions and classes
5. Merge findings and generate a comprehensive implementation report
```
