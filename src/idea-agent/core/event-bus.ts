export interface AgentEvent<T = unknown> {
  name: string;
  payload: T;
  at: string;
  runId: string;
  sessionId: string;
  turn: number;
}

export type EventListener = (event: AgentEvent) => void | Promise<void>;

export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();
  private anyListeners = new Set<EventListener>();

  on(eventName: string, listener: EventListener): () => void {
    const bucket = this.listeners.get(eventName) ?? new Set<EventListener>();
    bucket.add(listener);
    this.listeners.set(eventName, bucket);
    return () => {
      const current = this.listeners.get(eventName);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(eventName);
      }
    };
  }

  onAny(listener: EventListener): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  async emit(event: AgentEvent): Promise<void> {
    const listeners = this.listeners.get(event.name);
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) {
        await listener(event);
      }
    }

    if (this.anyListeners.size > 0) {
      for (const listener of this.anyListeners) {
        await listener(event);
      }
    }
  }
}
