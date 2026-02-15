/**
 * Minimal Markdown → ANSI terminal renderer.
 *
 * Handles: headings, bold, inline code, code blocks, lists,
 * horizontal rules, blockquotes, and tables.
 */

import * as S from "./styles";

/* ── inline formatting ────────────────────────────────────── */

function renderInline(line: string): string {
  // inline code: `code`
  line = line.replace(/`([^`]+)`/g, (_m, code: string) => S.cyan(code));
  // bold + italic: ***text*** or ___text___
  line = line.replace(/\*{3}(.+?)\*{3}/g, (_m, t: string) => S.bold(S.italic(t)));
  // bold: **text** or __text__
  line = line.replace(/\*{2}(.+?)\*{2}/g, (_m, t: string) => S.bold(t));
  line = line.replace(/_{2}(.+?)_{2}/g, (_m, t: string) => S.bold(t));
  // italic: *text* or _text_
  line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_m, t: string) => S.italic(t));
  return line;
}

/* ── code block state ─────────────────────────────────────── */

interface CodeBlock {
  lang: string;
  lines: string[];
}

/* ── table helpers ────────────────────────────────────────── */

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)*\|$/.test(line.trim());
}

function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  // Remove leading and trailing |, then split by |
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const stripped = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return stripped.split("|").map((c) => c.trim());
}

function stripAnsi(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padCell(text: string, width: number): string {
  const visible = stripAnsi(text);
  const pad = Math.max(0, width - visible);
  return text + " ".repeat(pad);
}

function renderTable(lines: string[]): string {
  // Parse all rows
  const rows = lines.filter((l) => !isTableSeparator(l)).map(parseTableCells);
  if (rows.length === 0) return lines.join("\n");

  const colCount = Math.max(...rows.map((r) => r.length));

  // Normalize row lengths
  for (const row of rows) {
    while (row.length < colCount) row.push("");
  }

  // Apply inline formatting
  const formatted = rows.map((row) => row.map(renderInline));

  // Calculate column widths based on visible text length
  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    colWidths.push(Math.max(3, ...formatted.map((row) => stripAnsi(row[c]))));
  }

  const output: string[] = [];

  // Top border
  const topBar = S.dim("  ┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
  output.push(topBar);

  for (let r = 0; r < formatted.length; r++) {
    const cells = formatted[r].map((cell, c) => ` ${padCell(cell, colWidths[c])} `);
    const rowText = S.dim("  │") + cells.map((cell, c) =>
      c < cells.length - 1 ? cell + S.dim("│") : cell,
    ).join("") + S.dim("│");
    output.push(rowText);

    // After header row (first row), add separator
    if (r === 0) {
      const sep = S.dim("  ├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤");
      output.push(sep);
    }
  }

  // Bottom border
  const botBar = S.dim("  └" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");
  output.push(botBar);

  return output.join("\n");
}

/* ── public API ───────────────────────────────────────────── */

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let codeBlock: CodeBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    // code fence open/close
    if (raw.trimStart().startsWith("```")) {
      if (codeBlock === null) {
        const lang = raw.trimStart().slice(3).trim();
        codeBlock = { lang, lines: [] };
        continue;
      } else {
        output.push(renderCodeBlock(codeBlock));
        codeBlock = null;
        continue;
      }
    }

    if (codeBlock !== null) {
      codeBlock.lines.push(raw);
      continue;
    }

    // table: collect consecutive table rows and render as a block
    if (isTableRow(raw)) {
      const tableLines: string[] = [raw];
      while (i + 1 < lines.length && (isTableRow(lines[i + 1]) || isTableSeparator(lines[i + 1]))) {
        i++;
        tableLines.push(lines[i]);
      }
      output.push(renderTable(tableLines));
      continue;
    }

    // horizontal rule
    if (/^-{3,}$/.test(raw.trim()) || /^\*{3,}$/.test(raw.trim())) {
      output.push(S.horizontalRule());
      continue;
    }

    // headings
    const headingMatch = raw.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      output.push(renderHeading(level, content));
      continue;
    }

    // blockquote
    if (raw.trimStart().startsWith("> ")) {
      const content = raw.trimStart().slice(2);
      output.push(`  ${S.gray("│")} ${S.italic(renderInline(content))}`);
      continue;
    }

    // unordered list
    const ulMatch = raw.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      const indent = ulMatch[1];
      const content = ulMatch[2];
      output.push(`${indent}  ${S.dim("•")} ${renderInline(content)}`);
      continue;
    }

    // ordered list
    const olMatch = raw.match(/^(\s*)(\d+)\.\s+(.+)/);
    if (olMatch) {
      const indent = olMatch[1];
      const num = olMatch[2];
      const content = olMatch[3];
      output.push(`${indent}  ${S.boldBlue(`${num}.`)} ${renderInline(content)}`);
      continue;
    }

    // normal paragraph
    output.push(renderInline(raw));
  }

  // unclosed code block
  if (codeBlock !== null) {
    output.push(renderCodeBlock(codeBlock));
  }

  return output.join("\n");
}

/* ── code block renderer ──────────────────────────────────── */

function renderCodeBlock(block: CodeBlock): string {
  const width = Math.min(S.getTerminalWidth() - 4, 100);
  const langLabel = block.lang ? ` ${block.lang} ` : "";
  const topBar = S.dim(`  ┌${langLabel}${"─".repeat(Math.max(0, width - langLabel.length - 1))}┐`);
  const botBar = S.dim(`  └${"─".repeat(width)}┘`);

  const codeLines = block.lines.map((l) => {
    const padded = l.length < width - 2 ? l + " ".repeat(width - 2 - l.length) : l.slice(0, width - 2);
    return `  ${S.dim("│")} ${S.brightWhite(padded)} ${S.dim("│")}`;
  });

  return [topBar, ...codeLines, botBar].join("\n");
}

/* ── heading renderer ─────────────────────────────────────── */

function renderHeading(level: number, text: string): string {
  switch (level) {
    case 1:
      return `\n${S.boldWhite(S.underline(text))}\n`;
    case 2:
      return `\n${S.boldCyan(text)}`;
    case 3:
      return `${S.bold(text)}`;
    default:
      return text;
  }
}
