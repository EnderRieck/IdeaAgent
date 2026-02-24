import type { z } from "zod";

// ── ChatMessage types (OpenAI-compatible) ──────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// ── Legacy types (kept for backward compatibility during migration) ──

export type LoopStatus =
  | "init"
  | "running"
  | "waiting_approval"
  | "waiting_user"
  | "completed"
  | "failed"
  | "aborted";

export interface AskUserOption {
  id: string;
  text: string;
}

export interface AskUserQuestion {
  prompt: string;
  details?: string;
  options: AskUserOption[];
  allowMultiple?: boolean;
}

export interface RuntimeDeps {
  nowISO(): string;
  randomId(prefix: string): string;
}
