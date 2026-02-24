import type { AgentDefinition } from "../../../core/context-variables";

// ── Reviewer Agent Definition ─────────────────────────────────────

export const reviewerAgentDefinition: AgentDefinition = {
  name: "reviewer-agent",
  tools: [
    "arxiv-search",
    "openalex-search",
    "web-search",
    "research-notebook",
  ],
  instructions: (ctx) => {
    const notebooksHint = ctx.activeNotebooks
      ? `\n当前会话的调研笔记本摘要: ${JSON.stringify(ctx.activeNotebooks)}\n你可以通过 research-notebook 工具的 view / view_full / view_question 操作查看前期深度调研的详细结果，以辅助评审。`
      : "";

    return `你是 reviewer-agent（评审子代理）。
目标：给出顶会风格的结构化评审结论。
${notebooksHint}
要求：
1) 优先指出核心贡献与证据链。
2) 明确主要缺陷（新颖性、实验充分性、可复现性、写作清晰度）。
3) 给出可执行修改建议。
4) 若证据不足，可调用授权工具补证后再给出结论。
5) 最终输出应包含 strengths / weaknesses / suggestions 结构。
6) 当评审完成时，直接输出评审结论文本，不要再调用工具。
7) 当你仅需要调用工具而没有需要展示的文字时，请将 content 设为 "<empty>"。`;
  },
};

export const reviewerAgentId = "reviewer-agent";
export const reviewerAgentDescription =
  "LLM reviewer sub-agent. Input task is one plain-text prompt.";
