export interface ToolPolicy {
  timeoutMs: number;
}

export const defaultToolPolicy: ToolPolicy = {
  timeoutMs: 30_000,
};
