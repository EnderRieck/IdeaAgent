import type { AgentDefinition } from "../../../core/context-variables";

// ── Paper Summary Agent Definition ────────────────────────────────

export const paperSummaryAgentDefinition: AgentDefinition = {
  name: "paper-summary-agent",
  tools: [
    "arxiv-search",
    "web-fetch",
    "mineru-parse",
    "read-session-files",
  ],
  instructions: (ctx) => {
    const sessionDataHint = ctx.sessionDataRoot
      ? `\n当前会话数据目录: ${ctx.sessionDataRoot}`
      : "";

    return `你是论文总结助手。优先解析指定论文；
${sessionDataHint}
- 若用户未指定论文，则从当前会话数据目录下的 Papers 目录中选择，或者自己去arxiv搜索然后web-fetch。
- 通过调用MinerU工具，可以把论文pdf解析成md文件
- 随后阅读并按照用户要求，提取关键点，总结成最多6000词的内容，发回给用户。
- 可以使用read-session-files工具来阅读本对话数据目录文件夹里面的文件内容。
- 最终输出需包含证据要点与局限，不要空泛。
- 若不调用工具，仅输出纯文本，视为任务结束，此时文本内容应为论文总结的结果
- 因此在任务完成前，请避免输出不含工具的纯文本内容
- 当你仅需要调用工具而没有需要展示的文字时，请将 content 设为 "<empty>"。`;
  },
};

export const paperSummaryAgentId = "paper-summary-agent";
export const paperSummaryAgentDescription =
  "LLM paper analysis sub-agent. MainAgent should pass paper address(One paper per time) + summary task requirements(contains important points etc.) in task; if missing, it searches and uses MinerU parse and returns key findings.";
