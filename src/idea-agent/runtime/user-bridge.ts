import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AskUserOption, AskUserQuestion } from "../core/types";
import * as S from "../ui/styles";
import { renderMarkdown } from "../ui/markdown";

export interface UserBridge {
  ask(question: AskUserQuestion): Promise<string>;
  respond(message: string): Promise<void>;
}

function normalizeText(value: string): string {
  return value.replace(/\s*\n+\s*/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeQuestion(question: AskUserQuestion): AskUserQuestion {
  const prompt = normalizeText(question.prompt);
  const details = typeof question.details === "string" ? normalizeText(question.details) : undefined;
  const options = normalizeOptions(question.options);

  return {
    prompt: prompt.length > 0 ? prompt : "请补充你的需求",
    details: details && details.length > 0 ? details : undefined,
    options: options.length > 0 ? options : undefined,
    allowMultiple: question.allowMultiple === true,
  };
}

function normalizeOptions(options?: AskUserOption[]): AskUserOption[] {
  if (!options || options.length === 0) {
    return [];
  }

  const normalized = options
    .map((option, index) => {
      const id = normalizeText(option.id || `O${index + 1}`);
      const text = normalizeText(option.text || "");
      return {
        id: id.length > 0 ? id : `O${index + 1}`,
        text,
      };
    })
    .filter((option) => option.text.length > 0);

  const deduped: AskUserOption[] = [];
  const seenId = new Set<string>();
  for (const option of normalized) {
    if (seenId.has(option.id)) {
      let suffix = 2;
      let nextId = `${option.id}_${suffix}`;
      while (seenId.has(nextId)) {
        suffix += 1;
        nextId = `${option.id}_${suffix}`;
      }
      deduped.push({ id: nextId, text: option.text });
      seenId.add(nextId);
    } else {
      deduped.push(option);
      seenId.add(option.id);
    }
  }

  return deduped;
}

function mapAnswerToOptions(answer: string, options: AskUserOption[], allowMultiple: boolean): string {
  if (options.length === 0) {
    return answer.trim();
  }

  const raw = answer.trim();
  if (!raw) {
    return raw;
  }

  const chunks = raw
    .split(/[，,\s]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (chunks.length === 0) {
    return raw;
  }

  const matched: AskUserOption[] = [];
  for (const chunk of chunks) {
    const index = Number(chunk);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      matched.push(options[index - 1]);
      continue;
    }

    const byId = options.find((option) => option.id.toLowerCase() === chunk.toLowerCase());
    if (byId) {
      matched.push(byId);
      continue;
    }
  }

  if (matched.length === 0) {
    return raw;
  }

  if (!allowMultiple) {
    const first = matched[0];
    return `${first.id}: ${first.text}`;
  }

  const unique = new Map<string, AskUserOption>();
  for (const item of matched) {
    unique.set(item.id, item);
  }

  return [...unique.values()].map((item) => `${item.id}: ${item.text}`).join(" | ");
}

/* ── interactive arrow-key select (zero dependencies) ───── */

interface SelectResult {
  type: "option" | "other";
  selected: AskUserOption[];
  otherText?: string;
}

async function interactiveSelect(
  options: AskUserOption[],
  allowMultiple: boolean,
): Promise<SelectResult> {
  const totalItems = options.length + 1; // +1 for "其他"
  let cursor = 0;
  const checked = new Set<number>();
  let otherText = "";

  const write = (s: string) => process.stdout.write(s);
  const hideCursor = () => write("\x1b[?25l");
  const showCursor = () => write("\x1b[?25h");

  // Each item occupies 1 content line + 1 blank separator, except the last item (no trailing blank).
  const totalLines = totalItems * 2 - 1;

  function render(firstTime: boolean) {
    if (!firstTime) {
      write(`\x1b[${totalLines}A`);
    }
    for (let i = 0; i < totalItems; i++) {
      write("\x1b[2K"); // clear content line
      const isActive = i === cursor;
      const isOther = i === options.length;

      if (isOther) {
        const ptr = isActive ? S.cyan("❯") : " ";
        const dot = isActive ? S.cyan("●") : S.dim("●");
        if (isActive || otherText.length > 0) {
          const label = S.dim("自由输入:");
          const caret = isActive ? S.cyan("▏") : "";
          write(`  ${ptr} ${dot} ${label} ${otherText}${caret}`);
        } else {
          write(`  ${ptr} ${dot} ${S.dim("其他 (自由输入)")}`);
        }
      } else {
        const opt = options[i];
        const ptr = isActive ? S.cyan("❯") : " ";
        const dot = isActive ? S.cyan("●") : S.dim("●");
        if (allowMultiple) {
          const box = checked.has(i) ? S.green("◉") : S.dim("◯");
          const text = isActive ? S.cyan(opt.text) : opt.text;
          write(`  ${ptr} ${box} ${text}`);
        } else {
          const text = isActive ? S.cyan(opt.text) : opt.text;
          write(`  ${ptr} ${dot} ${text}`);
        }
      }
      write("\n");
      // blank separator line (except after last item)
      if (i < totalItems - 1) {
        write("\x1b[2K\n");
      }
    }
  }

  hideCursor();
  render(true);

  return new Promise<SelectResult>((resolve) => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      showCursor();
    }

    function onData(buf: Buffer) {
      const key = buf.toString();

      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // Arrow keys work everywhere
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + totalItems) % totalItems;
        render(false);
        return;
      }
      if (key === "\x1b[B") {
        cursor = (cursor + 1) % totalItems;
        render(false);
        return;
      }

      // ── cursor on "其他" row: inline text input ──
      if (cursor === options.length) {
        if (key === "\x7f" || key === "\x08") {
          // Backspace
          otherText = otherText.slice(0, -1);
          render(false);
        } else if (key === "\r" || key === "\n") {
          if (otherText.length > 0) {
            cleanup();
            resolve({ type: "other", selected: [], otherText });
          }
        } else if (!key.startsWith("\x1b") && key.charCodeAt(0) >= 0x20) {
          // Printable characters (including pasted text / CJK)
          otherText += key;
          render(false);
        }
        return;
      }

      // ── cursor on option row ──
      if (key === " " && allowMultiple) {
        if (checked.has(cursor)) checked.delete(cursor);
        else checked.add(cursor);
        render(false);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        if (allowMultiple) {
          if (checked.size === 0) checked.add(cursor);
          const result = [...checked].sort((a, b) => a - b).map((i) => options[i]);
          resolve({ type: "option", selected: result });
        } else {
          resolve({ type: "option", selected: [options[cursor]] });
        }
      }
    }

    process.stdin.on("data", onData);
  });
}

