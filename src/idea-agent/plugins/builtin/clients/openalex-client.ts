export interface OAPaper {
  openalexId: string;
  arxivId?: string;
  doi?: string;
  title: string;
  abstract?: string;
  year?: number;
  citationCount: number;
  authors: string[];
  venue?: string;
  referencedWorks: string[];
}

export interface OAReference {
  openalexId: string;
  arxivId?: string;
  title: string;
  abstract?: string;
  year?: number;
  citationCount: number;
}

export interface OACitation {
  openalexId: string;
  arxivId?: string;
  title: string;
  abstract?: string;
  year?: number;
  citationCount: number;
}

export interface OpenAlexOptions {
  baseUrl?: string;
  apiKey?: string;
  email?: string;
  maxRetries?: number;
  initialBackoffMs?: number;
  minIntervalMs?: number;
}

interface OpenAlexResponse {
  results?: Record<string, unknown>[];
  [key: string]: unknown;
}

export class OpenAlexClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly email?: string;
  private readonly maxRetries: number;
  private readonly initialBackoffMs: number;
  private readonly minIntervalMs: number;
  private lastRequestTs = 0;

  constructor(options: OpenAlexOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.openalex.org";
    this.apiKey = options.apiKey;
    this.email = options.email;
    this.maxRetries = options.maxRetries ?? 5;
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.minIntervalMs = options.minIntervalMs ?? 10;
  }

  async getPaper(arxivId: string, title?: string): Promise<OAPaper | undefined> {
    const cleanId = this.stripVersion(arxivId.replace("arxiv:", "").replace("arXiv:", ""));
    const doi = `https://doi.org/10.48550/arxiv.${cleanId}`;
    const data = await this.requestWithRetry<OpenAlexResponse>(`${this.baseUrl}/works`, {
      filter: `doi:${doi}`,
    });

    const results = (data?.results ?? []) as Record<string, unknown>[];
    if (results.length > 0) {
      return this.parsePaper(results[0]);
    }

    if (!title) {
      return undefined;
    }

    return this.searchByTitle(title);
  }

  async getPaperById(openalexId: string): Promise<OAPaper | undefined> {
    const cleanId = this.cleanOpenAlexId(openalexId);
    const data = await this.requestWithRetry<Record<string, unknown>>(`${this.baseUrl}/works/${cleanId}`);
    if (!data) {
      return undefined;
    }
    return this.parsePaper(data);
  }

  async getReferences(arxivId: string, limit: number = 50): Promise<OAReference[]> {
    const paper = await this.getPaper(arxivId);
    if (!paper || paper.referencedWorks.length === 0) {
      return [];
    }

    const refs: OAReference[] = [];
    for (const refId of paper.referencedWorks.slice(0, limit)) {
      const ref = await this.getPaperById(refId);
      if (!ref) {
        continue;
      }
      refs.push({
        openalexId: ref.openalexId,
        arxivId: ref.arxivId,
        title: ref.title,
        abstract: ref.abstract,
        year: ref.year,
        citationCount: ref.citationCount,
      });
    }
    return refs;
  }

  async getCitations(arxivId: string, limit: number = 50): Promise<OACitation[]> {
    const paper = await this.getPaper(arxivId);
    if (!paper) {
      return [];
    }

    return this.getCitationsByOaId(paper.openalexId, limit);
  }

  async batchGetPapersByIds(openalexIds: string[]): Promise<Record<string, OAPaper>> {
    const cleanIds = openalexIds.map((id) => this.cleanOpenAlexId(id));
    const batchSize = 50;
    const out: Record<string, OAPaper> = {};

    for (let index = 0; index < cleanIds.length; index += batchSize) {
      const batch = cleanIds.slice(index, index + batchSize);
      const data = await this.requestWithRetry<OpenAlexResponse>(`${this.baseUrl}/works`, {
        filter: `openalex_id:${batch.join("|")}`,
        "per-page": String(batch.length),
      });
      for (const item of (data?.results ?? []) as Record<string, unknown>[]) {
        const paper = this.parsePaper(item);
        out[paper.openalexId] = paper;
      }
    }

    return out;
  }

  async batchGetPapers(arxivIds: string[]): Promise<Record<string, OAPaper>> {
    const out: Record<string, OAPaper> = {};
    for (const arxivId of arxivIds) {
      const paper = await this.getPaper(arxivId);
      if (paper) {
        out[arxivId] = paper;
      }
    }
    return out;
  }

  async searchPapers(
    keywords: string,
    minCitations: number = 10,
    minYear: number = 2018,
    maxResults: number = 50,
    sortBy: string = "cited_by_count:desc",
  ): Promise<OAPaper[]> {
    const filters: string[] = [];
    if (minCitations > 0) {
      filters.push(`cited_by_count:>${minCitations}`);
    }
    if (minYear) {
      filters.push(`publication_year:>${minYear - 1}`);
    }

    const target = Math.max(1, Math.floor(maxResults));
    const perPage = Math.min(target, 200);
    const maxPages = Math.max(1, Math.ceil(target / perPage));

    const papers: OAPaper[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page += 1) {
      const data = await this.requestWithRetry<OpenAlexResponse>(`${this.baseUrl}/works`, {
        search: keywords,
        filter: filters.join(","),
        sort: sortBy,
        "per-page": String(perPage),
        page: String(page),
      });

      const rows = ((data?.results ?? []) as Record<string, unknown>[]).map((item) => this.parsePaper(item));
      if (rows.length === 0) {
        break;
      }

      for (const paper of rows) {
        if (seen.has(paper.openalexId)) {
          continue;
        }
        seen.add(paper.openalexId);
        papers.push(paper);
        if (papers.length >= target) {
          return papers.slice(0, target);
        }
      }

      if (rows.length < perPage) {
        break;
      }
    }

    return papers.slice(0, target);
  }

  async searchPapersMultiQuery(
    queries: string[],
    minCitations: number = 10,
    minYear: number = 2018,
    resultsPerQuery: number = 20,
    maxTotal: number = 100,
  ): Promise<OAPaper[]> {
    const all: OAPaper[] = [];
    const seen = new Set<string>();

    for (const query of queries) {
      if (all.length >= maxTotal) {
        break;
      }

      const papers = await this.searchPapers(query, minCitations, minYear, resultsPerQuery);
      for (const paper of papers) {
        if (seen.has(paper.openalexId)) {
          continue;
        }
        seen.add(paper.openalexId);
        all.push(paper);
        if (all.length >= maxTotal) {
          break;
        }
      }
    }

    return all;
  }

  async getCitationsByOaId(openalexId: string, limit: number = 50, minYear?: number): Promise<OACitation[]> {
    let filter = `cites:${this.cleanOpenAlexId(openalexId)}`;
    if (minYear) {
      filter += `,publication_year:>${minYear - 1}`;
    }

    const target = Math.max(1, Math.floor(limit));
    const perPage = Math.min(target, 200);
    const maxPages = Math.max(1, Math.ceil(target / perPage));

    const citations: OACitation[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page += 1) {
      const data = await this.requestWithRetry<OpenAlexResponse>(`${this.baseUrl}/works`, {
        filter,
        "per-page": String(perPage),
        page: String(page),
        sort: "cited_by_count:desc",
      });

      const items = (data?.results ?? []) as Record<string, unknown>[];
      if (items.length === 0) {
        break;
      }

      const parsed = this.parseCitations(items);
      for (const citation of parsed) {
        if (seen.has(citation.openalexId)) {
          continue;
        }
        seen.add(citation.openalexId);
        citations.push(citation);
        if (citations.length >= target) {
          return citations.slice(0, target);
        }
      }

      if (items.length < perPage) {
        break;
      }
    }

    return citations.slice(0, target);
  }

  async expandCitationNetwork(
    seedPapers: OAPaper[],
    maxRefsPerPaper: number = 10,
    maxCitationsPerPaper: number = 5,
    minCitationCount: number = 5,
  ): Promise<{ papers: OAPaper[]; edges: Array<[string, string, "cites"]> }> {
    const expanded = new Map<string, OAPaper>(seedPapers.map((paper) => [paper.openalexId, paper]));
    const edges: Array<[string, string, "cites"]> = [];

    const allRefIds = new Set<string>();
    const paperRefs = new Map<string, string[]>();

    for (const paper of seedPapers) {
      const refs = paper.referencedWorks.slice(0, maxRefsPerPaper);
      paperRefs.set(paper.openalexId, refs);
      refs.forEach((refId) => allRefIds.add(refId));
    }

    const refPapers = await this.batchGetPapersByIds([...allRefIds]);
    for (const [paperId, refs] of paperRefs.entries()) {
      for (const refId of refs) {
        const refPaper = refPapers[this.cleanOpenAlexId(refId)] ?? refPapers[refId];
        if (!refPaper) {
          continue;
        }
        edges.push([paperId, refPaper.openalexId, "cites"]);
        if (refPaper.citationCount >= minCitationCount && !expanded.has(refPaper.openalexId)) {
          expanded.set(refPaper.openalexId, refPaper);
        }
      }
    }

    let citationCount = 0;
    for (const paper of seedPapers.slice(0, 20)) {
      if (citationCount >= 100) {
        break;
      }

      const citations = await this.getCitationsByOaId(paper.openalexId, maxCitationsPerPaper, 2020);
      for (const citation of citations) {
        if (citation.citationCount < minCitationCount) {
          continue;
        }

        edges.push([citation.openalexId, paper.openalexId, "cites"]);
        citationCount += 1;

        if (!expanded.has(citation.openalexId)) {
          const full = await this.getPaperById(citation.openalexId);
          if (full) {
            expanded.set(full.openalexId, full);
          }
        }
      }
    }

    return {
      papers: [...expanded.values()],
      edges,
    };
  }

  private async searchByTitle(title: string): Promise<OAPaper | undefined> {
    const data = await this.requestWithRetry<OpenAlexResponse>(`${this.baseUrl}/works`, {
      search: title.slice(0, 100).trim(),
      "per-page": "3",
    });

    const results = (data?.results ?? []) as Record<string, unknown>[];
    if (results.length === 0) {
      return undefined;
    }

    const best = results[0];
    const resultTitle = String(best.title ?? "").toLowerCase();
    const queryTitle = title.toLowerCase();
    if (resultTitle.slice(0, 30) !== queryTitle.slice(0, 30)) {
      return undefined;
    }

    return this.parsePaper(best);
  }

  private parsePaper(data: Record<string, unknown>): OAPaper {
    const ids = (data.ids ?? {}) as Record<string, unknown>;
    const openalexId = String(data.id ?? "");

    let arxivId: string | undefined;
    const arxiv = ids.arxiv;
    if (typeof arxiv === "string" && arxiv.length > 0) {
      arxivId = arxiv.replace("https://arxiv.org/abs/", "");
    }

    if (!arxivId && typeof ids.doi === "string" && ids.doi.includes("10.48550/arxiv.")) {
      arxivId = ids.doi.split("10.48550/arxiv.").pop();
    }

    const authorships = (data.authorships ?? []) as Array<{ author?: { display_name?: string } }>;
    const authors = authorships
      .map((authorship) => authorship.author?.display_name ?? "")
      .filter((author) => author.length > 0);

    const abstractIndex = data.abstract_inverted_index as Record<string, number[]> | undefined;
    const abstract = abstractIndex ? this.reconstructAbstract(abstractIndex) : undefined;

    const primaryLocation = data.primary_location as { source?: { display_name?: string } } | undefined;
    const venue = primaryLocation?.source?.display_name;

    const referencedWorks = ((data.referenced_works ?? []) as unknown[])
      .map((value) => String(value))
      .filter((value) => value.length > 0);

    return {
      openalexId,
      arxivId,
      doi: typeof data.doi === "string" ? data.doi : undefined,
      title: String(data.title ?? ""),
      abstract,
      year: typeof data.publication_year === "number" ? data.publication_year : undefined,
      citationCount: typeof data.cited_by_count === "number" ? data.cited_by_count : 0,
      authors,
      venue,
      referencedWorks,
    };
  }

  private parseCitations(data: Record<string, unknown>[]): OACitation[] {
    return data.map((item) => {
      const ids = (item.ids ?? {}) as Record<string, unknown>;
      const arxiv = typeof ids.arxiv === "string" ? ids.arxiv.replace("https://arxiv.org/abs/", "") : undefined;
      return {
        openalexId: String(item.id ?? ""),
        arxivId: arxiv,
        title: String(item.title ?? ""),
        abstract: undefined,
        year: typeof item.publication_year === "number" ? item.publication_year : undefined,
        citationCount: typeof item.cited_by_count === "number" ? item.cited_by_count : 0,
      };
    });
  }

  private reconstructAbstract(invertedIndex: Record<string, number[]>): string {
    const positionWord = new Map<number, string>();
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) {
        positionWord.set(pos, word);
      }
    }

    const maxPos = Math.max(...positionWord.keys(), 0);
    const words: string[] = [];
    for (let index = 0; index <= maxPos; index += 1) {
      words.push(positionWord.get(index) ?? "");
    }
    return words.join(" ").trim();
  }

  private stripVersion(arxivId: string): string {
    return arxivId.replace(/v\d+$/, "");
  }

  private cleanOpenAlexId(openalexId: string): string {
    return openalexId.replace("https://openalex.org/", "");
  }

  private async requestWithRetry<T extends object>(
    url: string,
    params?: Record<string, string>,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      try {
        await this.rateLimit();

        const query = new URLSearchParams({
          ...(params ?? {}),
          ...this.getAuthParams(),
        });

        const response = await fetch(`${url}?${query.toString()}`);

        if (response.status === 200) {
          return (await response.json()) as T;
        }

        if (response.status === 404) {
          return undefined;
        }

        if (response.status === 403 || response.status >= 500) {
          await this.sleep(this.initialBackoffMs * 2 ** attempt);
          continue;
        }

        return undefined;
      } catch {
        if (attempt === this.maxRetries - 1) {
          return undefined;
        }
        await this.sleep(this.initialBackoffMs * 2 ** attempt);
      }
    }

    return undefined;
  }

  private getAuthParams(): Record<string, string> {
    if (this.apiKey) {
      return { api_key: this.apiKey };
    }
    if (this.email) {
      return { mailto: this.email };
    }
    return {};
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTs;
    if (elapsed < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTs = Date.now();
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
