import type { MemoryStore } from "./store";
import type { MemoryEvent } from "./types";

export class MemoryWriter {
  constructor(private readonly store: MemoryStore) {}

  async append(event: MemoryEvent): Promise<void> {
    await this.store.append(event);
  }
}
