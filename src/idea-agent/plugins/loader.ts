import type { PluginModule } from "./types";

export class PluginLoader {
  async load(moduleFactory: () => Promise<PluginModule> | PluginModule): Promise<PluginModule> {
    return moduleFactory();
  }
}
