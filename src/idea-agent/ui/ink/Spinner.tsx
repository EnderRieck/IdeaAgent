import React, { useState, useEffect } from "react";
import { getInk } from "./ink-api";

const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  const { Text } = getInk();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Text>
      <Text color="cyan">{frames[frame]}</Text>
      {label ? <Text> {label}</Text> : null}
    </Text>
  );
}