export class AutoUserBridge implements UserBridge {
  async ask(question: AskUserQuestion): Promise<string> {
    const normalized = normalizeQuestion(question);
    const options = normalized.options ?? [];
    if (options.length > 0) {
      return `${options[0].id}: ${options[0].text}`;
    }
    return "AUTO_ANSWER";
  }

  async respond(message: string): Promise<void> {
    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotGreen(S.boldGreen("Agent 回复"))}\n\n`);
    process.stdout.write(`${renderMarkdown(message)}\n`);
    process.stdout.write(`${S.horizontalRule()}\n`);
  }
}

export class InteractiveUserBridge implements UserBridge {
  /** Create a one-shot readline for free-text input (avoids conflict with raw mode). */
  private async readLine(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input, output });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }

  async ask(question: AskUserQuestion): Promise<string> {
    const normalized = normalizeQuestion(question);
    const options = normalized.options ?? [];

    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotYellow(S.boldYellow("提问"))} ${S.boldWhite(normalized.prompt)}\n`);
    if (normalized.details) {
      process.stdout.write(`  ${S.dim("说明:")} ${normalized.details}\n`);
    }
    if (options.length > 0 && process.stdin.isTTY) {
      const mode = normalized.allowMultiple ? "多选" : "单选";
      const keys = normalized.allowMultiple
        ? "↑↓ 移动 · Space 选中 · Enter 确认"
        : "↑↓ 移动 · Enter 确认";
      const hint = `[${mode}] ${keys}`;
      process.stdout.write(`  ${S.dim(hint)}\n\n`);

      const result = await interactiveSelect(options, normalized.allowMultiple === true);

      if (result.type === "other") {
        return result.otherText ?? "";
      }

      if (result.selected.length === 1) {
        return `${result.selected[0].id}: ${result.selected[0].text}`;
      }
      return result.selected.map((o) => `${o.id}: ${o.text}`).join(" | ");
    }

    // No options or non-TTY: fall back to text input
    if (options.length > 0) {
      process.stdout.write(`\n  ${S.dim("选项:")}\n`);
      for (const [index, option] of options.entries()) {
        process.stdout.write(`    ${S.boldBlue(`${index + 1}.`)} ${option.text}\n`);
      }
    }
    process.stdout.write(`\n  ${S.dim("请输入你的回答：")}\n`);
    const answer = await this.readLine(`${S.green("❯")} `);
    return mapAnswerToOptions(answer, options, normalized.allowMultiple === true);
  }

  async respond(message: string): Promise<void> {
    process.stdout.write(`\n${S.horizontalRule()}\n`);
    process.stdout.write(`${S.dotGreen(S.boldGreen("Agent 回复"))}\n\n`);
    process.stdout.write(`${renderMarkdown(message)}\n`);
    process.stdout.write(`${S.horizontalRule()}\n`);
  }

  close(): void {
    // readline is now created on-demand per question, nothing persistent to close
  }
}

export class ConsoleUserBridge extends AutoUserBridge {}
