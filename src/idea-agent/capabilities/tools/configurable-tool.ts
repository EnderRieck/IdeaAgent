import { getToolRuntimeProfile } from "../../config/tool-config";
import type { Tool, ToolContext, ToolResult, ToolRuntimeProfile } from "./types";

export abstract class ConfigurableTool<I = unknown, O = unknown> implements Tool<I, O> {
  abstract readonly id: string;
  abstract readonly inputSchema: Tool<I, O>["inputSchema"];
  protected abstract readonly defaultProfile: ToolRuntimeProfile;

  private cachedProfile?: ToolRuntimeProfile;

  get description(): string {
    return this.getProfile().description;
  }

  get inputHint(): string | undefined {
    return this.getProfile().inputHint;
  }

  get inputFields(): ToolRuntimeProfile["inputFields"] {
    return this.getProfile().inputFields;
  }

  get outputFormat(): string | undefined {
    return this.getProfile().outputFormat;
  }

  protected getProfile(): ToolRuntimeProfile {
    if (!this.cachedProfile) {
      this.cachedProfile = getToolRuntimeProfile(this.id, this.defaultProfile);
    }
    return this.cachedProfile;
  }

  requiresApproval?(input: I, ctx: ToolContext): Promise<boolean> | boolean;
  abstract execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
