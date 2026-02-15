import { getSubAgentRuntimeProfile } from "../../config/subagent-config";
import type { SubAgent, SubAgentContext, SubAgentResult, SubAgentRuntimeProfile, SubAgentTask } from "./types";

export abstract class ConfigurableSubAgent implements SubAgent {
  abstract readonly id: string;
  abstract readonly description: string;
  protected abstract readonly defaultProfile: SubAgentRuntimeProfile;

  async run(task: SubAgentTask, ctx: SubAgentContext): Promise<SubAgentResult> {
    const taskPrompt = task.trim();
    if (!taskPrompt) {
      throw new Error(`${this.id} task prompt cannot be empty`);
    }

    const profile = getSubAgentRuntimeProfile(this.id, this.defaultProfile);
    return this.runWithProfile(taskPrompt, ctx, profile);
  }

  protected abstract runWithProfile(
    taskPrompt: string,
    ctx: SubAgentContext,
    profile: SubAgentRuntimeProfile,
  ): Promise<SubAgentResult>;
}
