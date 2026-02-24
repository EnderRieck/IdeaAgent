import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";
import { getIdeaAgentSettings } from "../../../config/settings";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const inputSchema = z.object({
  filePath: z.string().min(1),
  encoding: z.enum(["utf-8", "base64"]).default("utf-8").optional(),
  maxBytes: z.number().int().positive().max(MAX_FILE_SIZE).optional(),
});

export const readSessionFilesTool: NativeTool = {
  name: "read-session-files",
  description:
    "读取当前会话数据目录（session_data/<current_session_id>）中的文件内容" +
    "包括下载文件、解析后的 Markdown、笔记本等会话产物。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>, ctx) {
    const encoding = input.encoding ?? "utf-8";
    const maxBytes = input.maxBytes ?? MAX_FILE_SIZE;

    const settings = getIdeaAgentSettings();
    const dataDir = settings.memory.dataDir ?? ".idea-agent-data";
    const sessionId = (ctx.sessionId as string) ?? "default";
    const sessionDataRoot = path.resolve(process.cwd(), dataDir, "sessions", sessionId, "session_data");

    const resolved = path.resolve(input.filePath);
    const normalized = path.normalize(resolved);

    if (!normalized.startsWith(sessionDataRoot + path.sep) && normalized !== sessionDataRoot) {
      return {
        ok: false,
        value: `Error: Access denied: path must be under ${sessionDataRoot}`,
      };
    }

    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        return { ok: false, value: `Error: Not a file: ${resolved}` };
      }

      if (info.size > maxBytes) {
        return {
          ok: false,
          value: `Error: File size (${info.size} bytes) exceeds current maxBytes limit (${maxBytes}). To read this file, increase the maxBytes parameter (up to 10485760).`,
        };
      }

      const buffer = await readFile(resolved);
      const content = encoding === "base64"
        ? buffer.toString("base64")
        : buffer.toString("utf-8");

      return {
        value: JSON.stringify({
          filePath: resolved,
          size: info.size,
          encoding,
          content,
        }),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "read-session-files failed";
      return { ok: false, value: `Error: ${msg}` };
    }
  },
};
