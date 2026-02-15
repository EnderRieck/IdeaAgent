import path from "node:path";
import { setupGlobalProxy } from "./runtime/proxy-setup";
import { EventBus } from "./core/event-bus";
import { LLMMainAgent } from "./core/llm-main-agent";
import type { MainAgent } from "./core/decision";
import { AgentKernel } from "./core/kernel";
import { LLMContextCompactor, PassthroughContextCompactor } from "./core/context-compactor";
import { ToolRegistry } from "./capabilities/tools/registry";
import type { Tool, ToolInputFieldSpec } from "./capabilities/tools/types";
import { SubAgentRegistry } from "./capabilities/subagents/registry";
import {
  SEARCH_TOOL_PROFILES,
  appendResultLevelHint,
  buildResultLevelCounts,
  resolveBaseResults,
} from "./capabilities/tools/search-result-level";
import { ToolInvoker } from "./capabilities/tools/invoker";
import type { ToolPolicy } from "./capabilities/tools/policy";
import { SubAgentInvoker } from "./capabilities/subagents/invoker";
import { InteractiveApprovalGate, RejectingApprovalGate } from "./runtime/approval-gate";
import { AutoUserBridge, type UserBridge, InteractiveUserBridge } from "./runtime/user-bridge";
import { MemoryManager } from "./memory/manager";
import { FileMemoryStore } from "./memory/store";
import { SessionRunner } from "./runtime/session-runner";
import { resolveRuntimeConfig } from "./runtime/config";
import { PluginManager } from "./plugins/manager";
import { builtinPlugin } from "./plugins/builtin/plugin";
import type { LoopState } from "./core/types";
import { getIdeaAgentSettings, type IdeaAgentSettings } from "./config/settings";
import { getToolRuntimeProfile } from "./config/tool-config";

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
    constraintsMaxChars?: number;
    dialogueMaxChars?: number;
    recallQueryMaxChars?: number;
    recentDialogueMaxChars?: number;
    historyMessagesMaxChars?: number;
  };
}

export interface IdeaAgentRuntime {
  runner: SessionRunner;
  eventBus: EventBus;
  toolRegistry: ToolRegistry;
  subAgentRegistry: SubAgentRegistry;
  pluginManager: PluginManager;
  settings: IdeaAgentSettings;
  close(): Promise<void>;
}

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function resolveMainAgent(
  settings: IdeaAgentSettings,
  capabilities: {
    tools: Array<{ id: string; description: string; inputHint?: string; inputFields?: ToolInputFieldSpec[]; outputFormat?: string }>;
    subAgents: Array<{ id: string; description: string }>;
  },
  contextCompactor: LLMContextCompactor | PassthroughContextCompactor,
): MainAgent {
  const openai = settings.openai;
  const apiKey = openai.apiKey;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. IdeaAgent is LLM-only and cannot run without model credentials.");
  }

  return new LLMMainAgent({
    apiKey,
    baseUrl: openai.baseUrl,
    model: openai.model,
    temperature: openai.temperature,
    maxTokens: openai.maxTokens,
    systemPrompt: openai.systemPrompt,
    tools: capabilities.tools,
    subAgents: capabilities.subAgents,
    contextCompactor,
    recentDialogueMaxChars: settings.contextCompact.recentDialogueMaxChars,
    historyMessagesMaxChars: settings.contextCompact.historyMessagesMaxChars,
    debugPrompts: settings.runtime.debugPrompts === true,
  });
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

