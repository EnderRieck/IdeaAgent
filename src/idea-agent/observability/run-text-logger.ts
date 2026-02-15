import fs from "node:fs/promises";
import path from "node:path";
import type { AgentEvent } from "../core/event-bus";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") {
        return item.toString();
      }
      if (typeof item === "function") {
        return `[Function ${item.name || "anonymous"}]`;
      }
      if (item instanceof Error) {
        return {
          name: item.name,
          message: item.message,
          stack: item.stack,
        };
      }
      return item;
    });
  } catch {
    return "[UnserializablePayload]";
  }
}

function compactPayload(payload: unknown, maxChars: number = 3000): string {
  const serialized = safeStringify(payload);
  if (serialized.length <= maxChars) {
    return serialized;
  }
  return `${serialized.slice(0, maxChars)} ...<truncated ${serialized.length - maxChars} chars>`;
}

export class RunTextLogger {
  readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async create(params: {
    dataDir?: string;
    sessionId: string;
    runId: string;
    goal: string;
  }): Promise<RunTextLogger> {
    const baseDir = params.dataDir ?? ".idea-agent-data";
    const logDir = path.join(baseDir, "sessions", params.sessionId, "logs");
    await fs.mkdir(logDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${timestamp}-${params.sessionId}-${params.runId}.log`;
    const filePath = path.join(logDir, fileName);

    const logger = new RunTextLogger(filePath);
    await logger.logLine(`=== IdeaAgent Run Log ===`);
    await logger.logLine(`startAt: ${new Date().toISOString()}`);
    await logger.logLine(`sessionId: ${params.sessionId}`);
    await logger.logLine(`runId: ${params.runId}`);
    await logger.logLine(`goal: ${params.goal}`);
    await logger.logLine("--- events ---");
    return logger;
  }

  async logEvent(event: AgentEvent): Promise<void> {
    const fullDetailEvents = new Set(["llm.prompt.input", "error.detail"]);
    const payload = fullDetailEvents.has(event.name)
      ? safeStringify(event.payload)
      : compactPayload(event.payload);
    const line = `[${event.at}] event=${event.name} turn=${event.turn} session=${event.sessionId} run=${event.runId} payload=${payload}`;
    await this.logLine(line);
  }

  async logLine(message: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      await fs.appendFile(this.filePath, `${message}\n`, "utf-8");
    });
    return this.queue;
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
