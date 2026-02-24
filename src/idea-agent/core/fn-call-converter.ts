import type { ChatMessage, ToolCall, ToolDefinition } from "./types";

// ── XML Format Function Calling Converter ──────────────────────────
// For models that don't support native tool calling (e.g. DeepSeek).
// Format: <function=name><parameter=key>value</parameter></function>
// Based on AI-Researcher's fn_call_converter.py

const FN_REGEX = /<function=([^>]+)>\n?([\s\S]*?)<\/function>/;
const FN_PARAM_REGEX = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;

// ── Convert ToolDefinitions to text description for system prompt ──

export function convertToolsToDescription(tools: ToolDefinition[]): string {
  const parts: string[] = [];

  for (let i = 0; i < tools.length; i++) {
    const fn = tools[i].function;
    parts.push(`---- BEGIN FUNCTION #${i + 1}: ${fn.name} ----`);
    parts.push(`Description: ${fn.description}`);

    const params = fn.parameters as {
      properties?: Record<string, { type?: string; description?: string; enum?: string[] }>;
      required?: string[];
    };

    if (params?.properties && Object.keys(params.properties).length > 0) {
      parts.push("Parameters:");
      const required = new Set(params.required ?? []);
      let j = 0;
      for (const [name, info] of Object.entries(params.properties)) {
        j++;
        const status = required.has(name) ? "required" : "optional";
        const type = info.type ?? "string";
        let desc = info.description ?? "No description provided";
        if (info.enum) {
          desc += `\nAllowed values: [${info.enum.map((v) => `\`${v}\``).join(", ")}]`;
        }
        parts.push(`  (${j}) ${name} (${type}, ${status}): ${desc}`);
      }
    } else {
      parts.push("No parameters are required for this function.");
    }

    parts.push(`---- END FUNCTION #${i + 1} ----`);
    if (i < tools.length - 1) parts.push("");
  }

  return parts.join("\n");
}

// ── System prompt suffix template ──────────────────────────────────

function buildSystemPromptSuffix(tools: ToolDefinition[]): string {
  const description = convertToolsToDescription(tools);
  return `
You have access to the following functions:

${description}

If you choose to call a function ONLY reply in the following format with NO suffix:

<function=example_function_name>
<parameter=example_parameter_1>value_1</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format, start with <function= and end with </function>
- Required parameters MUST be specified
- Only call one function at a time
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after.
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls
`;
}

// ── Convert native messages to non-FC messages ─────────────────────
// Injects tool descriptions into system prompt, converts tool_calls to XML text,
// converts tool results to user messages.

export function convertToNonFnCallMessages(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): ChatMessage[] {
  const suffix = buildSystemPromptSuffix(tools);
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content + suffix });
      continue;
    }

    if (msg.role === "user") {
      result.push({ ...msg });
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const tc = msg.tool_calls[0];
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        let xmlContent = `<function=${tc.function.name}>\n`;
        for (const [key, value] of Object.entries(args)) {
          const strValue = typeof value === "string" ? value : JSON.stringify(value);
          const isMultiline = strValue.includes("\n");
          xmlContent += `<parameter=${key}>`;
          if (isMultiline) xmlContent += "\n";
          xmlContent += strValue;
          if (isMultiline) xmlContent += "\n";
          xmlContent += "</parameter>\n";
        }
        xmlContent += "</function>";

        const textContent = msg.content ? `${msg.content}\n\n${xmlContent}` : xmlContent;
        result.push({ role: "assistant", content: textContent });
      } else {
        result.push({ role: "assistant", content: msg.content ?? "" });
      }
      continue;
    }

    if (msg.role === "tool") {
      // Convert tool result to user message
      result.push({
        role: "user",
        content: `EXECUTION RESULT of [${msg.name}]:\n${msg.content}`,
      });
      continue;
    }
  }

  return result;
}

// ── Parse XML function calls from assistant content ────────────────

export function parseXmlFunctionCalls(
  content: string,
  tools: ToolDefinition[],
): { text: string; toolCalls: ToolCall[] } {
  // Fix missing closing tag
  let fixed = content;
  if (fixed.includes("<function=") && !fixed.includes("</function>")) {
    if (fixed.endsWith("</")) {
      fixed = fixed + "function>";
    } else {
      fixed = fixed + "\n</function>";
    }
  }

  const match = FN_REGEX.exec(fixed);
  if (!match) {
    return { text: content, toolCalls: [] };
  }

  const fnName = match[1];
  const fnBody = match[2];

  // Validate function exists
  const matchingTool = tools.find((t) => t.function.name === fnName);
  if (!matchingTool) {
    return { text: content, toolCalls: [] };
  }

  // Parse parameters
  const params: Record<string, unknown> = {};
  const paramProperties = (matchingTool.function.parameters as {
    properties?: Record<string, { type?: string }>;
  })?.properties ?? {};

  let paramMatch: RegExpExecArray | null;
  const paramRegex = new RegExp(FN_PARAM_REGEX.source, "gs");
  while ((paramMatch = paramRegex.exec(fnBody)) !== null) {
    const paramName = paramMatch[1];
    let paramValue: unknown = paramMatch[2].trim();

    // Type conversion
    const paramType = paramProperties[paramName]?.type;
    if (paramType === "integer" || paramType === "number") {
      const num = Number(paramValue);
      if (!Number.isNaN(num)) paramValue = num;
    } else if (paramType === "array" || paramType === "boolean") {
      try {
        paramValue = JSON.parse(paramValue as string);
      } catch {
        // keep as string
      }
    }

    params[paramName] = paramValue;
  }

  const toolCallId = `xmlcall_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const textBefore = fixed.split("<function=")[0].trim();

  return {
    text: textBefore,
    toolCalls: [
      {
        id: toolCallId,
        type: "function",
        function: {
          name: fnName,
          arguments: JSON.stringify(params),
        },
      },
    ],
  };
}

// ── Interleave user messages between consecutive assistant messages ─
// Some models require alternating user/assistant messages.

export function interleaveUserMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      i > 0 &&
      result.length > 0 &&
      result[result.length - 1].role === "assistant"
    ) {
      result.push({
        role: "user",
        content: "Please continue with the next action based on your previous observations.",
      });
    }
    result.push(msg);
  }

  return result;
}
