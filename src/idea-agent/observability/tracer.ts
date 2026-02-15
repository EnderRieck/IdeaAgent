export interface TraceRecord {
  name: string;
  startAt: string;
  endAt?: string;
  metadata?: Record<string, unknown>;
}

export class Tracer {
  private readonly records: TraceRecord[] = [];

  start(name: string, metadata?: Record<string, unknown>): TraceRecord {
    const record: TraceRecord = {
      name,
      startAt: new Date().toISOString(),
      metadata,
    };
    this.records.push(record);
    return record;
  }

  end(record: TraceRecord): void {
    record.endAt = new Date().toISOString();
  }

  list(): TraceRecord[] {
    return this.records;
  }
}
