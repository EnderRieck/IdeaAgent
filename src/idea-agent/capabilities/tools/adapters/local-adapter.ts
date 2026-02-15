import { z } from "zod";
import type { Tool, ToolResult } from "../types";

export class LocalFunctionTool implements Tool<Record<string, unknown>, unknown> {
  inputSchema = z.record(z.unknown());

  constructor(
    public readonly id: string,
    public readonly description: string,
    private readonly run: (input: Record<string, unknown>) => Promise<unknown>,
  ) {}

  async execute(input: Record<string, unknown>): Promise<ToolResult<unknown>> {
    try {
      const data = await this.run(input);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Local adapter error" };
    }
  }
}
