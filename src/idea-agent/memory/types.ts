export interface MemoryContext {
  sessionId: string;
  runId: string;
}

export interface MemoryItem {
  id: string;
  type: "session" | "working" | "durable";
  content: string;
  source?: string;
  createdAt: string;
  tags?: string[];
}

export interface MemoryEvent {
  sessionId: string;
  type: "append";
  item: MemoryItem;
}
