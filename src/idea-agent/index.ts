import { setupGlobalProxy } from "./runtime/proxy-setup";
import { EventBus } from "./core/event-bus";
import type { NativeTool } from "./core/native-tool";
import { LLMClient } from "./core/llm-client";
import { LLMMessageCompressor } from "./core/message-compressor";
import { createAskUserTool, createSwitchPhaseTool } from "./core/builtin-tools";
import type { UserBridge } from "./runtime/user-bridge";
import { createSubAgentTool } from "./core/subagent-tool";
import type { ApprovalGate } from "./core/agent-loop";
import { buildPhaseAgents } from "./core/main-agent";
import { SessionRunner } from "./runtime/session-runner";
import { resolveRuntimeConfig } from "./runtime/config";
import { AutoUserBridge, InteractiveUserBridge } from "./runtime/user-bridge";
import { MemoryManager } from "./memory/manager";
import { FileMemoryStore } from "./memory/store";
import { builtinPlugin } from "./plugins/builtin/plugin";
import { getIdeaAgentSettings, type IdeaAgentSettings } from "./config/settings";
import { getSubAgentRuntimeProfile } from "./config/subagent-config";

// ── Options ───────────────────────────────────────────────────────

export interface CreateRuntimeOptions {
  configPath?: string;
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    systemPrompt?: string;
  };
  runtime?: {
    interactive?: boolean;
    autoApproveSensitiveTools?: boolean;
    debugPrompts?: boolean;
    maxTurns?: number;
    toolDefaultTimeoutMs?: number;
  };
  contextCompact?: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
  /** Externally provided UserBridge (e.g. from Ink UI) */
  userBridge?: UserBridge;
  /** Externally provided waitForUserInput callback (e.g. from Ink UI) */
  waitForUserInput?: () => Promise<string | null>;
}

// ── Runtime ───────────────────────────────────────────────────────

export interface IdeaAgentRuntime {
  runner: SessionRunner;
  eventBus: EventBus;
  toolRegistry: Map<string, NativeTool>;
  settings: IdeaAgentSettings;
  close(): Promise<void>;
}

// ── Helpers ───────────────────────────────────────────────────────

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveSettings(options?: CreateRuntimeOptions): IdeaAgentSettings {
  return getIdeaAgentSettings({
    configPath: options?.configPath,
    override: {
      openai: options?.openai,
      runtime: options?.runtime,
      contextCompact: options?.contextCompact,
    },
  });
}

function safeCloseBridge(userBridge: UserBridge): void {
  const withClose = userBridge as UserBridge & { close?: () => void };
  if (typeof withClose.close === "function") {
    withClose.close();
  }
}

// ── Simple Approval Gate ──────────────────────────────────────────

class SimpleApprovalGate implements ApprovalGate {
  constructor(
    private readonly userBridge: UserBridge,
    private readonly sensitiveTools: Set<string>,
    private readonly autoApprove: boolean,
  ) {}

  async shouldApprove(toolName: string, _input: unknown): Promise<boolean> {
    if (!this.sensitiveTools.has(toolName)) return true;
    if (this.autoApprove) return true;

    const answer = await this.userBridge.ask({
      prompt: `工具 "${toolName}" 需要审批。是否允许执行？`,
      options: [
        { id: "Y", text: "允许" },
        { id: "N", text: "拒绝" },
      ],
    });
    return answer.toLowerCase().startsWith("y");
  }
}

// ── Create Runtime ────────────────────────────────────────────────

export async function createIdeaAgentRuntime(options?: CreateRuntimeOptions): Promise<IdeaAgentRuntime> {
  setupGlobalProxy();

  if (options?.configPath) {
    process.env.IDEA_AGENT_CONFIG_PATH = options.configPath;
  }

  const settings = resolveSettings(options);
  const runtimeConfig = resolveRuntimeConfig(settings.runtime);
  const eventBus = new EventBus();

  // LLM Client
  const apiKey = settings.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. IdeaAgent is LLM-only and cannot run without model credentials.");
  }

  const llmClient = new LLMClient({
    apiKey,
    baseUrl: settings.openai.baseUrl,
  });

  // Message compressor
  const compressor = settings.contextCompact?.enabled !== false
    ? new LLMMessageCompressor(
        llmClient,
        settings.contextCompact?.model ?? settings.openai.model ?? "gpt-4o-mini",
      )
    : undefined;

  // User bridge (prefer externally injected)
  const userBridge: UserBridge = options?.userBridge
    ?? (settings.runtime.interactive ? new InteractiveUserBridge() : new AutoUserBridge());

  // Approval gate
  const sensitiveTools = new Set<string>(["local-cli"]);
  const approvalGate = new SimpleApprovalGate(
    userBridge,
    sensitiveTools,
    settings.runtime.autoApproveSensitiveTools === true,
  );

  // Build tool registry from builtin plugin
  const toolRegistry = new Map<string, NativeTool>();

  // Register all builtin tools
  for (const tool of builtinPlugin.tools) {
    toolRegistry.set(tool.name, tool);
  }

  // Register ask_user tool
  const askUserTool = createAskUserTool(userBridge);
  toolRegistry.set(askUserTool.name, askUserTool);

  // Register subagents as tools (merge subagents.config.json overrides)
  for (const descriptor of builtinPlugin.subAgentDescriptors) {
    const def = descriptor.definition;
    const profile = getSubAgentRuntimeProfile(descriptor.id, {
      model: settings.openai.model ?? "gpt-5.2",
      systemPrompt: typeof def.instructions === "string" ? def.instructions : "",
      allowedTools: def.tools,
      maxTurns: descriptor.maxTurns,
    });

    const agentDefinition = {
      ...def,
      model: profile.model,
      instructions: profile.systemPrompt || def.instructions,
      tools: profile.allowedTools,
    };

    const subAgentTool = createSubAgentTool({
      name: descriptor.id,
      description: descriptor.description,
      agentDefinition,
      toolRegistry,
      llmClient,
      maxTurns: profile.maxTurns ?? descriptor.maxTurns,
      compressor,
      eventBus,
    });
    toolRegistry.set(subAgentTool.name, subAgentTool);
  }

  // Build phase agents and register switch_phase tool
  const allToolNames = [...Array.from(toolRegistry.keys()), "switch_phase"];
  const phaseAgents = buildPhaseAgents(allToolNames, settings.openai.model);
  const switchPhaseTool = createSwitchPhaseTool(userBridge, phaseAgents);
  toolRegistry.set(switchPhaseTool.name, switchPhaseTool);
  const mainAgent = phaseAgents.discover;

  // Memory
  const memory = new MemoryManager(new FileMemoryStore(settings.memory.dataDir));

  // Wait-for-user-input callback (prefer externally injected)
  const waitForUserInput = options?.waitForUserInput;

  // Session runner
  const runner = new SessionRunner({
    agent: mainAgent,
    toolRegistry,
    llmClient,
    memory,
    eventBus,
    config: runtimeConfig,
    dataDir: settings.memory.dataDir,
    compressor,
    approvalGate,
    waitForUserInput,
  });

  return {
    runner,
    eventBus,
    toolRegistry,
    settings,
    async close() {
      safeCloseBridge(userBridge);
    },
  };
}

// ── Create Initial Session ────────────────────────────────────────

export function createInitialSession(): {
  sessionId: string;
  runId: string;
} {
  return {
    sessionId: randomId("session"),
    runId: randomId("run"),
  };
}

// Legacy alias
export const createInitialState = createInitialSession;
