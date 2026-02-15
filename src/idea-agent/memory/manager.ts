import type { MemoryContext, MemoryEvent, MemoryItem } from "./types";
import type { MemoryStore } from "./store";

export class MemoryManager {
  constructor(private readonly store: MemoryStore) {}

  async recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]> {
    return this.store.recall(query, ctx);
  }

  async append(event: MemoryEvent): Promise<void> {
    if (event.item.type === "durable" && event.item.content.length < 30) {
      return;
    }
    await this.store.append(event);
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    return this.store.snapshot(sessionId);
  }
}
