export interface AuditEntry {
  action: string;
  actor: string;
  detail?: Record<string, unknown>;
  at: string;
}

export class AuditLog {
  private readonly entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  list(): AuditEntry[] {
    return this.entries;
  }
}
