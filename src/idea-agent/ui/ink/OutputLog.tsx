import React, { useMemo } from "react";
import { getInk } from "./ink-api";
import { Spinner } from "./Spinner";
import { Divider } from "./Divider";
import { renderMarkdown } from "../markdown";
import type { AgentEvent } from "../../core/event-bus";

function compactText(value: unknown, maxChars = 220): string {
  const raw = typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  return raw.length <= maxChars ? raw : `${raw.slice(0, maxChars)}...(truncated)`;
}

/* ── Merged display item types ─────────────────────────── */

type DisplayItem =
  | { kind: "session"; sessionId: string }
  | { kind: "turn"; turn: number; agent: string; thinking: boolean }
  | { kind: "message"; content: string }
  | { kind: "user-message"; content: string }
  | { kind: "tool"; name: string; input: unknown; status: "pending" | "done" | "error"; result?: string; error?: string }
  | { kind: "status"; type: "complete" | "failed"; text: string };

function buildDisplayItems(events: AgentEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const pendingTools = new Map<string, number>(); // callId -> index in items

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;

    switch (ev.name) {
      case "run.started":
        items.push({ kind: "session", sessionId: String(p.sessionId ?? "") });
        break;

      case "agent.llm.start":
        items.push({ kind: "turn", turn: Number(p.turn ?? ev.turn), agent: String(p.agent ?? ""), thinking: true });
        break;

      case "agent.message": {
        const content = String(p.content ?? "").replace(/<empty>/g, "").trim();
        if (!content) break;
        // Mark previous turn as no longer thinking
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === "turn") { (items[i] as any).thinking = false; break; }
        }
        items.push({ kind: "message", content });
        break;
      }

      case "agent.tool.start": {
        const callId = String(p.callId ?? p.toolName ?? "");
        const idx = items.length;
        items.push({ kind: "tool", name: String(p.toolName ?? "unknown"), input: p.input, status: "pending" });
        pendingTools.set(callId, idx);
        break;
      }

      case "agent.tool.complete": {
        const callId = String(p.callId ?? p.toolName ?? "");
        const idx = pendingTools.get(callId);
        if (idx !== undefined && items[idx]?.kind === "tool") {
          (items[idx] as any).status = "done";
          (items[idx] as any).result = compactText(p.valuePreview, 200);
          pendingTools.delete(callId);
        }
        break;
      }

      case "agent.tool.error": {
        const callId = String(p.callId ?? p.toolName ?? "");
        const idx = pendingTools.get(callId);
        if (idx !== undefined && items[idx]?.kind === "tool") {
          (items[idx] as any).status = "error";
          (items[idx] as any).error = compactText(p.error, 200);
          pendingTools.delete(callId);
        }
        break;
      }

      case "user.message": {
        const userContent = String(p.content ?? "").trim();
        if (userContent) {
          items.push({ kind: "user-message", content: userContent });
        }
        break;
      }

      case "agent.complete":
        items.push({ kind: "status", type: "complete", text: String(p.reason ?? "") });
        break;

      case "run.completed":
        items.push({ kind: "status", type: "complete", text: "运行完成" });
        break;

      case "run.failed":
        items.push({ kind: "status", type: "failed", text: String(p.error ?? "") });
        break;
    }
  }
  return items;
}

/* ── Sub-components ────────────────────────────────────── */

function TurnHeader({ turn, agent, thinking }: { turn: number; agent: string; thinking: boolean }) {
  const { Box, Text } = getInk();
  return (
    <Box flexDirection="column">
      <Divider />
      <Box>
        <Text color="yellow" bold>⟡</Text>
        <Text bold> Turn {turn} </Text>
        <Text dimColor>[{agent}]</Text>
        {thinking && <Text> <Spinner label="思考中" /></Text>}
      </Box>
    </Box>
  );
}

function AgentMessage({ content }: { content: string }) {
  const { Text } = getInk();
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  return <Text>{rendered}</Text>;
}

function ToolCall({ item }: { item: Extract<DisplayItem, { kind: "tool" }> }) {
  const { Box, Text } = getInk();
  const icon = item.status === "error" ? "✗" : item.status === "done" ? "✓" : "⧖";
  const iconColor = item.status === "error" ? "red" : item.status === "done" ? "green" : "cyan";

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={iconColor}>{icon}</Text>
        <Text color="cyan" bold> {item.name}</Text>
        <Text dimColor> ── {compactText(item.input, 120)}</Text>
      </Text>
      {item.status === "done" && item.result && (
        <Text dimColor>  └ {item.result}</Text>
      )}
      {item.status === "error" && item.error && (
        <Text color="red">  └ {item.error}</Text>
      )}
    </Box>
  );
}

function RunStatus({ type, text }: { type: "complete" | "failed"; text: string }) {
  const { Text } = getInk();
  if (type === "complete") {
    return <Text><Text color="green">✓</Text> <Text color="green" bold>{text}</Text></Text>;
  }
  return <Text><Text color="red">✗</Text> <Text color="red" bold>运行失败:</Text> {text}</Text>;
}

function UserMessage({ content }: { content: string }) {
  const { Box, Text } = getInk();
  return (
    <Box>
      <Text color="blue" bold>❯ </Text>
      <Text dimColor>{content}</Text>
    </Box>
  );
}

/* ── Settled / Active split ────────────────────────────── */

/**
 * Find the boundary between "settled" items (won't change) and
 * "active" items (thinking spinner / pending tools) at the tail.
 * Everything before the boundary goes into <Static>.
 */
function findSettledBoundary(items: DisplayItem[]): number {
  let boundary = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "tool" && item.status === "pending") {
      boundary = i;
      continue;
    }
    if (item.kind === "turn" && item.thinking) {
      boundary = i;
      break;
    }
    break;
  }
  return boundary;
}

/* ── Render a single DisplayItem ──────────────────────── */

function RenderItem({ item }: { item: DisplayItem }) {
  const { Text } = getInk();
  switch (item.kind) {
    case "session":
      return <Text dimColor>Session: {item.sessionId}</Text>;
    case "turn":
      return <TurnHeader turn={item.turn} agent={item.agent} thinking={item.thinking} />;
    case "message":
      return <AgentMessage content={item.content} />;
    case "user-message":
      return <UserMessage content={item.content} />;
    case "tool":
      return <ToolCall item={item} />;
    case "status":
      return <RunStatus type={item.type} text={item.text} />;
  }
}

/* ── Main OutputLog ────────────────────────────────────── */

interface OutputLogProps {
  events: AgentEvent[];
}

export function OutputLog({ events }: OutputLogProps) {
  const { Box, Static } = getInk();
  const items = useMemo(() => buildDisplayItems(events), [events]);
  const splitIdx = findSettledBoundary(items);
  const settled = items.slice(0, splitIdx);
  const live = items.slice(splitIdx);

  return (
    <Box flexDirection="column">
      <Static items={settled}>
        {(item: DisplayItem, i: number) => (
          <Box key={i} flexDirection="column">
            <RenderItem item={item} />
          </Box>
        )}
      </Static>
      {live.map((item, i) => (
        <Box key={`live-${i}`} flexDirection="column">
          <RenderItem item={item} />
        </Box>
      ))}
    </Box>
  );
}
