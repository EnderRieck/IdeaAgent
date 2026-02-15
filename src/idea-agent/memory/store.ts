import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryContext, MemoryEvent, MemoryItem } from "./types";

export interface MemoryStore {
  recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]>;
  append(event: MemoryEvent): Promise<void>;
  snapshot(sessionId: string): Promise<Record<string, unknown>>;
}

export class InMemoryStore implements MemoryStore {
  private readonly bySession = new Map<string, MemoryItem[]>();

  async recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]> {
    const rows = this.bySession.get(ctx.sessionId) ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return rows;
    }
    return rows.filter((item) => item.content.toLowerCase().includes(needle));
  }

  async append(event: MemoryEvent): Promise<void> {
    const rows = this.bySession.get(event.sessionId) ?? [];
    rows.push(event.item);
    this.bySession.set(event.sessionId, rows);
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    const rows = this.bySession.get(sessionId) ?? [];
    return {
      total: rows.length,
      session: rows.filter((row) => row.type === "session").length,
      working: rows.filter((row) => row.type === "working").length,
      durable: rows.filter((row) => row.type === "durable").length,
      items: rows,
    };
  }
}

export class FileMemoryStore implements MemoryStore {
  private readonly dataDir: string;
  private readonly durableFile: string;

  constructor(dataDir: string = ".idea-agent-data") {
    this.dataDir = dataDir;
    this.durableFile = path.join(this.dataDir, "durable.jsonl");
  }

  async recall(query: string, ctx: MemoryContext): Promise<MemoryItem[]> {
    const [sessionItems, durableItems] = await Promise.all([
      this.readSessionItems(ctx.sessionId),
      this.readDurableItems(),
    ]);

    const merged = [...sessionItems, ...durableItems];
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return merged;
    }

    return merged.filter((item) => item.content.toLowerCase().includes(needle));
  }

  async append(event: MemoryEvent): Promise<void> {
    await this.ensureDirs(event.sessionId);

    const line = `${JSON.stringify(event.item)}\n`;
    const sessionFile = this.getSessionFile(event.sessionId);
    await fs.appendFile(sessionFile, line, "utf-8");

    if (event.item.type === "durable") {
      await fs.appendFile(this.durableFile, line, "utf-8");
    }
  }

  async snapshot(sessionId: string): Promise<Record<string, unknown>> {
    const rows = await this.readSessionItems(sessionId);
    return {
      total: rows.length,
      session: rows.filter((row) => row.type === "session").length,
      working: rows.filter((row) => row.type === "working").length,
      durable: rows.filter((row) => row.type === "durable").length,
      items: rows.slice(-50),
    };
  }

  private getSessionFile(sessionId: string): string {
    return path.join(this.dataDir, "sessions", sessionId, "memory.jsonl");
  }

  private async ensureDirs(sessionId?: string): Promise<void> {
    if (sessionId) {
      await fs.mkdir(path.join(this.dataDir, "sessions", sessionId), { recursive: true });
    }
    await fs.mkdir(path.dirname(this.durableFile), { recursive: true });
  }

  private async readSessionItems(sessionId: string): Promise<MemoryItem[]> {
    await this.ensureDirs(sessionId);
    return this.readJsonlFile(this.getSessionFile(sessionId));
  }

  private async readDurableItems(): Promise<MemoryItem[]> {
    await this.ensureDirs();
    return this.readJsonlFile(this.durableFile);
  }

  private async readJsonlFile(filePath: string): Promise<MemoryItem[]> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as MemoryItem);
    } catch {
      return [];
    }
  }
}
