import React, { useState, useEffect, useCallback, useMemo } from "react";
import { getInk } from "./ink-api";
import type { EventBus, AgentEvent } from "../../core/event-bus";
import type { AskUserQuestion } from "../../core/types";
import type { InkUserBridge } from "../../runtime/ink-user-bridge";
import { OutputLog } from "./OutputLog";
import { UserInput } from "./UserInput";
import { AskUserPrompt } from "./AskUserPrompt";
import { StatusBar } from "./StatusBar";
import { Divider } from "./Divider";

interface AppProps {
  eventBus: EventBus;
  inkBridge: InkUserBridge;
  title: string;
  waitForInputResolve: React.MutableRefObject<((text: string | null) => void) | null>;
  waitForInputFlag: React.MutableRefObject<{ set: (v: boolean) => void }>;
}

export function App({ eventBus, inkBridge, title, waitForInputResolve, waitForInputFlag }: AppProps) {
  const { Box, Text } = getInk();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [askState, setAskState] = useState<{ question: AskUserQuestion; resolve: (answer: string) => void } | null>(null);

  // Expose setWaitingForInput to external caller
  useEffect(() => {
    waitForInputFlag.current.set = setWaitingForInput;
  }, [waitForInputFlag]);

  // Subscribe to events
  useEffect(() => {
    const stop = eventBus.onAny((ev) => {
      setEvents((prev) => [...prev, ev]);
    });
    return stop;
  }, [eventBus]);

  // Wire up ink bridge ask callback
  useEffect(() => {
    inkBridge.setAskCallback((question) => {
      return new Promise<string>((resolve) => {
        setAskState({ question, resolve });
      });
    });
  }, [inkBridge]);

  const handleInputSubmit = useCallback((text: string) => {
    setWaitingForInput(false);
    waitForInputResolve.current?.(text || null);
    waitForInputResolve.current = null;
  }, [waitForInputResolve]);

  const handleInputCancel = useCallback(() => {
    setWaitingForInput(false);
    waitForInputResolve.current?.(null);
    waitForInputResolve.current = null;
  }, [waitForInputResolve]);

  const handleAskSelect = useCallback((answer: string) => {
    askState?.resolve(answer);
    setAskState(null);
  }, [askState]);

  // Extract turn/status/agent from events for StatusBar
  const { turn, status, agentName } = useMemo(() => {
    let t = 0, s = "idle", a = "";
    for (const ev of events) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.name === "agent.llm.start") {
        t = Number(p.turn ?? ev.turn); s = "thinking"; a = String(p.agent ?? "");
      } else if (ev.name === "agent.message") {
        s = "responded";
      } else if (ev.name === "agent.tool.start") {
        s = `tool: ${String(p.toolName ?? "")}`;
      } else if (ev.name === "run.completed") {
        s = "completed";
      } else if (ev.name === "run.failed") {
        s = "failed";
      }
    }
    return { turn: t, status: s, agentName: a };
  }, [events]);

  return (
    <Box flexDirection="column">
      <Text bold inverse>{` ❯ ${title} `}</Text>
      <OutputLog events={events} />
      <Divider />
      <StatusBar turn={turn} status={status} agentName={agentName} />
      {askState && (
        <AskUserPrompt
          prompt={askState.question.prompt}
          details={askState.question.details}
          options={askState.question.options}
          allowMultiple={askState.question.allowMultiple}
          onSelect={handleAskSelect}
        />
      )}
      {waitingForInput && !askState && (
        <UserInput onSubmit={handleInputSubmit} onCancel={handleInputCancel} placeholder="输入消息..." />
      )}
    </Box>
  );
}
