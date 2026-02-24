import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MineruClient } from "../clients/mineru-client";
import type { NativeTool } from "../../../core/native-tool";
import { getIdeaAgentSettings } from "../../../config/settings";
import { getToolExtraConfigs } from "../../../config/tool-config";

function readExtraString(extra: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = extra[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

const inputSchema = z.object({
  pdfUrl: z.string().url().optional(),
  filePath: z.string().min(1).optional(),
  mineruApiUrl: z.string().url().optional(),
  savePath: z.string().optional(),
  outputMarkdownFileName: z.string().min(1).optional(),
});

function deriveMarkdownFileName(input: { filePath?: string; pdfUrl?: string; outputMarkdownFileName?: string }): string {
  if (input.outputMarkdownFileName) {
    const name = path.basename(input.outputMarkdownFileName);
    return name.endsWith(".md") ? name : `${name}.md`;
  }

  const source = input.filePath ?? input.pdfUrl ?? "parsed";
  const base = path.basename(source).replace(/\.pdf$/i, "");
  return base.length > 0 ? `${base}.md` : "parsed.md";
}

function resolveMarkdownDir(dataDir: string, sessionId: string): string {
  return path.resolve(process.cwd(), dataDir, "sessions", sessionId, "session_data", "parsed-markdown");
}

export const mineruParseTool: NativeTool = {
  name: "mineru-parse",
  description: "通过 MinerU 本地 API 解析 PDF，失败时自动回退到基础解析器。不可以解析其他类型的文件，如html等",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>, ctx) {
    try {
      const settings = getIdeaAgentSettings();
      const extra = getToolExtraConfigs("mineru-parse");
      const extraApiUrl = readExtraString(extra, ["apiUrl", "api_url", "mineruApiUrl", "mineru_api_url"]);
      const client = new MineruClient({
        apiUrl: input.mineruApiUrl ?? extraApiUrl ?? settings.mineru.apiUrl,
      });

      const data = await (async () => {
        if (input.filePath) {
          return client.parseFile(input.filePath);
        }

        if (!input.pdfUrl) {
          throw new Error("Either pdfUrl or filePath must be provided.");
        }

        if (input.savePath) {
          return client.parseWithStorage(input.pdfUrl, input.savePath);
        }

        return client.parse(input.pdfUrl);
      })();

      const sessionId = (ctx.sessionId as string) ?? "default";
      const markdownDir = resolveMarkdownDir(
        settings.memory.dataDir ?? ".idea-agent-data",
        sessionId,
      );
      const fileName = deriveMarkdownFileName(input);
      const markdownPath = path.resolve(markdownDir, fileName);
      await fs.mkdir(markdownDir, { recursive: true });
      await fs.writeFile(markdownPath, data.markdown ?? "", "utf-8");

      return {
        value: JSON.stringify({
          ...data,
          markdownPath,
        }),
      };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "MinerU parse failed"}` };
    }
  },
};
