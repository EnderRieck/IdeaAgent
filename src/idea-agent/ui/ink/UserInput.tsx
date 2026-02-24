import React, { useState } from "react";
import { getInk } from "./ink-api";

interface UserInputProps {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  placeholder?: string;
}

export function UserInput({ onSubmit, onCancel, placeholder }: UserInputProps) {
  const { Box, Text, useInput } = getInk();
  const [buf, setBuf] = useState("");
  const [cur, setCur] = useState(0);

  useInput((input: string, key: any) => {
    if (key.escape) { onCancel(); return; }

    // Alt+Enter / Option+Return → insert newline
    if (key.return && key.meta) {
      setBuf(p => p.slice(0, cur) + "\n" + p.slice(cur));
      setCur(c => c + 1);
      return;
    }

    // Enter → submit
    if (key.return && input.length <= 1) {
      onSubmit(buf.trim());
      return;
    }

    if (key.backspace || key.delete) {
      if (cur > 0) {
        setBuf(p => p.slice(0, cur - 1) + p.slice(cur));
        setCur(c => c - 1);
      }
      return;
    }

    if (key.leftArrow) { if (cur > 0) setCur(c => c - 1); return; }
    if (key.rightArrow) { if (cur < buf.length) setCur(c => c + 1); return; }
    if (key.upArrow || key.downArrow) return;

    if (input && !key.ctrl && !key.meta) {
      const clean = input.replace(/\r\n?/g, "\n");
      setBuf(p => p.slice(0, cur) + clean + p.slice(cur));
      setCur(c => c + clean.length);
    }
  });

  const lines = buf.split("\n");
  let offset = 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box><Text color="cyan" dimColor> Alt+Enter 换行 | Enter 发送 | Esc 取消</Text></Box>
      {buf.length === 0 && placeholder && (
        <Box><Text dimColor>{`█ ${placeholder}`}</Text></Box>
      )}
      {buf.length > 0 && lines.map((line, i) => {
        const start = offset;
        offset += line.length + 1;
        const hasCursor = cur >= start && cur <= start + line.length;
        const lc = cur - start;
        return (
          <Box key={i}>
            <Text>{hasCursor ? line.slice(0, lc) + "█" + line.slice(lc) : line || " "}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
