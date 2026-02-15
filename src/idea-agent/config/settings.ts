import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const openaiConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    systemPrompt: z.string().min(1).optional(),
  })
  .partial();

const openalexConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    email: z.string().min(3).optional(),
    maxResults: z.number().int().positive().max(1000).optional(),
  })
  .partial();

const arxivConfigSchema = z
  .object({
    maxResults: z.number().int().positive().max(1000).optional(),
  })
  .partial();

const mineruConfigSchema = z
  .object({
    apiUrl: z.string().url().optional(),
  })
  .partial();

const memoryConfigSchema = z
  .object({
    dataDir: z.string().min(1).optional(),
  })
  .partial();

const webConfigSchema = z
  .object({
    provider: z.enum(["brave", "duckduckgo", "bing"]).optional(),
    apiKey: z.string().min(1).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    maxResults: z.number().int().positive().max(1000).optional(),
  })
  .partial();

const runtimeConfigSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    toolDefaultTimeoutMs: z.number().int().positive().optional(),
    interactive: z.boolean().optional(),
    autoApproveSensitiveTools: z.boolean().optional(),
    debugPrompts: z.boolean().optional(),
  })
  .partial();

const contextCompactConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    constraintsMaxChars: z.number().int().positive().optional(),
    dialogueMaxChars: z.number().int().positive().optional(),
    recallQueryMaxChars: z.number().int().positive().optional(),
    recentDialogueMaxChars: z.number().int().positive().optional(),
    historyMessagesMaxChars: z.number().int().positive().optional(),
  })
  .partial();

const fileConfigSchema = z
  .object({
    openai: openaiConfigSchema.optional(),
    openalex: openalexConfigSchema.optional(),
    arxiv: arxivConfigSchema.optional(),
    mineru: mineruConfigSchema.optional(),
    memory: memoryConfigSchema.optional(),
    web: webConfigSchema.optional(),
    runtime: runtimeConfigSchema.optional(),
    contextCompact: contextCompactConfigSchema.optional(),
  })
  .partial();

export interface IdeaAgentSettings {
  openai: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  };
  openalex: {
    apiKey?: string;
    email?: string;
    maxResults?: number;
  };
  arxiv: {
    maxResults?: number;
  };
  mineru: {
    apiUrl?: string;
  };
  memory: {
    dataDir?: string;
  };
  web: {
    provider?: "brave" | "duckduckgo" | "bing";
    apiKey?: string;
    timeoutSeconds?: number;
    maxResults?: number;
  };
  runtime: {
    maxTurns?: number;
    toolDefaultTimeoutMs?: number;
    interactive?: boolean;
    autoApproveSensitiveTools?: boolean;
    debugPrompts?: boolean;
  };
  contextCompact: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    constraintsMaxChars?: number;
    dialogueMaxChars?: number;
    recallQueryMaxChars?: number;
    recentDialogueMaxChars?: number;
    historyMessagesMaxChars?: number;
  };
}

const defaultSettings: IdeaAgentSettings = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxTokens: 900,
  },
  openalex: {
    maxResults: 100,
  },
  arxiv: {
    maxResults: 30,
  },
  mineru: {},
  memory: {
    dataDir: ".idea-agent-data",
  },
  web: {
    provider: "brave",
    timeoutSeconds: 20,
    maxResults: 5,
  },
  runtime: {
    maxTurns: 24,
    toolDefaultTimeoutMs: 30_000,
    interactive: false,
    autoApproveSensitiveTools: false,
    debugPrompts: false,
  },
  contextCompact: {
    enabled: true,
    temperature: 0,
    maxTokens: 900,
    constraintsMaxChars: 12_000,
    dialogueMaxChars: 16_000,
    recallQueryMaxChars: 6_000,
    recentDialogueMaxChars: 8_000,
    historyMessagesMaxChars: 10_000,
  },
};

function parseEnvNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveConfigPath(configPath?: string): string {
  return configPath ?? process.env.IDEA_AGENT_CONFIG_PATH ?? path.resolve(process.cwd(), "idea-agent.config.json");
}

function pickDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function loadFileConfig(configPath?: string): Partial<IdeaAgentSettings> {
  const resolved = resolveConfigPath(configPath);
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const raw = fs.readFileSync(resolved, "utf-8");
  const json = JSON.parse(raw) as unknown;
  return fileConfigSchema.parse(json);
}

