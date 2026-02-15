import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { Tool } from "../../../capabilities/tools/types";
import { getIdeaAgentSettings } from "../../../config/settings";

const inputSchema = z.object({
  url: z.string().url(),
  mode: z.enum(["auto", "text", "html", "json", "download"]).default("auto").optional(),
  maxChars: z.number().int().positive().max(300_000).default(20_000).optional(),
  timeoutSeconds: z.number().int().positive().max(180).default(30).optional(),
  savePath: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
});

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number(code);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : _;
    });
}

function stripHtml(text: string): string {
  return decodeHtmlEntities(text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return undefined;
  }

  const title = stripHtml(match[1]);
  return title.length > 0 ? title : undefined;
}

function htmlToMarkdown(html: string, url: string): { markdown: string; title?: string } | undefined {
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const reader = new Readability(doc.cloneNode(true) as Document);
    const article = reader.parse();
    if (!article || !article.content || article.content.trim().length === 0) {
      return undefined;
    }

    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    turndown.remove(["script", "style", "nav", "footer", "iframe"]);

    const markdown = turndown.turndown(article.content).trim();
    if (markdown.length === 0) {
      return undefined;
    }

    const title = (article.title ?? "").trim() || undefined;
    return { markdown, title };
  } catch {
    return undefined;
  }
}

function truncateText(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { content: text, truncated: false };
  }

  return {
    content: `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-").trim();
  return cleaned.length > 0 ? cleaned : `download-${Date.now()}`;
}

function extensionFromContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes("application/pdf")) {
    return ".pdf";
  }
  if (lower.includes("application/json")) {
    return ".json";
  }
  if (lower.includes("text/html")) {
    return ".html";
  }
  if (lower.includes("text/plain")) {
    return ".txt";
  }
  return "";
}

function inferNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (segment && segment.trim().length > 0) {
      return segment;
    }
  } catch {
    return `download-${Date.now()}`;
  }

  return `download-${Date.now()}`;
}

function resolveDownloadPath(params: {
  url: string;
  storageDir: string;
  contentType: string;
  savePath?: string;
  fileName?: string;
}): string {
  const ext = extensionFromContentType(params.contentType);

  if (params.savePath) {
    if (path.isAbsolute(params.savePath)) {
      return params.savePath;
    }
    return path.resolve(params.storageDir, params.savePath);
  }

  const baseName = sanitizeFileName(params.fileName ?? inferNameFromUrl(params.url));
  const hasExt = path.extname(baseName).length > 0;
  const finalName = hasExt ? baseName : `${baseName}${ext || ".bin"}`;

  return path.resolve(params.storageDir, finalName);
}

function shouldDownload(params: {
  mode: z.infer<typeof inputSchema>["mode"];
  contentType: string;
  url: string;
}): boolean {
  if (params.mode === "download") {
    return true;
  }

  const lowerType = params.contentType.toLowerCase();
  if (lowerType.includes("application/pdf") || lowerType.includes("application/octet-stream")) {
    return true;
  }

  return /\.pdf($|\?)/i.test(params.url);
}

export const webFetchTool: Tool<z.infer<typeof inputSchema>, unknown> = {
  id: "web-fetch",
  description:
    "Fetch webpage/file content from URL. Supports downloading files to local storage directory for downstream tools (e.g., mineru-parse with filePath).",
  inputHint:
    '{"url":"https://example.com","mode":"text"} | {"url":"https://arxiv.org/pdf/2401.12345.pdf","mode":"download","fileName":"paper.pdf"}',
  inputSchema,
  async execute(input, ctx) {
    try {
      const settings = getIdeaAgentSettings();
      const timeoutMs = (input.timeoutSeconds ?? 30) * 1000;
      const maxChars = input.maxChars ?? 20_000;
      const dataDir = settings.memory.dataDir ?? ".idea-agent-data";
      const storageDir = path.resolve(process.cwd(), dataDir, "sessions", ctx.sessionId, "session_data", "downloads");

      const response = await fetchWithTimeout(
        input.url,
        {
          method: "GET",
          headers: {
            "User-Agent": "IdeaAgent-WebFetch/1.0",
            Accept: "*/*",
          },
          redirect: "follow",
        },
        timeoutMs,
      );

      if (!response.ok) {
        return {
          ok: false,
          error: `web-fetch failed: ${response.status} ${response.statusText}`,
        };
      }

      const finalUrl = response.url || input.url;
      const contentType = response.headers.get("content-type") ?? "application/octet-stream";

      if (shouldDownload({ mode: input.mode, contentType, url: finalUrl })) {
        const bytes = Buffer.from(await response.arrayBuffer());
        const filePath = resolveDownloadPath({
          url: finalUrl,
          storageDir,
          contentType,
          savePath: input.savePath,
          fileName: input.fileName,
        });

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, bytes);

        return {
          ok: true,
          data: {
            mode: "download",
            url: input.url,
            finalUrl,
            status: response.status,
            contentType,
            bytes: bytes.length,
            filePath,
            storageDir,
          },
        };
      }

      const text = await response.text();
      const lowerType = contentType.toLowerCase();

      if (input.mode === "json" || (input.mode === "auto" && lowerType.includes("application/json"))) {
        try {
          const parsed = JSON.parse(text) as unknown;
          const serialized = JSON.stringify(parsed, null, 2);
          const truncated = truncateText(serialized, maxChars);
          return {
            ok: true,
            data: {
              mode: "json",
              url: input.url,
              finalUrl,
              status: response.status,
              contentType,
              content: truncated.content,
              truncated: truncated.truncated,
              storageDir,
            },
          };
        } catch {
          const truncated = truncateText(text, maxChars);
          return {
            ok: true,
            data: {
              mode: "text",
              url: input.url,
              finalUrl,
              status: response.status,
              contentType,
              content: truncated.content,
              truncated: truncated.truncated,
              storageDir,
            },
          };
        }
      }

      if (input.mode === "html") {
        const truncated = truncateText(text, maxChars);
        return {
          ok: true,
          data: {
            mode: "html",
            url: input.url,
            finalUrl,
            status: response.status,
            contentType,
            title: extractTitle(text),
            content: truncated.content,
            truncated: truncated.truncated,
            storageDir,
          },
        };
      }

      if (lowerType.includes("text/html")) {
        const mdResult = htmlToMarkdown(text, finalUrl);
        if (mdResult) {
          const truncated = truncateText(mdResult.markdown, maxChars);
          return {
            ok: true,
            data: {
              mode: "markdown",
              url: input.url,
              finalUrl,
              status: response.status,
              contentType,
              title: mdResult.title ?? extractTitle(text),
              content: truncated.content,
              truncated: truncated.truncated,
              storageDir,
            },
          };
        }

        // fallback: readability failed, use stripHtml
        const fallbackText = stripHtml(text);
        const truncated = truncateText(fallbackText, maxChars);
        return {
          ok: true,
          data: {
            mode: "text",
            url: input.url,
            finalUrl,
            status: response.status,
            contentType,
            title: extractTitle(text),
            content: truncated.content,
            truncated: truncated.truncated,
            readabilityFailed: true,
            storageDir,
          },
        };
      }

      const truncated = truncateText(text, maxChars);
      return {
        ok: true,
        data: {
          mode: "text",
          url: input.url,
          finalUrl,
          status: response.status,
          contentType,
          content: truncated.content,
          truncated: truncated.truncated,
          storageDir,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "web-fetch failed",
      };
    }
  },
};
