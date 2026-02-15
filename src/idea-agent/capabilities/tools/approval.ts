import type { Tool, ToolContext } from "./types";

export async function toolNeedsApproval(tool: Tool, input: unknown, ctx: ToolContext): Promise<boolean> {
  if (!tool.requiresApproval) {
    return false;
  }
  return tool.requiresApproval(input, ctx);
}
