import React, { useState } from "react";
import { getInk } from "./ink-api";
import type { AskUserOption } from "../../core/types";

interface AskUserPromptProps {
  prompt: string;
  details?: string;
  options: AskUserOption[];
  allowMultiple?: boolean;
  onSelect: (answer: string) => void;
}

export function AskUserPrompt({ prompt, details, options, allowMultiple, onSelect }: AskUserPromptProps) {
  const { Box, Text, useInput } = getInk();
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  useInput((_input: string, key: any) => {
    if (key.upArrow) {
      setCursor((c) => (c - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % options.length);
      return;
    }
    if (_input === " " && allowMultiple) {
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    if (key.escape) {
      onSelect(`${options[0].id}: ${options[0].text}`);
      return;
    }
    if (key.return) {
      if (allowMultiple) {
        const sel = checked.size > 0 ? [...checked].sort((a, b) => a - b) : [cursor];
        onSelect(sel.map((i) => `${options[i].id}: ${options[i].text}`).join(" | "));
      } else {
        onSelect(`${options[cursor].id}: ${options[cursor].text}`);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>{prompt}</Text>
      {details && <Text dimColor>{details}</Text>}
      <Text dimColor>{allowMultiple ? "↑↓ 选择 · Space 选中 · Enter 确认 · Esc 取消" : "↑↓ 选择 · Enter 确认 · Esc 取消"}</Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const active = i === cursor;
          const ptr = active ? "❯" : " ";
          const indicator = allowMultiple
            ? (checked.has(i) ? "◉" : "◯")
            : (active ? "●" : "○");
          return (
            <Box key={opt.id}>
              <Text color={active ? "cyan" : undefined}>
                {`  ${ptr} ${indicator} ${opt.text}`}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
