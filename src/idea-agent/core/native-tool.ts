import type { z } from "zod";
import type { ToolDefinition } from "./types";
import type { ContextVariables, ToolExecutionResult } from "./context-variables";

// ── NativeTool interface ───────────────────────────────────────────
// Replaces the old Tool<I, O> interface from capabilities/tools/types.ts.

export interface NativeTool<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  requiresApproval?: boolean | ((input: I) => boolean);
  execute(input: I, ctx: ContextVariables): Promise<ToolExecutionResult>;
}

// ── Convert NativeTool to OpenAI ToolDefinition ────────────────────

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const typeName = def?.typeName as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        const innerDef = (value as unknown as { _def: Record<string, unknown> })._def;
        const isOptional = innerDef?.typeName === "ZodOptional";
        const isDefault = innerDef?.typeName === "ZodDefault";
        const innerSchema = isOptional || isDefault
          ? (innerDef.innerType as z.ZodType)
          : value;

        properties[key] = zodToJsonSchema(innerSchema);

        if (!isOptional && !isDefault) {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) {
        result.required = required;
      }
      return result;
    }

    case "ZodString":
      return { type: "string" };

    case "ZodNumber":
      return { type: "number" };

    case "ZodBoolean":
      return { type: "boolean" };

    case "ZodArray": {
      const itemSchema = def.type as z.ZodType;
      return { type: "array", items: zodToJsonSchema(itemSchema) };
    }

    case "ZodEnum": {
      const values = (def as unknown as { values: string[] }).values;
      return { type: "string", enum: values };
    }

    case "ZodLiteral": {
      const value = (def as unknown as { value: unknown }).value;
      return { type: typeof value, enum: [value] };
    }

    case "ZodOptional":
    case "ZodDefault": {
      const inner = def.innerType as z.ZodType;
      return zodToJsonSchema(inner);
    }

    case "ZodRecord":
      return { type: "object", additionalProperties: true };

    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = (def.options as z.ZodType[]) ?? [];
      return { oneOf: options.map(zodToJsonSchema) };
    }

    case "ZodNullable": {
      const inner = def.innerType as z.ZodType;
      const base = zodToJsonSchema(inner);
      return { ...base, nullable: true };
    }

    default:
      return { type: "object" };
  }
}

export function toToolDefinition(tool: NativeTool): ToolDefinition {
  let parameters: Record<string, unknown>;
  try {
    parameters = zodToJsonSchema(tool.inputSchema);
  } catch {
    parameters = { type: "object", properties: {} };
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}
