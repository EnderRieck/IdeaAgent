import type { MemoryStore } from "./store";
import type { MemoryContext, MemoryItem } from "./types";

export class MemoryRetriever {
  constructor(private readonly store: MemoryStore) {}

  async recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]> {
    return this.store.recall(query, ctx);
  }
}
