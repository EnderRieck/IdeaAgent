import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NativeTool } from "../../../core/native-tool";
import type { ContextVariables, ToolExecutionResult } from "../../../core/context-variables";
import { getIdeaAgentSettings } from "../../../config/settings";

// ── Data Structures ──

interface SearchRecord {
  toolId: string;
  query: string;
  turn: number;
  ok: boolean;
}

interface ResearchQuestion {
  id: number;
  question: string;
  status: "pending" | "investigating" | "answered";
  findings: string;
  sources: string[];
  searches: SearchRecord[];
}

interface ResearchNotebook {
  notebookId: string;
  goal: string;
  questions: ResearchQuestion[];
  createdAt: string;
  updatedAt: string;
}

// ── Input Schema ──

const inputSchema = z.object({
  operation: z.enum([
    "create",
    "list",
    "view",
    "view_question",
    "add_questions",
    "update_question",
    "view_full",
    "deepen_question",
  ]),
  notebookId: z.string().optional(),
  goal: z.string().optional(),
  questions: z.array(z.string()).optional(),
  questionId: z.number().optional(),
  findings: z.string().optional(),
  status: z.enum(["pending", "investigating", "answered"]).optional(),
  sources: z.array(z.string()).optional(),
  deepenTask: z.string().optional(),
});

type NotebookInput = z.infer<typeof inputSchema>;

// ── Singleton Storage ──

const notebooks = new Map<string, ResearchNotebook>();
let nextId = 1;
const loadedSessions = new Set<string>();

// ── Persistence Helpers ──

