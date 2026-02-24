import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";

const allowedPattern = /^[\d\s()+\-*/.,^eEpiPIa-zA-Z]+$/;

const inputSchema = z.object({
  expression: z.string().min(1),
});

export const scientificCalculatorTool: NativeTool = {
  name: "scientific-calculator",
  description: "使用 Math 上下文计算科学数值表达式。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    try {
      const normalized = input.expression.replace(/\^/g, "**");
      if (!allowedPattern.test(normalized)) {
        return { ok: false, value: "Error: Expression contains forbidden characters" };
      }

      const result = Function("Math", `return (${normalized});`)(Math);
      if (typeof result !== "number" || Number.isNaN(result)) {
        return { ok: false, value: "Error: Expression did not evaluate to a valid number" };
      }

      return { value: JSON.stringify({ value: result }) };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "Calculation failed"}` };
    }
  },
};
