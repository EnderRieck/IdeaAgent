import { XMLParser } from "fast-xml-parser";

export interface ArxivPaper {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  publishedDate?: string;
  pdfUrl?: string;
}

export interface ArxivSearchInput {
  keywords: string;
  categories?: string[];
  maxResults?: number;
}

export interface ArxivClientOptions {
  baseUrl?: string;
  minIntervalMs?: number;
}

type ArxivEntry = {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: Array<{ name?: string }> | { name?: string };
  category?: Array<{ term?: string }> | { term?: string };
  link?: Array<{ title?: string; href?: string }> | { title?: string; href?: string };
};

export class ArxivClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private lastRequestTs = 0;
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });

  constructor(options: ArxivClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://export.arxiv.org/api/query";
    this.minIntervalMs = Math.max(options.minIntervalMs ?? 3500, 3500);
  }

  private buildSearchQuery(keywords: string, categories?: string[]): string {
    const tokens = this.tokenizeKeywords(keywords);
    if (tokens.length === 0) {
      return `all:${keywords}`;
    }

    const termClauses = tokens.map((token) => {
      const escaped = token.includes(" ") ? `"${token}"` : token;
      return `(ti:${escaped} OR abs:${escaped})`;
    });

    let query = termClauses.length === 1
      ? termClauses[0]
      : termClauses.join(" AND ");

    if (categories && categories.length > 0) {
      const catQuery = categories.map((category) => `cat:${category}`).join(" OR ");
      query = `(${query}) AND (${catQuery})`;
    }

    return query;
  }

  private tokenizeKeywords(keywords: string): string[] {
    const tokens: string[] = [];
    const regex = /"([^"]+)"|(\S+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(keywords)) !== null) {
      const value = (match[1] ?? match[2]).trim();
      if (value.length > 0) {
        tokens.push(value);
      }
    }

    return tokens;
  }

  async search(input: ArxivSearchInput): Promise<ArxivPaper[]> {
    const query = this.buildSearchQuery(input.keywords, input.categories);

    const target = Math.max(1, Math.floor(input.maxResults ?? 10));
    const pageSize = Math.min(200, target);
    const maxPages = Math.max(1, Math.ceil(target / pageSize));

    const out: ArxivPaper[] = [];
    const seen = new Set<string>();

    for (let page = 0; page < maxPages; page += 1) {
      await this.rateLimitWait();

      const start = page * pageSize;
      const currentPageSize = Math.min(pageSize, target - out.length);

      const url = new URL(this.baseUrl);
      url.searchParams.set("search_query", query);
      url.searchParams.set("start", String(start));
      url.searchParams.set("max_results", String(currentPageSize));
      url.searchParams.set("sortBy", "relevance");

      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`arXiv search failed: ${response.status} ${response.statusText}`);
      }

      const xmlText = await response.text();
      const papers = this.parseResponse(xmlText);

      if (papers.length === 0) {
        break;
      }

      let newCount = 0;
      for (const paper of papers) {
        if (!paper.arxivId || seen.has(paper.arxivId)) {
          continue;
        }
        seen.add(paper.arxivId);
        out.push(paper);
        newCount += 1;

        if (out.length >= target) {
          return out.slice(0, target);
        }
      }

      if (papers.length < currentPageSize || newCount === 0) {
        break;
      }
    }

    return out.slice(0, target);
  }

  async getPaper(arxivId: string): Promise<ArxivPaper> {
    await this.rateLimitWait();

    const url = new URL(this.baseUrl);
    url.searchParams.set("id_list", arxivId);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`arXiv get paper failed: ${response.status} ${response.statusText}`);
    }

    const xmlText = await response.text();
    const papers = this.parseResponse(xmlText);
    if (papers.length === 0) {
      throw new Error(`Paper not found: ${arxivId}`);
    }
    return papers[0];
  }

  async searchMultipleQueries(
    queries: string[],
    resultsPerQuery: number = 5,
    maxTotal: number = 30,
  ): Promise<ArxivPaper[]> {
    const all: ArxivPaper[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      if (all.length >= maxTotal) {
        break;
      }
      try {
        const papers = await this.search({ keywords: query, maxResults: resultsPerQuery });
        for (const paper of papers) {
          if (seen.has(paper.arxivId)) {
            continue;
          }
          seen.add(paper.arxivId);
          all.push(paper);
          if (all.length >= maxTotal) {
            break;
          }
        }
      } catch {
        continue;
      }
    }

    return all;
  }

  private async rateLimitWait(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) {
      await new Promise((resolve) => setTimeout(resolve, this.minIntervalMs - elapsed));
    }
    this.lastRequestTs = Date.now();
  }

  private parseResponse(xmlText: string): ArxivPaper[] {
    const parsed = this.parser.parse(xmlText) as {
      feed?: {
        entry?: ArxivEntry[] | ArxivEntry;
      };
    };

    const entries = this.toArray(parsed.feed?.entry);
    return entries.map((entry) => {
      const id = (entry.id ?? "").split("/").pop() ?? "";
      const authors = this.toArray(entry.author).map((author) => author.name ?? "").filter(Boolean);
      const categories = this.toArray(entry.category).map((cat) => cat.term ?? "").filter(Boolean);
      const links = this.toArray(entry.link);
      const pdfLink = links.find((link) => link.title === "pdf")?.href;
      const fallbackPdf = id ? "https://arxiv.org/pdf/" + id + ".pdf" : undefined;

      return {
        arxivId: id,
        title: (entry.title ?? "").trim(),
        abstract: (entry.summary ?? "").trim(),
        authors,
        categories,
        publishedDate: entry.published,
        pdfUrl: pdfLink ?? fallbackPdf,
      };
    });
  }

  private toArray<T>(value: T | T[] | undefined): T[] {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }
}