function loadEnvConfig(): Partial<IdeaAgentSettings> {
  return {
    openai: pickDefined({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
      temperature: parseEnvNumber(process.env.OPENAI_TEMPERATURE),
      maxTokens: parseEnvNumber(process.env.OPENAI_MAX_TOKENS),
      systemPrompt: process.env.OPENAI_SYSTEM_PROMPT,
    }),
    openalex: pickDefined({
      apiKey: process.env.OPENALEX_API_KEY,
      email: process.env.OPENALEX_EMAIL,
      maxResults: parseEnvNumber(process.env.OPENALEX_MAX_RESULTS),
    }),
    arxiv: pickDefined({
      maxResults: parseEnvNumber(process.env.ARXIV_MAX_RESULTS),
    }),
    mineru: pickDefined({
      apiUrl: process.env.MINERU_API_URL,
    }),
    memory: pickDefined({
      dataDir: process.env.IDEA_AGENT_DATA_DIR,
    }),
    web: pickDefined({
      provider: process.env.WEB_SEARCH_PROVIDER as "brave" | "duckduckgo" | "bing" | undefined,
      apiKey: process.env.BRAVE_API_KEY,
      timeoutSeconds: parseEnvNumber(process.env.WEB_SEARCH_TIMEOUT_SECONDS),
      maxResults: parseEnvNumber(process.env.WEB_SEARCH_MAX_RESULTS),
    }),
    runtime: pickDefined({
      maxTurns: parseEnvNumber(process.env.IDEA_AGENT_MAX_TURNS),
      toolDefaultTimeoutMs: parseEnvNumber(process.env.IDEA_AGENT_TOOL_TIMEOUT_MS),
      interactive: parseEnvBoolean(process.env.IDEA_AGENT_INTERACTIVE),
      autoApproveSensitiveTools: parseEnvBoolean(process.env.IDEA_AGENT_AUTO_APPROVE_SENSITIVE_TOOLS),
      debugPrompts: parseEnvBoolean(process.env.IDEA_AGENT_DEBUG_PROMPTS),
    }),
    contextCompact: pickDefined({
      enabled: parseEnvBoolean(process.env.IDEA_AGENT_CONTEXT_COMPACT_ENABLED),
      baseUrl: process.env.IDEA_AGENT_CONTEXT_COMPACT_BASE_URL,
      model: process.env.IDEA_AGENT_CONTEXT_COMPACT_MODEL,
      temperature: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_TEMPERATURE),
      maxTokens: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_MAX_TOKENS),
      constraintsMaxChars: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_CONSTRAINTS_MAX_CHARS),
      dialogueMaxChars: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_DIALOGUE_MAX_CHARS),
      recallQueryMaxChars: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_RECALL_MAX_CHARS),
      recentDialogueMaxChars: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_RECENT_DIALOGUE_MAX_CHARS),
      historyMessagesMaxChars: parseEnvNumber(process.env.IDEA_AGENT_CONTEXT_COMPACT_HISTORY_MAX_CHARS),
    }),
  };
}

function mergeSettings(base: IdeaAgentSettings, ...overrides: Array<Partial<IdeaAgentSettings>>): IdeaAgentSettings {
  return overrides.reduce<IdeaAgentSettings>((acc, patch) => {
    return {
      openai: {
        ...acc.openai,
        ...pickDefined(patch.openai ?? {}),
      },
      openalex: {
        ...acc.openalex,
        ...pickDefined(patch.openalex ?? {}),
      },
      arxiv: {
        ...acc.arxiv,
        ...pickDefined(patch.arxiv ?? {}),
      },
      mineru: {
        ...acc.mineru,
        ...pickDefined(patch.mineru ?? {}),
      },
      memory: {
        ...acc.memory,
        ...pickDefined(patch.memory ?? {}),
      },
      web: {
        ...acc.web,
        ...pickDefined(patch.web ?? {}),
      },
      runtime: {
        ...acc.runtime,
        ...pickDefined(patch.runtime ?? {}),
      },
      contextCompact: {
        ...acc.contextCompact,
        ...pickDefined(patch.contextCompact ?? {}),
      },
    };
  }, base);
}

export function getIdeaAgentSettings(options?: { configPath?: string; override?: Partial<IdeaAgentSettings> }): IdeaAgentSettings {
  const fileConfig = loadFileConfig(options?.configPath);
  const envConfig = loadEnvConfig();
  return mergeSettings(defaultSettings, fileConfig, envConfig, options?.override ?? {});
}
