import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";

const inputSchema = z.object({
  pdfUrl: z.string().url().optional(),
  filePath: z.string().min(1).optional(),
});

export const pdfParseBasicTool: NativeTool = {
  name: "pdf-parse-basic",
  description: "基础 PDF 文本提取备用解析器。",
  inputSchema,
  async execute(input: z.infer<typeof inputSchema>) {
    try {
      let buffer: Buffer;
      if (input.filePath) {
        buffer = await fs.readFile(input.filePath);
      } else if (input.pdfUrl) {
        const response = await fetch(input.pdfUrl);
        if (!response.ok) {
          return { ok: false, value: `Error: Download failed: ${response.status} ${response.statusText}` };
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        return { ok: false, value: "Error: Either pdfUrl or filePath must be provided." };
      }

      const parsed = await pdfParse(buffer);
      return {
        value: JSON.stringify({
          text: parsed.text,
          length: parsed.text.length,
          parser: "pdf-parse-basic",
        }),
      };
    } catch (error) {
      return { ok: false, value: `Error: ${error instanceof Error ? error.message : "PDF parse failed"}` };
    }
  },
};
