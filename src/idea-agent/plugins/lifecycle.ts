export type PluginLifecycleStage =
  | "discover"
  | "validate"
  | "load"
  | "register"
  | "activate"
  | "invoke"
  | "deactivate"
  | "unload";
