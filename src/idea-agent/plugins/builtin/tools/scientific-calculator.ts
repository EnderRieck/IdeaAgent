import { z } from "zod";
import type { Tool } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  expression: z.string().min(1),
});

const allowedPattern = /^[\d\s()+\-*/.,^eEpiPIa-zA-Z]+$/;

export const scientificCalculatorTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "scientific-calculator",
  description: "Evaluate scientific numeric expressions using Math context.",
  inputSchema,
  async execute(input) {
    try {
      const normalized = input.expression.replace(/\^/g, "**");
      if (!allowedPattern.test(normalized)) {
        return { ok: false, error: "Expression contains forbidden characters" };
      }

      const result = Function("Math", `return (${normalized});`)(Math);
      if (typeof result !== "number" || Number.isNaN(result)) {
        return { ok: false, error: "Expression did not evaluate to a valid number" };
      }

      return { ok: true, data: { value: result } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Calculation failed" };
    }
  },
};
