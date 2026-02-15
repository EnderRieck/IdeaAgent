export interface RuntimeConfig {
  maxTurns: number;
  toolDefaultTimeoutMs: number;
}

export const defaultRuntimeConfig: RuntimeConfig = {
  maxTurns: 24,
  toolDefaultTimeoutMs: 30_000,
};

export function resolveRuntimeConfig(input?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    maxTurns: input?.maxTurns ?? defaultRuntimeConfig.maxTurns,
    toolDefaultTimeoutMs: input?.toolDefaultTimeoutMs ?? defaultRuntimeConfig.toolDefaultTimeoutMs,
  };
}
