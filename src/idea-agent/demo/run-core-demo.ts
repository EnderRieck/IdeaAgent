import { createIdeaAgentRuntime, createInitialState } from "../index";

async function main(): Promise<void> {
  const runtime = await createIdeaAgentRuntime();
  const { runner, eventBus, toolRegistry, subAgentRegistry } = runtime;

  const eventStats = new Map<string, number>();
  const stopListen = eventBus.onAny((event) => {
    eventStats.set(event.name, (eventStats.get(event.name) ?? 0) + 1);
  });

  try {
    const initial = createInitialState("验证主Agent循环是否跑通");
    const finalState = await runner.run(initial);

    console.log("=== CORE DEMO RESULT ===");
    console.log("status:", finalState.status);
    console.log("turn:", finalState.turn);
    console.log("toolResults:", finalState.toolResults.length);
    console.log("subAgentResults:", finalState.subAgentResults.length);
    console.log("memorySnapshot.total:", (finalState.memorySnapshot.total as number) ?? 0);
    console.log("registered tools:", toolRegistry.list().length);
    console.log("registered subagents:", subAgentRegistry.list().length);
    console.log("event counts:");

    for (const [name, count] of [...eventStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (count > 0) {
        console.log(`  ${name}: ${count}`);
      }
    }

    const latestTool = finalState.toolResults[finalState.toolResults.length - 1];
    const latestSub = finalState.subAgentResults[finalState.subAgentResults.length - 1];
    console.log("latest tool ok:", latestTool?.ok ?? false);
    console.log("latest subagent ok:", latestSub?.ok ?? false);
  } finally {
    stopListen();
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
