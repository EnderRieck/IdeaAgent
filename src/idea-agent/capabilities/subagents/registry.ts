import type { SubAgent } from "./types";

export class SubAgentRegistry {
  private readonly items = new Map<string, SubAgent>();

  register(item: SubAgent): void {
    this.items.set(item.id, item);
  }

  unregister(id: string): void {
    this.items.delete(id);
  }

  get(id: string): SubAgent | undefined {
    return this.items.get(id);
  }

  list(): SubAgent[] {
    return [...this.items.values()];
  }
}
