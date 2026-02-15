import { pluginManifestSchema } from "./manifest";
import type { PluginContext, PluginModule } from "./types";
import type { ToolRegistry } from "../capabilities/tools/registry";
import type { SubAgentRegistry } from "../capabilities/subagents/registry";

export class PluginManager {
  private readonly plugins = new Map<string, PluginModule>();

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly subAgentRegistry: SubAgentRegistry,
    private readonly ctx: PluginContext,
  ) {}

  async register(plugin: PluginModule): Promise<void> {
    pluginManifestSchema.parse(plugin.manifest);

    await plugin.onLoad?.(this.ctx);
    await plugin.onRegister?.(this.ctx);

    for (const tool of plugin.tools ?? []) {
      this.toolRegistry.register(tool);
    }

    for (const subAgent of plugin.subAgents ?? []) {
      this.subAgentRegistry.register(subAgent);
    }

    await plugin.onActivate?.(this.ctx);
    this.plugins.set(plugin.manifest.id, plugin);
  }

  async unregister(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      return;
    }

    await plugin.onDeactivate?.(this.ctx);

    for (const toolId of plugin.manifest.capabilities.tools ?? []) {
      this.toolRegistry.unregister(toolId);
    }

    for (const subId of plugin.manifest.capabilities.subagents ?? []) {
      this.subAgentRegistry.unregister(subId);
    }

    await plugin.onUnload?.(this.ctx);
    this.plugins.delete(pluginId);
  }

  list(): PluginModule[] {
    return [...this.plugins.values()];
  }
}