function getNotebooksDir(sessionId: string): string {
  const settings = getIdeaAgentSettings();
  const dataDir = settings.memory.dataDir ?? ".idea-agent-data";
  return path.resolve(process.cwd(), dataDir, "sessions", sessionId, "session_data", "notebooks");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function persistNotebook(notebook: ResearchNotebook, sessionId: string): void {
  const dir = getNotebooksDir(sessionId);
  ensureDir(dir);

  const jsonPath = path.join(dir, `${notebook.notebookId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(notebook, null, 2), "utf-8");

  const mdPath = path.join(dir, `${notebook.notebookId}.md`);
  fs.writeFileSync(mdPath, renderMarkdown(notebook), "utf-8");
}

function ensureLoaded(sessionId: string): void {
  if (loadedSessions.has(sessionId)) return;
  loadedSessions.add(sessionId);

  const dir = getNotebooksDir(sessionId);
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  let maxId = 0;

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const nb = JSON.parse(raw) as ResearchNotebook;
      if (nb.notebookId && nb.goal) {
        notebooks.set(nb.notebookId, nb);
        const match = nb.notebookId.match(/^notebook-(\d+)$/);
        if (match) {
          maxId = Math.max(maxId, Number(match[1]));
        }
      }
    } catch {
      // skip corrupted files
    }
  }

  if (maxId >= nextId) {
    nextId = maxId + 1;
  }
}

// ── Text Unescape ──

function unescapeText(text: string): string {
  return text
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "");
}

// ── Query Normalization (for dedup) ──

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateSearch(question: ResearchQuestion, toolId: string, query: string): boolean {
  const normalized = normalizeQuery(query);
  return question.searches.some(
    (s) => s.toolId === toolId && normalizeQuery(s.query) === normalized,
  );
}

// ── Rendering Helpers ──

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function renderCompact(notebook: ResearchNotebook): string {
  const lines: string[] = [];
  lines.push(`# ${notebook.notebookId}: ${notebook.goal}`);
  lines.push(`updated: ${notebook.updatedAt}`);
  lines.push("");

  for (const q of notebook.questions) {
    const statusIcon =
      q.status === "answered" ? "[done]"
        : q.status === "investigating" ? "[...]"
          : "[   ]";
    lines.push(`Q${q.id} ${statusIcon} ${q.question}`);
    if (q.findings) {
      lines.push(`  findings: ${truncate(q.findings, 200)}`);
    }
    if (q.sources.length > 0) {
      lines.push(`  sources(${q.sources.length}): ${q.sources.slice(0, 3).join(", ")}${q.sources.length > 3 ? "..." : ""}`);
    }
    if (q.searches.length > 0) {
      lines.push(`  searches: ${q.searches.length} (ok: ${q.searches.filter((s) => s.ok).length})`);
    }
  }

  const answered = notebook.questions.filter((q) => q.status === "answered").length;
  const total = notebook.questions.length;
  lines.push("");
  lines.push(`progress: ${answered}/${total} answered`);

  return lines.join("\n");
}

function renderQuestionDetail(notebook: ResearchNotebook, questionId: number): string {
  const q = notebook.questions.find((item) => item.id === questionId);
  if (!q) return `Question ${questionId} not found in ${notebook.notebookId}`;

  const lines: string[] = [];
  lines.push(`# ${notebook.notebookId} — Q${q.id}`);
  lines.push(`question: ${q.question}`);
  lines.push(`status: ${q.status}`);
  lines.push("");

  if (q.findings) {
    lines.push("## Findings");
    lines.push(q.findings);
    lines.push("");
  }

  if (q.sources.length > 0) {
    lines.push("## Sources");
    for (const src of q.sources) {
      lines.push(`- ${src}`);
    }
    lines.push("");
  }

  if (q.searches.length > 0) {
    lines.push("## Search History");
    for (const s of q.searches) {
      const ok = s.ok ? "ok" : "failed";
      lines.push(`- [T${s.turn}] ${s.toolId} (${ok}): ${s.query}`);
    }
  }

  return lines.join("\n");
}

function renderFull(notebook: ResearchNotebook): string {
  const lines: string[] = [];
  lines.push(`# ${notebook.notebookId}: ${notebook.goal}`);
  lines.push(`created: ${notebook.createdAt} | updated: ${notebook.updatedAt}`);
  lines.push("");

  for (const q of notebook.questions) {
    lines.push(`## Q${q.id}: ${q.question} [${q.status}]`);
    if (q.findings) {
      lines.push("");
      lines.push(q.findings);
    }
    if (q.sources.length > 0) {
      lines.push("");
      lines.push("Sources:");
      for (const src of q.sources) {
        lines.push(`- ${src}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderMarkdown(notebook: ResearchNotebook): string {
  const lines: string[] = [];
  lines.push(`# Research Notebook: ${notebook.notebookId}`);
  lines.push("");
  lines.push(`**Goal:** ${notebook.goal}`);
  lines.push(`**Created:** ${notebook.createdAt}`);
  lines.push(`**Updated:** ${notebook.updatedAt}`);
  lines.push("");

  const answered = notebook.questions.filter((q) => q.status === "answered").length;
  lines.push(`**Progress:** ${answered}/${notebook.questions.length} questions answered`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const q of notebook.questions) {
    lines.push(`## Q${q.id}: ${q.question}`);
    lines.push("");
    lines.push(`**Status:** ${q.status}`);
    lines.push("");

    if (q.findings) {
      lines.push("### Findings");
      lines.push("");
      lines.push(q.findings);
      lines.push("");
    }

    if (q.sources.length > 0) {
      lines.push("### Sources");
      lines.push("");
      for (const src of q.sources) {
        lines.push(`- ${src}`);
      }
      lines.push("");
    }

    if (q.searches.length > 0) {
      lines.push("### Search History");
      lines.push("");
      for (const s of q.searches) {
        const ok = s.ok ? "ok" : "failed";
        lines.push(`- [Turn ${s.turn}] ${s.toolId} (${ok}): ${s.query}`);
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Operation Handlers ──

function handleCreate(input: NotebookInput, sessionId: string, now: string): ToolExecutionResult {
  ensureLoaded(sessionId);

  if (!input.goal) {
    return { ok: false, value: "Error: create requires 'goal'" };
  }

  const normalizedGoal = input.goal.toLowerCase().replace(/\s+/g, " ").trim();
  for (const existing of notebooks.values()) {
    const existingNorm = existing.goal.toLowerCase().replace(/\s+/g, " ").trim();
    if (
      existingNorm === normalizedGoal ||
      (normalizedGoal.length >= 20 && existingNorm.includes(normalizedGoal)) ||
      (existingNorm.length >= 20 && normalizedGoal.includes(existingNorm))
    ) {
      return {
        value: JSON.stringify({
          notebookId: existing.notebookId,
          questionCount: existing.questions.length,
          reused: true,
          message: `已存在目标相似的笔记本 ${existing.notebookId}，已自动复用。如需追加问题请用 add_questions。`,
        }),
      };
    }
  }

  const notebookId = `notebook-${nextId++}`;

  const questions: ResearchQuestion[] = (input.questions ?? []).map((q, i) => ({
    id: i + 1,
    question: q,
    status: "pending" as const,
    findings: "",
    sources: [],
    searches: [],
  }));

  const notebook: ResearchNotebook = {
    notebookId,
    goal: input.goal,
    questions,
    createdAt: now,
    updatedAt: now,
  };

  notebooks.set(notebookId, notebook);
  persistNotebook(notebook, sessionId);

  return {
    value: JSON.stringify({ notebookId, questionCount: questions.length }),
  };
}

function handleList(sessionId: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  const items = Array.from(notebooks.values()).map((nb) => {
    const answered = nb.questions.filter((q) => q.status === "answered").length;
    return {
      id: nb.notebookId,
      goal: truncate(nb.goal, 120),
      stats: {
        total: nb.questions.length,
        answered,
        pending: nb.questions.length - answered,
      },
    };
  });

  return { value: JSON.stringify({ notebooks: items }) };
}

function handleView(input: NotebookInput, sessionId: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  if (!input.notebookId) {
    return { ok: false, value: "Error: view requires 'notebookId'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  return { value: renderCompact(notebook) };
}

function handleViewQuestion(input: NotebookInput, sessionId: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  if (!input.notebookId || input.questionId == null) {
    return { ok: false, value: "Error: view_question requires 'notebookId' and 'questionId'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  return { value: renderQuestionDetail(notebook, input.questionId) };
}

function handleAddQuestions(input: NotebookInput, sessionId: string, now: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  if (!input.notebookId || !input.questions || input.questions.length === 0) {
    return { ok: false, value: "Error: add_questions requires 'notebookId' and non-empty 'questions'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  const startId = notebook.questions.length + 1;
  const added: Array<{ id: number; question: string }> = [];

  for (let i = 0; i < input.questions.length; i++) {
    const id = startId + i;
    const q: ResearchQuestion = {
      id,
      question: input.questions[i],
      status: "pending",
      findings: "",
      sources: [],
      searches: [],
    };
    notebook.questions.push(q);
    added.push({ id, question: q.question });
  }

  notebook.updatedAt = now;
  persistNotebook(notebook, sessionId);

  return { value: JSON.stringify({ added }) };
}

function handleUpdateQuestion(input: NotebookInput, sessionId: string, now: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  if (!input.notebookId || input.questionId == null) {
    return { ok: false, value: "Error: update_question requires 'notebookId' and 'questionId'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  const question = notebook.questions.find((q) => q.id === input.questionId);
  if (!question) {
    return { ok: false, value: `Error: Question ${input.questionId} not found in ${input.notebookId}` };
  }

  if (input.findings) {
    const cleaned = unescapeText(input.findings);
    question.findings = question.findings
      ? `${question.findings}\n\n${cleaned}`
      : cleaned;
  }

  if (input.status) {
    question.status = input.status;
  }

  if (input.sources && input.sources.length > 0) {
    for (const src of input.sources) {
      if (!question.sources.includes(src)) {
        question.sources.push(src);
      }
    }
  }

  notebook.updatedAt = now;
  persistNotebook(notebook, sessionId);

  return { value: JSON.stringify({ updated: true }) };
}

function handleViewFull(input: NotebookInput, sessionId: string): ToolExecutionResult {
  ensureLoaded(sessionId);
  if (!input.notebookId) {
    return { ok: false, value: "Error: view_full requires 'notebookId'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  return { value: renderFull(notebook) };
}

function renderResearchBrief(question: ResearchQuestion, deepenTask: string): string {
  const lines: string[] = [];
  lines.push("=== 后续深度调研任务 ===");
  lines.push("");
  lines.push("## 调研任务");
  lines.push(deepenTask);
  lines.push("");
  lines.push("## 原始问题");
  lines.push(question.question);
  lines.push("");

  if (question.findings) {
    lines.push("## 已有发现（前次调研结果）");
    lines.push(question.findings);
    lines.push("");
  }

  if (question.searches.length > 0) {
    lines.push("## 已执行的搜索（请勿重复）");
    for (const s of question.searches) {
      lines.push(`- ${s.toolId}: ${s.query}`);
    }
    lines.push("");
  }

  lines.push("## 通用要求");
  lines.push(
    "请基于以上已有信息和调研任务，进行更深入的调研。" +
    "避免重复已有的搜索，聚焦于尚未覆盖的方面。" +
    "返回的调研报告应补充新的发现，而非重复已有内容。",
  );
  return lines.join("\n");
}

function handleDeepenQuestion(input: NotebookInput, sessionId: string, now: string): ToolExecutionResult {
  ensureLoaded(sessionId);

  if (!input.notebookId || input.questionId == null || !input.deepenTask) {
    return { ok: false, value: "Error: deepen_question requires 'notebookId', 'questionId' and 'deepenTask'" };
  }

  const notebook = notebooks.get(input.notebookId);
  if (!notebook) {
    return { ok: false, value: `Error: Notebook '${input.notebookId}' not found` };
  }

  const question = notebook.questions.find((q) => q.id === input.questionId);
  if (!question) {
    return { ok: false, value: `Error: Question ${input.questionId} not found in ${input.notebookId}` };
  }

  question.status = "investigating";
  notebook.updatedAt = now;
  persistNotebook(notebook, sessionId);

  return { value: renderResearchBrief(question, input.deepenTask) };
}

// ── Dedup: Record a search attempt on a question ──

export function recordSearch(
  sessionId: string,
  notebookId: string,
  questionId: number,
  toolId: string,
  query: string,
  turn: number,
  ok: boolean,
): { recorded: boolean; duplicate: boolean } {
  ensureLoaded(sessionId);
  const notebook = notebooks.get(notebookId);
  if (!notebook) return { recorded: false, duplicate: false };

  const question = notebook.questions.find((q) => q.id === questionId);
  if (!question) return { recorded: false, duplicate: false };

  if (isDuplicateSearch(question, toolId, query)) {
    return { recorded: false, duplicate: true };
  }

  question.searches.push({ toolId, query: normalizeQuery(query), turn, ok });
  return { recorded: true, duplicate: false };
}

// ── Notebook Summary (for LLM payload injection) ──

export function getNotebooksSummary(sessionId: string): Array<{
  id: string;
  goal: string;
  questionCount: number;
  answeredCount: number;
}> {
  ensureLoaded(sessionId);
  return Array.from(notebooks.values()).map((nb) => ({
    id: nb.notebookId,
    goal: truncate(nb.goal, 120),
    questionCount: nb.questions.length,
    answeredCount: nb.questions.filter((q) => q.status === "answered").length,
  }));
}

// ── Tool Export ──

export const researchNotebookTool: NativeTool = {
  name: "research-notebook",
  description: "调研笔记本：管理问题驱动的研究过程，记录问题、发现和来源。内容应尽量详实",
  inputSchema,
  async execute(input: NotebookInput, ctx): Promise<ToolExecutionResult> {
    const sessionId = (ctx.sessionId as string) ?? "default";
    const now = new Date().toISOString();

    switch (input.operation) {
      case "create":
        return handleCreate(input, sessionId, now);
      case "list":
        return handleList(sessionId);
      case "view":
        return handleView(input, sessionId);
      case "view_question":
        return handleViewQuestion(input, sessionId);
      case "add_questions":
        return handleAddQuestions(input, sessionId, now);
      case "update_question":
        return handleUpdateQuestion(input, sessionId, now);
      case "view_full":
        return handleViewFull(input, sessionId);
      case "deepen_question":
        return handleDeepenQuestion(input, sessionId, now);
      default:
        return { ok: false, value: `Error: Unknown operation: ${input.operation}` };
    }
  },
};
