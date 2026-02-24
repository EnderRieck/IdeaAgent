import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pdfParse from "pdf-parse";

export interface ParseResult {
  markdown: string;
  pdfPath?: string;
  parser: "mineru" | "pdf-parse-basic";
}

export interface MineruClientOptions {
  apiUrl?: string;
}

export class MineruClient {
  private readonly apiUrl?: string;

  constructor(options: MineruClientOptions = {}) {
    this.apiUrl = options.apiUrl;
  }

  async downloadPdf(pdfUrl: string): Promise<Buffer | undefined> {
    try {
      const response = await fetch(pdfUrl, { redirect: "follow" });
      if (!response.ok) {
        return undefined;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return undefined;
    }
  }

  async parseWithStorage(pdfUrl: string, savePath: string): Promise<ParseResult> {
    const pdfContent = await this.downloadPdf(pdfUrl);
    if (!pdfContent) {
      return { markdown: "", parser: "pdf-parse-basic" };
    }

    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, pdfContent);

    if (!this.apiUrl) {
      const markdown = await this.parsePdfWithFallback(pdfContent);
      return { markdown, pdfPath: savePath, parser: "pdf-parse-basic" };
    }

    try {
      const markdown = await this.parseBufferWithMineru(pdfContent, path.basename(savePath));
      return { markdown, pdfPath: savePath, parser: "mineru" };
    } catch {
      const markdown = await this.parsePdfWithFallback(pdfContent);
      return { markdown, pdfPath: savePath, parser: "pdf-parse-basic" };
    }
  }

  async parse(pdfUrl: string): Promise<ParseResult> {
    const pdfContent = await this.downloadPdf(pdfUrl);
    if (!pdfContent) {
      return { markdown: "", parser: "pdf-parse-basic" };
    }

    if (!this.apiUrl) {
      const markdown = await this.parsePdfWithFallback(pdfContent);
      return { markdown, parser: "pdf-parse-basic" };
    }

    try {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-agent-mineru-"));
      const fileName = `paper-${Date.now()}.pdf`;
      const markdown = await this.parseBufferWithMineru(pdfContent, fileName);
      await fs.rm(tmpDir, { recursive: true, force: true });
      return { markdown, parser: "mineru" };
    } catch {
      const markdown = await this.parsePdfWithFallback(pdfContent);
      return { markdown, parser: "pdf-parse-basic" };
    }
  }

  async parseFile(filePath: string): Promise<ParseResult> {
    const buffer = await fs.readFile(filePath);
    if (!this.apiUrl) {
      return {
        markdown: await this.parsePdfWithFallback(buffer),
        pdfPath: filePath,
        parser: "pdf-parse-basic",
      };
    }

    try {
      const markdown = await this.parseBufferWithMineru(buffer, path.basename(filePath));
      return { markdown, pdfPath: filePath, parser: "mineru" };
    } catch {
      return {
        markdown: await this.parsePdfWithFallback(buffer),
        pdfPath: filePath,
        parser: "pdf-parse-basic",
      };
    }
  }

  private async parseBufferWithMineru(buffer: Buffer, fileName: string): Promise<string> {
    if (!this.apiUrl) {
      throw new Error("MinerU API URL not configured");
    }

    const bytes = new Uint8Array(buffer);
    const formData = new FormData();
    formData.append("files", new Blob([bytes], { type: "application/pdf" }), fileName);
    formData.append("return_md", "true");

    const response = await fetch(`${this.apiUrl}/file_parse`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`MinerU parse failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as unknown;
    return this.extractText(data);
  }

  private async parsePdfWithFallback(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text ?? "";
  }

  private extractText(data: unknown): string {
    if (typeof data === "string") {
      return data;
    }

    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
      const row = data[0] as { md_content?: unknown; text?: unknown };
      return String(row.md_content ?? row.text ?? "");
    }

    if (typeof data === "object" && data !== null) {
      const record = data as {
        results?: Record<string, { md_content?: unknown }>;
        md_content?: unknown;
        text?: unknown;
      };

      if (record.results) {
        for (const item of Object.values(record.results)) {
          if (item && item.md_content) {
            return String(item.md_content);
          }
        }
      }

      if (record.md_content) {
        return String(record.md_content);
      }

      if (record.text) {
        return String(record.text);
      }
    }

    return "";
  }
}
