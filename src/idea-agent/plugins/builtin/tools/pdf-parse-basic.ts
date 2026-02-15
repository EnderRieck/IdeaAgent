import fs from "node:fs/promises";
import pdfParse from "pdf-parse";
import { z } from "zod";
import type { Tool } from "../../../capabilities/tools/types";

const inputSchema = z.object({
  pdfUrl: z.string().url().optional(),
  filePath: z.string().min(1).optional(),
});

export const pdfParseBasicTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "pdf-parse-basic",
  description: "Basic PDF text extraction fallback parser.",
  inputSchema,
  async execute(input) {
    try {
      let buffer: Buffer;
      if (input.filePath) {
        buffer = await fs.readFile(input.filePath);
      } else if (input.pdfUrl) {
        const response = await fetch(input.pdfUrl);
        if (!response.ok) {
          return { ok: false, error: `Download failed: ${response.status} ${response.statusText}` };
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        return { ok: false, error: "Either pdfUrl or filePath must be provided." };
      }

      const parsed = await pdfParse(buffer);
      return {
        ok: true,
        data: {
          text: parsed.text,
          length: parsed.text.length,
          parser: "pdf-parse-basic",
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "PDF parse failed" };
    }
  },
};
