import React from "react";
import { getInk } from "./ink-api";

interface StatusBarProps {
  turn: number;
  status: string;
  agentName?: string;
}

export function StatusBar({ turn, status, agentName }: StatusBarProps) {
  const { Text } = getInk();
  const parts = [`Turn ${turn}`, status];
  if (agentName) parts.push(agentName);
  return <Text dimColor>{parts.join(" · ")}</Text>;
}
