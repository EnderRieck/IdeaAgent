import { z } from "zod";
import type { NativeTool } from "./native-tool";
import type { UserBridge } from "../runtime/user-bridge";
import type { AgentDefinition } from "./context-variables";
import type { PhaseName } from "./main-agent";

// ── ask_user tool ──────────────────────────────────────────────────

export function createAskUserTool(bridge: UserBridge): NativeTool {
  return {
    name: "ask_user",
    description:
      "向用户提出选择题并等待回复。" +
      "必须提供 options 选项列表，每个选项需包含 id 和 text。" +
      "如需向用户提开放式问题，请直接通过文本输出提问，不要使用此工具。",
    inputSchema: z.object({
      question: z.string().min(1).describe("The question to ask the user"),
      details: z.string().optional().describe("Additional context or details about the question"),
      options: z
        .array(
          z.object({
            id: z.string().min(1).describe("Short unique identifier for this option, e.g. 'A', 'opt1'"),
            text: z.string().min(1).describe("Display text for this option"),
          }),
        )
        .min(2)
        .describe("List of choices for the user to pick from (at least 2)"),
      allowMultiple: z
        .boolean()
        .optional()
        .describe("If true, the user can select more than one option"),
    }),
    async execute(
      input: {
        question: string;
        details?: string;
        options: Array<{ id: string; text: string }>;
        allowMultiple?: boolean;
      },
      _ctx,
    ) {
      const answer = await bridge.ask({
        prompt: input.question,
        details: input.details,
        options: input.options,
        allowMultiple: input.allowMultiple,
      });
      return { value: answer };
    },
  };
}

// ── switch_phase tool ─────────────────────────────────────────────

const PHASE_LABELS: Record<PhaseName, string> = {
  discover: "需求确定 (Discover)",
  explore: "深度调研 (Explore)",
  idea: "创意生成 (Idea)",
  story: "研究故事 (Story)",
};

export function createSwitchPhaseTool(
  bridge: UserBridge,
  phaseAgents: Record<PhaseName, AgentDefinition>,
): NativeTool {
  return {
    name: "switch_phase",
    description:
      "切换工作阶段。可选阶段: discover(需求确定), explore(深度调研), idea(创意生成), story(研究故事撰写)。" +
      "切换前会征求用户同意。",
    inputSchema: z.object({
      phase: z.enum(["discover", "explore", "idea", "story"]).describe(
        "Target phase: discover, explore, idea, or story",
      ),
      reason: z.string().optional().describe("Why switch to this phase"),
    }),
    async execute(input: { phase: PhaseName; reason?: string }, _ctx) {
      const label = PHASE_LABELS[input.phase];
      const prompt = `建议切换到「${label}」阶段${input.reason ? `，原因：${input.reason}` : ""}。是否同意？`;

      const answer = await bridge.ask({
        prompt,
        options: [
          { id: "yes", text: "同意切换" },
          { id: "no", text: "留在当前阶段" },
        ],
      });

      if (answer.toLowerCase().startsWith("yes") || answer.includes("同意")) {
        return {
          value: `已切换到「${label}」阶段。`,
          agent: phaseAgents[input.phase],
        };
      }

      return { value: "用户拒绝切换，保持当前阶段。" };
    },
  };
}
