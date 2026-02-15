import { z } from "zod";

export const pluginManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.object({
    tools: z.array(z.string()).optional(),
    subagents: z.array(z.string()).optional(),
  }),
});
