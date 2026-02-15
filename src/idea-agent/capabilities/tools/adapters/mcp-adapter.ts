import { z } from "zod";
import type { Tool, ToolResult } from "../types";

export interface McpClient {
  invoke(toolId: string, input: Record<string, unknown>): Promise<unknown>;
}

export class McpToolAdapter implements Tool<Record<string, unknown>, unknown> {
  inputSchema = z.record(z.unknown());

  constructor(
    public readonly id: string,
    public readonly description: string,
    private readonly client: McpClient,
  ) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult<unknown>> {
    try {
      const data = await this.client.invoke(this.id, input);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "MCP invoke failed" };
    }
  }
}
