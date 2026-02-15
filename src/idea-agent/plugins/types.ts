import type { SubAgent } from "../capabilities/subagents/types";
import type { Tool } from "../capabilities/tools/types";

export interface PluginContext {
  env: Record<string, string | undefined>;
  nowISO(): string;
}

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  capabilities: {
    tools?: string[];
    subagents?: string[];
  };
}

export interface PluginModule {
  manifest: PluginManifest;
  tools?: Tool[];
  subAgents?: SubAgent[];
  onLoad?(ctx: PluginContext): Promise<void>;
  onRegister?(ctx: PluginContext): Promise<void>;
  onActivate?(ctx: PluginContext): Promise<void>;
  onDeactivate?(ctx: PluginContext): Promise<void>;
  onUnload?(ctx: PluginContext): Promise<void>;
}
