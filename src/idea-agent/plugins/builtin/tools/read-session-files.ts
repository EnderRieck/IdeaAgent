import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../../../capabilities/tools/types";
import { getIdeaAgentSettings } from "../../../config/settings";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const inputSchema = z.object({
  filePath: z.string().min(1),
  encoding: z.enum(["utf-8", "base64"]).default("utf-8").optional(),
  maxBytes: z.number().int().positive().max(MAX_FILE_SIZE).optional(),
});

export const readSessionFilesTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "read-session-files",
  description:
    "Read a file from the current session's data directory (session_data/). " +
    "Covers downloads, parsed-markdown, notebooks and other session artifacts. " +
    "Use this to read downloaded PDFs, parsed results, notebooks, etc.",
  inputFields: [
    { name: "filePath", type: "string", required: true, description: "Absolute path to the session data file" },
    { name: "encoding", type: "string", required: false, description: "utf-8 (default) or base64" },
    { name: "maxBytes", type: "number", required: false, description: "Max bytes to read, default 10MB" },
  ],
  inputSchema,
  async execute(input, ctx) {
    const encoding = input.encoding ?? "utf-8";
    const maxBytes = input.maxBytes ?? MAX_FILE_SIZE;

    const settings = getIdeaAgentSettings();
    const dataDir = settings.memory.dataDir ?? ".idea-agent-data";
    const sessionDataRoot = path.resolve(process.cwd(), dataDir, "sessions", ctx.sessionId, "session_data");

    const resolved = path.resolve(input.filePath);
    const normalized = path.normalize(resolved);

    if (!normalized.startsWith(sessionDataRoot + path.sep) && normalized !== sessionDataRoot) {
      return {
        ok: false,
        error: `Access denied: path must be under ${sessionDataRoot}`,
      };
    }

    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        return { ok: false, error: `Not a file: ${resolved}` };
      }

      if (info.size > maxBytes) {
        return {
          ok: false,
          error: `File size (${info.size} bytes) exceeds current maxBytes limit (${maxBytes}). To read this file, increase the maxBytes parameter (up to 10485760).`,
        };
      }

      const buffer = await readFile(resolved);
      const content = encoding === "base64"
        ? buffer.toString("base64")
        : buffer.toString("utf-8");

      return {
        ok: true,
        data: {
          filePath: resolved,
          size: info.size,
          encoding,
          content,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "read-session-files failed";
      return { ok: false, error: msg };
    }
  },
};