function buildToolInputHint(
  tool: { id: string; inputHint?: string },
  settings: IdeaAgentSettings,
): string | undefined {
  switch (tool.id) {
    case "web-search": {
      const profile = SEARCH_TOOL_PROFILES.web;
      const base = resolveBaseResults(settings.web.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(tool.inputHint, counts);
    }

    case "arxiv-search": {
      const profile = SEARCH_TOOL_PROFILES.arxiv;
      const base = resolveBaseResults(settings.arxiv.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(tool.inputHint, counts);
    }

    case "openalex-search": {
      const profile = SEARCH_TOOL_PROFILES.openalex;
      const base = resolveBaseResults(settings.openalex.maxResults, profile.defaultBaseResults, profile.maxResults);
      const counts = buildResultLevelCounts(base, profile.maxResults);
      return appendResultLevelHint(tool.inputHint, counts);
    }

    case "web-fetch": {
      const dataDir = settings.memory.dataDir ?? ".idea-agent-data";
      const baseHint = tool.inputHint?.trim() ?? "{}";
      return `${baseHint}; storageBaseDir=${dataDir}/sessions/<sessionId>/session_data/downloads; 下载PDF后将返回filePath传给mineru-parse.filePath`;
    }

    default:
      return tool.inputHint;
  }
}

function resolveToolCapability(tool: Tool, settings: IdeaAgentSettings): {
  id: string;
  description: string;
  inputHint?: string;
  inputFields?: ToolInputFieldSpec[];
  outputFormat?: string;
} {
  const profile = getToolRuntimeProfile(tool.id, {
    description: tool.description,
    inputHint: tool.inputHint,
    inputFields: tool.inputFields,
    outputFormat: tool.outputFormat,
  });

  return {
    id: tool.id,
    description: profile.description,
    inputHint: buildToolInputHint({ id: tool.id, inputHint: profile.inputHint }, settings),
    inputFields: profile.inputFields,
    outputFormat: profile.outputFormat,
  };
}

export async function createIdeaAgentRuntime(options?: CreateRuntimeOptions): Promise<IdeaAgentRuntime> {
  setupGlobalProxy();

  if (options?.configPath) {
    process.env.IDEA_AGENT_CONFIG_PATH = options.configPath;
  }

  const settings = resolveSettings(options);
  const runtimeConfig = resolveRuntimeConfig(settings.runtime);

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const subAgentRegistry = new SubAgentRegistry();

  const pluginManager = new PluginManager(toolRegistry, subAgentRegistry, {
    env: process.env,
    nowISO: () => new Date().toISOString(),
  });
  await pluginManager.register(builtinPlugin);

  const userBridge: UserBridge = settings.runtime.interactive ? new InteractiveUserBridge() : new AutoUserBridge();
  const sensitiveTools = new Set<string>(["local-cli"]);

  const approvalGate = settings.runtime.interactive || settings.runtime.autoApproveSensitiveTools
    ? new InteractiveApprovalGate(userBridge, sensitiveTools, settings.runtime.autoApproveSensitiveTools === true)
    : new RejectingApprovalGate(sensitiveTools);

  // Collect per-tool timeout overrides from tools.config.json
  const policyOverrides: Record<string, Partial<ToolPolicy>> = {};
  for (const tool of toolRegistry.list()) {
    const profile = getToolRuntimeProfile(tool.id, {
      description: tool.description,
      inputHint: tool.inputHint,
      inputFields: tool.inputFields,
      outputFormat: tool.outputFormat,
    });
    if (typeof profile.timeoutMs === "number") {
      policyOverrides[tool.id] = { timeoutMs: profile.timeoutMs };
    }
  }

  const toolInvoker = new ToolInvoker(
    toolRegistry,
    approvalGate,
    { timeoutMs: runtimeConfig.toolDefaultTimeoutMs },
    undefined,
    Object.keys(policyOverrides).length > 0 ? policyOverrides : undefined,
  );

  const contextCompactor = settings.contextCompact.enabled === false
    ? new PassthroughContextCompactor()
    : new LLMContextCompactor({
        apiKey: settings.openai.apiKey ?? "",
        baseUrl: settings.contextCompact.baseUrl ?? settings.openai.baseUrl,
        model: settings.contextCompact.model ?? settings.openai.model,
        temperature: settings.contextCompact.temperature,
        maxTokens: settings.contextCompact.maxTokens,
      });

  const capabilities = {
    tools: toolRegistry.list().map((tool) => resolveToolCapability(tool, settings)),
    subAgents: subAgentRegistry.list().map((subAgent) => ({ id: subAgent.id, description: subAgent.description })),
  };

  const kernel = new AgentKernel({
    mainAgent: resolveMainAgent(settings, capabilities, contextCompactor),
    toolInvoker,
    subAgentInvoker: new SubAgentInvoker(subAgentRegistry, {
      onProgress: async (event) => {
        await eventBus.emit({
          name: "subagent.progress",
          payload: {
            subAgentId: event.subAgentId,
            stage: event.stage,
            payload: event.payload,
          },
          at: new Date().toISOString(),
          runId: event.runId,
          sessionId: event.sessionId,
          turn: event.turn,
        });
      },
      onError: async (event) => {
        await eventBus.emit({
          name: "error.detail",
          payload: {
            ...event.detail,
            subAgentId: event.subAgentId,
          },
          at: new Date().toISOString(),
          runId: event.runId,
          sessionId: event.sessionId,
          turn: event.turn,
        });
      },
    }, toolInvoker),
    userBridge,
    contextCompactor,
    constraintsMaxChars: settings.contextCompact.constraintsMaxChars ?? 12_000,
    dialogueMaxChars: settings.contextCompact.dialogueMaxChars ?? 16_000,
    nowISO: () => new Date().toISOString(),
  });

  const memory = new MemoryManager(new FileMemoryStore(settings.memory.dataDir));

  const runner = new SessionRunner({
    kernel,
    memory,
    eventBus,
    config: runtimeConfig,
    contextCompactor,
    recallQueryMaxChars: settings.contextCompact.recallQueryMaxChars ?? 6_000,
    nowISO: () => new Date().toISOString(),
  });

  return {
    runner,
    eventBus,
    toolRegistry,
    subAgentRegistry,
    pluginManager,
    settings,
    async close() {
      safeCloseBridge(userBridge);
    },
  };
}

export function createInitialState(goal?: string): LoopState {
  return {
    sessionId: randomId("session"),
    runId: randomId("run"),
    turn: 1,
    status: "init",
    goal,
    toolResults: [],
    subAgentResults: [],
    memorySnapshot: {},
    evidenceRefs: [],
  };
}
