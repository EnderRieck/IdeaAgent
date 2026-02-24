import React from "react";
import { getInk } from "./ink-api";

interface DividerProps {
  color?: string;
}

export function Divider({ color }: DividerProps) {
  const { Text } = getInk();
  const width = process.stdout.columns ?? 80;
  return <Text dimColor color={color}>{"─".repeat(width)}</Text>;
}
