import { createIdeaAgentRuntime, createInitialSession } from "../index";

async function main(): Promise<void> {
  const runtime = await createIdeaAgentRuntime();
  const { runner, eventBus, toolRegistry } = runtime;

  const eventStats = new Map<string, number>();
  const stopListen = eventBus.onAny((event) => {
    eventStats.set(event.name, (eventStats.get(event.name) ?? 0) + 1);
  });

  try {
    const initial = createInitialSession();
    const finalState = await runner.run(initial);

    console.log("=== CORE DEMO RESULT ===");
    console.log("status:", finalState.status);
    console.log("turns:", finalState.turn);
    console.log("messages:", finalState.messages.length);
    console.log("registered tools:", toolRegistry.size);
    console.log("event counts:");

    for (const [name, count] of [...eventStats.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (count > 0) {
        console.log(`  ${name}: ${count}`);
      }
    }
  } finally {
    stopListen();
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
